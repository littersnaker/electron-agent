// 模块说明：负责 Composer 文本、附件队列与解析状态管理。
"use client";

import { useCallback, useRef, useState } from "react";
import { normalizeAttachedFile } from "../constants/page-constants";
import type { AttachedFile } from "../constants/page-constants";
import type { AttachmentCandidate } from "../utilities/attachment-input";
import { parseAttachmentCandidate } from "../utilities/file-parser";

const MAX_COMPOSER_ATTACHMENTS = 32;
const DEFAULT_MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

export interface AttachmentIngestionOptions {
  strategy?: "append" | "replace";
  maxFiles?: number;
  maxTotalBytes?: number;
}

function formatMegabytes(byteCount: number): string {
  return `${Math.max(1, Math.ceil(byteCount / 1024 / 1024))} MB`;
}

function selectCandidatesWithinLimits(
  candidates: readonly AttachmentCandidate[],
  maxFiles: number,
  maxBytes: number,
): {
  selected: AttachmentCandidate[];
  omittedByCount: number;
  omittedBySize: number;
} {
  const selected: AttachmentCandidate[] = [];
  let selectedBytes = 0;
  let omittedBySize = 0;

  for (const candidate of candidates) {
    if (selected.length >= maxFiles) break;
    if (selectedBytes + candidate.file.size > maxBytes) {
      omittedBySize += 1;
      continue;
    }

    selected.push(candidate);
    selectedBytes += candidate.file.size;
  }

  return {
    selected,
    omittedByCount: Math.max(
      0,
      candidates.length - selected.length - omittedBySize,
    ),
    omittedBySize,
  };
}

function attachmentFingerprint(attachment: AttachedFile): string {
  return [
    attachment.relativePath || attachment.name,
    attachment.size || 0,
    attachment.lastModified || 0,
    attachment.type,
  ].join(":");
}

function candidateFingerprint(candidate: AttachmentCandidate): string {
  return [
    candidate.relativePath ||
      candidate.file.webkitRelativePath ||
      candidate.file.name,
    candidate.file.size,
    candidate.file.lastModified,
    candidate.file.type || "application/octet-stream",
  ].join(":");
}

function deduplicateCandidates(
  candidates: readonly AttachmentCandidate[],
  existingAttachments: readonly AttachedFile[],
): { unique: AttachmentCandidate[]; duplicateCount: number } {
  const seen = new Set(existingAttachments.map(attachmentFingerprint));
  const unique: AttachmentCandidate[] = [];
  let duplicateCount = 0;

  for (const candidate of candidates) {
    const fingerprint = candidateFingerprint(candidate);
    if (seen.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(fingerprint);
    unique.push(candidate);
  }

  return { unique, duplicateCount };
}

function deduplicateAttachments(
  attachments: readonly AttachedFile[],
): AttachedFile[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const fingerprint = attachmentFingerprint(attachment);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

export function useComposer() {
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addAttachments = useCallback(
    async (
      candidates: readonly AttachmentCandidate[],
      options: AttachmentIngestionOptions = {},
    ): Promise<void> => {
      if (candidates.length === 0) return;

      const strategy = options.strategy || "append";
      const maxFiles = Math.max(
        1,
        Math.min(
          options.maxFiles || MAX_COMPOSER_ATTACHMENTS,
          MAX_COMPOSER_ATTACHMENTS,
        ),
      );
      const maxTotalBytes = Math.max(
        1,
        Math.min(
          options.maxTotalBytes || DEFAULT_MAX_BATCH_BYTES,
          MAX_BATCH_BYTES,
        ),
      );
      const existingAttachments = strategy === "append" ? attachedFiles : [];
      const deduplicated = deduplicateCandidates(
        candidates,
        existingAttachments,
      );
      const currentFileCount = existingAttachments.length;
      const currentByteCount = existingAttachments.reduce(
        (total, attachment) => total + (attachment.size || 0),
        0,
      );
      const availableFileCount = Math.max(0, maxFiles - currentFileCount);
      const availableBytes = Math.max(0, maxTotalBytes - currentByteCount);
      const selection = selectCandidatesWithinLimits(
        deduplicated.unique,
        availableFileCount,
        availableBytes,
      );
      const selectedCandidates = selection.selected;

      if (selectedCandidates.length === 0) {
        let reason = `附件总大小已达到 ${formatMegabytes(maxTotalBytes)} 上限`;
        if (deduplicated.duplicateCount === candidates.length) {
          reason = "所选文件已在附件列表中";
        } else if (availableFileCount === 0) {
          reason = `附件数量已达到 ${maxFiles} 个上限`;
        }

        setAttachmentError(reason);
        return;
      }

      setIsParsingFile(true);
      setAttachmentError("");

      try {
        const settled = await Promise.allSettled(
          selectedCandidates.map(parseAttachmentCandidate),
        );
        const parsed = settled.flatMap((result) =>
          result.status === "fulfilled"
            ? [normalizeAttachedFile(result.value)]
            : [],
        );
        const failedCount = settled.length - parsed.length;

        setAttachedFiles((current) => {
          if (strategy === "replace" && parsed.length === 0) return current;
          const next = strategy === "replace" ? parsed : [...current, ...parsed];
          return deduplicateAttachments(next).slice(0, maxFiles);
        });

        if (
          failedCount > 0 ||
          deduplicated.duplicateCount > 0 ||
          selection.omittedByCount > 0 ||
          selection.omittedBySize > 0
        ) {
          const details = [
            failedCount > 0 ? `${failedCount} 个文件读取失败` : "",
            deduplicated.duplicateCount > 0
              ? `${deduplicated.duplicateCount} 个重复文件已忽略`
              : "",
            selection.omittedByCount > 0
              ? `${selection.omittedByCount} 个文件超过数量上限`
              : "",
            selection.omittedBySize > 0
              ? [
                  `${selection.omittedBySize} 个文件超过总大小上限`,
                  `（${formatMegabytes(maxTotalBytes)}）`,
                ].join("")
              : "",
          ].filter(Boolean);
          setAttachmentError(details.join("，"));
        }
      } finally {
        setIsParsingFile(false);
      }
    },
    [attachedFiles],
  );

  const removeAttachedFile = useCallback((attachmentId: string) => {
    setAttachedFiles((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

  const clearAfterSubmit = useCallback(() => {
    setInput("");
    setAttachedFiles([]);
    setAttachmentError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const resetComposer = useCallback(() => {
    clearAfterSubmit();
    setIsParsingFile(false);
  }, [clearAfterSubmit]);

  return {
    input,
    setInput,
    attachedFiles,
    setAttachedFiles,
    addAttachments,
    removeAttachedFile,
    attachmentError,
    isParsingFile,
    fileInputRef,
    clearAfterSubmit,
    resetComposer,
  };
}
