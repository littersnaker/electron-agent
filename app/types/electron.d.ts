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

interface ElectronCredentialApi {
  read: () => Promise<Record<string, string>>;
  write: (values: Record<string, string>) => Promise<Record<string, string>>;
}

interface ElectronPreferenceApi {
  read: () => Promise<ElectronUiPreferences>;
  write: (values: ElectronUiPreferences) => Promise<ElectronUiPreferences>;
}

declare global {
  /** Electron 侧持久化的 UI 偏好（renderer 各 hook 共用此环境类型）。 */
  interface ElectronUiPreferences {
    selectedChatModel?: string;
    selectedMediaModel?: string;
    builtinPlugins?: Record<string, boolean>;
    codeAgentMode?: "suggest" | "auto_edit" | "full_auto";
    /** 允许视觉 Review（截图发送给云端视觉模型）；缺省视为允许。 */
    visualReviewEnabled?: boolean;
    /** Code Agent 完成后自动视觉 Review；缺省视为开启。 */
    visualReviewAutoEnabled?: boolean;
  }

  interface Window {
    electronAPI?: {
      platform: string;
      backendBaseUrl: string;
      initialTheme: ElectronAppTheme;
      selectFolder: () => Promise<string | null>;
      exportCommerceReportPdf: (
        payload: CommercePdfPayload,
      ) => Promise<{ canceled: boolean; filePath?: string }>;
      capturePageScroll: (
        url: string,
        maxFrames?: number,
      ) => Promise<{
        frames: Array<{ base64: string; offsetTop: number }>;
        pageHeight: number;
        viewportHeight: number;
      }>;
      clipboard: {
        readText: () => Promise<string>;
        writeText: (text: string) => Promise<void>;
      };
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
