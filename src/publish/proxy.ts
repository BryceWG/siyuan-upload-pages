/**
 * All outbound requests go through SiYuan's kernel proxy (`/api/network/forwardProxy`).
 *
 * The plugin cannot call api.cloudflare.com directly: that host answers
 * `OPTIONS` with `7001 Method OPTIONS not available for that URI`, so the CORS
 * preflight triggered by the `Authorization` header always fails in the
 * frontend. The kernel has no such restriction.
 */

import { request } from "@/api";

export interface ForwardProxyResult {
    body: string;
    contentType: string;
    elapsed: number;
    headers: Record<string, string[]>;
    status: number;
    url: string;
}

export interface ProxyRequestOptions {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    contentType?: string;
    /** A JSON value, or a base64 string when `payloadEncoding` is `base64`. */
    payload?: unknown;
    payloadEncoding?: "json" | "text" | "base64";
    timeoutMs?: number;
}

export async function proxyRequest(options: ProxyRequestOptions): Promise<ForwardProxyResult> {
    const headers = Object.entries(options.headers ?? {}).map(([key, value]) => ({ [key]: value }));

    const response = await request<ForwardProxyResult>("/api/network/forwardProxy", {
        url: options.url,
        method: options.method ?? "GET",
        timeout: options.timeoutMs ?? 120000,
        contentType: options.contentType ?? "application/json",
        headers,
        payload: options.payload ?? "",
        payloadEncoding: options.payloadEncoding ?? "json",
        responseEncoding: "text",
    });

    if (!response.ok || !response.data) {
        throw new Error(response.raw.msg || "forwardProxy request failed");
    }

    return response.data;
}
