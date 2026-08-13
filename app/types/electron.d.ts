// 模块说明：声明 preload 暴露给网页层的安全 Electron API。
export {};

type ElectronAppTheme = "dark" | "light";

interface CommercePdfPayload {
  html: string;
  suggestedFileName: string;
}

interface ElectronUiPreferences {
  selectedChatModel?: string;
  selectedMediaModel?: string;
  builtinPlugins?: Record<string, boolean>;
  codeAgentMode?: "suggest" | "auto_edit" | "full_auto";
}

interface ElectronWindowControls {
  minimize: () => void;
  toggleMaximize: () => Promise<boolean>;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
}

interface ElectronCredentialApi {
  read: () => Promise<Record<string, string>>;
  write: (values: Record<string, string>) => Promise<Record<string, string>>;
}

interface ElectronPreferenceApi {
  read: () => Promise<ElectronUiPreferences>;
  write: (values: ElectronUiPreferences) => Promise<ElectronUiPreferences>;
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
      capturePage: (url: string) => Promise<{ base64: string }>;
      setTheme: (theme: ElectronAppTheme) => Promise<ElectronAppTheme>;
      credentials: ElectronCredentialApi;
      preferences: ElectronPreferenceApi;
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
