// 模块说明：输入框右键菜单（复制/粘贴/全选）与光标插入逻辑。
"use client";

import { useCallback, useRef, useState } from "react";
import type { ContextMenuItem } from "../components/context-menu";
import { readClipboard, writeClipboard } from "../lib/clipboard";

export function useComposerContextMenu(
  input: string,
  onInputChange: (value: string) => void,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const insertTextAtCursor = (text: string) => {
    const element = textareaRef.current;
    if (!element) return;
    const start = element.selectionStart ?? input.length;
    const end = element.selectionEnd ?? input.length;
    const next = input.slice(0, start) + text + input.slice(end);
    onInputChange(next);
    requestAnimationFrame(() => {
      element.focus();
      const position = start + text.length;
      element.setSelectionRange(position, position);
    });
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await readClipboard();
      if (text) insertTextAtCursor(text);
    } catch {
      // 剪贴板不可读时静默失败
    }
  };

  const openMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const copyFromTextarea = (): string => {
    const element = textareaRef.current;
    if (!element) return input;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? input.length;
    const selected = input.slice(start, end);
    return selected || input;
  };

  const items: ContextMenuItem[] = [
    {
      label: "复制",
      onSelect: () => void writeClipboard(copyFromTextarea()),
    },
    { label: "粘贴", onSelect: () => void pasteFromClipboard() },
    { label: "全选", onSelect: () => textareaRef.current?.select() },
  ];

  return { textareaRef, menu, items, openMenu, closeMenu };
}
