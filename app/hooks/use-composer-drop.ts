"use client";
/**
 * 模块职责：统一处理聊天输入框的文字选区、文件和文件夹拖放。
 */
import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, RefObject } from "react";
import {
  insertTextAtSelection,
  readCurrentSelectionText,
  readDroppedText,
  resolveComposerDropKind,
  writeSelectedTextToTransfer,
} from "../utilities/text-drop";
import type { ComposerDropKind } from "../utilities/text-drop";

interface UseComposerDropOptions {
  input: string;
  disabled: boolean;
  allowFiles: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onFileDrop: (dataTransfer: DataTransfer) => Promise<void>;
}

interface ComposerDropHandlers {
  onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => Promise<void>;
}

interface UseComposerDropResult {
  activeDropKind: ComposerDropKind | null;
  isDragActive: boolean;
  dropHandlers: ComposerDropHandlers;
}

/** 提供与 ChatGPT 类似的“选中文字后直接拖入输入框”体验。 */
export function useComposerDrop({
  input,
  disabled,
  allowFiles,
  textareaRef,
  onInputChange,
  onFileDrop,
}: UseComposerDropOptions): UseComposerDropResult {
  const [activeDropKind, setActiveDropKind] =
    useState<ComposerDropKind | null>(null);
  const dragDepthRef = useRef(0);
  const selectedTextRef = useRef("");

  useEffect(() => {
    const handleDragStart = (event: globalThis.DragEvent): void => {
      if (!event.dataTransfer) return;
      const selectedText = readCurrentSelectionText(event.target);
      if (!selectedText) return;
      selectedTextRef.current = selectedText;
      writeSelectedTextToTransfer(event.dataTransfer, selectedText);
    };

    const clearSelectionAfterDrag = (): void => {
      window.setTimeout(() => {
        selectedTextRef.current = "";
      }, 0);
    };

    document.addEventListener("dragstart", handleDragStart, true);
    document.addEventListener("dragend", clearSelectionAfterDrag, true);
    return () => {
      document.removeEventListener("dragstart", handleDragStart, true);
      document.removeEventListener("dragend", clearSelectionAfterDrag, true);
    };
  }, []);

  const resolveDropKind = (dataTransfer: DataTransfer): ComposerDropKind | null => {
    const fallback = selectedTextRef.current || readCurrentSelectionText();
    return resolveComposerDropKind(dataTransfer, allowFiles, fallback);
  };

  const insertText = (droppedText: string): void => {
    if (!droppedText) return;
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? input.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const result = insertTextAtSelection(
      input,
      droppedText,
      selectionStart,
      selectionEnd,
    );
    onInputChange(result.value);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(result.caretPosition, result.caretPosition);
    });
  };

  const handleDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    const dropKind = resolveDropKind(event.dataTransfer);
    if (!dropKind) return;
    event.preventDefault();
    if (disabled) return;
    dragDepthRef.current += 1;
    setActiveDropKind(dropKind);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    const dropKind = resolveDropKind(event.dataTransfer);
    if (!dropKind) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (!disabled && activeDropKind !== dropKind) setActiveDropKind(dropKind);
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!activeDropKind) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setActiveDropKind(null);
  };

  const handleDrop = async (event: ReactDragEvent<HTMLDivElement>): Promise<void> => {
    const dropKind = resolveDropKind(event.dataTransfer);
    if (!dropKind) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setActiveDropKind(null);
    if (disabled) return;

    if (dropKind === "text") {
      const fallback = selectedTextRef.current || readCurrentSelectionText();
      insertText(readDroppedText(event.dataTransfer, fallback));
      selectedTextRef.current = "";
      return;
    }

    await onFileDrop(event.dataTransfer);
  };

  return {
    activeDropKind,
    isDragActive: activeDropKind !== null,
    dropHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
