import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type AppTheme = "dark" | "light";

type MaximizedChangeListener = (maximized: boolean) => void;

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  selectFolder: () => ipcRenderer.invoke("dialog:openDirectory"),
  /** 将 Commerce Agent 生成的打印 HTML 交给主进程导出为真实 PDF。 */
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
      const listener = (_event: IpcRendererEvent, maximized: boolean) => {
        callback(maximized);
      };

      ipcRenderer.on("window:maximized-changed", listener);
      return () => {
        ipcRenderer.removeListener("window:maximized-changed", listener);
      };
    },
  },
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  isElectron: true,
});
