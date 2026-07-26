// 模块说明：负责 tool repair 核心服务与领域逻辑。
import { z } from "zod";

export interface RawToolCall {
  id?: string;
  name: string;
  /** 模型原始 arguments，可能是 JSON 字符串，也可能已经是对象。 */
  arguments: unknown;
}

export interface RepairedToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  repaired: boolean;
  repairNotes: string[];
  validationError: string | null;
}

const toolSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  get_local_time: z.object({}).strict(),
  search_project_index: z.object({ query: z.string().min(1) }).strict(),
  list_directory: z
    .object({ dirPath: z.string().optional().default(".") })
    .strict(),
  search_codebase: z.object({ keyword: z.string().min(1) }).strict(),
  read_file_from_disk: z.object({ filePath: z.string().min(1) }).strict(),
  propose_file_change: z
    .object({
      filePath: z.string().min(1),
      fileContent: z.string(),
    })
    .strict(),
  get_diff: z.object({ filePath: z.string().min(1) }).strict(),
  apply_file_change: z.object({ filePath: z.string().min(1) }).strict(),
  run_terminal_command: z.object({ command: z.string().min(1) }).strict(),
};

const argumentAliases: Record<string, Record<string, string>> = {
  search_project_index: {
    keyword: "query",
    text: "query",
    search: "query",
  },
  list_directory: {
    path: "dirPath",
    directory: "dirPath",
    directoryPath: "dirPath",
  },
  search_codebase: {
    query: "keyword",
    text: "keyword",
    search: "keyword",
  },
  read_file_from_disk: {
    path: "filePath",
    filename: "filePath",
    file: "filePath",
  },
  propose_file_change: {
    path: "filePath",
    filename: "filePath",
    content: "fileContent",
    newContent: "fileContent",
  },
  get_diff: {
    path: "filePath",
    filename: "filePath",
  },
  apply_file_change: {
    path: "filePath",
    filename: "filePath",
  },
  run_terminal_command: {
    cmd: "command",
    shell: "command",
  },
};

function normalizeToolName(name: string, availableToolNames: readonly string[]): {
  name: string;
  repaired: boolean;
  note: string | null;
} {
  const trimmed = name.trim();
  if (availableToolNames.includes(trimmed)) {
    return { name: trimmed, repaired: false, note: null };
  }

  const normalized = trimmed.toLowerCase().replace(/[-\s]/gu, "_");
  const exactNormalized = availableToolNames.find(
    (candidate) => candidate.toLowerCase().replace(/[-\s]/gu, "_") === normalized,
  );
  if (exactNormalized) {
    return {
      name: exactNormalized,
      repaired: true,
      note: `工具名已从 ${trimmed} 规范化为 ${exactNormalized}。`,
    };
  }

  return { name: trimmed, repaired: false, note: null };
}

/**
 * 只做可预测、低风险的 JSON 修复。
 *
 * 不使用 eval，也不会把任意字符串当作代码执行；无法可靠修复时返回空对象并让
 * schema 校验给模型一个明确错误，使下一轮可以自行纠正。
 */
function parseArguments(value: unknown): {
  args: Record<string, unknown>;
  repaired: boolean;
  note: string | null;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      args: { ...(value as Record<string, unknown>) },
      repaired: false,
      note: null,
    };
  }

  const source = typeof value === "string" ? value.trim() : "";
  if (!source) {
    return { args: {}, repaired: false, note: null };
  }

  const withoutMarkdownFence = source
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const candidates = [
    source,
    withoutMarkdownFence,
    withoutMarkdownFence
      .replace(/[“”]/gu, '"')
      .replace(/[‘’]/gu, '"')
      .replace(/,\s*([}\]])/gu, "$1"),
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const parsed = JSON.parse(candidates[index]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          args: parsed as Record<string, unknown>,
          repaired: index > 0,
          note:
            index > 0
              ? "工具参数中的 Markdown 包裹、中文引号或尾随逗号已自动修复。"
              : null,
        };
      }
    } catch {
      // 继续尝试下一个保守候选，不在这里吞掉最终校验错误。
    }
  }

  return {
    args: {},
    repaired: true,
    note: "工具参数不是合法 JSON 对象，已降级为空对象并交由 Schema 返回错误。",
  };
}

function applyArgumentAliases(
  toolName: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; notes: string[] } {
  const aliases = argumentAliases[toolName] || {};
  const repairedArgs = { ...args };
  const notes: string[] = [];

  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!(alias in repairedArgs) || canonical in repairedArgs) continue;
    repairedArgs[canonical] = repairedArgs[alias];
    delete repairedArgs[alias];
    notes.push(`参数 ${alias} 已映射为 ${canonical}。`);
  }

  return { args: repairedArgs, notes };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue: z.ZodError["issues"][number]) => {
      const path = issue.path.length ? issue.path.join(".") : "参数对象";
      return `${path}: ${issue.message}`;
    })
    .join("；");
}

/**
 * 对模型生成的工具调用进行“解析 -> 别名修复 -> Schema 校验”。
 *
 * MCP 工具使用服务器返回的 JSON Schema，当前由 MCP 层在实际调用前再次校验；
 * 本模块对内置工具提供更严格的 Zod 校验和常见字段别名修复。
 */
export function repairToolCall(
  rawCall: RawToolCall,
  availableToolNames: readonly string[],
): RepairedToolCall {
  const normalizedName = normalizeToolName(rawCall.name, availableToolNames);
  const parsed = parseArguments(rawCall.arguments);
  const aliased = applyArgumentAliases(normalizedName.name, parsed.args);
  const repairNotes = [
    normalizedName.note,
    parsed.note,
    ...aliased.notes,
  ].filter((note): note is string => Boolean(note));
  const schema = toolSchemas[normalizedName.name];

  if (!schema) {
    return {
      id: rawCall.id,
      name: normalizedName.name,
      args: aliased.args,
      repaired:
        normalizedName.repaired || parsed.repaired || aliased.notes.length > 0,
      repairNotes,
      validationError: null,
    };
  }

  const validation = schema.safeParse(aliased.args);
  if (!validation.success) {
    return {
      id: rawCall.id,
      name: normalizedName.name,
      args: aliased.args,
      repaired:
        normalizedName.repaired || parsed.repaired || aliased.notes.length > 0,
      repairNotes,
      validationError: formatZodError(validation.error),
    };
  }

  return {
    id: rawCall.id,
    name: normalizedName.name,
    args: validation.data,
    repaired:
      normalizedName.repaired || parsed.repaired || aliased.notes.length > 0,
    repairNotes,
    validationError: null,
  };
}
