/**
 * 模块职责：使用 esbuild 把 Electron TypeScript 主进程代码编译为 CommonJS。
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const rootDirectory = path.resolve(__dirname, "..");
const outputDirectory = path.join(rootDirectory, ".electron");

/**
 * 创建输出目录并编译 main/preload 两个 Electron 入口。
 */
async function compileElectron(): Promise<void> {
  fs.mkdirSync(outputDirectory, { recursive: true });
  console.log("正在编译 Electron TypeScript...");

  await build({
    entryPoints: [
      path.join(rootDirectory, "electron", "main.ts"),
      path.join(rootDirectory, "electron", "preload.ts"),
    ],
    bundle: true,
    outdir: outputDirectory,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["electron"],
    logLevel: "info",
  });

  console.log("Electron TypeScript 编译完成。 ");
}

compileElectron().catch((error: unknown) => {
  console.error("Electron 编译失败：", error);
  process.exit(1);
});
