/**
 * 模块职责：删除所有可重复生成的构建目录，保证安装包不会混入旧产物。
 */
import fs from "node:fs";
import path from "node:path";

const rootDirectory = process.cwd();
const releaseDirectories = [
  "release",
  ".electron",
  "dist",
  "python-dist",
  ".python-build",
  ".python-spec",
] as const;

/**
 * 删除一个构建目录；目录不存在时不会报错。
 */
function removeBuildDirectory(directoryName: string): void {
  const target = path.join(rootDirectory, directoryName);
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`已清理 ${directoryName}`);
}

/**
 * 依次清理全部前端、Electron、Python 和安装包产物。
 */
function main(): void {
  releaseDirectories.forEach(removeBuildDirectory);
}

main();
