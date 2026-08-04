// 模块说明：负责 page 页面或应用入口逻辑。
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api-client";

interface TraceSummary {
  id: string;
  sessionId: string;
  projectId: string;
  model: string;
  requestPreview: string;
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  eventCount: number;
}

interface TraceEvent {
  id: number;
  traceId: string;
  sequence: number;
  category: string;
  name: string;
  status: "started" | "completed" | "failed" | "info";
  durationMs: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ContextCacheStats {
  entries: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  hitRate: number;
}

interface TraceListResponse {
  traces: TraceSummary[];
  contextCache: ContextCacheStats;
}

interface TraceDetailResponse {
  traceId: string;
  events: TraceEvent[];
  evaluation: Record<string, unknown> | null;
  contextCache: ContextCacheStats;
}

const EMPTY_CACHE_STATS: ContextCacheStats = {
  entries: 0,
  hits: 0,
  misses: 0,
  writes: 0,
  evictions: 0,
  hitRate: 0,
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "运行中";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
}

function statusClassName(status: TraceSummary["status"]): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-800";
    case "failed":
      return "bg-red-100 text-red-800";
    case "paused":
      return "bg-amber-100 text-amber-800";
    default:
      return "bg-sky-100 text-sky-800";
  }
}

/**
 * Agent 可观测性页面。
 *
 * 页面只读取后端已经脱敏、截断后的 Trace 数据，不会在浏览器端直接读取工作区、
 * Prompt 或密钥。列表用于定位慢调用和失败运行，详情用于查看节点、LLM、Tool、
 * Cache、HITL 与 Evaluation 的完整事件顺序。
 */
export default function ObservabilityPage() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [cacheStats, setCacheStats] =
    useState<ContextCacheStats>(EMPTY_CACHE_STATS);
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const loadTraces = useCallback(async () => {
    setLoadingList(true);
    setErrorMessage("");
    try {
      const response = await apiFetch("/api/agent/observability?limit=50", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`读取 Trace 列表失败（HTTP ${response.status}）`);
      }
      const payload = (await response.json()) as TraceListResponse;
      setTraces(payload.traces || []);
      setCacheStats(payload.contextCache || EMPTY_CACHE_STATS);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadTraceDetail = useCallback(async (traceId: string) => {
    setSelectedTraceId(traceId);
    setLoadingDetail(true);
    setErrorMessage("");
    try {
      const response = await apiFetch(
        `/api/agent/observability?traceId=${encodeURIComponent(traceId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(`读取 Trace 详情失败（HTTP ${response.status}）`);
      }
      const payload = (await response.json()) as TraceDetailResponse;
      setDetail(payload);
      setCacheStats(payload.contextCache || EMPTY_CACHE_STATS);
    } catch (error) {
      setDetail(null);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTraces();
  }, [loadTraces]);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 md:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium text-sky-700">Multi-agent</p>
            <h1 className="text-2xl font-semibold">Agent Trace 可观测中心</h1>
            <p className="mt-1 text-sm text-slate-500">
              查看工作流耗时、工具修复、HITL 暂停、缓存命中和在线评估结果。
            </p>
          </div>
          <div className="flex gap-2">
            <a
              href="/"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
            >
              返回工作台
            </a>
            <button
              type="button"
              onClick={() => void loadTraces()}
              disabled={loadingList}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingList ? "刷新中…" : "刷新 Trace"}
            </button>
          </div>
        </header>

        {errorMessage ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {[
            ["缓存条目", cacheStats.entries],
            ["命中次数", cacheStats.hits],
            ["未命中", cacheStats.misses],
            ["写入次数", cacheStats.writes],
            ["淘汰次数", cacheStats.evictions],
            ["命中率", `${(cacheStats.hitRate * 100).toFixed(1)}%`],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-semibold">{value}</p>
            </div>
          ))}
        </section>

        <section className="grid min-h-[560px] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="font-semibold">最近运行</h2>
              <p className="text-xs text-slate-500">最多展示最近 50 条根 Trace。</p>
            </div>
            <div className="max-h-[720px] divide-y divide-slate-100 overflow-y-auto">
              {!loadingList && traces.length === 0 ? (
                <p className="p-5 text-sm text-slate-500">
                  暂无 Trace。执行一次 Code Agent 请求后会自动产生记录。
                </p>
              ) : null}
              {traces.map((trace: TraceSummary) => (
                <button
                  key={trace.id}
                  type="button"
                  onClick={() => void loadTraceDetail(trace.id)}
                  className={`w-full p-4 text-left transition hover:bg-slate-50 ${
                    selectedTraceId === trace.id ? "bg-sky-50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${statusClassName(
                        trace.status,
                      )}`}
                    >
                      {trace.status}
                    </span>
                    <span className="text-xs text-slate-400">
                      {formatDuration(trace.durationMs)}
                    </span>
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm font-medium">
                    {trace.requestPreview || "无请求摘要"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                    <span>{trace.model}</span>
                    <span>{trace.eventCount} 个事件</span>
                    <span>{formatDate(trace.startedAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="font-semibold">运行详情</h2>
              <p className="truncate text-xs text-slate-500">
                {selectedTraceId || "从左侧选择一条 Trace"}
              </p>
            </div>
            <div className="max-h-[720px] overflow-y-auto p-5">
              {loadingDetail ? (
                <p className="text-sm text-slate-500">正在读取事件时间线…</p>
              ) : null}

              {!loadingDetail && detail ? (
                <div className="space-y-6">
                  <section>
                    <h3 className="mb-3 text-sm font-semibold">事件时间线</h3>
                    <ol className="space-y-3">
                      {detail.events.map((event: TraceEvent) => (
                        <li
                          key={event.id}
                          className="rounded-xl border border-slate-200 p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-slate-100 px-2 py-1 text-xs">
                                {event.category}
                              </span>
                              <span className="text-sm font-medium">
                                {event.name}
                              </span>
                            </div>
                            <span className="text-xs text-slate-500">
                              {event.status}
                              {event.durationMs === null
                                ? ""
                                : ` · ${formatDuration(event.durationMs)}`}
                            </span>
                          </div>
                          {Object.keys(event.metadata).length > 0 ? (
                            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                              {JSON.stringify(event.metadata, null, 2)}
                            </pre>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </section>

                  <section>
                    <h3 className="mb-3 text-sm font-semibold">在线评估</h3>
                    {detail.evaluation ? (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-4 text-xs text-slate-100">
                        {JSON.stringify(detail.evaluation, null, 2)}
                      </pre>
                    ) : (
                      <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
                        本次运行尚无评估报告，可能仍在运行或停在人工确认阶段。
                      </p>
                    )}
                  </section>
                </div>
              ) : null}

              {!loadingDetail && !detail ? (
                <p className="text-sm text-slate-500">
                  选择 Trace 后可查看节点、LLM、Tool、Cache、HITL 和 Evaluation 事件。
                </p>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
