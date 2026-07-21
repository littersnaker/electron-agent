/// <reference types="node" />
import fs from "fs";
import path from "path";
import pngToIco from "png-to-ico";

const rootDir = process.cwd();
const sourcePngPath = path.join(rootDir, "public", "icon.png");
const targetIcoPath = path.join(rootDir, "public", "icon.ico");

async function prepareElectronIcons() {
  if (!fs.existsSync(sourcePngPath)) {
    throw new Error(`未找到图标源文件: ${sourcePngPath}`);
  }

  const icoBuffer = await pngToIco(sourcePngPath);
  fs.writeFileSync(targetIcoPath, icoBuffer);

  console.log(`[icons] 已同步 Windows 安装包图标: ${path.relative(rootDir, targetIcoPath)}`);
  console.log(`[icons] 当前统一图标源: ${path.relative(rootDir, sourcePngPath)}`);
}

prepareElectronIcons().catch((error) => {
  console.error("[icons] 图标预处理失败:", error);
  process.exit(1);
});
