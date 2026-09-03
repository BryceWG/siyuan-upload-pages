/**
 * Vercel non-Git deployment.
 *
 * Flow:
 *   1. POST /v2/files            per file, raw bytes, `x-vercel-digest: <sha1>`
 *   2. POST /v13/deployments     references the uploaded files by sha + size
 *
 * `projectSettings.framework = null` keeps Vercel from running a build step —
 * the uploaded files are served as-is.
 */

import { sha1 } from "@noble/hashes/sha1";
import { bytesToHex } from "@noble/hashes/utils";

import { proxyRequest } from "./proxy";
import { SiteFile, bytesToBase64 } from "./site";
import type { DeployResult, Progress } from "./provider";

const API_BASE = "https://api.vercel.com";

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


export async function deploy(
    files: SiteFile[],
    config: VercelConfig,
    onProgress: Progress = () => { },
): Promise<DeployResult> {
    const entries = files.map((file) => ({
        entry: {
            // Vercel expects deployment-root-relative paths without a leading slash.
            file: file.path.replace(/^\//, ""),
            sha: bytesToHex(sha1(file.bytes)),
            size: file.bytes.length,
        } satisfies FileEntry,
        bytes: file.bytes,
    }));

    let uploaded = 0;
    for (const { entry, bytes } of entries) {
        await uploadFile(config, entry.sha, bytes);
        uploaded += 1;
        onProgress(`上传中 ${uploaded}/${entries.length}`);
    }

    onProgress("创建部署…");
    const deployment = await vercelJson<{ id: string; url: string }>(config, {
        path: "/v13/deployments",
        method: "POST",
        payload: {
            name: config.project,
            project: config.project,
            target: config.target,
            files: entries.map(({ entry }) => entry),
            projectSettings: { framework: null },
        },
    });

    return {
        id: deployment.id,
        url: deployment.url.startsWith("http") ? deployment.url : `https://${deployment.url}`,
    };
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
