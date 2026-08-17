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

/**
 * 把 Markdown 源码转成纯文本（复制全文时用）：
 * 去掉代码围栏/行内代码、粗体/斜体/删除线、标题、引用、列表标记、
 * 链接/图片语法与 HTML 标签，只保留可读文本。
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/^```[^\n]*\n/, "").replace(/\n```$/, ""),
    )
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
