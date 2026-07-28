/**
 * 模块职责：项目文件索引、符号提取与索引检索。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { assertExistingWorkspaceDirectory } from "../workspace-path";
import { type ProjectRow, getDatabase, now } from "./workspace-database";
export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "build",
  "out",
  "out-server",
  "release",
  "coverage",
  ".pnpm-store",
]);

export const INDEXED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".yml",
  ".yaml",
  ".sql",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".vue",
]);

export const MAX_FILE_SIZE = 512 * 1024;

export const MAX_INDEXED_FILES = 6000;

export function languageFor(filePath: string): string {
  return path.extname(filePath).slice(1) || "text";
}

export function extractSymbols(
  content: string,
): Array<{ name: string; kind: string; line: number }> {
  const results: Array<{ name: string; kind: string; line: number }> = [];
  const pattern =
    /^\s*(?:export\s+)?(?:default\s+)?(function|class|interface|type|enum|const)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of content.matchAll(pattern)) {
    const offset = match.index || 0;
    results.push({
      name: match[2],
      kind: match[1],
      line: content.slice(0, offset).split("\n").length,
    });
  }
  return results;
}

export function collectFiles(rootPath: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    if (files.length >= MAX_INDEXED_FILES) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= MAX_INDEXED_FILES) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name))
          walk(path.join(directory, entry.name));
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      if (INDEXED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        files.push(fullPath);
    }
  };
  walk(rootPath);
  return files;
}

export async function indexProject(
  projectId: string,
): Promise<{ indexedFileCount: number }> {
  const db = getDatabase();
  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as unknown as ProjectRow | undefined;
  if (!project) throw new Error("项目不存在");
  assertExistingWorkspaceDirectory(project.root_path);

  db.prepare("UPDATE projects SET index_status = 'indexing' WHERE id = ?").run(
    projectId,
  );
  try {
    const filePaths = collectFiles(project.root_path);
    const indexed = await Promise.all(
      filePaths.map(async (fullPath) => {
        const stat = await fs.promises.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) return null;
        const content = await fs.promises.readFile(fullPath, "utf8");
        return {
          relativePath: path
            .relative(project.root_path, fullPath)
            .replaceAll("\\", "/"),
          content,
          hash: createHash("sha256").update(content).digest("hex"),
          modifiedAtMs: Math.floor(stat.mtimeMs),
          size: stat.size,
        };
      }),
    );

    const write = () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM file_index WHERE project_id = ?").run(
          projectId,
        );
        db.prepare("DELETE FROM symbol_index WHERE project_id = ?").run(
          projectId,
        );
        db.prepare("DELETE FROM code_content WHERE project_id = ?").run(
          projectId,
        );
        const insertFile = db.prepare(
          "INSERT INTO file_index (project_id, file_path, content_hash, language, modified_at_ms, size_bytes) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const insertSymbol = db.prepare(
          "INSERT INTO symbol_index (project_id, file_path, symbol_name, symbol_kind, line_number) VALUES (?, ?, ?, ?, ?)",
        );
        const insertContent = db.prepare(
          "INSERT INTO code_content (project_id, file_path, content) VALUES (?, ?, ?)",
        );
        let count = 0;
        for (const item of indexed) {
          if (!item) continue;
          count += 1;
          insertFile.run(
            projectId,
            item.relativePath,
            item.hash,
            languageFor(item.relativePath),
            item.modifiedAtMs,
            item.size,
          );
          insertContent.run(projectId, item.relativePath, item.content);
          for (const symbol of extractSymbols(item.content)) {
            insertSymbol.run(
              projectId,
              item.relativePath,
              symbol.name,
              symbol.kind,
              symbol.line,
            );
          }
        }
        db.prepare(
          "UPDATE projects SET index_status = 'ready', indexed_file_count = ?, last_opened_at = ? WHERE id = ?",
        ).run(count, now(), projectId);
        db.exec("COMMIT");
        return count;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    return { indexedFileCount: write() };
  } catch (error) {
    db.prepare("UPDATE projects SET index_status = 'error' WHERE id = ?").run(
      projectId,
    );
    throw error;
  }
}

export function searchProjectIndex(
  projectId: string,
  query: string,
): Array<{ filePath: string; snippet: string }> {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', ""))
    .filter(Boolean);
  if (terms.length === 0) return [];
  const where = terms.map(() => "content LIKE ?").join(" AND ");
  const rows = getDatabase()
    .prepare(
      `SELECT file_path, content FROM code_content WHERE project_id = ? AND ${where} LIMIT 12`,
    )
    .all(projectId, ...terms.map((term) => `%${term}%`)) as unknown as Array<{
    file_path: string;
    content: string;
  }>;
  return rows.map((row) => {
    const index = row.content.toLowerCase().indexOf(terms[0].toLowerCase());
    const start = Math.max(0, index - 120);
    return {
      filePath: row.file_path,
      snippet: row.content.slice(start, start + 360),
    };
  });
}
