// 模块说明：负责 route 接口及服务端流程。
import { NextResponse } from "next/server";
import { indexProject } from "@/app/lib/server/workspace-store";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    return NextResponse.json(await indexProject(projectId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Indexing failed" }, { status: 400 });
  }
}
