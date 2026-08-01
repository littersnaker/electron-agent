# 交付前验证报告

验证日期：2026-08-01

## 本次改动

- Model Router 修复与供应商真实降级；
- Kimi、千问模型 ID 和区域端点兼容；
- Electron 固定数据目录与凭证持久化；
- 构建时从 `.env.local` 白名单提取百炼配置；
- 将百炼共享兜底嵌入 Python 后端生成模块；
- 用户 Key、环境变量、内置兜底的优先级隔离；
- 百炼文本、图片和视频接口统一使用同一套凭证解析；
- 设置页明确提示百炼留空时使用内置兜底；
- Auto Router 区分模型级失败与供应商端点级失败；
- 百炼业务空间 API Base URL 可在设置页保存并覆盖公共地址；
- 最近成功模型会进入短期可用性缓存并在后续 Auto 请求中优先。

## 已通过

- Python `compileall` 语法检查；
- FastAPI Pytest 冒烟测试：15 项全部通过；
- 103 个 TypeScript/TSX 业务文件语法转换检查，0 个语法错误；
- 189 个源码与 Markdown 文件规范检查，全部不超过 500 行；
- Python AST 注释检查，所有函数和方法都有 docstring；
- 内置百炼凭证可正确解码，且与构建源值一致；
- 内置配置只包含 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL` 白名单；
- 除 `.env.local` 外的项目文件中没有出现百炼 Key 明文；
- 用户百炼 Key 优先于 Python 内置兜底；
- 用户未配置百炼 Key 时，Auto Router 能识别内置 Qwen 凭证；
- 百炼媒体生成接口同样能够读取内置兜底。

## 当前环境无法完成的检查

当前执行环境没有项目 `node_modules`、pnpm、ESLint 和 PyInstaller，因此无法在这里执行真实的：

```bash
pnpm install
pnpm typecheck
pnpm electron:typecheck
pnpm build
pnpm electron:make
```

新增 TypeScript/TSX 已按项目现有严格 TypeScript/ESLint 风格编写，并通过 TypeScript
语法转换检查。请在可联网开发机安装锁定依赖后执行：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm verify
$env:REQUIRE_BUILTIN_QWEN_KEY = "1"
pnpm electron:make:win
```

## 手动验收建议

1. 不在设置页填写任何模型 Key，启动应用并使用默认 Qwen 发送消息；
2. 点击 Qwen 行“验证”，确认提示正在使用应用内置百炼兜底；
3. 测试一项百炼图片或视频生成，确认不再提示未配置 Key；
4. 在设置页填写个人百炼 Key，再次验证，确认不再显示“内置兜底”；
5. 完全退出应用后重新打开，确认用户 Key 和模型选择仍然保留；
6. 删除个人百炼 Key，确认应用重新使用内置兜底；
7. 使用无效个人 Key 验证，确认明确报鉴权错误，而不是静默切换共享 Key；
8. 百炼 Max 返回模型级 404 时，确认 Router 会继续尝试 Plus/Flash；
9. 将百炼 Base URL 改为不可达地址，确认只报告一次百炼端点错误，不再重复等待 Plus/Flash；
10. 执行正式安装包构建并在无 `.env.local` 的干净电脑上安装测试。
