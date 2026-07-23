import { NextResponse } from "next/server";
import {
  createProject,
  createSession,
  deleteSession,
  listWorkspace,
  updateSession,
} from "@/app/lib/server/workspace-store";
import type {
  StoredMessage,
  StoredMessageAttachment,
} from "@/app/lib/server/workspace-store";

export const runtime = "nodejs";

type WorkspaceActionBody = Record<string, unknown> & {
  action?: unknown;
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readAttachment(value: unknown): StoredMessageAttachment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = readOptionalString(record.name)?.trim();
  const type = readOptionalString(record.type)?.trim();
  const dataUrl = readOptionalString(record.dataUrl)?.trim();
  const url = readOptionalString(record.url)?.trim();
  const assetKind = record.assetKind;
  const downloadName = readOptionalString(record.downloadName)?.trim();

  if (!name || !type || (!dataUrl && !url)) return null;
  if (dataUrl && !dataUrl.startsWith("data:")) return null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
    } catch {
      return null;
    }
  }

  return {
    name,
    type,
    dataUrl,
    url,
    assetKind:
      assetKind === "image" ||
      assetKind === "video" ||
      assetKind === "file"
        ? assetKind
        : undefined,
    downloadName,
  };
}

function readMessages(value: unknown): StoredMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((item): StoredMessage[] => {
    if (
      !item ||
      typeof item !== "object" ||
      !("role" in item) ||
      (item.role !== "user" && item.role !== "assistant") ||
      !("content" in item) ||
      typeof item.content !== "string"
    ) {
      return [];
    }

    const rawAttachments: unknown[] =
      "attachments" in item && Array.isArray(item.attachments)
        ? item.attachments
        : [];
    const attachments = rawAttachments.flatMap((attachment) => {
      const parsed = readAttachment(attachment);
      return parsed ? [parsed] : [];
    });

    return [
      {
        role: item.role,
        content: item.content,
        attachments: attachments.length ? attachments : undefined,
      },
    ];
  });
}

/** 返回本地持久化的项目和会话列表。 */
export async function GET(): Promise<Response> {
  return NextResponse.json(listWorkspace());
}

/**
 * 统一处理工作区写操作。
 * 媒体结果也通过 messages_json 保存，图片 Data URL 可长期展示，视频保存临时 URL。
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
