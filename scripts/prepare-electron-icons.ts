/**
 * 模块职责：根据 PNG 主图标生成 Windows 安装包需要的 ICO 文件。
 */
import fs from "node:fs";
import path from "node:path";
import pngToIco from "png-to-ico";

const rootDirectory = process.cwd();
const sourcePngPath = path.join(rootDirectory, "public", "icon.png");
const targetIcoPath = path.join(rootDirectory, "public", "icon.ico");

/**
 * 检查 PNG 图标并转换为 ICO；转换失败时让构建立即停止。
 */
async function prepareElectronIcons(): Promise<void> {
  if (!fs.existsSync(sourcePngPath)) {
    throw new Error(`未找到图标源文件：${sourcePngPath}`);
  }
  const icoBuffer = await pngToIco(sourcePngPath);
  fs.writeFileSync(targetIcoPath, icoBuffer);
  console.log(`Windows 图标已生成：${path.relative(rootDirectory, targetIcoPath)}`);
}

prepareElectronIcons().catch((error: unknown) => {
  console.error("图标预处理失败：", error);
  process.exit(1);
});
