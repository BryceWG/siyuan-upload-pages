# 发布到 Cloudflare Pages

把当前打开的思源文档发布成一个静态页面，上传到你已经创建好的 Cloudflare Pages 项目。

[English](./README.md)

## 工作方式

1. 调用思源自己的 `/api/export/exportPreviewHTML` 拿到文档 HTML（和思源「导出 HTML」同一套渲染结果）。
2. 同源读取当前主题的样式：`stage/build/export/base.css`、`appearance/themes/<主题>/theme.css`、KaTeX 与代码高亮样式，连同它们引用的字体一起打包进站点，因此页面保持你当前的主题外观。
3. 公式和代码高亮在**发布时**用思源自带的 KaTeX / highlight.js 渲染完成，产出的页面不含任何 JavaScript。
4. 正文里引用的 `assets/`、`emojis/` 资源一并上传，路径保持不变。
5. 通过 Cloudflare Pages Direct Upload 上传，站点结构就是一个 `index.html` 加静态资源。

所有 Cloudflare 请求都经由思源内核的 `/api/network/forwardProxy` 转发——`api.cloudflare.com` 不响应 `OPTIONS`，浏览器端带 `Authorization` 头的请求会在 CORS 预检阶段失败。

## 准备工作

1. 在 Cloudflare 控制台创建一个 Pages 项目，创建时选择 **Direct Upload（上传资产）**。Git 集成类型的项目无法用本插件上传，且项目类型创建后不可更改。
2. 创建 API Token：权限选 `Account` → `Cloudflare Pages` → `Edit`。
3. 在插件设置里填入 Account ID、项目名、API Token，点「测试」确认连通。

## 使用

- 顶栏图标 → 「发布当前文档到 Cloudflare Pages」
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
- API Token 保存在本工作空间的插件数据文件（`data/storage/petal/siyuan-upload-pages/publish-config.json`）中，请勿分享该文件。
