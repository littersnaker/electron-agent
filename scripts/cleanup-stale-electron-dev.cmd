@echo off
chcp 65001 >nul
echo 正在关闭旧版 Electron 开发进程及其 Next.js 子进程...
taskkill /F /IM electron.exe /T >nul 2>&1
echo 清理完成。现在可以重新执行 pnpm electron:dev。
