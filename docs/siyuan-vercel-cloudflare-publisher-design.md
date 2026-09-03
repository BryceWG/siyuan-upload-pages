# 思源笔记发布到 Vercel / Cloudflare Pages：插件开发资料与实现方案

本文面向第一次开发思源插件的开发者，目标是：在思源中选择文档，生成适合公开访问的静态网页，并发布到已经创建好的 Vercel 项目或 Cloudflare Pages 项目。

## 1. 可行性判断

这个想法可以完整实现，但“登录好的 Vercel/Cloudflare 页面”不能直接被插件复用为 API 登录态。自动部署需要用户在插件设置中提供一种授权：Vercel Access Token、Vercel Deploy Hook、Cloudflare API Token 或 Cloudflare Pages Deploy Hook。

推荐先做“静态站点生成 + 直接上传”版本，后续再增加 GitHub 集成。插件首次设置时显示配置向导，比尝试读取浏览器 Cookie 更安全，也更可靠。

## 2. 思源插件开发起点

使用官方的 `plugin-sample-vite-svelte` 模板。官方模板给出了生命周期、设置面板、数据存储、前端到内核的调用和 Kernel Plugin 示例；当前模板要求 Node.js 24+、pnpm 11.4 左右。普通插件包至少需要 `plugin.json`、`index.js`、`index.css`、`i18n/*` 和 README；若使用 Kernel Plugin，还会有 `kernel.js`。

建议的初始目录：

```text
src/
  index.ts                 # 插件入口、菜单、命令
  settings.ts              # 设置界面
  publish/
    content.ts             # 读取思源文档并转换为中间格式
    renderer.ts            # 生成网页文件
    manifest.ts            # 文档 ID、slug、哈希和发布时间映射
    providers/
      vercel.ts
      cloudflare-pages.ts
  ui/PublishDialog.svelte
public/i18n/zh-CN.yaml
```

先掌握这些 API：`onload`、`onLayoutReady`、`addTopBar`、`addToolbarItem`、`fetchSyncPost`、`loadData`、`saveData`、`getSecret`、`getVariable`。令牌优先放在 Secret 中。

官方开发指南明确要求：插件不要直接用 Node/Electron 的 `fs` 读写 `data` 目录，应使用思源内核文件 API，以免破坏同步和数据一致性。因此发布缓存、状态文件和资源读取都应经过内核 API，或只使用插件自己的存储目录。

## 3. 内容处理路线

### 路线 A：调用思源原生 HTML 导出

思源内核目前注册了 `/api/export/exportHTML`、`/api/export/exportPreviewHTML`、`/api/export/exportMdHTML` 等接口；这些接口需要鉴权和管理员权限。思源本身支持导出 HTML，适合用来参考其公式、代码块、表格和嵌入块处理方式。

原生导出结果通常包含思源主题 CSS、内部 class、块 ID、资源路径和面向本地工作区的链接。直接上传到网站容易出现 CSS 路径失效、本地 `/assets` 图片失效、`siyuan://` 链接失效，以及编辑器布局混入网页等问题。原生 HTML 更适合作为解析参考或高级兼容模式，不建议原样作为最终页面。

### 路线 B：Markdown 转 HTML

通过 `/api/export/exportMdContent` 获取文档 Markdown，再使用 `markdown-it` 或 `unified/remark/rehype` 生成 HTML。输出结构干净、样式完全由网站模板控制；缺点是要自己处理思源特有语法，例如块引用、嵌入块、属性视图、公式和自定义块。

### 路线 C：推荐的混合方案

1. 用思源接口取得文档标题、属性和块 DOM。
2. 对正文优先调用 `/api/block/getBlockDOMWithEmbed`，保留公式、代码、表格和常见富文本效果。
3. 将返回 DOM 解析为中间结构，删除编辑器专用属性和不需要的交互节点。
4. 将思源资源复制到站点的 `assets/`，改写 `<img>`、背景图和附件链接。
5. 用自己的 HTML 模板包裹正文，只保留白名单 CSS 类。
6. 对块引用做降级处理：能映射到已发布文档的链接就转换为站内链接，无法映射的引用显示为普通文本。

这样既能利用思源已有渲染能力，也不会把思源编辑器页面原样暴露到公网。

## 4. 网站文件结构

每次发布都生成一个完整、可覆盖的静态站点：

```text
site/
  index.html
  404.html
  posts/example-note/index.html
  assets/image-abc.webp
  static/style.css
  static/app.js
  manifest.json
  robots.txt
  sitemap.xml
```

`manifest.json` 保存文档 ID、标题、slug、路径、更新时间、标签和内容哈希。slug 优先读取文档属性 `custom-publish-slug`；没有时由标题生成 URL-safe slug，冲突时追加文档 ID 短串。不要直接把标题作为唯一键，否则改标题会导致旧页面无法清理。

## 5. 元数据设计

文档属性建议使用：

- `custom-publish=true`：纳入发布集合；
- `custom-publish-slug`：固定 URL；
- `custom-publish-summary`：摘要；
- `custom-publish-cover`：封面资源；
- `custom-published-at`：首次发布时间；更新时保留；
- `custom-publish-tags`：覆盖或补充标签。

站点设置包括作者姓名、头像 URL、个人主页 URL、站点名称、副标题、站点 URL、默认语言、时区、版权年份、默认分享图，以及 RSS、sitemap、robots.txt 开关。作者信息属于普通变量，API Token 属于 Secret。

每篇文章输出 `<title>`、description、author、发布时间、更新时间、Open Graph/Twitter Card，以及 JSON-LD `Article` 或 `BlogPosting`。

## 6. Vercel 方案

### 6.1 直接部署 API

Vercel REST API 使用 `Authorization: Bearer <TOKEN>` 认证；非 Git 部署流程是：为每个文件计算 SHA、上传文件，再创建部署并引用这些文件。当前创建部署接口为 `POST https://api.vercel.com/v13/deployments`，上传文件接口为 `POST https://api.vercel.com/v2/files`。部署状态最后会变为 `READY` 或 `ERROR`。

插件配置：`vercelToken`（Secret）、`vercelProjectIdOrName`、`vercelTeamId`（团队项目才需要）、`vercelTarget`（preview/production）、`siteBaseUrl`。

如果项目已经由 Git 连接并配置了构建流程，优先使用 Git/Deploy Hook 路线，不要同时使用直接上传，以免两个来源相互覆盖。

### 6.2 Deploy Hook

Vercel Deploy Hook 是与项目绑定的 URL，请求它可以触发部署，但前提是项目已有连接的 Git 仓库。插件仍需把生成的内容提交到 Git 仓库；Hook 本身不能上传文章文件。

### 6.3 `vercel.json`

纯静态站点通常不需要 `vercel.json`。只有在需要重写、缓存响应头、trailing slash 策略或 Vercel Functions 时再加入。

## 7. Cloudflare Pages 方案

### 7.1 Direct Upload

Cloudflare Pages 支持 Direct Upload，把已经构建好的静态文件上传到 Pages。官方文档建议：如果要从自己的构建流程或本地电脑上传，选择 Direct Upload；该项目创建后不能再切换为 Git integration，因此创建项目时要先决定部署模式。

插件配置：`cloudflareApiToken`（Secret）、`cloudflareAccountId`、`pagesProjectName`、`pagesBranch`、`siteBaseUrl`。发布使用的 Token 至少需要 Pages Write 权限。

API 基本地址为：

`https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/deployments`

Direct Upload 的 multipart/哈希格式应以当前 Pages API 文档或 Wrangler 版本为准，上传逻辑要封装在独立 provider 中。

### 7.2 Deploy Hook / Git integration

Cloudflare Pages Deploy Hook 与项目绑定，不需要额外认证，因此必须像密码一样保管；它只能触发已有构建流程，不能替代内容上传。Git integration 适合“插件更新 Git 仓库，Pages 自动构建”的方案。

## 8. 推荐的 MVP

第一版只实现：设置站点和作者信息；设置一个 Vercel 或 Cloudflare Pages 项目；用 `custom-publish=true` 标记文档；发布当前文档和发布全部文档；生成首页、文章页、CSS、资源、manifest 和 sitemap；显示生产 URL、部署 ID 和错误信息；发布前显示文章数、资源数和总大小。

暂时不做评论、全文搜索、登录、动态数据库、在线编辑、块级双向链接同步，以及每次修改自动发布。

## 9. 发布流程

```ts
async function publishAll() {
  const docs = await queryDocsByAttribute("custom-publish", "true");
  const site = await buildSite(docs, await loadSiteConfig());
  await validateSite(site);
  const provider = createProvider(await loadProviderConfig());
  const result = await provider.deploy(site.files, { target: "production" });
  await savePublishState({ deploymentId: result.id, url: result.url, posts: site.manifest.posts });
}
```

Provider 接口只保留 `testConnection()`、`deploy(files, options)` 和可选的 `getStatus(deploymentId)`。以后增加 GitHub、Netlify、S3 或自建服务器时，不需要改动内容生成部分。

## 10. 安全与可靠性

- API Token 只放 Secret，不写入 manifest、日志、错误弹窗或网页。
- 使用最小权限 Token；Deploy Hook URL 也应当视为密码。
- 发布前清理 HTML，过滤脚本、事件属性、危险 URL、意外 iframe 和 `../` 路径。
- 每次发布生成新部署；确认成功后再记录为当前版本，失败时保留旧站点。
- 对发布按钮加互斥锁，避免连续点击产生多个部署。
- 先预览构建并检查链接、图片和页面数量，再上传。
- 保存每篇文档的内容哈希，未变化的文档可以复用生成文件。

## 11. 开发顺序

1. 用官方模板跑通空插件和设置面板。
2. 读取当前文档 ID、标题和属性。
3. 调用思源接口读取正文，保存调试 HTML。
4. 完成单篇文章和资源路径改写。
5. 完成多篇文章、首页和 manifest。
6. 先实现 Vercel 或 Cloudflare 的一个 provider。
7. 加入部署状态轮询和错误展示。
8. 再实现第二个 provider。
9. 最后考虑 GitHub + Deploy Hook、自动发布和 marketplace 发布。

## 12. 选择建议

想尽快做出能用版本：Vite/Svelte + 混合内容处理 + Cloudflare Pages Direct Upload。想要版本历史、回滚和多人协作：Vite/Svelte + Markdown/中间格式 + GitHub Contents API + Vercel/Cloudflare Git integration。两者都不依赖读取浏览器登录 Cookie。

## 官方资料

- [SiYuan plugin-sample](https://github.com/siyuan-note/plugin-sample)
- [SiYuan plugin-sample-vite-svelte](https://github.com/siyuan-note/plugin-sample-vite-svelte)
- [SiYuan Plugin API 类型声明](https://github.com/siyuan-note/petal/blob/main/siyuan.d.ts)
- [SiYuan Kernel API 路由（含导出接口）](https://github.com/siyuan-note/siyuan/blob/master/kernel/api/router.go)
- [Vercel REST API 基础与认证](https://vercel.com/docs/rest-api)
- [Vercel 创建部署](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
- [Vercel 部署流程](https://vercel.com/docs/deployments)
- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Pages REST API](https://developers.cloudflare.com/pages/configuration/api/)
- [Cloudflare Pages Deploy Hooks](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)
