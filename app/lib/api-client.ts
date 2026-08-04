// 模块说明：统一处理 React 页面到本地 FastAPI 服务的请求地址。

/**
 * 读取 Electron preload 注入的后端地址。
 *
 * 开发模式下 React 运行在 Vite 的 5173 端口，Python 运行在另一个随机端口；
 * 生产模式下 React 由 FastAPI 同源托管，因此没有注入地址时直接返回空字符串。
 */
export function getBackendBaseUrl(): string {
  const electronUrl = window.electronAPI?.backendBaseUrl?.trim();
  if (electronUrl) return electronUrl.replace(/\/$/u, "");

  const configured = import.meta.env.VITE_BACKEND_URL?.trim();
  return configured ? configured.replace(/\/$/u, "") : "";
}

/**
 * 把 `/api/...` 相对地址转换成当前环境可访问的完整地址。
 */
export function buildApiUrl(path: string): string {
  if (/^https?:\/\//iu.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getBackendBaseUrl()}${normalizedPath}`;
}

/**
 * 与浏览器原生 fetch 用法一致，但会自动补上 FastAPI 地址。
 */
export function apiFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(buildApiUrl(path), options);
}
