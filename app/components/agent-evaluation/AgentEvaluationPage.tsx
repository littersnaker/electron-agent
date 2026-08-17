// 模块说明：Agent 评测跑分页面——选数据集发起评测、查看通过率/耗时/Token。
// 布局沿用 Skills / 知识库管理页的 Apple 风格（主题变量 + CustomTitleBar）。
"use client";

import { useEffect, useState } from "react";
import type { ThemeMode } from "../../constants/theme";
import { getThemeVariables } from "../../constants/theme";
import { apiFetch } from "../../lib/api-client";
import CustomTitleBar from "../CustomTitleBar";

interface EvalDataset {
  name: string;
  agentId: string;
  caseCount: number;
}

interface EvalCase {
  caseIndex: number;
  input: string;
  expected: string;
  passed: boolean;
  output: string;
  durationMs: number;
  errorMessage: string;
}

interface EvalRun {
  id: string;
  agentId: string;
  datasetName: string;
  totalCases: number;
  passed: number;
  avgDurationMs: number;
  totalTokens: number;
  status: string;
  finishedAt: string;
}

interface AgentEvaluationPageProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onBack: () => void;
  hidden?: boolean;
}

export default function AgentEvaluationPage({
  theme,
  onToggleTheme,
  onBack,
  hidden = false,
}: AgentEvaluationPageProps) {
  const [datasets, setDatasets] = useState<EvalDataset[]>([]);
  const [selected, setSelected] = useState("");
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<EvalRun | null>(null);
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadDatasets = async () => {
    const response = await apiFetch("/api/agent/evaluation/datasets");
    const payload = await response.json();
    const items = Array.isArray(payload?.datasets) ? payload.datasets : [];
    setDatasets(items);
    if (items.length > 0) {
      setSelected((current) => current || String(items[0].name));
    }
  };

  useEffect(() => {
    void apiFetch("/api/agent/evaluation/datasets")
      .then((response) => response.json())
      .then((payload) => {
        const items = Array.isArray(payload?.datasets) ? payload.datasets : [];
        setDatasets(items);
        if (items.length > 0) {
          setSelected((current) => current || String(items[0].name));
        }
      })
      .catch(() => setError("加载评测数据集失败"));
  }, []);

  useEffect(() => {
    if (!runId) return;
    const timer = window.setInterval(() => {
      void apiFetch(`/api/agent/evaluation/runs/${runId}`)
        .then((response) => response.json())
        .then((payload) => {
          if (payload?.run) setRun(payload.run);
          if (Array.isArray(payload?.cases)) setCases(payload.cases);
          if (payload?.run?.status === "completed") {
            window.clearInterval(timer);
          }
        })
        .catch(() => window.clearInterval(timer));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [runId]);

  const startRun = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setRun(null);
    setCases([]);
    try {
      const dataset = datasets.find((item) => item.name === selected);
      const response = await apiFetch("/api/agent/evaluation/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: dataset?.agentId || "qa",
          datasetName: selected,
          projectId: "",
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || "发起评测失败");
      }
      setRunId(String(payload.runId || ""));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "发起评测失败");
    } finally {
      setBusy(false);
    }
  };

  const createSampleDataset = async () => {
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/agent/evaluation/datasets", { method: "POST" });
      await loadDatasets();
    } catch {
      setError("生成示例数据集失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      data-theme={theme}
      className="theme-transition flex h-screen flex-col overflow-hidden"
      style={{
        ...getThemeVariables(theme),
        display: hidden ? "none" : undefined,
        background:
          "radial-gradient(circle at 72% 12%, var(--app-glow-blue), transparent 28%), radial-gradient(circle at 45% 95%, var(--app-glow-purple), transparent 30%), var(--app-bg)",
        color: "var(--text-primary)",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', sans-serif",
      }}
    >
      <CustomTitleBar theme={theme} onToggleTheme={onToggleTheme} />

      <div className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col px-6 pb-5 pt-6 lg:px-10">
        <header className="mb-5 flex shrink-0 items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={onBack}
              aria-label="返回工作台"
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all duration-200 hover:bg-[var(--glass-hover)] active:scale-[0.94]"
              style={{
                background: "var(--glass)",
                borderColor: "var(--border-strong)",
                color: "var(--accent-blue)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
                cursor: "pointer",
              }}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                <path
                  d="M12.2 4.5 6.7 10l5.5 5.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div>
              <h1 className="text-[17px] font-semibold tracking-[-0.01em]">
                Agent 评测
              </h1>
              <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                选数据集跑分，看通过率 / 耗时 / Token
              </p>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {error ? (
            <div
              className="mb-4 rounded-[14px] border px-4 py-3 text-[12px]"
              style={{
                borderColor: "var(--accent-red)",
                color: "var(--accent-red)",
                background: "color-mix(in srgb, var(--accent-red) 8%, transparent)",
              }}
            >
              {error}
            </div>
          ) : null}

          {datasets.length === 0 ? (
            <div
              className="mb-4 rounded-[18px] border px-4 py-4 text-[12px]"
              style={{
                borderColor: "var(--border)",
                background: "var(--glass)",
                color: "var(--text-secondary)",
              }}
            >
              还没有评测数据集。可把 JSON 数据集放到本地 evaluations 目录，
              或生成一个示例数据集试用。
              <button
                type="button"
                onClick={createSampleDataset}
                disabled={busy}
                className="ml-3 rounded-[10px] px-3 py-1 text-[12px] font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: "var(--accent-blue)" }}
              >
                生成示例数据集
              </button>
            </div>
          ) : (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <select
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className="h-9 rounded-[10px] border bg-[var(--glass-black)] px-3 text-[12px] outline-none"
                style={{ color: "var(--text-primary)", borderColor: "var(--border)" }}
              >
                {datasets.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}（{item.agentId} · {item.caseCount} 例）
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={startRun}
                disabled={busy || !selected}
                className="h-9 rounded-[10px] px-4 text-[12px] font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-50"
                style={{ background: "var(--accent-blue)" }}
              >
                {busy ? "发起中…" : "开始评测"}
              </button>
            </div>
          )}

          {run ? (
            <div
              className="mb-4 rounded-[18px] border px-4 py-3"
              style={{ borderColor: "var(--border)", background: "var(--glass)" }}
            >
              <div className="mb-2 flex items-baseline gap-3">
                <span className="text-[14px] font-semibold">
                  {run.datasetName} · {run.agentId}
                </span>
                <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {run.status === "completed" ? "已完成" : "运行中"}
                </span>
              </div>
              <div
                className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]"
                style={{ color: "var(--text-secondary)" }}
              >
                <span>通过 {run.passed}/{run.totalCases}</span>
                <span>
                  通过率{" "}
                  {run.totalCases
                    ? Math.round((run.passed / run.totalCases) * 100)
                    : 0}
                  %
                </span>
                <span>均耗 {run.avgDurationMs}ms</span>
                <span>Token {run.totalTokens}</span>
              </div>
            </div>
          ) : null}

          {cases.length > 0 ? (
            <ul className="space-y-2">
              {cases.map((item) => (
                <li
                  key={item.caseIndex}
                  className="rounded-[16px] border px-4 py-2.5"
                  style={{ borderColor: "var(--border)", background: "var(--glass)" }}
                >
                  <div className="flex items-center gap-2 text-[12px]">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{
                        background: item.passed
                          ? "var(--accent-green)"
                          : "var(--accent-red)",
                      }}
                    />
                    <span className="font-medium">
                      #{item.caseIndex + 1} {item.input.slice(0, 60)}
                    </span>
                    <span className="ml-auto" style={{ color: "var(--text-tertiary)" }}>
                      {item.durationMs}ms
                    </span>
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                    期望：{item.expected}
                  </div>
                  {item.errorMessage ? (
                    <div className="mt-1 text-[11px]" style={{ color: "var(--accent-red)" }}>
                      {item.errorMessage}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </main>
  );
}
