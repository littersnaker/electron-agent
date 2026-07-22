import fs from "fs";
import path from "path";

/**
 * 将用户选择的目录规范化为绝对路径，并在进入持久化层前完成校验。
 *
 * 不能直接对空字符串调用 path.resolve：空字符串会被解析成服务进程目录，
 * 这会把应用自身目录误当成用户项目。
 */
export function normalizeAndValidateWorkspacePath(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("项目根目录不能为空");
  }

  const absolutePath = path.resolve(trimmed);
  assertExistingWorkspaceDirectory(absolutePath);
  return absolutePath;
}

/** 验证已经存入数据库的工作区路径仍然存在且确实是目录。 */
export function assertExistingWorkspaceDirectory(rootPath: string): void {
  if (!fs.existsSync(rootPath)) {
    throw new Error(`项目目录不存在: ${rootPath}`);
  }

  const stat = fs.statSync(rootPath);
  if (!stat.isDirectory()) {
    throw new Error(`项目路径不是目录: ${rootPath}`);
  }
}

/**
 * 比较两个工作区路径是否指向同一位置。
 * Windows 文件系统通常大小写不敏感，因此在 Windows 上统一转成小写比较。
 */
export function areWorkspacePathsEqual(
  leftPath: string,
  rightPath: string,
): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);

  if (process.platform === "win32") {
    return left.toLocaleLowerCase() === right.toLocaleLowerCase();
  }

  return left === right;
}
