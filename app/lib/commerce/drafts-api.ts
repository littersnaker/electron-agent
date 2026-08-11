// Listing 草稿的后端交互：保存、确认、驳回。
// 草稿在 Listing 生成时已自动落库（报告中的 draftId），
// 这里的保存用于把用户在编辑器中修改后的内容回写数据库。

import { apiFetch } from "../api-client";
import type { AmazonListingDraft } from "./listing/types";

export type ListingDraftStatus = "pending" | "confirmed" | "rejected";

export interface ListingDraftRecord {
  id: string;
  sessionId: string;
  query: string;
  marketplace: string;
  draft: AmazonListingDraft;
  source: "template" | "llm";
  status: ListingDraftStatus;
  notes: string;
  createdAt: string;
  confirmedAt: string | null;
  updatedAt: string | null;
}

/** 把当前编辑内容保存回草稿；返回 false 表示草稿不存在（可能已被删除）。 */
export async function saveListingDraft(
  draftId: string,
  draft: AmazonListingDraft,
  notes = "",
): Promise<void> {
  const response = await apiFetch(`/api/commerce/listing/drafts/${encodeURIComponent(draftId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, notes }),
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail || `保存草稿失败（HTTP ${response.status}）`);
  }
}

/** 人工确认草稿（终态，确认后不可再编辑）。 */
export async function confirmListingDraft(draftId: string): Promise<void> {
  const response = await apiFetch(
    `/api/commerce/listing/drafts/${encodeURIComponent(draftId)}/confirm`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error((await readErrorDetail(response)) || `确认草稿失败（HTTP ${response.status}）`);
  }
}

/** 驳回草稿（终态，驳回后不可再编辑）。 */
export async function rejectListingDraft(draftId: string): Promise<void> {
  const response = await apiFetch(
    `/api/commerce/listing/drafts/${encodeURIComponent(draftId)}/reject`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error((await readErrorDetail(response)) || `驳回草稿失败（HTTP ${response.status}）`);
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // 响应体不是 JSON 时忽略，使用默认错误文案。
  }
  return "";
}
