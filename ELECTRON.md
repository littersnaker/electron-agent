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

## 浏览器自动化控制服务

`automation-server.ts` 在主进程内启动一个仅绑定 `127.0.0.1` 随机端口的 HTTP 服务，
供 Python 后端的 `browser.*` 工具驱动内置浏览器（navigate / extract / click /
fill / screenshot）。要点：

- 每次应用启动生成随机 Bearer token，请求做 timing-safe 校验；
- 地址与 token 通过两条通道交给 Python：打包模式下 `buildBackendEnvironment`
  注入 env；`pnpm dev`（concurrently 直启后端）走 `automation-endpoint.json`
  端点文件（0600，含 pid 存活校验）；
- 自动化窗口为常驻隐藏窗口：`sandbox: true` + 独立非持久会话（与主窗口登录态
  隔离）、无 preload，渲染进程崩溃自动重建；
- 视觉截图（视觉 Review / 全站巡检 / browser.look）也复用这套窗口与截图逻辑。

## 安全边界

- renderer 禁用 Node 集成；
- React 只能通过 preload 暴露的有限 API 使用 Electron 能力；
- 后端与自动化控制服务都只监听 `127.0.0.1`；
- 自动化窗口使用独立非持久会话，不共享主窗口 Cookie 与登录态；
- `.env.local` 不进入生产安装包；
- 用户数据写入 Electron 的 `userData/python-data`；
- 外部链接交给系统浏览器打开；
- Electron 退出时清理 Python 子进程并关闭自动化服务。

## 常用命令

```bash
pnpm electron:compile
pnpm electron:pack
pnpm electron:make
pnpm electron:make:win
pnpm electron:make:mac
pnpm electron:make:linux
```
