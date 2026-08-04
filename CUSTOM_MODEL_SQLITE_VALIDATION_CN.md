# 自定义模型与 Base URL 修复验证报告

## 验证结论

- 普通聊天模型选择器只固定显示 Auto，用户模型从 SQLite 动态追加。
- `config/chat-models.json` 与基线版本 SHA-256 完全一致，已有 `model` 值未修改。
- 新增模型写入 `custom_models` 表后可立即调用。
- 清空 Python 内存缓存并重新进入应用生命周期后，自定义模型可从 SQLite 恢复。
- 自定义模型手动选择时只调用该模型，不会偷换为其他供应商。
- 勾选“允许 Auto 自动尝试”后，自定义模型会按照 `autoPriority` 参与 Auto。
- 设置页 `Qwen / DashScope Base URL` 会随 `/api/media/generate` 请求传给 Python。
- 百炼聊天地址、完整图片地址、完整视频地址均可规范化成同一业务空间根域名。
- Python 测试共 18 项，全部通过。
- 211 个受规范脚本管理的源码和文档文件均不超过 500 行。
- 全部 Python 函数和方法均包含 docstring。
- 113 个 TypeScript/TSX 文件完成语法转译检查，无诊断错误。
- 相对导入路径检查通过。
- `git diff --check` 通过。

## 未执行项目

当前环境没有 `node_modules`，Corepack 也无法连接 npm Registry 下载 pnpm，因而无法
执行正式的 `pnpm typecheck`、`pnpm electron:typecheck`、`pnpm build` 和项目 ESLint。
代码已按项目现有 TypeScript/React 风格整理，并通过语法、导入及源码规范检查。

在有网络的本机解压后运行：

```bash
corepack enable
pnpm install
pnpm verify
```
