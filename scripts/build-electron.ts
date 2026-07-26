/// <reference types="node" />
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const rootDir = process.cwd();
const nextDistDirName = ".next-electron";
const nextDistDir = path.join(rootDir, nextDistDirName);
const standaloneSource = path.join(nextDistDir, "standalone");
const staticSource = path.join(nextDistDir, "static");
const outServerRoot = path.join(rootDir, "out-server");
const outServerDir = path.join(outServerRoot, "standalone");

/** 执行项目命令，并把子进程输出同步到当前终端。 */
function runCommand(command: string): void {
  execSync(command, {
    stdio: "inherit",
    cwd: rootDir,
    env: process.env,
  });
}

/** 校验 Next.js standalone 构建产物是否完整。 */
function assertStandaloneBuild(): void {
  const serverEntry = path.join(standaloneSource, "server.js");

  if (!fs.existsSync(standaloneSource)) {
    throw new Error(
      `${nextDistDirName}/standalone 目录不存在，请确认 next.config.ts 同时配置了 output: "standalone" 和 distDir: "${nextDistDirName}"。`,
    );
  }

  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `${nextDistDirName}/standalone/server.js 不存在，Next.js standalone 构建不完整。`,
    );
  }

  if (!fs.existsSync(staticSource)) {
    throw new Error(
      `${nextDistDirName}/static 目录不存在，Next.js 静态资源构建不完整。`,
    );
  }
}

/** 将 standalone、静态资源和 public 整理到 Electron 资源目录。 */
function prepareStandaloneRuntime(): void {
  fs.rmSync(outServerRoot, { recursive: true, force: true });
  fs.mkdirSync(outServerDir, { recursive: true });

  fs.cpSync(standaloneSource, outServerDir, {
    recursive: true,
    dereference: true,
  });

  // server.js 会按照自定义 distDir 查找静态资源。
  const destinationStatic = path.join(
    outServerDir,
    nextDistDirName,
    "static",
  );
  fs.mkdirSync(destinationStatic, { recursive: true });
  fs.cpSync(staticSource, destinationStatic, { recursive: true });

  const sourcePublic = path.join(rootDir, "public");
  if (fs.existsSync(sourcePublic)) {
    fs.cpSync(sourcePublic, path.join(outServerDir, "public"), {
      recursive: true,
    });
  }

  copyEnvironmentFile();
}

/** 将本机环境变量文件复制到内嵌 Next.js 服务目录。 */
function copyEnvironmentFile(): void {
  const sourceEnvLocal = path.join(rootDir, ".env.local");
  if (!fs.existsSync(sourceEnvLocal)) {
    console.warn(
      "未找到项目根目录 .env.local，打包后的应用将依赖系统环境变量。",
    );
    return;
  }

  fs.cpSync(sourceEnvLocal, path.join(outServerDir, ".env.local"));
  console.log("已复制 .env.local 到 standalone 运行目录。");
}

try {
  console.log("=== Step 1: 编译 Electron 主进程 TypeScript ===");
  runCommand("pnpm electron:compile");

  console.log(
    "\n=== Step 2: 构建 Next.js 前端项目 (.next-electron / Standalone) ===",
  );
  runCommand("pnpm run build");

  console.log("\n=== Step 3: 校验并整理 Next.js 生产服务文件 ===");
  assertStandaloneBuild();
  prepareStandaloneRuntime();

  console.log("\n✅ Electron 打包资源准备完成。");
  console.log(
    "后续 electron-builder 会由 package.json 脚本显式读取 electron-builder.yml。",
  );
} catch (error) {
  console.error("\n❌ 构建资源准备过程中发生错误:", error);
  process.exit(1);
}
