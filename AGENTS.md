# AGENTS.md

## What this is

PaperKite (`siyuan-upload-pages`) — a SiYuan plugin that publishes the currently open document as a self-contained static page to Cloudflare Pages or Vercel. TypeScript + Svelte 5, built with Vite as a CommonJS library, package manager is **pnpm**, Node >= 24. Full design doc: `docs/siyuan-vercel-cloudflare-publisher-design.md`.

## Commands

```bash
pnpm install
pnpm run dev     # watch build → dev/ (pairs with make-link to load in a running SiYuan)
pnpm run build   # production build → dist/ + package.zip
pnpm run check   # tsc --noEmit (both tsconfigs) + svelte-check — this is the only "test"/lint gate
```

There are no unit tests; `pnpm run check` must pass before a change counts as done.

## Layout

- `src/index.ts` — plugin entry (`PublishPlugin`): commands, top-bar menu, settings, publish flow, records UI.
- `src/publish/` — the core:
  - `site-builder.ts` — content pipeline only: produces `SiteFile[]` (pure content, no upload logic).
  - `provider.ts` — dispatch interface (`PublishTarget`); `cloudflare-pages.ts` / `vercel.ts` implement it. **Adding a platform means adding a module here; never touch the content pipeline for that.**
  - `storage.ts` — persistence primitive; `records.ts` / `template-options.ts` build on it.
- `src/libs/` — reusable Svelte components and dialogs; `src/api.ts` — SiYuan kernel HTTP API calls.
- `public/i18n/{en,zh-CN}.json` — user-facing strings; access via `this.i18n.*` (`yaml-plugin.js` can compile YAML i18n to JSON at build time).
- `dev/` — dev-mode build output (loaded into SiYuan via `scripts/make_dev_link.js`); `dist/` — production output. Neither is hand-edited.
- Path alias: `@` → `src/`.

## Rules that matter

- **All outbound HTTP goes through the SiYuan kernel's `/api/network/forwardProxy`.** Direct `fetch` to api.cloudflare.com etc. fails CORS preflight (no `OPTIONS` answer). Follow the existing pattern in `src/api.ts` / `src/publish/*`.
- **The published page must contain no JavaScript.** Math (KaTeX) and code highlighting are rendered at publish time in `site-builder.ts`.
- **Storage safety (`src/publish/storage.ts`):** SiYuan's `loadData` resolves (not rejects) on failure and ambiguous results look like "no data". Every store classifies its load into `loaded` / `empty` / `unreadable`; `unreadable` **freezes the file — never write over it**. Every user-facing entry point must `await this.dataReady()` (see `src/index.ts`) before doing anything that could save.
- **Never leak API tokens** into messages, console output, or error details.
- Published pages of one deployment share a manifest (`SiteManifest`); a deploy always carries the previous manifest forward, and deleting a publish redeployes the kept files — never delete the deployment itself.
- A document's slug is fixed at first publish (link stability); don't regenerate it.
- Supports desktop and mobile frontends (`getFrontend()` / `isMobile`); keep UI usable on mobile (e.g. `menu.fullscreen()`).
- Run `pnpm run update-version` / `make-install` scripts only when the user asks for a release.
