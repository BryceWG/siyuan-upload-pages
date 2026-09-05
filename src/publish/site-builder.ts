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

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import { request, sql } from "@/api";
import { BuiltSite, SiteFile, guessContentType, textToBytes } from "./site";
import { TemplateOptions } from "./template-options";

interface PreviewHTMLResponse {
    id: string;
    name: string;
    content: string;
    attrs: Record<string, string>;
    type: string;
}

export interface BuildOptions extends TemplateOptions {
    /** Path segment the page is served under, e.g. `a1b2c3d4e5` in `/a1b2c3d4e5/`. */
    slug: string;
    /** Heading of the table of contents, e.g. `目录`. */
    tocLabel: string;
    /** Kernel folder holding the page icon files, e.g. `/plugins/<plugin>/asset`. */
    iconDir: string;
}

const PAGE_STYLE = `
html { scroll-behavior: smooth; }
html, body { margin: 0; padding: 0; }
body { background-color: var(--b3-theme-background); color: var(--b3-theme-on-background); }
.sp-shell { display: flex; align-items: flex-start; justify-content: center; gap: 2.5rem;
    max-width: __SHELL_WIDTH__; margin: 0 auto; padding: 2rem 1.5rem 6rem; box-sizing: border-box; }
.sp-page { order: 1; flex: 1 1 auto; min-width: 0; max-width: __WIDTH__; }
.sp-title { font-size: 2em; line-height: 1.3; margin: 0 0 1.5rem; font-weight: 600; }
.protyle-wysiwyg [data-node-id] { cursor: auto; }
.protyle-wysiwyg .protyle-action { user-select: none; }
img { max-width: 100%; }
.protyle-wysiwyg table { max-width: 100%; }
.protyle-wysiwyg pre { max-width: 100%; overflow-x: auto; }
.protyle-wysiwyg pre code { font-family: var(--b3-font-family-code, monospace); }
[data-type="NodeHTMLBlock"] { overflow-x: auto; }
[id] { scroll-margin-top: 1.5rem; }
.sp-toc { order: 2; flex: 0 0 15rem; position: sticky; top: 2rem; align-self: flex-start;
    max-height: calc(100vh - 4rem); overflow: auto; font-size: 13px; line-height: 1.6;
    border-left: 1px solid var(--b3-border-color); padding-left: 1rem; }
.sp-toc__label { font-weight: 600; margin-bottom: .5rem; color: var(--b3-theme-on-surface); }
.sp-toc__item { display: block; padding: 2px 0; color: var(--b3-theme-on-surface);
    text-decoration: none; overflow: hidden; text-overflow: ellipsis; }
.sp-toc__item:hover { color: var(--b3-theme-primary); }
.sp-toc__item--l2 { padding-left: .75rem; }
.sp-toc__item--l3 { padding-left: 1.5rem; }
.sp-toc__item--l4 { padding-left: 2.25rem; }
.sp-toc__item--l5 { padding-left: 3rem; }
.sp-toc__item--l6 { padding-left: 3.75rem; }
.sp-toc__split { margin: .6rem 0; border-top: 1px solid var(--b3-border-color); }
.sp-doc { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--b3-border-color); }
.sp-doc__title { font-size: 1.6em; line-height: 1.3; margin: 0 0 1rem; font-weight: 600; }
.sp-ref { color: var(--b3-theme-primary); text-decoration: none; border-bottom: 1px solid currentColor; }
/* The export stylesheet lays block math out as a flex row with a leading
   spacer, which pushes the formula against the right edge. KaTeX's own
   centering is restored here, tags included. */
.protyle-wysiwyg .katex-display > .katex > .katex-html { display: block; position: relative; }
.protyle-wysiwyg .katex-display > .katex > .katex-html::before { content: none; }
.protyle-wysiwyg .katex-display > .katex > .katex-html > .tag { position: absolute; right: 0; margin: 0; }
/* Keep exported code on its original lines; the editor stylesheet may make
   inline code rules win over highlight.js' block layout. */
.protyle-wysiwyg .code-block { overflow-x: auto; }
.protyle-wysiwyg .code-block .hljs { display: block; white-space: pre; overflow-x: auto; }

@media (max-width: 1100px) {
    .sp-shell { flex-direction: column; gap: 1.5rem; max-width: __WIDTH__; }
    .sp-page { order: 2; max-width: 100%; }
    .sp-toc { order: 1; position: static; flex: none; width: 100%; max-height: none;
        border-left: 0; padding-left: 0; }
}
`;

export async function buildSinglePageSite(
    docId: string,
    options: BuildOptions
): Promise<BuiltSite> {
    const main = await fetchPreview(docId);

    const warnings: string[] = [];
    const files = new Map<string, SiteFile>();

    const holder = document.createElement("div");
    holder.innerHTML = main.content;

    // The kernel's own footnote conversion follows references recursively across
    // documents, so its definitions carry the references of the referenced
    // documents as well. They are dropped unconditionally and inclusion is
    // decided here instead, exactly one level deep.
    const footnoteTargets = options.includeRefs
        ? await resolveFootnoteTargets(holder, warnings)
        : new Map<string, string>();
    dropFootnoteDefs(holder);

    let included = new Set<string>();
    if (options.includeRefs) {
        included = await appendReferencedDocs(holder, docId, warnings);
    } else {
        dropFootnoteMarkers(holder);
    }

    sanitize(holder);
    linkIncludedDocs(holder);
    linkFootnoteRefs(holder, footnoteTargets, included);

    stripSpriteIcons(holder);
    await renderMath(holder, warnings);
    await highlightCode(holder, warnings);
    await collectReferencedAssets(holder, files, warnings);

    const toc = options.toc ? buildToc(holder, options) : "";

    const stylesheets = await collectStylesheets(files, warnings);
    const iconLinks = await addIcons(options, files, warnings);
    const title = main.name || "Untitled";
    const slug = options.slug;
    const canonical = canonicalHtml(holder);

    const html = renderPage(
        title,
        holder.innerHTML,
        toc,
        iconLinks,
        stylesheets,
        options,
        themeVariables()
    );

    const page = `/${slug}/index.html`;
    files.set(page, {
        path: page,
        bytes: textToBytes(html),
        contentType: "text/html; charset=utf-8",
    });

    return {
        title,
        slug,
        files: [...files.values()],
        warnings,
        fingerprint: contentFingerprint(canonical, title, toc, options, files),
    };
}

// -------------------------------------------------------------- fingerprint

const BLOCK_ID = /^\d{14}-[a-z0-9]+$/;

/**
 * A canonical serialization of the built DOM for change detection. The kernel
 * emits block attributes in Go map order — reshuffled on every export — and
 * mints fresh ids for the footnote section each time, so the raw HTML of an
 * unchanged document is never byte-identical (verified against a live kernel:
 * with attributes sorted and block ids dropped, two exports of the same
 * document match exactly). Sorting and dropping happens on a detached clone;
 * the emitted page keeps the kernel's own attribute order and ids.
 */
function canonicalHtml(root: HTMLElement): string {
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("*").forEach((element) => {
        const attributes = [...element.attributes].map(({ name, value }) => ({
            name,
            value,
            blockId: BLOCK_ID.test(value),
        }));
        attributes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const attribute of attributes) {
            element.removeAttribute(attribute.name);
        }
        for (const attribute of attributes) {
            if (!attribute.blockId) {
                element.setAttribute(attribute.name, attribute.value);
            }
        }
    });
    return clone.innerHTML;
}

/**
 * Digest of everything the published page consists of: the canonical DOM in
 * place of `/index.html` (whose bytes carry the kernel's attribute shuffling),
 * the page shell inputs — the stylesheet template included, so that a change to
 * the template alone still triggers a redeploy — and the exact bytes of every
 * other site file.
 */
function contentFingerprint(
    canonical: string,
    title: string,
    toc: string,
    options: BuildOptions,
    files: Map<string, SiteFile>
): string {
    const assets = [...files.values()]
        .filter((file) => !file.path.endsWith("/index.html"))

        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((file) => `${file.path}:${bytesToHex(blake3(file.bytes))}`);
    const parts = [
        `title=${title}`,
        `addTitle=${options.addTitle}`,
        `width=${cssWidth(options.contentWidth)}`,
        `includeRefs=${options.includeRefs}`,
        `themeMode=${siyuanThemeMode()}`,
        `theme=${siyuanAppearance().light}/${siyuanAppearance().dark}`,
        `toc=${toc}`,
        `style=${PAGE_STYLE}`,
        `dom=${canonical}`,
        `files=${assets.join("\n")}`,
    ];
    return bytesToHex(blake3(utf8ToBytes(parts.join("\n\n"))));
}

// ------------------------------------------------------------------ preview

async function fetchPreview(docId: string): Promise<PreviewHTMLResponse> {
    const response = await request<PreviewHTMLResponse>("/api/export/exportPreviewHTML", {
        id: docId,
        keepFold: false,
        merge: false,
        image: false,
    });
    if (!response.ok || !response.data) {
        throw new Error(response.raw.msg || "exportPreviewHTML failed");
    }
    return response.data;
}

// ------------------------------------------------------ referenced documents

const SIYUAN_BLOCK_HREF = "siyuan://blocks/";

/** Where the kernel puts the content of the blocks the body references. */
const FOOTNOTES = ".footnotes-defs-div";

/** Everything that is not the body of the published document itself. */
const REFERENCED_PARTS = "section.sp-doc";

/**
 * `exportPreviewHTML` turns every reference in the body into a footnote and
 * appends the referenced content at the end of the page — recursively, so a
 * reference inside a referenced document brings in a third document. The
 * definitions are therefore always dropped and inclusion is left to
 * `appendReferencedDocs`, which follows exactly one level; the markers survive
 * until `linkFootnoteRefs` knows which documents made it into the page.
 */
function dropFootnoteDefs(root: HTMLElement): void {
    root.querySelectorAll(FOOTNOTES).forEach((node) => node.remove());
}

/** The `<sup>` markers the kernel leaves in the body for every footnote. */
function dropFootnoteMarkers(root: HTMLElement): void {
    root.querySelectorAll(".footnotes-ref").forEach((node) => node.remove());
}

function dropFootnotes(root: HTMLElement): void {
    dropFootnoteDefs(root);
    dropFootnoteMarkers(root);
}

/**
 * Maps each footnote definition to the document it came from, so the markers in
 * the body can link to the section that document gets appended as. Must run
 * before `dropFootnoteDefs`.
 *
 * A definition anchors inside the first block of its target. For a document
 * reference that block is the title heading the export mints on the fly — an id
 * that no query resolves — so the blocks that follow it serve as fallbacks.
 */
async function resolveFootnoteTargets(
    root: HTMLElement,
    warnings: string[]
): Promise<Map<string, string>> {
    const candidates = new Map<string, string[]>();
    root.querySelectorAll<HTMLElement>(`${FOOTNOTES} [id^="footnotes-def-"]`).forEach((def) => {
        const host = def.closest<HTMLElement>("[data-node-id]") ?? def;
        const ids: string[] = [];
        for (
            let node: Element | null = host;
            node && ids.length < 4;
            node = node.nextElementSibling
        ) {
            const id = node.getAttribute("data-node-id") ?? "";
            if (BLOCK_ID.test(id)) {
                ids.push(id);
            }
        }
        if (ids.length > 0) {
            candidates.set(def.id, ids);
        }
    });

    if (candidates.size === 0) {
        return new Map();
    }

    const roots = await resolveRootIds([...new Set([...candidates.values()].flat())], warnings);
    const targets = new Map<string, string>();
    for (const [defId, ids] of candidates) {
        const target = ids.map((id) => roots.get(id)).find((value) => !!value);
        if (target) {
            targets.set(defId, target);
        }
    }
    return targets;
}

/**
 * Turns the footnote markers into links to the appended sections. Markers whose
 * document is not part of the page — a reference to a block of the published
 * document itself, or one that failed to export — are dropped.
 */
function linkFootnoteRefs(
    root: HTMLElement,
    targets: Map<string, string>,
    included: Set<string>
): void {
    root.querySelectorAll<HTMLElement>(".footnotes-ref").forEach((marker) => {
        const link = marker.querySelector("a");
        const defId = (link?.getAttribute("href") ?? "").replace(/^#/, "");
        const target = targets.get(defId);
        if (!link || !target || !included.has(target)) {
            marker.remove();
            return;
        }
        link.setAttribute("href", `#${docAnchor(target)}`);
        link.classList.add("sp-ref");
    });
}

interface RefSeed {
    /** Block the reference points at; its document is what gets included. */
    blockId: string;
    /** Element to turn into an in-page link, or null when it carries content of its own. */
    anchor: HTMLElement | null;
}

/**
 * Appends the documents the body points at — via block references, document
 * links or embed blocks — as sections of the same page. Only one level is
 * followed: references inside an included document stay plain text.
 */
async function appendReferencedDocs(
    root: HTMLElement,
    docId: string,
    warnings: string[]
): Promise<Set<string>> {
    const seeds = collectRefSeeds(root);
    const roots = await resolveRootIds([...new Set(seeds.map((seed) => seed.blockId))], warnings);
    const wanted: string[] = [];
    for (const seed of seeds) {
        const target = roots.get(seed.blockId);
        if (target && target !== docId && !wanted.includes(target)) {
            wanted.push(target);
        }
    }

    // Under the footnote block reference modes the kernel replaces every
    // reference with a marker, leaving no anchor in the DOM for `collectRefSeeds`
    // to find. The index knows them regardless of the export settings.
    for (const target of await queryReferencedDocs(docId, warnings)) {
        if (target !== docId && !wanted.includes(target)) {
            wanted.push(target);
        }
    }

    const included = new Set<string>();
    for (const id of wanted) {
        try {
            const doc = await fetchPreview(id);
            root.appendChild(buildDocSection(id, doc));
            included.add(id);
        } catch (error) {
            warnings.push(`引用文档导出失败: ${id} (${String(error)})`);
        }
    }

    // Stashed here and turned into anchors after `sanitize`, which strips the
    // reference targets it cannot resolve.
    for (const seed of seeds) {
        const target = roots.get(seed.blockId);
        if (seed.anchor && target && included.has(target)) {
            seed.anchor.setAttribute("data-sp-doc", target);
        }
    }

    return included;
}

/** One pass over the tree, so the sections keep the order of the references. */
function collectRefSeeds(root: HTMLElement): RefSeed[] {
    const seeds: RefSeed[] = [];
    const push = (blockId: string | null | undefined, anchor: HTMLElement | null): void => {
        const id = (blockId ?? "").trim();
        if (BLOCK_ID.test(id)) {
            seeds.push({ blockId: id, anchor });
        }
    };

    root.querySelectorAll<HTMLElement>("*").forEach((element) => {
        const type = element.getAttribute("data-type") ?? "";
        const types = type.split(" ");

        if (types.includes("block-ref")) {
            push(element.getAttribute("data-id"), element);
            return;
        }
        if (types.includes("a")) {
            const href = element.getAttribute("data-href") ?? "";
            if (href.startsWith(SIYUAN_BLOCK_HREF)) {
                push(href.slice(SIYUAN_BLOCK_HREF.length).split(/[?#]/)[0], element);
            }
            return;
        }
        if (type === "NodeBlockQueryEmbed") {
            // The embedded blocks are already rendered inside; their ids say
            // which documents the content came from.
            element
                .querySelectorAll<HTMLElement>("[data-id], [data-node-id]")
                .forEach((embedded) => {
                    push(
                        embedded.getAttribute("data-id") ?? embedded.getAttribute("data-node-id"),
                        null
                    );
                });
        }
    });

    return seeds;
}

/** Maps every block id to the document it lives in. */
async function resolveRootIds(
    blockIds: string[],
    warnings: string[]
): Promise<Map<string, string>> {
    const roots = new Map<string, string>();
    if (blockIds.length === 0) {
        return roots;
    }

    // Every id was matched against `BLOCK_ID` before it got here, so the
    // literals cannot carry quotes.
    const list = blockIds.map((id) => `'${id}'`).join(",");
    const response = await sql(
        `SELECT id, root_id FROM blocks WHERE id IN (${list}) LIMIT ${blockIds.length}`
    );
    if (!response.ok || !Array.isArray(response.data)) {
        warnings.push(`引用文档查询失败: ${response.raw.msg || "query/sql failed"}`);
        return roots;
    }

    for (const row of response.data) {
        if (row?.id && row?.root_id) {
            roots.set(String(row.id), String(row.root_id));
        }
    }
    return roots;
}

/** Documents referenced by the published document itself, straight from the index. */
async function queryReferencedDocs(docId: string, warnings: string[]): Promise<string[]> {
    if (!BLOCK_ID.test(docId)) {
        return [];
    }

    const response = await sql(
        `SELECT DISTINCT def_block_root_id FROM refs WHERE root_id = '${docId}'`
    );
    if (!response.ok || !Array.isArray(response.data)) {
        warnings.push(`引用关系查询失败: ${response.raw.msg || "query/sql failed"}`);
        return [];
    }

    return response.data
        .map((row) => String(row?.def_block_root_id ?? ""))
        .filter((id) => BLOCK_ID.test(id));
}

function buildDocSection(docId: string, doc: PreviewHTMLResponse): HTMLElement {
    const section = document.createElement("section");
    section.className = "sp-doc";
    section.id = docAnchor(docId);

    const heading = document.createElement("h2");
    heading.className = "sp-doc__title";
    heading.textContent = doc.name || "Untitled";

    const body = document.createElement("div");
    body.innerHTML = doc.content;
    // This document's own references are the second level; its content is
    // included, the content it points at is not.
    dropFootnotes(body);

    section.append(heading, ...[...body.childNodes]);
    return section;
}

/** Turns the stashed references into links to the section that was appended. */
function linkIncludedDocs(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>("[data-sp-doc]").forEach((element) => {
        const target = element.getAttribute("data-sp-doc") ?? "";
        element.removeAttribute("data-sp-doc");
        if (!BLOCK_ID.test(target)) {
            return;
        }

        const anchor = document.createElement("a");
        for (const attribute of [...element.attributes]) {
            anchor.setAttribute(attribute.name, attribute.value);
        }
        anchor.classList.add("sp-ref");
        anchor.setAttribute("href", `#${docAnchor(target)}`);
        anchor.innerHTML = element.innerHTML;
        element.replaceWith(anchor);
    });
}

const docAnchor = (docId: string): string => `sp-doc-${docId}`;

// ---------------------------------------------------------------------- toc

interface TocEntry {
    level: number;
    id: string;
    text: string;
    /** True for the entries of an included referenced document. */
    referenced: boolean;
}

/**
 * A static table of contents: anchor ids are assigned by position so that two
 * exports of an unchanged document produce the same page, and every entry is a
 * plain `<a href="#...">` — no script on the published page. The headings of
 * the included documents sit behind a separator, mirroring the article.
 */

function buildToc(root: HTMLElement, options: BuildOptions): string {
    const entries: TocEntry[] = [];
    let counter = 0;
    let referenced = false;
    const anchorFor = (element: HTMLElement): string => {
        const id = `sp-h-${++counter}`;
        element.setAttribute("id", id);
        return id;
    };
    const add = (element: HTMLElement, level: number): void => {
        const text = headingText(element);
        if (text) {
            entries.push({ level, id: anchorFor(element), text, referenced });
        }
    };

    const headings = [...root.querySelectorAll<HTMLElement>("[data-type='NodeHeading']")];
    headings
        .filter((heading) => !heading.closest(REFERENCED_PARTS))
        .forEach((heading) => {
            add(heading, headingLevel(heading));
        });

    if (options.tocIncludeRefs) {
        referenced = true;
        root.querySelectorAll<HTMLElement>("section.sp-doc").forEach((section) => {
            const title = section.querySelector<HTMLElement>(".sp-doc__title");
            if (title) {
                add(title, 1);
            }
            section
                .querySelectorAll<HTMLElement>("[data-type='NodeHeading']")
                .forEach((heading) => {
                    add(heading, Math.min(6, headingLevel(heading) + 1));
                });
        });
    }

    if (entries.length === 0) {
        return "";
    }

    const split = entries[0].referenced ? -1 : entries.findIndex((entry) => entry.referenced);
    const items = entries
        .map((entry, index) => {
            const separator =
                index === split ? `            <div class="sp-toc__split"></div>\n` : "";
            return `${separator}            <a class="sp-toc__item sp-toc__item--l${entry.level}" href="#${escapeAttr(entry.id)}">${escapeHtml(entry.text)}</a>`;
        })
        .join("\n");

    return `        <aside class="sp-toc">
        <nav>
            <div class="sp-toc__label">${escapeHtml(options.tocLabel)}</div>
${items}
        </nav>
        </aside>`;
}

function headingLevel(heading: HTMLElement): number {
    const match = /^h([1-6])$/.exec(heading.getAttribute("data-subtype") ?? "");
    return match ? Number(match[1]) : 2;
}

/** The heading text without the block's own attribute markers. */
function headingText(heading: HTMLElement): string {
    const clone = heading.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".protyle-attr, .protyle-action").forEach((node) => node.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

// -------------------------------------------------------------------- icon

/**
 * The page icons, in the order browsers should prefer them: the SVG carries the
 * mark at any size and follows the tab bar's colour scheme, the PNG covers
 * clients without SVG favicon support, and the apple-touch icon is what iOS
 * uses when a page is added to the home screen.
 */
const PAGE_ICONS = [
    { file: "favicon.svg", rel: "icon", type: "image/svg+xml", sizes: "any" },
    { file: "favicon-96.png", rel: "icon", type: "image/png", sizes: "96x96" },
    { file: "apple-touch-icon.png", rel: "apple-touch-icon", type: "image/png", sizes: "" },
];

/**
 * Copies the icon files into the site root, where every published page shares
 * them. They are served from the plugin folder by the kernel, so the same
 * same-origin read as the rest of the assets applies. Returns the `<link>` tags
 * for the icons that could be read.
 */
async function addIcons(
    options: BuildOptions,
    files: Map<string, SiteFile>,
    warnings: string[]
): Promise<string> {
    const links: string[] = [];
    for (const icon of PAGE_ICONS) {
        const source = `${options.iconDir}/${icon.file}`;
        const path = `/${icon.file}`;
        try {
            const response = await fetch(encodeURI(source));
            if (!response.ok) {
                warnings.push(`读取图标失败 (HTTP ${response.status}): ${source}`);
                continue;
            }
            files.set(path, {
                path,
                bytes: new Uint8Array(await response.arrayBuffer()),
                contentType: response.headers.get("content-type") || guessContentType(path),
            });
            const sizes = icon.sizes ? ` sizes="${icon.sizes}"` : "";
            links.push(`    <link rel="${icon.rel}" href="${path}" type="${icon.type}"${sizes}>`);
        } catch (error) {
            warnings.push(`读取图标失败: ${source} (${String(error)})`);
        }
    }
    return links.join("\n");
}

// ---------------------------------------------------------------- page shell

function renderPage(
    title: string,
    body: string,
    toc: string,
    icons: string,
    stylesheets: string[],
    options: BuildOptions,
    variables: string
): string {
    const appearance = siyuanAppearance();
    const themeMode = siyuanThemeMode();
    const selectedTheme = themeMode === "dark" ? appearance.dark : appearance.light;
    const selectedCodeStyle =
        themeMode === "dark" ? appearance.codeStyle.dark : appearance.codeStyle.light;
    const links = stylesheets
        .filter((href) =>
            href.startsWith("/appearance/themes/")
                ? href === `/appearance/themes/${selectedTheme}/theme.css`
                : href.startsWith("/stage/protyle/js/highlight.js/styles/")
                  ? href === `/stage/protyle/js/highlight.js/styles/${selectedCodeStyle}.min.css`
                  : true
        )
        .map((href) => {
            return `    <link rel="stylesheet" href="${escapeAttr(href)}">`;
        })
        .join("\n");
    const icon = icons ? `\n${icons}` : "";

    const heading = options.addTitle ? `<h1 class="sp-title">${escapeHtml(title)}</h1>` : "";
    const width = cssWidth(options.contentWidth);
    const style = `${variables}\n${PAGE_STYLE}`
        .replace(/__SHELL_WIDTH__/g, toc ? `calc(${width} + 17.5rem)` : width)
        .replace(/__WIDTH__/g, width);

    return `<!DOCTYPE html>
<html lang="${escapeAttr(siyuanLang())}" data-theme-mode="${themeMode}" data-light-theme="${escapeAttr(appearance.light)}" data-dark-theme="${escapeAttr(appearance.dark)}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>${icon}
${links}
    <style>${style}</style>
</head>
<body>
    <div class="sp-shell">
        <main class="sp-page">
        ${heading}
        <div class="protyle-wysiwyg protyle-wysiwyg--attr">
${body}
        </div>
        </main>
${toc}
    </div>
</body>
</html>
`;
}

/** Preserve the active SiYuan theme variables even when its theme CSS is not portable. */
function themeVariables(): string {
    const computed = getComputedStyle(document.documentElement);
    const declarations: string[] = [];
    for (let index = 0; index < computed.length; index += 1) {
        const name = computed.item(index);
        if (name.startsWith("--b3-") || name.startsWith("--custom-")) {
            const value = computed.getPropertyValue(name).trim();
            if (value) declarations.push(`${name}: ${value};`);
        }
    }
    return declarations.length ? `:root { ${declarations.join(" ")} }` : "";
}

/** The width lands inside a `<style>` block, so only a plain CSS length passes. */
function cssWidth(value: string): string {
    const width = value.trim();
    return /^\d+(\.\d+)?(px|rem|em|%|vw|ch)$/.test(width) ? width : "800px";
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

/**
 * Mirrors SiYuan's own `mathRender`: both block and inline math carry
 * `data-subtype="math"`, block math is a `DIV`, and `data-content` is
 * HTML-escaped by Lute so it needs unescaping before it reaches KaTeX.
 */
async function renderMath(root: HTMLElement, warnings: string[]): Promise<void> {
    const nodes = [...root.querySelectorAll<HTMLElement>("[data-subtype='math'][data-content]")];
    if (nodes.length === 0) {
        return;
    }

    const katex = await loadGlobalScript<any>("katex", "/stage/protyle/js/katex/katex.min.js");
    if (!katex) {
        warnings.push(`未能加载 KaTeX，${nodes.length} 个公式将以源码形式输出`);
        nodes.forEach((node) => {
            node.textContent = unescapeHtml(node.getAttribute("data-content") ?? "");
        });
        return;
    }

    for (const node of nodes) {
        const latex = unescapeHtml(node.getAttribute("data-content") ?? "");
        const isBlock = node.tagName === "DIV";
        try {
            const html = katex.renderToString(latex, {
                displayMode: isBlock,
                output: "html",
                throwOnError: false,
                trust: true,
            });
            if (isBlock) {
                // SiYuan nests the output one level deeper than the spin frame.
                const frame = mathFrame(node);
                frame.innerHTML = "<span></span>";
                frame.firstElementChild!.innerHTML = html;
            } else {
                node.innerHTML = html;
            }
            node.setAttribute("data-render", "true");
        } catch (error) {
            warnings.push(`公式渲染失败: ${latex} (${String(error)})`);
            node.textContent = latex;
        }
        node.removeAttribute("data-content");
    }
}

/** The container a block formula renders into, created when the export omits it. */
function mathFrame(node: HTMLElement): Element {
    const existing =
        node.querySelector("[spin]") ??
        [...node.children].find((child) => !child.classList.contains("protyle-attr"));
    if (existing) {
        return existing;
    }
    const frame = document.createElement("div");
    node.insertBefore(frame, node.firstChild);
    return frame;
}

/** `data-content` keeps Lute's HTML escaping even after the parser decoded the attribute. */
function unescapeHtml(value: string): string {
    const unescape = (window as any).Lute?.UnEscapeHTMLStr;
    if (typeof unescape === "function") {
        return unescape(value);
    }
    const area = document.createElement("textarea");
    area.innerHTML = value;
    return area.value;
}

// --------------------------------------------------------------------- code

async function highlightCode(root: HTMLElement, warnings: string[]): Promise<void> {
    const blocks = root.querySelectorAll<HTMLElement>(".code-block .hljs, .code-block pre code");
    if (blocks.length === 0) {
        return;
    }

    const hljs = await loadGlobalScript<any>(
        "hljs",
        "/stage/protyle/js/highlight.js/highlight.min.js"
    );
    if (!hljs) {
        warnings.push("未能加载 highlight.js，代码块将不带高亮");
        return;
    }

    blocks.forEach((block) => {
        const language =
            block.closest<HTMLElement>("[data-subtype]")?.getAttribute("data-subtype") ?? "";
        const code = block.textContent ?? "";
        try {
            const result = hljs.getLanguage?.(language)
                ? hljs.highlight(code, { language, ignoreIllegals: true })
                : hljs.highlightAuto(code);
            block.innerHTML = result.value;
            block.classList.add("hljs");
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

const ASSET_ATTRIBUTES = [
    "src",
    "href",
    "poster",
    "data-src",
    "data-image",
    "data-background-image",
    "xlink:href",
];

/**
 * Pulls every `assets/` and `emojis/` file the page references out of the
 * workspace and into the site, rewriting the references to root-absolute paths
 * so they keep resolving from `/<slug>/index.html`.
 */
async function collectReferencedAssets(
    root: HTMLElement,
    files: Map<string, SiteFile>,
    warnings: string[]
): Promise<void> {
    const wanted = new Set<string>();

    [root, ...root.querySelectorAll<HTMLElement>("*")].forEach((element) => {
        for (const name of ASSET_ATTRIBUTES) {
            const value = element.getAttribute(name);
            const sitePath = value ? toWorkspacePath(value) : null;
            if (sitePath) {
                wanted.add(sitePath);
                // The page lives under `/<slug>/`, so SiYuan's workspace-relative
                // `assets/foo.png` has to become root-absolute.
                element.setAttribute(name, encodeURI(sitePath));
            }
        }

        const srcset = element.getAttribute("srcset");
        if (srcset) {
            const rewritten = srcset
                .split(",")
                .map((candidate) => {
                    const [url, descriptor] = candidate.trim().split(/\s+/, 2);
                    const sitePath = toWorkspacePath(url);
                    if (!sitePath) return candidate.trim();
                    wanted.add(sitePath);
                    return `${encodeURI(sitePath)}${descriptor ? ` ${descriptor}` : ""}`;
                })
                .join(", ");
            element.setAttribute("srcset", rewritten);
        }

        const style = element.getAttribute("style");
        if (style) {
            let rewritten = style;
            for (const url of extractCssUrls(style)) {
                const sitePath = toWorkspacePath(url);
                if (sitePath) {
                    wanted.add(sitePath);
                    rewritten = rewritten.split(url).join(encodeURI(sitePath));
                }
            }
            if (rewritten !== style) {
                element.setAttribute("style", rewritten);
            }
        }
    });

    root.querySelectorAll<HTMLStyleElement>("style").forEach((styleElement) => {
        for (const url of extractCssUrls(styleElement.textContent ?? "")) {
            const sitePath = toWorkspacePath(url);
            if (sitePath) wanted.add(sitePath);
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
    return /^\/(assets|emojis|plugins|appearance|stage)\//.test(withoutQuery)
        ? decodeURI(withoutQuery)
        : null;
}

// --------------------------------------------------------------- stylesheets

/**
 * Pulls SiYuan's own stylesheets into the site, keeping their server paths so
 * that relative `url()` references inside them keep resolving.
 */
async function collectStylesheets(
    files: Map<string, SiteFile>,
    warnings: string[]
): Promise<string[]> {
    const appearance = siyuanAppearance();
    const candidates = [
        "/stage/build/export/base.css",
        `/appearance/themes/${appearance.light}/theme.css`,
        "/stage/protyle/js/katex/katex.min.css",
        `/stage/protyle/js/highlight.js/styles/${appearance.codeStyle.light}.min.css`,
        `/stage/protyle/js/highlight.js/styles/${appearance.codeStyle.dark}.min.css`,
        `/appearance/themes/${appearance.dark}/theme.css`,
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
    warnings: string[]
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
    warnings: string[]
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

function siyuanAppearance(): {
    light: string;
    dark: string;
    codeStyle: { light: string; dark: string };
} {
    const appearance = (window as any).siyuan?.config?.appearance ?? {};
    return {
        light: appearance.themeLight || "daylight",
        dark: appearance.themeDark || "midnight",
        codeStyle: {
            light: appearance.codeBlockThemeLight || "github",
            dark: appearance.codeBlockThemeDark || appearance.codeBlockThemeLight || "github",
        },
    };
}

function siyuanThemeMode(): "light" | "dark" {
    const root = document.documentElement;
    const body = document.body;
    if (
        root.getAttribute("data-theme-mode") === "dark" ||
        body?.classList.contains("b3-theme-dark") ||
        body?.classList.contains("theme-dark")
    ) {
        return "dark";
    }
    const appearance = (window as any).siyuan?.config?.appearance ?? {};
    if (!appearance.modeOS) {
        return appearance.mode === 1 || appearance.mode === "1" ? "dark" : "light";
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const siyuanLang = (): string => (window as any).siyuan?.config?.lang?.replace("_", "-") || "zh-CN";

const escapeHtml = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (value: string): string => escapeHtml(value).replace(/"/g, "&quot;");
