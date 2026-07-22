import { NextResponse } from "next/server";
import {
  createProject,
  createSession,
  deleteSession,
  listWorkspace,
  updateSession,
} from "@/app/lib/server/workspace-store";
import type { StoredMessage } from "@/app/lib/server/workspace-store";

export const runtime = "nodejs";

type WorkspaceActionBody = Record<string, unknown> & {
  action?: unknown;
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readMessages(value: unknown): StoredMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.filter((item): item is StoredMessage =>
    Boolean(
      item &&
        typeof item === "object" &&
        "role" in item &&
        (item.role === "user" || item.role === "assistant") &&
        "content" in item &&
        typeof item.content === "string",
    ),
  );
}

/** 返回本地持久化的项目和会话列表。 */
export async function GET(): Promise<Response> {
  return NextResponse.json(listWorkspace());
}

/**
 * 统一处理工作区写操作。
 *
 * 路径的存在性与目录类型由 workspace-store 再次校验，Route 层只负责
 * 拒绝明显缺失的参数，并把外部 unknown 数据转换成稳定类型。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as WorkspaceActionBody;

    if (body.action === "createProject") {
      const rootPath = readOptionalString(body.rootPath)?.trim() ?? "";
      if (!rootPath) {
        return NextResponse.json(
          { error: "项目根目录不能为空" },
          { status: 400 },
        );
      }

      return NextResponse.json({ project: createProject(rootPath) });
    }

    if (body.action === "createSession") {
      return NextResponse.json({
        session: createSession({
          mode: body.mode === "code" ? "code" : "qa",
          projectId: readOptionalString(body.projectId) ?? null,
          title: readOptionalString(body.title),
          messages: readMessages(body.messages),
        }),
      });
    }

    if (body.action === "updateSession") {
      return NextResponse.json({
        session: updateSession({
          id: readOptionalString(body.id) ?? "",
          title: readOptionalString(body.title) ?? "新对话",
          messages: readMessages(body.messages) ?? [],
        }),
      });
    }

    if (body.action === "deleteSession") {
      deleteSession(readOptionalString(body.id) ?? "");
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { error: "Unsupported workspace action" },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Workspace operation failed",
      },
      { status: 400 },
    );
  }
}
