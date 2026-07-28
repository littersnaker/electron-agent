/**
 * Composer 附件采集工具：统一处理文件选择、剪贴板图片和拖拽文件夹。
 * 目录读取使用 Chromium 的 File System Entry API，并设置明确上限避免一次性载入超大目录。
 */

export type AttachmentSourceKind =
  | "file-picker"
  | "clipboard"
  | "drop-file"
  | "drop-directory";

export interface AttachmentCandidate {
  file: File;
  sourceKind: AttachmentSourceKind;
  relativePath?: string;
}

interface LegacyFileSystemEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  readonly fullPath: string;
}

interface LegacyFileSystemFileEntry extends LegacyFileSystemEntry {
  file(
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ): void;
}

interface LegacyFileSystemDirectoryReader {
  readEntries(
    successCallback: (entries: LegacyFileSystemEntry[]) => void,
    errorCallback?: (error: DOMException) => void,
  ): void;
}

interface LegacyFileSystemDirectoryEntry extends LegacyFileSystemEntry {
  createReader(): LegacyFileSystemDirectoryReader;
}

type DataTransferItemWithEntry = {
  webkitGetAsEntry?: () => LegacyFileSystemEntry | null;
};

const MAX_DROPPED_FILES = 128;
const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".next-electron",
  ".electron",
  "node_modules",
  "release",
  "out",
  "out-server",
  "dist",
  "coverage",
]);

function readFileEntry(entry: LegacyFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function readDirectoryEntries(
  entry: LegacyFileSystemDirectoryEntry,
): Promise<LegacyFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: LegacyFileSystemEntry[] = [];

  while (true) {
    const batch = await new Promise<LegacyFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function flattenEntry(
  entry: LegacyFileSystemEntry,
  parentPath: string,
  output: AttachmentCandidate[],
): Promise<void> {
  if (output.length >= MAX_DROPPED_FILES) return;

  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    if (IGNORED_FILE_NAMES.has(entry.name)) return;
    const file = await readFileEntry(entry as LegacyFileSystemFileEntry);
    output.push({ file, sourceKind: "drop-file", relativePath });
    return;
  }

  if (!entry.isDirectory || IGNORED_DIRECTORY_NAMES.has(entry.name)) return;

  const children = await readDirectoryEntries(
    entry as LegacyFileSystemDirectoryEntry,
  );
  for (const child of children) {
    await flattenEntry(child, relativePath, output);
    if (output.length >= MAX_DROPPED_FILES) return;
  }
}

/** 从拖拽数据中递归提取文件；目录中的文件会保留相对路径。 */
export async function collectDroppedAttachments(
  dataTransfer: DataTransfer,
): Promise<AttachmentCandidate[]> {
  const output: AttachmentCandidate[] = [];
  const items = Array.from(dataTransfer.items);

  for (const item of items) {
    if (item.kind !== "file") continue;

    const entry = (item as unknown as DataTransferItemWithEntry)
      .webkitGetAsEntry?.();
    try {
      if (entry) {
        const beforeCount = output.length;
        await flattenEntry(entry, "", output);
        if (entry.isDirectory) {
          for (let index = beforeCount; index < output.length; index += 1) {
            const candidate = output[index];
            if (candidate) candidate.sourceKind = "drop-directory";
          }
        }
      } else {
        const file = item.getAsFile();
        if (file) {
          output.push({ file, sourceKind: "drop-file", relativePath: file.name });
        }
      }
    } catch {
      const file = item.getAsFile();
      if (file) {
        output.push({ file, sourceKind: "drop-file", relativePath: file.name });
      }
    }

    if (output.length >= MAX_DROPPED_FILES) break;
  }

  if (output.length > 0) return output;

  return Array.from(dataTransfer.files)
    .slice(0, MAX_DROPPED_FILES)
    .map((file) => ({
      file,
      sourceKind: "drop-file" as const,
      relativePath: file.webkitRelativePath || file.name,
    }));
}

/** 从剪贴板提取图片或文件。纯文本粘贴由输入框自身继续处理。 */
export function collectClipboardAttachments(
  clipboardData: DataTransfer,
): AttachmentCandidate[] {
  return Array.from(clipboardData.files).map((file) => ({
    file,
    sourceKind: "clipboard" as const,
    relativePath: file.name,
  }));
}

export function createFilePickerCandidates(
  files: FileList | readonly File[],
): AttachmentCandidate[] {
  return Array.from(files).map((file) => ({
    file,
    sourceKind: "file-picker" as const,
    relativePath: file.webkitRelativePath || file.name,
  }));
}
