# Publish to Cloudflare Pages

Publishes the currently open SiYuan document as a static page to an existing Cloudflare Pages project.

## How it works

1. `/api/export/exportPreviewHTML` provides the document HTML — the same rendering SiYuan uses for its own HTML export.
2. The stylesheets of the active theme are read from the kernel (same origin): `stage/build/export/base.css`, `appearance/themes/<theme>/theme.css`, the KaTeX stylesheet and the code highlight theme, together with the fonts they reference. The published page therefore keeps your current theme.
3. Math and code highlighting are rendered **at publish time** with SiYuan's bundled KaTeX / highlight.js, so the uploaded page contains no JavaScript.
4. Referenced `assets/` and `emojis/` files are uploaded under their original paths.
5. Upload happens through Cloudflare Pages Direct Upload. The resulting site is a single `index.html` plus static files.

Every Cloudflare request is forwarded by the kernel through `/api/network/forwardProxy`: `api.cloudflare.com` does not answer `OPTIONS`, so a frontend request carrying an `Authorization` header always fails its CORS preflight.

## Setup

1. Create a Pages project in the Cloudflare dashboard and choose **Direct Upload**. Git-integrated projects cannot be used here, and the project type cannot be changed after creation.
2. Create an API Token with `Account` → `Cloudflare Pages` → `Edit`.
3. Fill in the Account ID, project name and API Token in the plugin settings, then press "Test".

## Usage

- Top bar icon → "Publish current document to Cloudflare Pages"
- Or the command with the same name in the command palette

The deployment URL is copied to the clipboard when the publish succeeds.

## Limitations

- Only the current document is published; the site is a single `index.html`.
- Block references cannot resolve on a single-page site and degrade to plain text.
- Diagrams that need runtime rendering (Mermaid, ECharts, flowcharts) are not processed and fall back to their source text.
- The API Token is stored with the plugin data in this workspace (`data/storage/petal/siyuan-upload-pages/publish-config.json`). Do not share that file.
