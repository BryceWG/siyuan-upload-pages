# 发布到 Cloudflare Pages / Vercel

把当前打开的思源文档发布成一个静态页面，上传到你已经创建好的 Cloudflare Pages 或 Vercel 项目。

[English](./README.md)

## 工作方式

1. 调用思源自己的 `/api/export/exportPreviewHTML` 拿到文档 HTML（和思源「导出 HTML」同一套渲染结果）。
2. 同源读取当前主题的样式：`stage/build/export/base.css`、`appearance/themes/<主题>/theme.css`、KaTeX 与代码高亮样式，连同它们引用的字体一起打包进站点，因此页面保持你当前的主题外观。
3. 公式和代码高亮在**发布时**用思源自带的 KaTeX / highlight.js 渲染完成，产出的页面不含任何 JavaScript。
4. 正文里引用的 `assets/`、`emojis/` 资源一并上传，路径保持不变。
5. 交给所选平台上传，站点结构就是一个 `index.html` 加静态资源。

所有对外请求都经由思源内核的 `/api/network/forwardProxy` 转发——`api.cloudflare.com` 不响应 `OPTIONS`，浏览器端带 `Authorization` 头的请求会在 CORS 预检阶段失败。

内容生成和上传是分开的：`src/publish/site-builder.ts` 只产出 `SiteFile[]`，`src/publish/provider.ts` 负责分发给具体平台。新增一个平台不需要改内容部分。

## 准备工作：Cloudflare Pages

1. 创建一个 Pages 项目，类型必须是 **Direct Upload（上传资产）**。Git 集成类型的项目无法用本插件上传，且项目类型创建后不可更改。用 API 建最省事：

   ```powershell
   $body = @{ name = "siyuan-notes"; production_branch = "main" } | ConvertTo-Json
   Invoke-RestMethod -Method Post `
     -Uri "https://api.cloudflare.com/client/v4/accounts/$account/pages/projects" `
     -Headers @{ Authorization = "Bearer $token" } `
     -ContentType "application/json" -Body $body
   ```

2. API Token 权限选 `Account` → `Cloudflare Pages` → `Edit`。
3. 插件设置里「发布目标」选 Cloudflare Pages，填 Account ID、项目名、Token、分支。

上传走 Direct Upload：`upload-token` → `check-missing` → `upload` → `upsert-hashes` → `deployments`。资源键是 `blake3(base64(内容) + 扩展名)` 取前 32 位十六进制。

## 准备工作：Vercel

1. 创建一个 Vercel 项目，**不要**连接 Git 仓库（连了也能用，但两个来源会互相覆盖）。
2. 在账户设置 → Tokens 创建 Access Token，Scope 选项目所属的账户或团队。
3. 插件设置里「发布目标」选 Vercel，填 Token、项目名；团队项目还要填 Team ID。

上传走非 Git 部署流程：先逐个 `POST /v2/files`（`x-vercel-digest` 是文件内容的 sha1），再 `POST /v13/deployments` 用 sha 引用这些文件。`projectSettings.framework` 传 `null`，Vercel 不会跑构建，直接按原样托管。

## 使用

- 顶栏图标 → 「发布当前文档」
- 或使用命令面板中的同名命令

发布成功后部署链接会自动复制到剪贴板。

## 开发

```bash
pnpm install
pnpm run dev          # 输出到 dev/，配合 make-link 使用
pnpm run build        # 输出到 dist/ 并打包 package.zip
pnpm run check        # tsc + svelte-check
```

## 已知限制

- 只发布当前一篇文档，整站只有一个 `index.html`。
- 块引用无法在单页站点中跳转，会降级为纯文本。
- Mermaid、ECharts、流程图等需要运行时渲染的图表暂不处理，会退化为源码文本。
- Vercel 是逐文件上传的，文件多时请求次数会比 Cloudflare（批量上传）多。
- Token 保存在本工作空间的插件数据文件（`data/storage/petal/siyuan-upload-pages/publish-config.json`）中，请勿分享该文件。

