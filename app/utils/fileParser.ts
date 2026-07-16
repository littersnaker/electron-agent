// src/app/utils/fileParser.ts
import { AttachedFile } from "../const/pageConst";

export async function parseSelectedFile(file: File): Promise<AttachedFile> {
  // 1. 解析图片
  if (file.type.startsWith("image/")) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        resolve({
          name: file.name,
          type: file.type,
          base64: event.target?.result as string,
        });
      };
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
  }

  // 2. 深度解析 PDF 
  if (file.type === "application/pdf") {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
    });
    const pdf = await loadingTask.promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tokenizedText = await page.getTextContent();
      const pageText = (tokenizedText.items as Array<{ str?: string }>)
        .map((item) => item.str || "")
        .join(" ");
      fullText += pageText + "\n";
      // 每 3 页让出一次主线程，防止大 PDF 阻塞 UI
      if (i % 3 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return {
      name: file.name,
      type: file.type,
      base64: "",
      textContent: fullText.trim() || "（未读取到有效文本）",
    };
  }

  // 3. 解析普通文本/代码文件
  return new Promise((resolve, reject) => {
    const textReader = new FileReader();
    textReader.onload = (textEvent) => {
      resolve({
        name: file.name,
        type: file.type,
        base64: "",
        textContent: textEvent.target?.result as string,
      });
    };
    textReader.onerror = () => reject(new Error("文本读取失败"));
    textReader.readAsText(file);
  });
}