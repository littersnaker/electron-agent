/**
 * Compile Electron TypeScript files to JavaScript.
 * Outputs to .electron/ directory.
 */
import { build } from "esbuild";
import path from "path";
import fs from "fs";

const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, ".electron");

async function compile() {
  // Ensure output directory exists
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log("Compiling Electron TypeScript files...");

  await build({
    entryPoints: [
      path.join(rootDir, "electron", "main.ts"),
      path.join(rootDir, "electron", "preload.ts"),
    ],
    bundle: true,
    outdir: outDir,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["electron", "electron-squirrel-startup", "electron-is-dev", "electron-updater"],
    logLevel: "info",
  });

  console.log("Electron TypeScript compiled successfully!");
}

compile().catch((err) => {
  console.error("Failed to compile Electron TypeScript:", err);
  process.exit(1);
});
