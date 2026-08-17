// 模块说明：Agent 评测跑分页面——选数据集发起评测、查看通过率/耗时/Token。
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api-client";

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  border: "var(--border)",
  green: "var(--accent-green)",
  red: "var(--accent-red)",
  blue: "var(--accent-blue)",
};

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

export default function AgentEvaluationPage({
  onBack,
  hidden = false,
}: {
  onBack: () => void;
  hidden?: boolean;
}) {
  const [datasets, setDatasets] = useState<EvalDataset[]>([]);
  const [selected, setSelected] = useState("");
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<EvalRun | null>(null);
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void apiFetch("/api/agent/evaluation/datasets")
      .then((response) => response.json())
      .then((payload) => {
        const items = Array.isArray(payload?.datasets) ? payload.datasets : [];
        setDatasets(items);
        if (items.length > 0) setSelected(String(items[0].name));
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
          if (payload?.run?.status === "completed") window.clearInterval(timer);
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
      const response = await apiFetch("/api/agent/evaluation/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: datasets.find((item) => item.name === selected)?.agentId || "qa",
          datasetName: selected,
          projectId: "",
        }),
      });
      const payload = await response.json();
      setRunId(String(payload.runId || ""));
    } catch {
      setError("发起评测失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mx-auto w-full max-w-3xl px-6 py-8"
      style={{ display: hidden ? "none" : undefined }}
    >
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: COLORS.text }}>
          🧪 Agent 评测
        </h1>
        <button
          type="button"
          onClick={onBack}
          className="rounded-[10px] border px-3 py-1.5 text-[12px] font-semibold transition-all hover:bg-[var(--glass-soft)]"
          style={{ color: COLORS.text, borderColor: COLORS.border }}
        >
          ← 返回工作台
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="rounded-[10px] border px-3 py-1.5 text-[12px]"
          style={{ color: COLORS.text, borderColor: COLORS.border, background: "var(--glass)" }}
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
          className="rounded-[10px] px-4 py-1.5 text-[12px] font-semibold text-white transition-all disabled:opacity-50"
          style={{ background: COLORS.blue }}
        >
          {busy ? "发起中…" : "开始评测"}
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded-[12px] border px-3 py-2 text-[12px]" style={{ borderColor: COLORS.red, color: COLORS.red }}>
          {error}
        </div>
      ) : null}

      {run ? (
        <div className="mb-4 rounded-[12px] border px-4 py-3" style={{ borderColor: COLORS.border }}>
          <div className="mb-2 flex items-baseline gap-3">
            <span className="text-[14px] font-semibold" style={{ color: COLORS.text }}>
              {run.datasetName} · {run.agentId}
            </span>
            <span className="text-[11px]" style={{ color: COLORS.textSubtle }}>
              {run.status === "completed" ? "已完成" : "运行中"}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]" style={{ color: COLORS.textMuted }}>
            <span>通过 {run.passed}/{run.totalCases}</span>
            <span>通过率 {run.totalCases ? Math.round((run.passed / run.totalCases) * 100) : 0}%</span>
            <span>均耗 {run.avgDurationMs}ms</span>
            <span>Token {run.totalTokens}</span>
          </div>
        </div>
      ) : null}

      {cases.length > 0 ? (
        <ul className="space-y-2">
          {cases.map((item) => (
            <li key={item.caseIndex} className="rounded-[12px] border px-3 py-2" style={{ borderColor: COLORS.border }}>
              <div className="flex items-center gap-2 text-[12px]">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: item.passed ? COLORS.green : COLORS.red }}
                />
                <span className="font-medium" style={{ color: COLORS.text }}>
                  #{item.caseIndex + 1} {item.input.slice(0, 60)}
                </span>
                <span className="ml-auto" style={{ color: COLORS.textSubtle }}>
                  {item.durationMs}ms
                </span>
              </div>
              <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>
                期望：{item.expected}
              </div>
              {item.errorMessage ? (
                <div className="mt-1 text-[11px]" style={{ color: COLORS.red }}>
                  {item.errorMessage}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
