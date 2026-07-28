import fs from "node:fs";
import path from "node:path";

const rootDirectory = process.cwd();
const releaseDirectories = [
  "release",
  ".electron",
  "out-server",
] as const;

for (const directoryName of releaseDirectories) {
  const target = path.join(rootDirectory, directoryName);
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`已清理 ${directoryName}`);
}
