"use client";

import { useCallback, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { normalizeAttachedFile } from "../const/pageConst";
import type { AttachedFile } from "../const/pageConst";
import { parseSelectedFile } from "../utils/fileParser";

export function useComposer() {
  const [input, setInput] = useState("");
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setIsParsingFile(true);
      try {
        const parsedFile = await parseSelectedFile(file);
        setAttachedFile(normalizeAttachedFile(parsedFile));
      } finally {
        setIsParsingFile(false);
      }
    },
    [],
  );

  const clearAfterSubmit = useCallback(() => {
    setInput("");
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const resetComposer = useCallback(() => {
    clearAfterSubmit();
    setIsParsingFile(false);
  }, [clearAfterSubmit]);

  return {
    input,
    setInput,
    attachedFile,
    setAttachedFile,
    isParsingFile,
    fileInputRef,
    handleFileSelect,
    clearAfterSubmit,
    resetComposer,
  };
}
