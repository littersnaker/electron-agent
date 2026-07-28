# Electron 桌面客户端

Multi-agent 使用 Electron 主进程启动内嵌的 Next.js standalone 服务，并在 BrowserWindow 中加载本地页面。

## 目录结构

```text
Multi-agent/
├── electron/                  # 主进程与 preload
├── scripts/
│   ├── compile-electron.ts    # 编译到 .electron/
│   ├── build-electron.ts      # 准备 standalone 运行时
│   └── clean-release.ts       # 清理生产产物
├── electron-builder.yml      # electron-builder 配置
├── .electron/                # 临时编译产物（忽略提交）
├── out-server/               # 临时 standalone 资源（忽略提交）
└── release/                  # 最终生产产物（忽略提交）
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm electron:dev` | 编译 Electron 并启动开发客户端 |
| `pnpm electron:compile` | 只编译主进程与 preload |
| `pnpm electron:pack` | 生成当前平台的未打包应用目录，用于冒烟测试 |
| `pnpm electron:make` | 生成当前平台安装包 |
| `pnpm electron:make:win` | 生成 Windows x64 NSIS 安装包 |
| `pnpm electron:make:mac` | 生成 macOS 安装包 |
| `pnpm electron:make:linux` | 生成 Linux x64 AppImage 与 deb |
| `./build-windows-installer.ps1` | 在 Windows 上校验 NSIS 品牌资源并生成规范命名的安装包 |
| `pnpm verify` | 执行 ESLint、Web TypeScript 与 Electron TypeScript 检查 |

## 生产产物

```text
release/
├── Multi-agent-1.0.0-windows-x64-setup.exe
├── win-unpacked/
├── Multi-agent-1.0.0-macos-arm64.dmg
├── Multi-agent-1.0.0-linux-x64.AppImage
├── Multi-agent-1.0.0-linux-x64.deb
└── electron-builder 生成的更新元数据
```

一次构建只会生成当前目标平台对应的文件。完整约定见
[`docs/release-artifacts.md`](./docs/release-artifacts.md)。

## 安全策略

- `appId` 保持 `com.agent.workspace`，防止升级后切换用户数据目录。
- `.env.local`、Sentry 构建密钥和本地 Agent 数据不会复制进生产包。
- API Key 通过运行时环境变量或应用内凭证设置提供。
- Next.js standalone 运行时位于 Electron resources 下，不进入 `app.asar`。
- 用户工作区、SQLite 数据和项目绝对路径不进入安装包。

## 自动更新

项目已集成 `electron-updater`。启用发布更新时，需要把安装包与 electron-builder 生成的更新元数据发布到同一更新源，并在主进程中配置对应 provider。
