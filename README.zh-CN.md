# 纸鸢 PaperKite

把当前打开的思源文档放飞成一张独立的静态网页，托管到你已经创建好的项目（Cloudflare Pages 或 Vercel）上，线还牵在你手里。


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

**链接的稳定性**：生产部署（Cloudflare 生产分支 / Vercel 的 production 目标）返回项目固定域名（Cloudflare 为 `<项目名>.pages.dev`；Vercel 为项目分配的 `<名称>.vercel.app` 域名），重复发布只更新内容，链接保持不变。预览部署（非生产分支 / preview 目标）平台每次都会生成新的部署链接。

### 发布记录与重复发布

每次发布都会在插件数据里留下一条记录（发布渠道、文档名与文档 ID、发布链接、发布时间和更新时间）。再次发布同一篇文档时：

- **页面没有变化**（构建产物与上次发布的指纹一致）：不再重复上传，提示已有发布记录并直接复制现有链接；
- **页面有变化**：自动重新部署并更新记录（发布时间保留，更新时间刷新）。

记录按「渠道 + 文档」区分，同一篇文档发布到 Cloudflare Pages 和 Vercel 会各自独立跟踪。

### 管理已发布页面

顶栏图标 → 「管理已发布页面」，或插件设置 → 「已发布页面」→「管理已发布页面」。列表中每条记录可以：

- **复制链接**：发布链接写入剪贴板（悬停按钮可查看完整链接）；
- **复制ID**：复制文档 ID（悬停按钮可查看完整 ID）；
- **删除**发布：先确认，随后删除远端部署并移除本地记录。渠道凭证缺失时无法删除远端部署，可选择仅清除本地记录。需要强制重新发布无变化的页面时，也可先删除记录再发布。

记录保存在 `data/storage/petal/siyuan-upload-pages/publish-records.json`。

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
- Vercel 没有批量上传接口，是每个文件一个请求（并发 6），文件多时请求次数仍比 Cloudflare 的批量上传多。

- Token 保存在本工作空间的插件数据文件（`data/storage/petal/siyuan-upload-pages/publish-config.json`）中，请勿分享该文件。

