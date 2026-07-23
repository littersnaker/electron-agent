# 白雪条：AI 绘图与百炼视觉模式改造说明

## 目标

本次改造在不破坏原有 QA / Code Agent 流程的前提下，新增独立媒体生成链路：

- 文生图
- 上传图片后按自然语言指令改图
- 文生视频
- 图生视频
- 参考图生视频
- 视频编辑
- 生成结果预览与下载
- 图片结果保存到本地会话，重新打开会话仍可查看和下载

普通图片理解仍使用原有视觉聊天模型；真正的图片生成与编辑使用 Qwen-Image 模型。媒体生成没有塞进 `/api/qa` 或 `/api/chat`，避免把异步视频任务和文本 SSE 混在一起。

## 模型与模式

### 图片生成 / 编辑

- `qwen-image-2.0-pro`
- `qwen-image-2.0`
- `qwen-image-edit-max`

### 截图中列出的视觉视频模型

- `wan2.7-t2v-2026-06-12`
- `wan2.7-t2v-2026-04-25`
- `happyhorse-1.1-t2v`
- `wan2.7-i2v-2026-04-25`
- `happyhorse-1.1-r2v`
- `wan2.7-r2v-2026-06-12`
- `happyhorse-1.0-video-edit`

## 关键实现

### 1. 独立媒体模型注册表

文件：`app/lib/media/catalog.ts`

模型 ID、支持模式、输出类型和调用协议都集中登记。新增或下线模型时只需修改注册表，UI 和 Route 不再硬编码模型列表。

### 2. 百炼媒体 Provider

文件：`app/lib/media/dashscope.ts`

- Qwen-Image 使用 multimodal generation 同步接口。
- 图片编辑发送“图片 + 文本编辑指令”。
- 图片 URL 返回后立即由服务端下载并转为 Data URL，因为厂商结果 URL 有有效期。
- 视频模型使用异步任务接口，提交后轮询 `task_id`。
- 图生视频使用 `first_frame`。
- 参考图生视频使用 `reference_image`。
- 视频编辑先将本地视频上传到百炼临时 OSS，再把 `oss://` URL 发送给视频模型。
- 浏览器停止生成时会向上游请求传播 `AbortSignal`。

### 3. 独立 API Route

- `app/api/media/generate/route.ts`：校验 mode、模型、MIME 和文件大小，再调用媒体 Provider。
- `app/api/media/download/route.ts`：为跨域临时视频 URL 提供同源下载，并通过域名白名单限制 SSRF 风险。

### 4. Codex 风格生成 UI

文件：`app/component/ChatComposer.tsx`

输入框上方增加横向视觉模式切换：

- 问答
- 生图
- 改图
- 文生视频
- 图生视频
- 参考生视频
- 视频编辑

选择模式后只展示兼容模型，并自动切换上传文件类型。用户在文生图模式上传图片时自动切换到改图；在文生视频模式上传图片或视频时自动切换到对应模式，避免素材看似上传但实际未参与生成。

### 5. 生成状态与会话持久化

文件：`app/hooks/useMediaGeneration.ts`

媒体生成状态独立于文本 SSE：

- 乐观插入用户消息与空 Assistant 消息
- 显示生成状态
- 支持停止生成
- 成功后一次性写入最终消息，避免乐观写入与最终写入发生覆盖竞争
- 失败时保留明确错误消息

### 6. 预览与下载

文件：`app/component/MessageAttachmentGallery.tsx`

用户上传附件和 AI 生成结果共用一个展示组件：

- 图片：Data URL 预览与直接下载
- 视频：远程 URL 播放，通过同源代理下载
- 文件名、MIME 和下载名随会话保存

### 7. 工作区存储

文件：

- `app/lib/server/workspace-store.ts`
- `app/api/workspace/route.ts`

扩展消息附件结构，保存生成媒体所需的 `dataUrl`、`url`、`assetKind` 和 `downloadName`。没有修改 Session 数据库 schema，旧会话仍可读取。

## 环境变量

参考 `env.example`：

```env
DASHSCOPE_API_KEY=sk-your-dashscope-key
DASHSCOPE_API_BASE=https://dashscope.aliyuncs.com
DASHSCOPE_UPLOAD_API_BASE=https://dashscope.aliyuncs.com
```

生产环境建议将 `DASHSCOPE_API_BASE` 改成百炼控制台显示的业务空间专属 Endpoint。临时文件上传适合开发和低并发，生产环境建议使用自有 OSS。

## 验证结果

已完成：

- 18 个相关 TypeScript / TSX 文件的语法转译检查
- 针对改动文件的严格类型检查
- `noUnusedLocals` / `noUnusedParameters` 检查

未执行完整 `pnpm lint` 与 `pnpm build`：当前沙箱没有项目依赖，且无法联网安装。拿到代码后请执行：

```bash
pnpm install
pnpm lint
pnpm build
```

## 安全说明

交付压缩包不会包含：

- `.env.local`
- `.env.sentry-build-plugin`
- `.agent-data`
- `node_modules`
- `.next`

请勿把真实 API Key 提交到版本库。
