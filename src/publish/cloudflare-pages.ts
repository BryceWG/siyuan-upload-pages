/**
 * Cloudflare Pages Direct Upload.
 *
 * Flow (matches what wrangler does):
 *   1. GET  /accounts/{account}/pages/projects/{project}/upload-token  -> short lived JWT
 *   2. POST /pages/assets/check-missing                                -> hashes to upload
 *   3. POST /pages/assets/upload                                       -> base64 payloads
 *   4. POST /pages/assets/upsert-hashes                                -> confirm
 *   5. POST /accounts/{account}/pages/projects/{project}/deployments    -> multipart manifest
 *
 * The asset key is `blake3(base64(content) + extension).hex[0:32]`.
 */

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import { proxyRequest } from "./proxy";
import { SiteFile, bytesToBase64, extensionOf } from "./site";

const API_BASE = "https://api.cloudflare.com/client/v4";
/** The upload JWT lives for 300s; refresh well before that. */
const TOKEN_TTL_MS = 200_000;
/** Keep a comfortable margin under Cloudflare's 50 MB per-bucket limit. */
const MAX_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_BATCH_FILES = 200;

export interface CloudflarePagesConfig {
    apiToken: string;
    accountId: string;
    projectName: string;
    branch: string;
}

export interface ProjectInfo {
    name: string;
    subdomain: string;
    productionBranch: string;
}

export interface DeployResult {
    id: string;
    url: string;
}

interface CloudflareEnvelope<T> {
    success: boolean;
    result: T;
    errors?: { code: number; message: string }[];
    messages?: unknown[];
}

interface UploadItem {
    key: string;
    value: string;
    metadata: { contentType: string };
    base64: true;
}

export const assetKey = (file: SiteFile): string =>
    bytesToHex(blake3(utf8ToBytes(bytesToBase64(file.bytes) + extensionOf(file.path)))).slice(0, 32);

export function validateConfig(config: CloudflarePagesConfig): string | null {
    if (!config.apiToken) {
        return "缺少 Cloudflare API Token";
    }
    if (!config.accountId) {
        return "缺少 Cloudflare Account ID";
    }
    if (!config.projectName) {
        return "缺少 Pages 项目名";
    }
    return null;
}

export async function getProject(config: CloudflarePagesConfig): Promise<ProjectInfo> {
    const project = await cloudflare<{ name: string; subdomain: string; production_branch: string }>({
        url: `${API_BASE}/accounts/${encodeURIComponent(config.accountId)}/pages/projects/${encodeURIComponent(config.projectName)}`,
        method: "GET",
        token: config.apiToken,
    });
    return {
        name: project.name,
        subdomain: project.subdomain,
        productionBranch: project.production_branch,
    };
}

export async function deploy(
    files: SiteFile[],
    config: CloudflarePagesConfig,
    onProgress: (message: string) => void = () => { },
): Promise<DeployResult> {
    const manifest: Record<string, string> = {};
    const byKey = new Map<string, SiteFile>();
    for (const file of files) {
        const key = assetKey(file);
        manifest[file.path] = key;
        byKey.set(key, file);
    }

    let token = await mintUploadToken(config);
    let tokenAt = Date.now();
    const refresh = async () => {
        if (Date.now() - tokenAt > TOKEN_TTL_MS) {
            token = await mintUploadToken(config);
            tokenAt = Date.now();
        }
        return token;
    };

    onProgress("检查已存在的文件…");
    const allKeys = [...byKey.keys()];
    const missing = await cloudflare<string[]>({
        url: `${API_BASE}/pages/assets/check-missing`,
        method: "POST",
        token,
        payload: { hashes: allKeys },
    });

    const pending = (missing ?? allKeys).filter((key) => byKey.has(key));
    if (pending.length === 0) {
        onProgress("所有文件均已存在，跳过上传");
    }

    let uploaded = 0;
    for (const batch of createBatches(pending, byKey)) {
        await cloudflare<unknown>({
            url: `${API_BASE}/pages/assets/upload`,
            method: "POST",
            token: await refresh(),
            payload: batch,
        });
        uploaded += batch.length;
        onProgress(`上传中 ${uploaded}/${pending.length}`);
    }

    if (pending.length > 0) {
        await cloudflare<unknown>({
            url: `${API_BASE}/pages/assets/upsert-hashes`,
            method: "POST",
            token: await refresh(),
            payload: { hashes: pending },
        });
    }

    onProgress("创建部署…");
    const multipart = buildMultipart([
        { name: "manifest", value: JSON.stringify(manifest) },
        ...(config.branch ? [{ name: "branch", value: config.branch }] : []),
    ]);

    const deployment = await cloudflare<{ id: string; url: string }>({
        url: `${API_BASE}/accounts/${encodeURIComponent(config.accountId)}/pages/projects/${encodeURIComponent(config.projectName)}/deployments`,
        method: "POST",
        token: config.apiToken,
        contentType: multipart.contentType,
        payload: bytesToBase64(multipart.bytes),
        payloadEncoding: "base64",
    });

    return { id: deployment.id, url: deployment.url };
}

async function mintUploadToken(config: CloudflarePagesConfig): Promise<string> {
    const result = await cloudflare<{ jwt: string }>({
        url: `${API_BASE}/accounts/${encodeURIComponent(config.accountId)}/pages/projects/${encodeURIComponent(config.projectName)}/upload-token`,
        method: "GET",
        token: config.apiToken,
    });
    if (!result?.jwt) {
        throw new Error("Cloudflare 未返回上传令牌");
    }
    return result.jwt;
}

function* createBatches(keys: string[], byKey: Map<string, SiteFile>): Generator<UploadItem[]> {
    let batch: UploadItem[] = [];
    let size = 0;

    for (const key of keys) {
        const file = byKey.get(key)!;
        const value = bytesToBase64(file.bytes);
        if (batch.length > 0 && (size + value.length > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_FILES)) {
            yield batch;
            batch = [];
            size = 0;
        }
        batch.push({ key, value, metadata: { contentType: file.contentType }, base64: true });
        size += value.length;
    }

    if (batch.length > 0) {
        yield batch;
    }
}

/**
 * Cloudflare rejects the deployment call unless the multipart body is byte
 * exact, so it is assembled by hand and forwarded verbatim as base64.
 */
function buildMultipart(fields: { name: string; value: string }[]): { bytes: Uint8Array; contentType: string } {
    const boundary = `----siyuanpages${crypto.randomUUID().replace(/-/g, "")}`;
    const body = fields
        .map(({ name, value }) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
        .join("");

    return {
        bytes: utf8ToBytes(`${body}--${boundary}--\r\n`),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

async function cloudflare<T>(options: {
    url: string;
    method: string;
    token: string;
    payload?: unknown;
    payloadEncoding?: "json" | "base64";
    contentType?: string;
}): Promise<T> {
    const response = await proxyRequest({
        url: options.url,
        method: options.method,
        headers: { Authorization: `Bearer ${options.token}` },
        contentType: options.contentType ?? "application/json",
        payload: options.payload,
        payloadEncoding: options.payloadEncoding ?? "json",
    });

    let envelope: CloudflareEnvelope<T>;
    try {
        envelope = JSON.parse(response.body);
    } catch {
        throw new Error(`Cloudflare 返回了非 JSON 响应 (HTTP ${response.status})`);
    }

    if (!envelope.success) {
        const detail = (envelope.errors ?? [])
            .map((error) => `${error.code}: ${error.message}`)
            .join("; ");
        throw new Error(detail || `Cloudflare 请求失败 (HTTP ${response.status})`);
    }

    return envelope.result;
}
