/**
 * Vercel non-Git deployment.
 *
 * Files are uploaded first (`POST /v2/files`, keyed by the sha1 of the content)
 * and the deployment then references them by sha. Inlining the bytes into the
 * deployment body is also possible, but then they never enter Vercel's file
 * store and a later deployment cannot reference them — which is exactly what
 * carrying previously published pages forward relies on.
 *
 * `projectSettings.framework = null` keeps Vercel from running a build step —
 * the uploaded files are served as-is.
 */

import { sha1 } from "@noble/hashes/sha1";
import { bytesToHex } from "@noble/hashes/utils";

import PromiseLimitPool from "@/libs/promise-pool";
import { proxyRequest } from "./proxy";
import { SiteFile, bytesToBase64 } from "./site";
import type { DeployResult, Progress, SiteManifest } from "./provider";

const API_BASE = "https://api.vercel.com";
/** Vercel has no batch upload endpoint, so files go up concurrently instead. */
const UPLOAD_CONCURRENCY = 6;
/** Reporting every single file would spam the message area. */
const PROGRESS_EVERY = 5;
/** The kernel proxy occasionally drops a connection mid-upload. */
const UPLOAD_RETRIES = 2;

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

interface FileRef {
    sha: string;
    size: number;
}

const isFileRef = (value: unknown): value is FileRef =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as FileRef).sha === "string" &&
    typeof (value as FileRef).size === "number";

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
    base: SiteManifest,
    config: VercelConfig,
    onProgress: Progress = () => {}
): Promise<DeployResult> {
    // The deployment body lists every file the site serves, so pages from
    // earlier publishes are carried over by sha. Their bytes already sit in
    // Vercel's file store, which is why they need no re-upload.
    const manifest: Record<string, FileRef> = {};
    for (const [path, ref] of Object.entries(base)) {
        if (isFileRef(ref)) {
            manifest[path] = ref;
        }
    }

    // Anything the previous deployment already referenced is in Vercel's file
    // store, so only genuinely new content has to be uploaded. Without this the
    // shared stylesheets and KaTeX fonts would be re-sent on every publish.
    const known = new Set(Object.values(manifest).map((ref) => ref.sha));

    // Identical content only has to be uploaded once, even if it is referenced
    // under several paths.
    const payloads = new Map<string, Uint8Array>();
    for (const file of files) {
        const sha = bytesToHex(sha1(file.bytes));
        manifest[file.path] = { sha, size: file.bytes.length };
        if (!known.has(sha)) {
            payloads.set(sha, file.bytes);
        }
    }

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
    // Manifest keys are site paths; Vercel wants them without a leading slash.
    const entries = Object.entries(manifest).map(([path, ref]) => ({
        file: path.replace(/^\//, ""),
        ...ref,
    }));
    const deployment = await createDeployment(config, entries);
    return { ...deployment, manifest };
}

async function createDeployment(
    config: VercelConfig,
    files: unknown[]
): Promise<{ id: string; url: string }> {
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
        (item) => item.name?.endsWith(".vercel.app") && !item.redirect
    );
    return domain?.name ?? null;
}

async function uploadFile(config: VercelConfig, sha: string, bytes: Uint8Array): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await postFile(config, sha, bytes);
            return;
        } catch (error) {
            // A connection dropped on the way through the kernel proxy is worth
            // retrying; a rejection from Vercel itself is not.
            if (attempt >= UPLOAD_RETRIES || !isTransient(error)) {
                throw error;
            }
        }
    }
}

const isTransient = (error: unknown): boolean =>
    /unexpected EOF|connection reset|timeout|forward request failed/i.test(
        error instanceof Error ? error.message : String(error)
    );

async function postFile(config: VercelConfig, sha: string, bytes: Uint8Array): Promise<void> {
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

async function vercelJson<T>(
    config: VercelConfig,
    options: VercelRequest & { allowMissing: true }
): Promise<T | null>;
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
        if (
            options.allowMissing &&
            (response.status === 404 || parsed?.error?.code === "not_found")
        ) {
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
