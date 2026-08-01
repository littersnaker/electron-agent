// 模块说明：声明 preload 暴露给网页层的安全 Electron API。
export {};

type ElectronAppTheme = "dark" | "light";

interface CommercePdfPayload {
  html: string;
  suggestedFileName: string;
}

interface ElectronWindowControls {
  minimize: () => void;
  toggleMaximize: () => Promise<boolean>;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: {
      platform: string;
      backendBaseUrl: string;
      initialTheme: ElectronAppTheme;
      selectFolder: () => Promise<string | null>;
      exportCommerceReportPdf: (
        payload: CommercePdfPayload,
      ) => Promise<{ canceled: boolean; filePath?: string }>;
      setTheme: (theme: ElectronAppTheme) => Promise<ElectronAppTheme>;
      versions: {
        node: string;
        chrome: string;
        electron: string;
      };
      isElectron: boolean;
      windowControls: ElectronWindowControls;
    };
  }
}
