// src/app/utils/fileParser.ts
import type { AttachedFile } from "../const/pageConst";
import { parseImageDataUrl } from "../const/pageConst";

export async function parseSelectedFile(file: File): Promise<AttachedFile> {
  // 图片：dataUrl 用于预览，base64 使用纯数据供模型请求。
  if (file.type.startsWith("image/")) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (event) => {
        const dataUrl = String(event.target?.result || "");
        const parsed = parseImageDataUrl(dataUrl);

        if (!parsed?.data) {
          reject(new Error("图片读取结果无效"));
          return;
        }

        resolve({
          name: file.name,
          type: parsed.mimeType || file.type,
          dataUrl,
          base64: parsed.data,
          size: file.size,
        });
      };

      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
  }

  // PDF 文本层解析。
  if (file.type === "application/pdf") {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
    });
    const pdf = await loadingTask.promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const tokenizedText = await page.getTextContent();
      const pageText = (tokenizedText.items as Array<{ str?: string }>)
        .map((item) => item.str || "")
        .join(" ");
      fullText += `${pageText}\n`;

      if (i % 3 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return {
      name: file.name,
      type: file.type,
      base64: "",
      size: file.size,
      textContent: fullText.trim() || "（未读取到有效文本）",
    };
  }

  // 普通文本 / 代码文件。
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      resolve({
        name: file.name,
        type: file.type,
        base64: "",
        size: file.size,
        textContent: String(event.target?.result || ""),
      });
    };

    reader.onerror = () => reject(new Error("文本读取失败"));
    reader.readAsText(file);
  });
}
