/**
 * Vercel non-Git deployment.
 *
 * Small sites go up in one call, with every file inlined into the deployment
 * request as base64. Above `INLINE_LIMIT_BYTES` the files are uploaded first
 * (`POST /v2/files`, keyed by the sha1 of the content) and the deployment then
 * references them by sha. Vercel has no archive upload, so those are the only
 * two options.
 *
 * `projectSettings.framework = null` keeps Vercel from running a build step —
 * the uploaded files are served as-is.
 */


import { sha1 } from "@noble/hashes/sha1";
import { bytesToHex } from "@noble/hashes/utils";

import PromiseLimitPool from "@/libs/promise-pool";
import { proxyRequest } from "./proxy";
import { SiteFile, bytesToBase64 } from "./site";
import type { DeployResult, Progress } from "./provider";

const API_BASE = "https://api.vercel.com";
/** Vercel has no batch upload endpoint, so files go up concurrently instead. */
const UPLOAD_CONCURRENCY = 6;
/** Reporting every single file would spam the message area. */
const PROGRESS_EVERY = 5;
/**
 * Small sites are inlined into the deployment request, which makes the whole
 * upload a single call. The body limit of that endpoint is not documented, so
 * this stays conservative and larger sites fall back to per-file upload.
 */
const INLINE_LIMIT_BYTES = 4 * 1024 * 1024;



export interface VercelConfig {
    token: string;
    project: string;
    /** Required for team projects, empty for personal ones. */
    teamId: string;
    target: "production" | "preview";
}

export interface ProjectInfo {
    id: string;
    name: string;
}

interface FileEntry {
    file: string;
    sha: string;
    size: number;
}

export function validateConfig(config: VercelConfig): string | null {
    if (!config.token) {
        return "缺少 Vercel Access Token";
    }
    if (!config.project) {
        return "缺少 Vercel 项目名";
    }
    return null;
}

export function findProject(config: VercelConfig): Promise<ProjectInfo | null> {
    return vercelJson<ProjectInfo>(config, {
        path: `/v9/projects/${encodeURIComponent(config.project)}`,
        method: "GET",
        allowMissing: true,
    });
}

export function createProject(config: VercelConfig): Promise<ProjectInfo> {
    return vercelJson<ProjectInfo>(config, {
        path: "/v11/projects",
        method: "POST",
        payload: { name: config.project, framework: null },
    });
}

/** Removes an earlier deployment; a deployment that is already gone counts as removed. */
export async function deleteDeployment(config: VercelConfig, deploymentId: string): Promise<void> {
    await vercelJson<unknown>(config, {
        path: `/v13/deployments/${encodeURIComponent(deploymentId)}`,
        method: "DELETE",
        allowMissing: true,
    });
}


export async function deploy(
    files: SiteFile[],
    config: VercelConfig,
    onProgress: Progress = () => { },
): Promise<DeployResult> {
    // Vercel expects deployment-root-relative paths without a leading slash.
    const paths = files.map((file) => file.path.replace(/^\//, ""));
    const base64 = files.map((file) => bytesToBase64(file.bytes));
    const inlineSize = base64.reduce((sum, value) => sum + value.length, 0);

    if (inlineSize <= INLINE_LIMIT_BYTES) {
        onProgress(`上传中（单请求 ${files.length} 个文件）`);
        return createDeployment(config, paths.map((path, index) => ({
            file: path,
            data: base64[index],
            encoding: "base64",
        })));
    }

    const entries: FileEntry[] = files.map((file, index) => ({
        file: paths[index],
        sha: bytesToHex(sha1(file.bytes)),
        size: file.bytes.length,
    }));

    // Identical content only has to be uploaded once, even if it is referenced
    // under several paths.
    const payloads = new Map<string, Uint8Array>();
    files.forEach((file, index) => payloads.set(entries[index].sha, file.bytes));

    const total = payloads.size;
    let uploaded = 0;
    const pool = new PromiseLimitPool<void>(UPLOAD_CONCURRENCY);
    for (const [sha, bytes] of payloads) {
        pool.add(async () => {
            await uploadFile(config, sha, bytes);
            uploaded += 1;
            if (uploaded % PROGRESS_EVERY === 0 || uploaded === total) {
                onProgress(`上传中 ${uploaded}/${total}`);
            }
        });
    }
    await pool.awaitAll();

    onProgress("创建部署…");
    return createDeployment(config, entries);
}

async function createDeployment(config: VercelConfig, files: unknown[]): Promise<DeployResult> {
    const deployment = await vercelJson<{ id: string; url: string }>(config, {
        path: "/v13/deployments",
        method: "POST",
        payload: {
            name: config.project,
            project: config.project,
            target: config.target,
            files,
            projectSettings: { framework: null },
        },
    });

    let url = deployment.url.startsWith("http") ? deployment.url : `https://${deployment.url}`;
    // Every deployment gets its own URL, but the project domain always serves
    // the latest production deployment — prefer it so republishing keeps one
    // stable link. The assigned domain cannot be derived from the project name
    // (Vercel appends a suffix when the name is taken), so it is looked up.
    if (config.target === "production") {
        const domain = await findProjectDomain(config).catch(() => null);
        if (domain) {
            url = `https://${domain}`;
        }
    }

    return { id: deployment.id, url };
}

/** The project's assigned `<name>.vercel.app` domain, skipping redirected ones. */
async function findProjectDomain(config: VercelConfig): Promise<string | null> {
    const result = await vercelJson<{ domains: { name: string; redirect?: string }[] }>(config, {
        path: `/v9/projects/${encodeURIComponent(config.project)}/domains`,
        method: "GET",
    });
    const domain = (result?.domains ?? []).find(
        (item) => item.name?.endsWith(".vercel.app") && !item.redirect,
    );
    return domain?.name ?? null;
}



async function uploadFile(config: VercelConfig, sha: string, bytes: Uint8Array): Promise<void> {
    const response = await proxyRequest({
        url: `${API_BASE}/v2/files${teamQuery(config, "?")}`,
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.token}`,
            "x-vercel-digest": sha,
        },
        contentType: "application/octet-stream",
        payload: bytesToBase64(bytes),
        payloadEncoding: "base64",
    });

    if (response.status >= 400) {
        throw new Error(errorMessage(response.body, response.status));
    }
}

interface VercelRequest {
    path: string;
    method: string;
    payload?: unknown;
    /** Return null instead of throwing when the resource does not exist. */
    allowMissing?: boolean;
}

async function vercelJson<T>(config: VercelConfig, options: VercelRequest & { allowMissing: true }): Promise<T | null>;
async function vercelJson<T>(config: VercelConfig, options: VercelRequest): Promise<T>;
async function vercelJson<T>(config: VercelConfig, options: VercelRequest): Promise<T | null> {
    const separator = options.path.includes("?") ? "&" : "?";
    const response = await proxyRequest({
        url: `${API_BASE}${options.path}${teamQuery(config, separator)}`,
        method: options.method,
        headers: { Authorization: `Bearer ${config.token}` },
        contentType: "application/json",
        payload: options.payload,
    });

    let parsed: any;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        throw new Error(`Vercel 返回了非 JSON 响应 (HTTP ${response.status})`);
    }

    if (response.status >= 400 || parsed?.error) {
        if (options.allowMissing && (response.status === 404 || parsed?.error?.code === "not_found")) {
            return null;
        }
        throw new Error(errorMessage(response.body, response.status));
    }

    return parsed as T;
}


const teamQuery = (config: VercelConfig, separator: string): string =>
    config.teamId ? `${separator}teamId=${encodeURIComponent(config.teamId)}` : "";

function errorMessage(body: string, status: number): string {
    try {
        const error = JSON.parse(body)?.error;
        if (error?.message) {
            return `${error.code ?? status}: ${error.message}`;
        }
    } catch {
        // fall through to the generic message
    }
    return `Vercel 请求失败 (HTTP ${status})`;
}
