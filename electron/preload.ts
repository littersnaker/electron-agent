/**
 * 模块职责：通过 contextBridge 向 React 暴露最小化的安全 Electron API。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type AppTheme = "dark" | "light";
type MaximizedChangeListener = (maximized: boolean) => void;

/**
 * 从 Electron additionalArguments 中读取 FastAPI 地址。
 */
function readBackendBaseUrl(): string {
  const prefix = "--backend-url=";
  const argument = process.argv.find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  backendBaseUrl: readBackendBaseUrl(),
  selectFolder: () => ipcRenderer.invoke("dialog:openDirectory"),
  exportCommerceReportPdf: (payload: {
    html: string;
    suggestedFileName: string;
  }) => ipcRenderer.invoke("commerce:exportPdf", payload),
  setTheme: (theme: AppTheme) => ipcRenderer.send("window:setTheme", theme),
  windowControls: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizedChange: (callback: MaximizedChangeListener) => {
      const listener = (_event: IpcRendererEvent, maximized: boolean): void => {
        callback(maximized);
      };
      ipcRenderer.on("window:maximized-changed", listener);
      return () => ipcRenderer.removeListener("window:maximized-changed", listener);
    },
  },
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  isElectron: true,
});
