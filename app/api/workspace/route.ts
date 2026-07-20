import { NextResponse } from "next/server";
import {
  createProject,
  createSession,
  deleteSession,
  listWorkspace,
  updateSession,
} from "@/app/lib/server/workspace-store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(listWorkspace());
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "createProject") {
      return NextResponse.json({ project: createProject(String(body.rootPath || "")) });
    }
    if (body.action === "createSession") {
      return NextResponse.json({
        session: createSession({
          mode: body.mode === "code" ? "code" : "qa",
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          title: typeof body.title === "string" ? body.title : undefined,
          messages: Array.isArray(body.messages) ? body.messages as never[] : undefined,
        }),
      });
    }
    if (body.action === "updateSession") {
      return NextResponse.json({
        session: updateSession({
          id: String(body.id || ""),
          title: String(body.title || "新对话"),
          messages: Array.isArray(body.messages) ? body.messages as never[] : [],
        }),
      });
    }
    if (body.action === "deleteSession") {
      deleteSession(String(body.id || ""));
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unsupported workspace action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace operation failed" }, { status: 400 });
  }
}
