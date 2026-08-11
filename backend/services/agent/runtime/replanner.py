"""失败后的动态重规划输入压缩器。

该模块不替换现有 Planner，只负责把失败历史压缩成结构化摘要，并让下一次执行
从一个小步骤继续，避免携带完整失败 transcript。
"""

from __future__ import annotations

from backend.services.agent.runtime.reasoning_memory import ReasoningMemory
from backend.services.agent.shared.failure_summary import FailureSummary
from backend.services.agent.shared.work_models import WorkItem


class Replanner:
    """构建失败摘要和 Retry 上下文，供现有批量 Planner 与 Worker 使用。"""

    def summarize_failure(
        self,
        *,
        work: WorkItem,
        error: str,
        changed_files: list[str],
        attempted_action: str = "",
        previous: FailureSummary | None = None,
    ) -> FailureSummary:
        """把一次失败合并到已有摘要，而不是追加完整工具历史。"""

        summary = previous or FailureSummary()
        summary.add_attempt(error, attempted_action)
        for path in changed_files:
            summary.add_changed_file(path)
        summary.set_root_cause(self._infer_root_cause(error))
        summary.set_next_recommendation(
            f"只处理 {work.id} 的失败根因；先读取最新文件，再执行一个可验证的小修复。"
        )
        return summary

    def prepare_retry_transcript(
        self,
        *,
        work: WorkItem,
        summary: FailureSummary,
        memory: ReasoningMemory,
    ) -> list[str]:
        """生成 Retry 允许携带的最小上下文列表。"""

        memory_text = memory.render_recent()
        current_state = (
            f"CURRENT CODE STATE:\n已修改文件：{summary.changed_files or ['无']}\n"
            f"当前 Work：{work.id} · {work.title}\n目标：{work.objective}"
        )
        next_goal = (
            "NEXT SMALL STEP:\n"
            f"{summary.next_recommendation or '读取最新代码并定位根因。'}"
        )
        entries = [summary.to_retry_prompt(), current_state, next_goal]
        if memory_text:
            entries.insert(1, f"REASONING MEMORY:\n{memory_text}")
        return [entry for entry in entries if entry.strip()]

    def compact_failure_observation(
        self,
        summaries: dict[str, FailureSummary],
    ) -> str:
        """为批量 Planner 合并多个 Work 的失败摘要。"""

        sections = []
        for work_id, summary in summaries.items():
            sections.append(f"### {work_id}\n{summary.to_retry_prompt()}")
        return "\n\n".join(sections)

    def _infer_root_cause(self, error: str) -> str:
        """从常见错误文本提取稳定根因分类，未知错误保留精简原文。"""

        lowered = error.lower()
        if "timeout" in lowered or "超时" in error:
            return "验证或工具执行超时，需要缩小命令范围或拆分步骤"
        if "protocol" in lowered or "json" in lowered:
            return "模型工具协议不合法，需要恢复为单动作 JSON"
        if "内容已变化" in error:
            return "文件自上次读取后已被修改（可能来自本 Work 此前的编辑或并行写入），旧版本补丁已失效，需重新读取最新内容"
        if "test" in lowered or "lint" in lowered or "type" in lowered:
            return "质量验证失败，需基于真实输出修复代码或测试"
        return error.strip()[:1_000] or "尚未识别根因"


__all__ = ["Replanner"]
