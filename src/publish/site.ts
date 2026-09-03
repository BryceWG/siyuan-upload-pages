import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export interface SiteFile {
    /** Site path, always starting with `/`, e.g. `/index.html`. */
    path: string;
    bytes: Uint8Array;
    contentType: string;
}

export interface BuiltSite {
    title: string;
    files: SiteFile[];
    /** Paths that were referenced but could not be read from the workspace. */
    warnings: string[];
}

export const totalSize = (files: SiteFile[]): number =>
    files.reduce((sum, file) => sum + file.bytes.length, 0);

/**
 * Digest of everything the site consists of: two builds with the same
 * fingerprint would upload byte-identical files, so an equal fingerprint means
 * the published page does not need a new deployment. Hashing is two level
 * (per file, then over `path:hash` lines) to stay cheap on large assets.
 */
export function siteFingerprint(files: SiteFile[]): string {
    const lines = [...files]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((file) => `${file.path}:${bytesToHex(blake3(file.bytes))}`);
    return bytesToHex(blake3(utf8ToBytes(lines.join("\n"))));
}

export const formatSize = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
    }
    return btoa(binary);
}

export const textToBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const CONTENT_TYPES: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    bmp: "image/bmp",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    pdf: "application/pdf",
    zip: "application/zip",
};

export const extensionOf = (path: string): string => {
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export const guessContentType = (path: string): string =>
    CONTENT_TYPES[extensionOf(path)] ?? "application/octet-stream";
