/**
 * 模块职责：在 FastAPI 启动期间显示独立加载窗口，并更新启动进度。
 */
import { BrowserWindow, nativeTheme } from "electron";
import type { BackendStartupProgress } from "./backend-process";

/**
 * 根据系统当前深浅色偏好生成加载页 HTML。
 *
 * 加载页不依赖 React、Vite 或 FastAPI，因此 Electron 启动后可以立即显示，
 * 避免用户在 Python 服务初始化期间只看到空白桌面。
 */
function buildStartupHtml(): string {
  const dark = nativeTheme.shouldUseDarkColors;
  const colors = dark
    ? {
        panel: "rgba(24,24,28,.96)",
        border: "rgba(255,255,255,.11)",
        text: "#f5f5f7",
        muted: "rgba(235,235,245,.58)",
        track: "rgba(255,255,255,.08)",
        glow: "rgba(10,132,255,.28)",
      }
    : {
        panel: "rgba(250,251,253,.97)",
        border: "rgba(15,23,42,.1)",
        text: "#17171b",
        muted: "rgba(30,30,35,.58)",
        track: "rgba(15,23,42,.08)",
        glow: "rgba(10,132,255,.2)",
      };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  *{box-sizing:border-box}
  html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;user-select:none}
  body{display:grid;place-items:center;padding:10px}
  .card{position:relative;width:100%;height:100%;overflow:hidden;border:1px solid ${colors.border};border-radius:24px;background:${colors.panel};box-shadow:0 28px 80px rgba(0,0,0,.26),inset 0 1px 0 rgba(255,255,255,.1);-webkit-app-region:drag}
  .glow{position:absolute;inset:-40% -20% auto 28%;height:90%;background:radial-gradient(circle,${colors.glow},transparent 67%);filter:blur(6px);pointer-events:none}
  .content{position:relative;display:flex;height:100%;flex-direction:column;align-items:center;justify-content:center;padding:34px 42px 30px;text-align:center}
  .logo{position:relative;display:grid;width:68px;height:68px;place-items:center;margin-bottom:18px;border:1px solid ${colors.border};border-radius:21px;background:linear-gradient(145deg,rgba(10,132,255,.18),rgba(191,90,242,.12));box-shadow:0 18px 42px ${colors.glow},inset 0 1px 0 rgba(255,255,255,.18)}
  .orbit{position:absolute;inset:13px;border:2px solid rgba(10,132,255,.24);border-top-color:#0a84ff;border-radius:50%;animation:spin 1.4s linear infinite}
  .orbit.secondary{inset:20px;border-color:rgba(191,90,242,.2);border-right-color:#bf5af2;animation-direction:reverse;animation-duration:1.9s}
  .spark{width:13px;height:13px;transform:rotate(45deg);border-radius:3px;background:linear-gradient(135deg,#61a8ff,#c77dff);box-shadow:0 0 18px rgba(97,168,255,.65)}
  h1{min-height:26px;margin:0;color:${colors.text};font-size:18px;font-weight:650;letter-spacing:-.02em}
  p{min-height:36px;max-width:340px;margin:8px 0 22px;color:${colors.muted};font-size:12px;line-height:1.55}
  .progress{width:100%;height:6px;overflow:hidden;border-radius:999px;background:${colors.track};box-shadow:inset 0 1px 2px rgba(0,0,0,.08)}
  .bar{width:12%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#0a84ff,#5aa8ff,#bf5af2);box-shadow:0 0 16px rgba(10,132,255,.36);transition:width 380ms cubic-bezier(.2,.8,.2,1)}
  .footer{display:flex;width:100%;justify-content:space-between;margin-top:12px;color:${colors.muted};font-size:10px;letter-spacing:.02em}
  .dots span{display:inline-block;animation:dots 1.2s ease-in-out infinite}.dots span:nth-child(2){animation-delay:.16s}.dots span:nth-child(3){animation-delay:.32s}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes dots{0%,70%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-2px)}}
  @media (prefers-reduced-motion:reduce){.orbit,.dots span{animation:none}.bar{transition:none}}
</style>
</head>
<body>
  <section class="card">
    <div class="glow"></div>
    <div class="content">
      <div class="logo" aria-hidden="true"><div class="orbit"></div><div class="orbit secondary"></div><div class="spark"></div></div>
      <h1 id="startup-title">正在启动 Multi-agent</h1>
      <p id="startup-detail">正在准备本地 Python 与 Agent 运行环境，请稍候…</p>
      <div class="progress"><div class="bar" id="startup-bar"></div></div>
      <div class="footer"><span>本地 FastAPI 服务</span><span class="dots">加载中<span>•</span><span>•</span><span>•</span></span></div>
    </div>
  </section>
<script>
  window.__setStartupState = function(state){
    document.getElementById('startup-title').textContent = state.title || '正在启动 Multi-agent';
    document.getElementById('startup-detail').textContent = state.detail || '正在初始化本地服务…';
    var value = Math.max(0.08, Math.min(1, Number(state.progress) || 0.08));
    document.getElementById('startup-bar').style.width = (value * 100).toFixed(1) + '%';
  };
</script>
</body>
</html>`;
}

/**
 * 创建并立即显示启动加载窗口。
 */
export async function createStartupWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 460,
    height: 310,
    frame: false,
    transparent: true,
    resizable: false,
    accentColor:false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildStartupHtml())}`,
  );
  if (!window.isDestroyed()) window.show();
  return window;
}

/**
 * 把 FastAPI 启动阶段同步到加载页文字和进度条。
 */
export function updateStartupWindow(
  window: BrowserWindow | null,
  progress: BackendStartupProgress,
): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;

  const serialized = JSON.stringify(progress);
  void window.webContents
    .executeJavaScript(`window.__setStartupState?.(${serialized})`, true)
    .catch((error) => console.warn("[Electron] 加载页进度更新失败", error));
}

/**
 * 安全关闭启动加载窗口。
 */
export function closeStartupWindow(window: BrowserWindow | null): void {
  if (window && !window.isDestroyed()) window.destroy();
}
