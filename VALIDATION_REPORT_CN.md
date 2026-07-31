# 交付前验证报告

验证日期：2026-07-31

## 本次改动

- 恢复 Electron 独立启动加载页；
- 加载页实时显示 FastAPI 初始化阶段与进度；
- 主窗口完成渲染后再关闭加载页；
- 深色模式使用左上角到右下角的圆弧揭示动画；
- 浅色模式使用右下角到左上角的圆弧揭示动画；
- 聊天图片较多时，主题切换不再重新渲染完整消息列表；
- 图片附件启用懒加载、异步解码和绘制区域隔离；
- Windows 运行依赖加入 `tzdata`。

## 已通过

- Python `compileall` 语法检查；
- FastAPI Pytest 冒烟测试：3 项全部通过；
- 99 个 TypeScript/TSX 文件语法转换检查，0 个语法错误；
- TypeScript 相对模块引用检查，0 个缺失；
- 168 个源码与 Markdown 文件规范检查，全部不超过 500 行；
- Python AST 注释检查，所有函数和方法都有 docstring；
- 新增 Electron 文件能够被现有 esbuild 入口从 `main.ts` 自动打包；
- 启动加载页不依赖 React、Vite 或 FastAPI；
- View Transition 不可用或系统要求减少动画时具有无动画降级路径。

## 当前环境无法完成的检查

交付环境无法连接 npm registry，因此没有下载项目 `node_modules`，不能在这里执行真实的：

```bash
pnpm install
pnpm typecheck
pnpm electron:typecheck
pnpm build
pnpm electron:make
```

你本机已经能够运行 Electron，覆盖文件并安装新增的 Python 依赖后，请执行：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
pnpm verify
pnpm dev
```

## 手动验收建议

1. 完全退出应用，确认任务管理器里没有残留的 Electron 和 FastAPI 进程；
2. 执行 `pnpm dev`，确认主窗口出现前先展示启动加载页；
3. 打开包含大图的历史会话；
4. 切换到深色模式，确认圆弧从左上角扩散；
5. 切换到浅色模式，确认圆弧从右下角扩散；
6. 连续切换两次，确认不会出现白屏、图片闪烁或按钮失效；
7. 执行 `pnpm electron:make:win` 重新生成正式安装包。
