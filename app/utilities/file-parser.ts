// 模块说明：提供用户附件读取、类型识别与内容提取能力。
import { parseImageDataUrl } from "../constants/page-constants";
import type { AttachedFile } from "../constants/page-constants";
import type {
  AttachmentCandidate,
  AttachmentSourceKind,
} from "./attachment-input";

const TEXT_FILE_EXTENSIONS = new Set([
  "adoc",
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "graphql",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "log",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "properties",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

interface ParseUserSelectedFileOptions {
  sourceKind?: AttachmentSourceKind;
  relativePath?: string;
}

function createAttachmentId(file: File): string {
  const suffix = Math.random().toString(36).slice(2, 9);
  return `attachment_${file.lastModified}_${file.size}_${suffix}`;
}

function fileExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function isTextFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    TEXT_FILE_EXTENSIONS.has(fileExtension(file.name))
  );
}

function baseAttachment(
  file: File,
  options: ParseUserSelectedFileOptions,
): Pick<
  AttachedFile,
  | "id"
  | "name"
  | "type"
  | "size"
  | "lastModified"
  | "relativePath"
  | "sourceKind"
> {
  return {
    id: createAttachmentId(file),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified,
    relativePath: options.relativePath || file.webkitRelativePath || file.name,
    sourceKind: options.sourceKind || "file-picker",
  };
}

function readBinaryFile(
  file: File,
  options: ParseUserSelectedFileOptions,
): Promise<AttachedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const dataUrl = String(event.target?.result || "");
      const parsed = parseImageDataUrl(dataUrl);
      const base64 = parsed?.data || dataUrl.split(",")[1] || "";

      if (!base64) {
        reject(new Error(`媒体文件读取结果无效：${file.name}`));
        return;
      }

      resolve({
        ...baseAttachment(file, options),
        type: parsed?.mimeType || file.type || "application/octet-stream",
        dataUrl,
        base64,
      });
    };

    reader.onerror = () => reject(new Error(`媒体文件读取失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function readPdfFile(
  file: File,
  options: ParseUserSelectedFileOptions,
): Promise<AttachedFile> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf = await loadingTask.promise;
  let fullText = "";

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const tokenizedText = await page.getTextContent();
    const pageText = (tokenizedText.items as Array<{ str?: string }>)
      .map((item) => item.str || "")
      .join(" ");
    fullText += `${pageText}\n`;

    if (pageNumber % 3 === 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  return {
    ...baseAttachment(file, options),
    base64: "",
    textContent: fullText.trim() || "（未读取到有效文本）",
  };
}

function readTextFile(
  file: File,
  options: ParseUserSelectedFileOptions,
): Promise<AttachedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      resolve({
        ...baseAttachment(file, options),
        base64: "",
        textContent: String(event.target?.result || ""),
      });
    };

    reader.onerror = () => reject(new Error(`文本读取失败：${file.name}`));
    reader.readAsText(file);
  });
}

export async function parseUserSelectedFile(
  file: File,
  options: ParseUserSelectedFileOptions = {},
): Promise<AttachedFile> {
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
    return readBinaryFile(file, options);
  }

  if (file.type === "application/pdf" || fileExtension(file.name) === "pdf") {
    return readPdfFile(file, options);
  }

  if (isTextFile(file)) {
    return readTextFile(file, options);
  }

  return {
    ...baseAttachment(file, options),
    base64: "",
    textContent: `（二进制文件 ${file.name}，未展开内容；大小 ${file.size} 字节。）`,
  };
}

export async function parseAttachmentCandidate(
  candidate: AttachmentCandidate,
): Promise<AttachedFile> {
  return parseUserSelectedFile(candidate.file, {
    sourceKind: candidate.sourceKind,
    relativePath: candidate.relativePath,
  });
}

/** @deprecated 请使用 parseUserSelectedFile。 */
export const parseSelectedFile = parseUserSelectedFile;
