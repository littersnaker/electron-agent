# 深浅色动画与启动加载页优化说明

## 一、本次解决的问题

1. 聊天中存在大尺寸图片时，切换深浅色模式会明显卡顿。
2. FastAPI 启动完成前 Electron 没有任何可见窗口，用户会误以为应用没有启动。
3. Windows 缺少 IANA 时区数据库时，Agent 可能报 `No time zone found with key ...`。

## 二、深浅色切换优化

主题切换现在使用浏览器原生 View Transition 根视图快照，而不是让聊天页面中的每个卡片、按钮和图片分别执行颜色动画。

动画方向：

- 切换到深色：新主题从左上角以圆弧向右下角扩散；
- 切换到浅色：新主题从右下角以圆弧向左上角扩散；
- 系统开启“减少动态效果”时自动跳过长动画。

性能措施：

- `ChatList` 使用 `React.memo`，仅切换主题时不重新执行大型消息树渲染；
- 图片附件使用异步解码与懒加载；
- 主题动画期间暂停页面内部零散 CSS transition；
- 媒体卡片使用绘制隔离，减少大范围重绘；
- 统一对根页面快照执行圆弧裁切动画。

相关文件：

```text
app/hooks/useThemeMode.ts
app/globals.css
app/components/ChatList.tsx
app/components/MessageAttachmentGallery.tsx
```

## 三、启动加载页

Electron 现在会先显示独立加载窗口，然后启动本地 FastAPI。加载页会展示以下阶段：

```text
检查端口和 Python 环境
启动 Python FastAPI
等待 Agent、数据库和接口就绪
加载 React 工作台
关闭加载页并显示主窗口
```

加载页完全由 Electron 本地 HTML 生成，不依赖 React 和 FastAPI，因此后端尚未启动时也能立即出现。

相关文件：

```text
electron/splash-window.ts
electron/backend-process.ts
electron/main.ts
electron/window.ts
```

## 四、Windows 时区修复

`requirements.txt` 已加入 `tzdata`。覆盖项目后请重新安装一次 Python 依赖：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

## 五、运行验证

```powershell
pnpm dev
```

预期行为：

1. 先出现 Multi-agent 启动加载窗口；
2. FastAPI 健康检查通过后，加载页关闭；
3. 主窗口出现；
4. 在包含图片的对话中切换主题，可以看到指定方向的圆弧过渡。

## 六、重新构建安装包

源码变化不会自动写入旧的安装包，发布前必须重新构建：

```powershell
pnpm verify
pnpm electron:make:win
```

生成结果位于 `release/`。
