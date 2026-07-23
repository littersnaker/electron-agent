import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_HOST_SUFFIXES = [
  ".aliyuncs.com",
  ".alicdn.com",
  ".aliyun.com",
];

function isAllowedRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return ALLOWED_HOST_SUFFIXES.some(
      (suffix) =>
        url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix),
    );
  } catch {
    return false;
  }
}

function safeFileName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 120);
  return normalized || "generated-media";
}

/**
 * 同源下载代理。
 * 百炼视频结果通常是跨域临时 URL，浏览器的 download 属性可能失效；
 * 通过本 Route 转发并设置 Content-Disposition，确保用户能直接保存。
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const remoteUrl = url.searchParams.get("url") || "";
  const fileName = safeFileName(url.searchParams.get("name") || "generated-media");

  if (!isAllowedRemoteUrl(remoteUrl)) {
    return NextResponse.json({ error: "不允许下载该远程地址" }, { status: 400 });
  }

  try {
    const remoteResponse = await fetch(remoteUrl, { cache: "no-store" });
    if (!remoteResponse.ok || !remoteResponse.body) {
      return NextResponse.json(
        { error: `远程文件下载失败（HTTP ${remoteResponse.status}）` },
        { status: 502 },
      );
    }

    return new Response(remoteResponse.body, {
      headers: {
        "Content-Type":
          remoteResponse.headers.get("content-type") ||
          "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "远程文件下载失败",
      },
      { status: 502 },
    );
  }
}
