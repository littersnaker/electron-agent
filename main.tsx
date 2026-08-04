// 模块说明：Vite React 渲染器入口，根据路径显示工作台或可观测页面。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "./app/page";
import ObservabilityPage from "./app/observability/page";
import "./app/globals.css";

/**
 * 根据当前浏览器路径选择顶层页面。
 * Electron 和普通浏览器都可以直接访问 `/observability`。
 */
function RootApplication() {
  return window.location.pathname.startsWith("/observability") ? (
    <ObservabilityPage />
  ) : (
    <Home />
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("index.html 中缺少 #root 容器");
}

createRoot(rootElement).render(
  <StrictMode>
    <RootApplication />
  </StrictMode>,
);
