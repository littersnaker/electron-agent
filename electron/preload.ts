import { contextBridge, ipcRenderer } from "electron";

type AppTheme = "dark" | "light";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  selectFolder: () => ipcRenderer.invoke("dialog:openDirectory"),
  /** 将 Commerce Agent 生成的打印 HTML 交给主进程导出为真实 PDF。 */
  exportCommerceReportPdf: (payload: {
    html: string;
    suggestedFileName: string;
  }) => ipcRenderer.invoke("commerce:exportPdf", payload),
  setTheme: (theme: AppTheme) => ipcRenderer.send("window:setTheme", theme),
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  isElectron: true,
});
