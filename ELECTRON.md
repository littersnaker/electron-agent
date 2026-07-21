# Electron 桌面客户端

本项目已支持打包为 Electron 桌面客户端。Electron 主进程会启动 Next.js standalone 服务器（包含所有 API 路由和 LangGraph Agent），并在 BrowserWindow 中加载页面。

## 目录结构

```
Agent Workspace/
├── electron/
│   ├── main.ts        # Electron 主进程（启动 Next.js、创建窗口、自动更新）
│   └── preload.ts     # 预加载脚本（通过 contextBridge 暴露安全 API）
├── scripts/
│   ├── compile-electron.ts   # 用 esbuild 把 electron/*.ts 编译到 .electron/*.js
│   └── build-electron.ts     # 完整打包流程（编译 → next build → electron-builder 打包）
├── electron-builder.yml  # electron-builder 打包配置（NSIS 安装包）
├── .electron/         # 编译输出（git ignored）
└── public/icon.png    # 应用图标
```

## 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm electron:dev` | 开发模式：编译 Electron 代码 → 启动 Electron → 自动运行 `next dev` → 打开窗口（带 DevTools） |
| `pnpm electron:compile` | 仅编译 `electron/*.ts` 到 `.electron/*.js` |
| `pnpm electron:build` | 完整打包：编译 + `next build` + 复制静态资源 + electron-builder 绿色版 |
| `pnpm electron:package` | 仅生成绿色版目录（不打包安装包） |
| `pnpm electron:make` | 生成 Windows NSIS 安装包（.exe） |

## 开发流程

```bash
# 1. 启动 Electron 开发模式（会自动启动 Next.js dev server）
pnpm electron:dev
```

开发模式下：
- Next.js 运行在 `http://localhost:3000`
- Electron 窗口自动加载该地址并打开 DevTools
- 修改 React 页面会触发 Next.js 热更新
- 修改 `electron/*.ts` 需要重新运行 `pnpm electron:dev`

## 打包流程

```bash
# 一键打包（生成绿色运行目录到 out/MyApp-win32-x64）
pnpm electron:build

# 生成 NSIS 安装包（.exe，类似豆包安装向导）
pnpm electron:make
```

打包产物位于 `out/` 目录：
- 绿色版：`out/MyApp-win32-x64/MyApp.exe`
- 安装包：`out/MyApp Setup 1.0.0.exe`

## 架构说明

```
┌─────────────────────────────────────────────┐
│              Electron 主进程                │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │   子进程: Next.js standalone server  │   │
│  │   - /api/chat (LangGraph Agent)     │   │
│  │   - /api/geminiChat                 │   │
│  │   - /api/agent                      │   │
│  │   - 页面路由 (/, /apitest, ...)      │   │
│  └─────────────────────────────────────┘   │
│                    │                        │
│                    ▼ localhost:3000         │
│  ┌─────────────────────────────────────┐   │
│  │       BrowserWindow (Chromium)       │   │
│  │       渲染 React 页面 + 客户端逻辑    │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

- **API 路由 / LangGraph Agent**：作为 Next.js 服务器的一部分在 Electron 内部运行，无需外部服务
- **环境变量**：构建时从 `.env.local` 读取并打包进客户端（`DASHSCOPE_API_KEY` 等）
- **自动更新**：生产模式下通过 `electron-updater` 每小时检查一次更新（需配置发布源）

## 环境变量

Electron 客户端复用项目根目录的 `.env.local`，以下变量会被打包：

| 变量 | 用途 |
|------|------|
| `DASHSCOPE_API_KEY` | Qwen / 通义千问 API（Agent 核心依赖） |
| `GEMINI_API_KEY` | Google Gemini API（服务端） |
| `NEXT_PUBLIC_GEMINI_API_KEY` | Gemini API（客户端直连） |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry 错误监控 |

## 注意事项

1. **生产构建禁用 Vercel 监控**：`next.config.ts` 在 `IS_ELECTRON_BUILD=true` 时会关闭 `automaticVercelMonitors`
2. **Sentry Edge 配置不生效**：Electron 中只会加载 `sentry.server.config`（Node.js runtime），edge runtime 不可用
3. **内存状态**：LangGraph 的 `MemorySaver` 仍是内存存储，关闭应用后丢失
4. **图标**：替换 `public/icon.png` 可自定义应用图标（建议 512×512 PNG；Windows 打包需额外提供 `.ico`）
5. **NSIS 安装包**：使用 electron-builder + NSIS 生成安装包，支持中文界面、自定义安装目录、桌面快捷方式
6. **国内镜像加速**：`.npmrc` 已配置 npmmirror 镜像，解决 electron-builder 下载慢的问题

## 自动更新配置

当前已集成 `electron-updater`。要启用自动更新，需在打包后发布 `latest.yml` 和安装包到一个可访问的地址（如 GitHub Releases），并在 `electron/main.ts` 的 `setupAutoUpdater` 中配置发布源（默认已读取 `electron-updater` 的内置配置）。
