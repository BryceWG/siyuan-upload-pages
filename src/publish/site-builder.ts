/**
 * Builds a single-page static site out of SiYuan's own HTML export.
 *
 * The route is "native export first": `/api/export/exportPreviewHTML` returns
 * the same DOM SiYuan uses for its own HTML export, and the stylesheets are
 * fetched from the running kernel (same origin, no CORS involved) so the
 * published page keeps the current theme.
 *
 * Math and code highlighting are rendered here, at publish time, using
 * SiYuan's bundled KaTeX / highlight.js. The uploaded page therefore needs no
 * JavaScript at all.
 */

import { request } from "@/api";
import { BuiltSite, SiteFile, guessContentType, textToBytes } from "./site";

interface PreviewHTMLResponse {
    id: string;
    name: string;
    content: string;
    attrs: Record<string, string>;
    type: string;
}

export interface BuildOptions {
    /** Prepend the document title as an `<h1>`. */
    addTitle: boolean;
    /** Max content width of the article, e.g. `800px`. */
    contentWidth: string;
}

const PAGE_STYLE = `
html, body { margin: 0; padding: 0; }
body { background-color: var(--b3-theme-background); color: var(--b3-theme-on-background); }
.sp-page { max-width: __WIDTH__; margin: 0 auto; padding: 2rem 1.5rem 6rem; box-sizing: border-box; }
.sp-title { font-size: 2em; line-height: 1.3; margin: 0 0 1.5rem; font-weight: 600; }
.protyle-wysiwyg [data-node-id] { cursor: auto; }
.protyle-wysiwyg .protyle-action { user-select: none; }
img { max-width: 100%; }
`;

export async function buildSinglePageSite(docId: string, options: BuildOptions): Promise<BuiltSite> {
    const response = await request<PreviewHTMLResponse>("/api/export/exportPreviewHTML", {
        id: docId,
        keepFold: false,
        merge: false,
        image: false,
    });
    if (!response.ok || !response.data) {
        throw new Error(response.raw.msg || "exportPreviewHTML failed");
    }

    const warnings: string[] = [];
    const files = new Map<string, SiteFile>();

    const holder = document.createElement("div");
    holder.innerHTML = response.data.content;

    sanitize(holder);
    stripSpriteIcons(holder);
    await renderMath(holder, warnings);
    await highlightCode(holder, warnings);
    await collectReferencedAssets(holder, files, warnings);

    const stylesheets = await collectStylesheets(files, warnings);
    const title = response.data.name || "Untitled";
    const html = renderPage(title, holder.innerHTML, stylesheets, options);

    files.set("/index.html", {
        path: "/index.html",
        bytes: textToBytes(html),
        contentType: "text/html; charset=utf-8",
    });

    return { title, files: [...files.values()], warnings };
}

// ---------------------------------------------------------------- page shell

function renderPage(title: string, body: string, stylesheets: string[], options: BuildOptions): string {
    const appearance = siyuanAppearance();
    const links = stylesheets
        .map((href) => `    <link rel="stylesheet" href="${escapeAttr(href.slice(1))}">`)
        .join("\n");
    const heading = options.addTitle ? `<h1 class="sp-title">${escapeHtml(title)}</h1>` : "";

    return `<!DOCTYPE html>
<html lang="${escapeAttr(siyuanLang())}" data-theme-mode="light" data-light-theme="${escapeAttr(appearance.light)}" data-dark-theme="${escapeAttr(appearance.dark)}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
${links}
    <style>${PAGE_STYLE.replace("__WIDTH__", options.contentWidth)}</style>
</head>
<body>
    <main class="sp-page">
        ${heading}
        <div class="protyle-wysiwyg protyle-wysiwyg--attr">
${body}
        </div>
    </main>
</body>
</html>
`;
}

// ------------------------------------------------------------------ cleanup

/** Remove anything that only makes sense inside the editor, plus active content. */
function sanitize(root: HTMLElement): void {
    root.querySelectorAll("script, noscript, template").forEach((node) => node.remove());

    root.querySelectorAll<HTMLElement>("*").forEach((element) => {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            if (name.startsWith("on")) {
                element.removeAttribute(attribute.name);
                continue;
            }
            if (name === "contenteditable" || name === "spellcheck" || name === "draggable") {
                element.removeAttribute(attribute.name);
            }
        }
    });

    // SiYuan renders external links as `<span data-type="a" data-href="...">`.
    // Turn those into real anchors so the published page stays clickable.
    root.querySelectorAll<HTMLElement>("[data-type~='a'][data-href]").forEach((element) => {
        const href = element.getAttribute("data-href") ?? "";
        if (!isSafeHref(href)) {
            element.removeAttribute("data-href");
            return;
        }
        if (element.tagName === "A") {
            element.setAttribute("href", href);
            element.setAttribute("rel", "noopener noreferrer");
            return;
        }
        const anchor = document.createElement("a");
        for (const attribute of [...element.attributes]) {
            anchor.setAttribute(attribute.name, attribute.value);
        }
        anchor.setAttribute("href", href);
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.innerHTML = element.innerHTML;
        element.replaceWith(anchor);
    });

    // Block references cannot resolve on a single-page site: keep the text, drop the link.
    root.querySelectorAll<HTMLElement>("[data-type~='block-ref']").forEach((element) => {
        element.removeAttribute("data-href");
        element.removeAttribute("href");
    });

    root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
        if (!isSafeHref(anchor.getAttribute("href") ?? "")) {
            anchor.removeAttribute("href");
        }
    });
}

/** Allows http(s), mailto and in-page anchors; everything else (siyuan://, javascript:) is dropped. */
function isSafeHref(href: string): boolean {
    const value = href.trim();
    if (!value) {
        return false;
    }
    if (value.startsWith("#") || value.startsWith("/")) {
        return true;
    }
    return /^(https?:|mailto:)/i.test(value);
}

/** SiYuan icons live in a JS-injected SVG sprite that a static page does not have. */
function stripSpriteIcons(root: HTMLElement): void {
    root.querySelectorAll("svg").forEach((svg) => {
        if (svg.querySelector("use")) {
            svg.remove();
        }
    });
    root.querySelectorAll(".protyle-icon, .protyle-action__copy").forEach((node) => node.remove());
}


// --------------------------------------------------------------------- math

async function renderMath(root: HTMLElement, warnings: string[]): Promise<void> {
    const blocks = root.querySelectorAll<HTMLElement>("[data-subtype='math'][data-content]");
    const inline = root.querySelectorAll<HTMLElement>("[data-type~='inline-math'][data-content]");
    if (blocks.length === 0 && inline.length === 0) {
        return;
    }

    const katex = await loadGlobalScript<any>("katex", "/stage/protyle/js/katex/katex.min.js");
    if (!katex) {
        warnings.push("未能加载 KaTeX，公式将以源码形式输出");
        return;
    }

    const render = (element: HTMLElement, target: HTMLElement, displayMode: boolean) => {
        try {
            target.innerHTML = katex.renderToString(element.getAttribute("data-content") ?? "", {
                displayMode,
                output: "html",
                throwOnError: false,
            });
        } catch (error) {
            warnings.push(`公式渲染失败：${String(error)}`);
        }
    };

    blocks.forEach((block) => {
        const target = block.querySelector<HTMLElement>("[spin='1']") ?? block;
        render(block, target, true);
        block.removeAttribute("data-content");
    });
    inline.forEach((element) => {
        render(element, element, false);
        element.removeAttribute("data-content");
    });
}

// --------------------------------------------------------------------- code

async function highlightCode(root: HTMLElement, warnings: string[]): Promise<void> {
    const blocks = root.querySelectorAll<HTMLElement>(".code-block .hljs");
    if (blocks.length === 0) {
        return;
    }

    const hljs = await loadGlobalScript<any>("hljs", "/stage/protyle/js/highlight.js/highlight.min.js");
    if (!hljs) {
        warnings.push("未能加载 highlight.js，代码块将不带高亮");
        return;
    }

    blocks.forEach((block) => {
        const language = block.parentElement?.getAttribute("data-subtype") ?? "";
        const code = block.textContent ?? "";
        try {
            const result = hljs.getLanguage?.(language)
                ? hljs.highlight(code, { language, ignoreIllegals: true })
                : hljs.highlightAuto(code);
            block.innerHTML = result.value;
        } catch (error) {
            warnings.push(`代码高亮失败：${String(error)}`);
        }
    });
}

/** Loads a script served by the kernel and resolves the global it defines. */
async function loadGlobalScript<T>(globalName: string, url: string): Promise<T | null> {
    const existing = (window as any)[globalName];
    if (existing) {
        return existing as T;
    }

    const loaded = await new Promise<boolean>((resolve) => {
        const script = document.createElement("script");
        script.src = url;
        script.async = true;
        script.addEventListener("load", () => resolve(true), { once: true });
        script.addEventListener("error", () => resolve(false), { once: true });
        document.head.appendChild(script);
    });

    return loaded ? ((window as any)[globalName] ?? null) : null;
}

// ------------------------------------------------------------------- assets

const ASSET_ATTRIBUTES = ["src", "href", "poster", "data-src", "xlink:href"];

/**
 * Rewrites nothing: SiYuan already emits workspace-relative paths such as
 * `assets/foo.png`, which resolve correctly for a page served at `/`. We only
 * need to pull those files out of the workspace and into the site.
 */
async function collectReferencedAssets(
    root: HTMLElement,
    files: Map<string, SiteFile>,
    warnings: string[],
): Promise<void> {
    const wanted = new Set<string>();

    root.querySelectorAll<HTMLElement>("*").forEach((element) => {
        for (const name of ASSET_ATTRIBUTES) {
            const value = element.getAttribute(name);
            const sitePath = value ? toWorkspacePath(value) : null;
            if (sitePath) {
                wanted.add(sitePath);
            }
        }
        for (const url of extractCssUrls(element.getAttribute("style") ?? "")) {
            const sitePath = toWorkspacePath(url);
            if (sitePath) {
                wanted.add(sitePath);
            }
        }
    });

    for (const sitePath of wanted) {
        await addWorkspaceFile(sitePath, files, warnings);
    }
}

/** Returns the site path for a workspace-relative reference, or null to leave it alone. */
function toWorkspacePath(raw: string): string | null {
    const value = raw.trim();
    if (!value || value.startsWith("#") || value.startsWith("data:") || value.includes("://")) {
        return null;
    }
    const normalized = value.startsWith("/") ? value : `/${value}`;
    const withoutQuery = normalized.split(/[?#]/)[0];
    if (withoutQuery.includes("/../")) {
        return null;
    }
    return /^\/(assets|emojis)\//.test(withoutQuery) ? decodeURI(withoutQuery) : null;
}

// --------------------------------------------------------------- stylesheets

/**
 * Pulls SiYuan's own stylesheets into the site, keeping their server paths so
 * that relative `url()` references inside them keep resolving.
 */
async function collectStylesheets(files: Map<string, SiteFile>, warnings: string[]): Promise<string[]> {
    const appearance = siyuanAppearance();
    const candidates = [
        "/stage/build/export/base.css",
        `/appearance/themes/${appearance.light}/theme.css`,
        "/stage/protyle/js/katex/katex.min.css",
        `/stage/protyle/js/highlight.js/styles/${appearance.codeStyle}.min.css`,
    ];

    const included: string[] = [];
    for (const path of candidates) {
        const file = await addWorkspaceFile(path, files, warnings);
        if (!file) {
            continue;
        }
        included.push(path);
        await addCssSubResources(path, new TextDecoder().decode(file.bytes), files, warnings);
    }
    return included;
}

async function addCssSubResources(
    cssPath: string,
    css: string,
    files: Map<string, SiteFile>,
    warnings: string[],
): Promise<void> {
    const baseDir = cssPath.slice(0, cssPath.lastIndexOf("/") + 1);
    for (const url of extractCssUrls(css)) {
        const resolved = resolvePath(baseDir, url);
        if (resolved) {
            await addWorkspaceFile(resolved, files, warnings);
        }
    }
}

function extractCssUrls(css: string): string[] {
    const urls: string[] = [];
    const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(css)) !== null) {
        urls.push(match[2]);
    }
    return urls;
}

function resolvePath(baseDir: string, raw: string): string | null {
    const value = raw.trim().split(/[?#]/)[0];
    if (!value || value.startsWith("data:") || value.includes("://")) {
        return null;
    }
    if (value.startsWith("/")) {
        return decodeURI(value);
    }
    const segments = `${baseDir}${value}`.split("/");
    const stack: string[] = [];
    for (const segment of segments) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    return `/${decodeURI(stack.join("/"))}`;
}

/** Reads a file served by the kernel (same origin) and adds it to the site. */
async function addWorkspaceFile(
    sitePath: string,
    files: Map<string, SiteFile>,
    warnings: string[],
): Promise<SiteFile | null> {
    const existing = files.get(sitePath);
    if (existing) {
        return existing;
    }

    try {
        const response = await fetch(encodeURI(sitePath));
        if (!response.ok) {
            warnings.push(`读取失败 (HTTP ${response.status}): ${sitePath}`);
            return null;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const file: SiteFile = {
            path: sitePath,
            bytes,
            contentType: response.headers.get("content-type") || guessContentType(sitePath),
        };
        files.set(sitePath, file);
        return file;
    } catch (error) {
        warnings.push(`读取失败: ${sitePath} (${String(error)})`);
        return null;
    }
}

// -------------------------------------------------------------------- misc

function siyuanAppearance(): { light: string; dark: string; codeStyle: string } {
    const appearance = (window as any).siyuan?.config?.appearance ?? {};
    return {
        light: appearance.themeLight || "daylight",
        dark: appearance.themeDark || "midnight",
        codeStyle: appearance.codeBlockThemeLight || "github",
    };
}

const siyuanLang = (): string => (window as any).siyuan?.config?.lang?.replace("_", "-") || "zh-CN";

const escapeHtml = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (value: string): string => escapeHtml(value).replace(/"/g, "&quot;");
