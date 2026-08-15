"use client";
/**
 * 检索效果评估弹窗：输入“问题 | 期望文档”测试集，一键计算召回率/精确率/F1。
 */
import { useState } from "react";
import { apiFetch } from "../../lib/api-client";

interface EvalSource {
  sourcePath: string;
  position?: string;
  score?: number;
}

interface EvalCaseResult {
  question: string;
  expect: string;
  hit: boolean;
  matchedSources: EvalSource[];
  topSources: EvalSource[];
  avgScore: number;
}

interface EvalResult {
  recallK: number;
  topK: number;
  totalCases: number;
  hits: number;
  recallRate: number;
  precisionRate: number;
  f1: number;
  avgScore: number;
  cases: EvalCaseResult[];
}

interface KnowledgeEvalModalProps {
  /** 是否显示弹窗 */
  open: boolean;
  /** 请求头使用的 Jina API Key */
  jinaKey: string;
  /** 关闭弹窗的回调 */
  onClose: () => void;
}

const PLACEHOLDER = `每行一条：问题 | 期望命中的文档路径（片段即可）

登录超时怎么排查 | auth.py
退款政策是什么 | manual.pdf
商品上架流程 | listing.md`;

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function sourceLabel(source: EvalSource): string {
  const name = source.sourcePath.split("/").pop() || source.sourcePath;
  return source.position ? `${name}（${source.position}）` : name;
}

/** 检索效果评估弹窗。 */
export default function KnowledgeEvalModal({ open, jinaKey, onClose }: KnowledgeEvalModalProps) {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [error, setError] = useState("");

  if (!open) return null;

  /** 解析文本为测试用例：每行“问题 | 期望路径”。 */
  const parseCases = () => {
    return text
      .split(/\r?\n/)
      .map((line) => {
        const [question, expect] = line.split("|").map((item) => item.trim());
        return question && expect ? { question, expect } : null;
      })
      .filter((item): item is { question: string; expect: string } => item !== null);
  };

  /** 调用后端逐题评估。 */
  const runEvaluation = async () => {
    const cases = parseCases();
    if (cases.length === 0) {
      setError("请至少输入一条“问题 | 期望文档”测试用例");
      return;
    }
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const response = await apiFetch("/api/knowledge/evaluate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-jina-api-key": jinaKey.trim(),
        },
        body: JSON.stringify({ cases }),
      });
      const payload = (await response.json()) as EvalResult & { detail?: string };
      if (!response.ok) {
        throw new Error(payload.detail || "评估失败");
      }
      setResult(payload);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "评估失败";
      setError(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[20px] border shadow-2xl"
        style={{
          background: "var(--glass-solid)",
          borderColor: "var(--border)",
          color: "var(--text-primary)",
        }}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-5 py-3.5"
          style={{ borderColor: "var(--border)" }}
        >
          <div>
            <h2 className="text-[14px] font-semibold">检索效果评估</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              用标注测试集计算向量检索的召回率 / 精确率 / F1
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[10px] border transition-colors hover:bg-[var(--glass-hover)]"
            style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
            aria-label="关闭"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
              <path
                d="m5.5 5.5 9 9M14.5 5.5l-9 9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={PLACEHOLDER}
            rows={7}
            disabled={running}
            className="w-full resize-y rounded-[12px] border bg-[var(--glass-black)] px-3 py-2.5 text-[12px] leading-5 outline-none transition-colors placeholder:text-[var(--text-tertiary)]"
            style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
          />

          <div className="mt-3 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void runEvaluation()}
              disabled={running}
              className="flex h-9 cursor-pointer items-center gap-2 rounded-[10px] px-4 text-[12px] font-medium transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: "var(--accent-blue)", color: "#ffffff" }}
            >
              {running && (
                <svg
                  viewBox="0 0 20 20"
                  className="h-3.5 w-3.5 animate-spin"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="10"
                    cy="10"
                    r="7"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeDasharray="30 14"
                    strokeLinecap="round"
                  />
                </svg>
              )}
              {running ? "评估中…" : "开始评估"}
            </button>
            {running && (
              <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                正在逐题执行向量召回 + 重排，请稍候…
              </span>
            )}
          </div>

          {error && (
            <p
              className="mt-3 rounded-[10px] border px-3 py-2 text-[11px]"
              style={{
                borderColor: "rgba(255,69,58,0.28)",
                background: "rgba(255,69,58,0.08)",
                color: "#ff6961",
              }}
            >
              {error}
            </p>
          )}

          {result && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                {[
                  { label: "召回率@K", value: formatRate(result.recallRate) },
                  { label: "精确率@K", value: formatRate(result.precisionRate) },
                  { label: "F1", value: result.f1.toFixed(3) },
                  { label: "命中", value: `${result.hits}/${result.totalCases}` },
                  { label: "均分", value: result.avgScore.toFixed(3) },
                ].map((item) => (
                  <span
                    key={item.label}
                    className="rounded-full border px-3 py-1 text-[11px]"
                    style={{
                      borderColor: "var(--border)",
                      background: "var(--glass)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {item.label}：<b style={{ color: "var(--text-primary)" }}>{item.value}</b>
                  </span>
                ))}
              </div>

              <div className="space-y-2">
                {result.cases.map((item, index) => (
                  <div
                    key={`${item.question}-${index}`}
                    className="rounded-[14px] border px-3.5 py-2.5"
                    style={{ borderColor: "var(--border)", background: "var(--glass-soft)" }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
                        style={{
                          background: item.hit ? "rgba(48,209,88,0.12)" : "rgba(255,69,58,0.12)",
                          color: item.hit ? "#34d97b" : "#ff6961",
                        }}
                      >
                        {item.hit ? "命中" : "未命中"}
                      </span>
                      <span className="min-w-0 truncate text-[12px] font-medium">
                        {item.question}
                      </span>
                    </div>
                    <div
                      className="mt-1 truncate text-[10px]"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      期望：{item.expect}
                      {item.matchedSources.length > 0
                        ? ` · 命中来源：${item.matchedSources.map(sourceLabel).join("、")}`
                        : ""}
                    </div>
                    {item.topSources.length > 0 && (
                      <div
                        className="mt-1.5 truncate text-[10px]"
                        style={{ color: "var(--text-tertiary)" }}
                      >
                        Top-{item.topSources.length}：
                        {item.topSources
                          .slice(0, 3)
                          .map((source) => sourceLabel(source))
                          .join("、")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
