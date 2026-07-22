import { contextBridge, ipcRenderer } from "electron";

type AppTheme = "dark" | "light";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  selectFolder: () => ipcRenderer.invoke("dialog:openDirectory"),
  setTheme: (theme: AppTheme) => ipcRenderer.send("window:setTheme", theme),
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  isElectron: true,
});
