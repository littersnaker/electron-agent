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
import type { CommerceResearchReport } from "@/app/lib/commerce/types";

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


function readCommerceReport(value: unknown): CommerceResearchReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.query !== "string" ||
    typeof raw.marketplace !== "string" ||
    !raw.category ||
    !raw.metrics ||
    !raw.insights ||
    !Array.isArray(raw.products)
  ) {
    return undefined;
  }

  if ((raw.version === 2 || raw.version === 3) && Array.isArray(raw.sources)) {
    return raw as unknown as CommerceResearchReport;
  }

  // v6 以前的单 Amazon 数据源报告仍按 v2 兼容读取；v9 新报告使用 v3。
  if (raw.version === 1) {
    const legacyDataSource =
      raw.dataSource && typeof raw.dataSource === "object"
        ? (raw.dataSource as Record<string, unknown>)
        : {};
    return {
      ...(raw as unknown as Omit<CommerceResearchReport, "version" | "sources" | "confidenceScore">),
      version: 2,
      sources: [
        {
          id: "amazon",
          label: "Amazon",
          status: "collected",
          provider:
            typeof legacyDataSource.provider === "string"
              ? (legacyDataSource.provider as CommerceResearchReport["sources"][number]["provider"])
              : undefined,
          quality:
            legacyDataSource.quality === "high" ||
            legacyDataSource.quality === "medium" ||
            legacyDataSource.quality === "low"
              ? legacyDataSource.quality
              : "low",
          sampleSize: raw.products.length,
          coverage: ["历史单源报告"],
          summary: "该报告由旧版本生成，仅包含 Amazon 单源数据。",
          warnings: [],
        },
      ],
      confidenceScore: 55,
    };
  }

  return undefined;
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

    const commerceReport =
      "commerceReport" in item
        ? readCommerceReport(item.commerceReport)
        : undefined;

    return [
      {
        role: item.role,
        content: item.content,
        attachments: attachments.length ? attachments : undefined,
        commerceReport,
      },
    ];
  });
}

/**
 * 返回本地持久化工作区。Code / Commerce 会话按插件开关按需查询，避免核心 QA
 * 启动时反序列化大量低频 Agent 历史。
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return NextResponse.json(
    listWorkspace({
      includeCode: url.searchParams.get("code") === "1",
      includeCommerce: url.searchParams.get("commerce") === "1",
    }),
  );
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
          mode:
            body.mode === "code"
              ? "code"
              : body.mode === "commerce"
                ? "commerce"
                : "qa",
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
