/**
 * 模块职责：为开发版和安装版提供一致的应用数据目录，并迁移旧版本数据。
 *
 * 旧代码直接使用 app.getPath("userData")。Electron 会根据应用名称生成该目录，
 * 因而开发运行、改名后的安装包和不同构建配置可能读到三个位置。这里改用 appData
 * 下的固定目录，确保 SQLite、偏好和凭证在重启或升级后仍落到同一位置。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const STABLE_DATA_DIRECTORY = "Multi-agent";
const MIGRATION_MARKER = ".storage-migration-v2";

/** 返回不受开发/打包应用名称影响的固定数据根目录。 */
export function getStableDataRoot(): string {
  return path.join(app.getPath("appData"), STABLE_DATA_DIRECTORY);
}

/** 在固定数据根目录中拼接文件或子目录。 */
export function getStableDataPath(...segments: string[]): string {
  return path.join(getStableDataRoot(), ...segments);
}

/** 仅在目标不存在时复制旧文件，绝不覆盖用户已经产生的新数据。 */
function copyFileWhenMissing(source: string, target: string): boolean {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

/** 递归合并旧目录，但绝不覆盖目标中已经存在的文件。 */
function mergeDirectoryWhenMissing(source: string, target: string): boolean {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return false;
  fs.mkdirSync(target, { recursive: true });
  let migrated = false;

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      migrated = mergeDirectoryWhenMissing(sourcePath, targetPath) || migrated;
    } else if (entry.isFile()) {
      migrated = copyFileWhenMissing(sourcePath, targetPath) || migrated;
    }
  }
  return migrated;
}

/**
 * 把旧版 userData 或开发目录中的 SQLite/偏好数据迁移到固定目录。
 *
 * 迁移采用“只补缺、不覆盖”的策略。即使某个旧目录损坏，也不会阻断应用启动；
 * 失败信息只写入控制台，用户仍可进入应用并重新配置。
 */
export function migrateLegacyApplicationData(): void {
  const stableRoot = getStableDataRoot();
  const markerPath = path.join(stableRoot, MIGRATION_MARKER);
  if (fs.existsSync(markerPath)) return;

  fs.mkdirSync(stableRoot, { recursive: true });
  const oldUserData = app.getPath("userData");
  const legacyDataDirectories = [
    // 旧 Electron 版本显式把 FastAPI 数据放在 userData/python-data。
    path.join(oldUserData, "python-data"),
    // 单独运行 Python 后端时，默认数据库直接位于项目 .local-data。
    path.join(process.cwd(), ".local-data"),
  ].filter((candidate, index, values) => {
    const normalized = path.resolve(candidate);
    return (
      normalized !== path.resolve(stableRoot, "python-data") &&
      values.findIndex((value) => path.resolve(value) === normalized) === index
    );
  });

  let migrated = false;
  for (const legacyDataDirectory of legacyDataDirectories) {
    try {
      migrated =
        mergeDirectoryWhenMissing(
          legacyDataDirectory,
          path.join(stableRoot, "python-data"),
        ) || migrated;
    } catch (error) {
      console.warn(
        `[Electron] 迁移旧数据库目录失败：${legacyDataDirectory}`,
        error,
      );
    }
  }

  try {
    migrated =
      copyFileWhenMissing(
        path.join(oldUserData, "app-preferences.json"),
        path.join(stableRoot, "app-preferences.json"),
      ) || migrated;
  } catch (error) {
    console.warn("[Electron] 迁移旧界面偏好失败", error);
  }

  try {
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({ migrated, updatedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    if (migrated) {
      console.info(`[Electron] 已迁移旧版应用数据到：${stableRoot}`);
    }
  } catch (error) {
    // 标记文件写入失败不应阻断启动；下次启动会再次执行“只补缺”迁移。
    console.warn("[Electron] 无法写入数据迁移标记", error);
  }
}
