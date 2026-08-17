// 模块说明：跨环境剪贴板读写——Electron 优先走主进程 IPC，
// 浏览器环境回退到 navigator.clipboard，保证右键菜单真实可用。

export async function writeClipboard(text: string): Promise<void> {
  const bridge = window.electronAPI?.clipboard;
  if (bridge) {
    await bridge.writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function readClipboard(): Promise<string> {
  const bridge = window.electronAPI?.clipboard;
  if (bridge) {
    return bridge.readText();
  }
  return navigator.clipboard.readText();
}
