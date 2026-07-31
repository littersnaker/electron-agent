"use client";

import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import type {
  AmazonListingDraft,
  AmazonListingValidation,
} from "../../../lib/commerce/listing/types";

function fieldIssueCount(
  validation: AmazonListingValidation,
  field: AmazonListingValidation["issues"][number]["field"],
): number {
  return validation.issues.filter((issue) => issue.field === field).length;
}

function FieldHeader({
  label,
  count,
  limit,
  issues,
}: {
  label: string;
  count?: number;
  limit?: number;
  issues: number;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <div className="text-[10px] font-semibold text-[var(--text-secondary)]">
        {label}
        {issues > 0 && (
          <span className="ml-1.5 rounded-full bg-[rgba(255,159,10,0.12)] px-1.5 py-0.5 text-[8px] text-[#ff9f0a]">
            {issues} 项提示
          </span>
        )}
      </div>
      {typeof count === "number" && typeof limit === "number" && (
        <span
          className="font-mono text-[8px]"
          style={{ color: count > limit ? "#ff453a" : "var(--text-quaternary)" }}
        >
          {count}/{limit}
        </span>
      )}
    </div>
  );
}

export function ListingEditor({
  draft,
  setDraft,
  validation,
}: {
  draft: AmazonListingDraft;
  setDraft: Dispatch<SetStateAction<AmazonListingDraft>>;
  validation: AmazonListingValidation;
}) {
  const updateBullet = (index: number, value: string) => {
    setDraft((current: AmazonListingDraft) => ({
      ...current,
      bulletPoints: current.bulletPoints.map((bullet: string, bulletIndex: number) =>
        bulletIndex === index ? value : bullet,
      ),
    }));
  };

  return (
    <div className="space-y-3">
      <div>
        <FieldHeader
          label="Title"
          count={draft.title.length}
          limit={validation.titleMaxCharacters}
          issues={fieldIssueCount(validation, "title")}
        />
        <textarea
          value={draft.title}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            setDraft((current: AmazonListingDraft) => ({
              ...current,
              title: event.target.value,
            }))
          }
          rows={2}
          className="w-full resize-y rounded-[12px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--text-primary)] outline-none focus:border-[rgba(10,132,255,0.38)]"
        />
      </div>

      <div>
        <FieldHeader
          label="Bullet Points"
          issues={fieldIssueCount(validation, "bulletPoints")}
        />
        <div className="space-y-2">
          {draft.bulletPoints.map((bullet, index) => (
            <div key={`bullet-${index + 1}`} className="flex gap-2">
              <span className="mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgba(10,132,255,0.12)] text-[8px] font-semibold text-[#64b5ff]">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <textarea
                  value={bullet}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                    updateBullet(index, event.target.value)
                  }
                  rows={3}
                  className="w-full resize-y rounded-[12px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2 text-[10px] leading-5 text-[var(--text-primary)] outline-none focus:border-[rgba(10,132,255,0.38)]"
                />
                <div className="mt-0.5 text-right font-mono text-[8px] text-[var(--text-quaternary)]">
                  {bullet.length}/{validation.bulletMaximumCharacters}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <FieldHeader
          label="Product Description"
          issues={fieldIssueCount(validation, "productDescription")}
        />
        <textarea
          value={draft.productDescription}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            setDraft((current: AmazonListingDraft) => ({
              ...current,
              productDescription: event.target.value,
            }))
          }
          rows={6}
          className="w-full resize-y rounded-[12px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2 text-[10px] leading-5 text-[var(--text-primary)] outline-none focus:border-[rgba(10,132,255,0.38)]"
        />
      </div>

      <div>
        <FieldHeader
          label="Backend Search Terms"
          count={new TextEncoder().encode(draft.searchTerms).length}
          limit={validation.backendSearchTermMaximumBytes}
          issues={fieldIssueCount(validation, "searchTerms")}
        />
        <textarea
          value={draft.searchTerms}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            setDraft((current: AmazonListingDraft) => ({
              ...current,
              searchTerms: event.target.value,
            }))
          }
          rows={3}
          className="w-full resize-y rounded-[12px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2 text-[10px] leading-5 text-[var(--text-primary)] outline-none focus:border-[rgba(10,132,255,0.38)]"
        />
      </div>
    </div>
  );
}
