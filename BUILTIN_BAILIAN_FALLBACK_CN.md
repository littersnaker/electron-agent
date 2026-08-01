# Python 内置百炼兜底说明

## 1. 当前行为

打包 Python 后端前，`scripts/embed_builtin_credentials.py` 会读取项目根目录的
`.env.local`，并且只提取以下白名单变量：

- `DASHSCOPE_API_KEY`
- `DASHSCOPE_BASE_URL`

生成结果写入：

```text
backend/core/_builtin_credentials_generated.py
```

随后 PyInstaller 会把该模块一起打入 `multi-agent-backend` 可执行文件。因此最终用户
不需要创建 `.env.local`，也不需要在设置页填写 Key，就能使用百炼文本模型以及百炼
图片/视频接口。

## 2. 凭证优先级

后端严格按照下面的顺序选择百炼 Key：

1. 用户在应用设置页填写并保存的 Key；
2. 启动 Python 后端时提供的 `DASHSCOPE_API_KEY` 环境变量；
3. 打包阶段嵌入 Python 的百炼共享兜底 Key。

用户输入为空时才会使用内置兜底。用户输入了无效 Key 时，系统会明确返回鉴权错误，
不会静默切换到共享 Key，以免隐藏配置问题或意外消耗共享额度。

## 3. 构建命令

先确认 `.env.local` 中存在有效的 `DASHSCOPE_API_KEY`，再执行：

```bash
pnpm credentials:embed
pnpm backend:build
```

正常执行 `pnpm electron:make` 或对应平台命令时，也会自动完成嵌入，不需要单独运行
`credentials:embed`。

发布前建议强制要求 Key 存在：

```powershell
# Windows PowerShell
$env:REQUIRE_BUILTIN_QWEN_KEY = "1"
pnpm electron:make:win
```

```bash
# macOS / Linux
REQUIRE_BUILTIN_QWEN_KEY=1 pnpm electron:make
```

## 4. 轮换共享 Key

1. 在百炼控制台创建新 Key；
2. 更新构建机的 `.env.local`；
3. 重新执行安装包构建；
4. 发布新安装包；
5. 确认用户升级后，再停用旧 Key。

已经发布出去的旧安装包不会自动获得新 Key，除非另行实现服务端 Token 代理。

## 5. 安全边界

生成模块使用压缩、混淆和完整性校验，避免明文 Key 出现在前端包、日志及普通文本
搜索结果中。但是桌面安装包由用户完全控制，具备逆向能力的用户仍可能提取共享 Key。
这属于所有“把统一供应商 Key 放进客户端”的固有限制。

生产环境更安全的方案是部署自有服务端代理：桌面端只登录你的业务账号，服务端保管
百炼 Key、限制每个用户额度、记录滥用并随时吊销访问。当前实现适合内部使用、小范围
交付或能够接受共享 Key 风险的场景。

## 6. 交付文件说明

完整交付包不包含 `.env.local` 明文文件，但包含已经生成的 Python 内置凭证模块。
该生成文件被 `.gitignore` 忽略，避免开发者误提交到公共仓库。
