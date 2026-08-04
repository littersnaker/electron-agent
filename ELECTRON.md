# Electron 本地 FastAPI 运行机制

## 开发模式

`pnpm dev` 会先启动 Vite，再编译并启动 Electron。Electron 的 `backend-process.ts` 自动：

1. 寻找 `.venv` 中的 Python；
2. 选择空闲端口；
3. 执行 `python -m backend.main`；
4. 等待 `/api/health` 成功；
5. 将后端地址通过 preload 传给 React；
6. 关闭应用时终止 Python 子进程。

## 生产模式

`pnpm electron:make` 会依次生成：

```text
.electron/       Electron CommonJS
dist/            React 静态页面
 python-dist/     PyInstaller 后端可执行文件
 release/         安装包
```

安装后 Electron 启动 `resources/backend/multi-agent-backend`，普通用户不需要安装 Python。FastAPI 同时提供 `/api/*` 和 `resources/frontend` 中的页面。

## 安全边界

- renderer 禁用 Node 集成；
- React 只能通过 preload 暴露的有限 API 使用 Electron 能力；
- 后端只监听 `127.0.0.1`；
- `.env.local` 不进入生产安装包；
- 用户数据写入 Electron 的 `userData/python-data`；
- 外部链接交给系统浏览器打开；
- Electron 退出时清理 Python 子进程。

## 常用命令

```bash
pnpm electron:compile
pnpm electron:pack
pnpm electron:make
pnpm electron:make:win
pnpm electron:make:mac
pnpm electron:make:linux
```
