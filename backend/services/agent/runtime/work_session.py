"""Work 级智能会话。

该模块把上下文隔离、Token 预算、结构化推理、失败摘要和动作反思组合成一个
可恢复会话，但不改变现有 Orchestrator、Planner 或 Work DAG 调度模型。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from backend.services.agent.context import ContextCompactor, WorkContext
from backend.services.agent.failure_summary import FailureSummary
from backend.services.agent.runtime.reasoning_controller import ReasoningController
from backend.services.agent.runtime.reasoning_memory import ReasoningMemory
from backend.services.agent.runtime.reasoning_state import ReasoningState
from backend.services.agent.runtime.reflection_engine import ReflectionEngine
from backend.services.agent.runtime.replanner import Replanner
from backend.services.agent.token_budget import TokenBudgetGuard
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkWorkerState

_FILE_HEADER = re.compile(r"^--- FILE:\s*(.+?)\s*---$", re.MULTILINE)
_MEMORY_HEADER = re.compile(r"^## Memory · ([^\n]+)$", re.MULTILINE)


@dataclass(slots=True)
class WorkSessionPrompt:
    """保存一次发送给模型的压缩上下文及其估算 Token。"""

    text: str
    estimated_tokens: int


class WorkIntelligenceSession:
    """管理单个 Work 的低 Token、可反思和可恢复执行状态。"""

    def __init__(self, work: WorkItem, state: WorkWorkerState) -> None:
        """从 Worker Checkpoint 恢复全部智能状态。"""

        self.work = work
        self.state = state
        self.controller = ReasoningController()
        restored_reasoning = (
            ReasoningState.from_json(state.reasoning_state)
            if state.reasoning_state
            else None
        )
        self.reasoning = self.controller.prepare(work, restored_reasoning)
        self.memory = ReasoningMemory.from_json(state.reasoning_memory)
        self.failure = FailureSummary.from_json(state.failure_summary)
        self.context = (
            WorkContext.from_json(state.work_context)
            if state.work_context
            else WorkContext(work_id=work.id, objective=work.objective)
        )
        self.budget = TokenBudgetGuard()
        self.budget.restore(state.token_budget)
        self.compactor = ContextCompactor()
        self.reflection_engine = ReflectionEngine()
        self.replanner = Replanner()

    def initialize(
        self,
        *,
        initial_context: str,
        project_tree: str,
        ledger_snapshot: dict[str, object],
        harness_context: str = "",
    ) -> None:
        """仅在首轮建立当前 Work 的独立上下文，避免注入全局完整历史。"""

        if self.state.transcript:
            self._persist()
            return
        selected = self._select_relevant_file_sections(
            f"{harness_context}\n\n{initial_context}"
        )
        self.context.relevant_files = [path for path, _ in selected]
        dependency_state = self._dependency_state(ledger_snapshot)
        metadata = self._project_metadata(project_tree)
        file_context = "\n\n".join(
            f"--- FILE: {path} ---\n{content[:4_000]}" for path, content in selected
        )
        memory_notes = self._extract_memory_notes(
            f"{harness_context}\n\n{initial_context}"
        )
        entries = [
            f"WORK CONTEXT:\n{metadata}\n{dependency_state}",
            f"RELATED FILES:\n{file_context or '首轮未命中相关文件，请使用 search/read 获取真实代码。'}",
            self.controller.build_directive(self.reasoning),
        ]
        if memory_notes:
            entries.insert(1, "MEMORY NOTES:\n" + "\n".join(memory_notes))
        for entry in entries:
            self.state.append_transcript(entry)
        self.context.add_action("已建立独立 Work Context，并裁剪全局项目输入。")
        self._persist()

    def _extract_memory_notes(self, text: str) -> list[str]:
        """从 Runtime 上下文中提取 Memory 段落，供 Worker 直接引用。"""

        matches = list(_MEMORY_HEADER.finditer(text))
        notes: list[str] = []
        for index, match in enumerate(matches[:8]):
            end = (
                matches[index + 1].start()
                if index + 1 < len(matches)
                else len(text)
            )
            block = text[match.end() : end]
            next_heading = re.search(
                r"^(?:## (?!Memory · ).+|--- FILE:.*)$",
                block,
                re.MULTILINE,
            )
            if next_heading:
                block = block[: next_heading.start()]
            compact = " ".join(block.split())[:1_200]
            if compact:
                notes.append(f"- [{match.group(1).strip()}] {compact}")
        return notes

    def build_prompt(self) -> WorkSessionPrompt:
        """压缩历史并附加最新推理状态，返回本轮模型输入。"""

        compacted, stats = self.compactor.compact_transcript(self.state.transcript)
        before = int(stats.get("before_tokens") or 0)
        after = int(stats.get("after_tokens") or 0)
        saved = max(0, before - after)
        if saved:
            self.budget.get("context").record_compressed(saved)
        retry_prompt = self.failure.to_retry_prompt()
        directive = self.controller.build_directive(self.reasoning)
        prompt_parts = [*compacted, directive]
        if retry_prompt:
            prompt_parts.append(retry_prompt)
        text = "\n\n".join(part for part in prompt_parts if part.strip())
        limit_chars = min(self.budget.get("context").limit, 10_000) * 3
        if len(text) > limit_chars:
            removed = max(0, len(text) - limit_chars) // 3
            # 保留开头的目标与预读文件，再截断中间，最后保留最近动作。
            head_budget = min(2_000, max(0, removed // 3))
            tail_budget = max(1, limit_chars - head_budget)
            if len(text) > tail_budget:
                text = (
                    text[:head_budget]
                    + "\n…（中间上下文已按预算压缩）…\n"
                    + text[-tail_budget:]
                )
            self.budget.get("context").record_cleaned(removed)
        estimate = max(1, (len(text.encode("utf-8")) + 3) // 4)
        self.context.token_usage["active"] = estimate
        self._persist()
        return WorkSessionPrompt(text=text, estimated_tokens=estimate)

    def record_usage(self, total_tokens: int) -> bool:
        """记录 Worker Token 并在严重超限时阻止无限调用。"""

        within_budget = self.budget.consume("worker", total_tokens)
        mitigation = self.budget.apply_mitigation("worker")
        actions = [str(item) for item in mitigation.get("actions", [])]
        self.context.update_token_usage(total=max(0, total_tokens))
        self.state.quality["tokenMitigation"] = mitigation
        self._persist()
        return within_budget or "block" not in actions

    def reflect(
        self,
        *,
        action: str,
        outcome_kind: str,
        summary: str = "",
        error: str = "",
    ) -> None:
        """在重要动作后保存结构化反思和可复用事实。"""

        if not self.controller.should_reflect(
            action,
            failed=outcome_kind == "failure",
        ):
            return
        reflection = self.reflection_engine.reflect(
            action=action,
            outcome_kind=outcome_kind,
            summary=summary,
            error=error,
            state=self.reasoning,
        )
        self.state.reflection = reflection.to_json()
        for fact in reflection.verified_facts:
            self.memory.add(
                decision=f"{action} 已验证",
                reason="真实工具结果支持该事实",
                evidence=fact,
                category="verified",
            )
        self.context.add_action(
            f"{action}: {outcome_kind} - {summary or error or '已观察结果'}"
        )
        self._persist()

    def record_failure(self, *, action: str, error: str) -> None:
        """把失败合并为摘要，并用最小 Retry 上下文替换膨胀历史。"""

        self.failure = self.replanner.summarize_failure(
            work=self.work,
            error=error,
            changed_files=self.state.changed_files,
            attempted_action=action,
            previous=self.failure,
        )
        self.context.failure_summary = self.failure.to_json()
        self.state.transcript = self.replanner.prepare_retry_transcript(
            work=self.work,
            summary=self.failure,
            memory=self.memory,
        )
        self.budget.consume("retry", max(1, len(error) // 3))
        self._persist()

    def _select_relevant_file_sections(self, text: str) -> list[tuple[str, str]]:
        """从已有检索上下文中只选择目标文件和最多八个语义相关文件。"""

        matches = list(_FILE_HEADER.finditer(text))
        sections: list[tuple[str, str]] = []
        terms = {
            token.lower()
            for token in re.findall(r"[A-Za-z_][A-Za-z0-9_./-]{2,}", self.work.objective)
        }
        targets = {path.replace("\\", "/") for path in self.work.target_files}
        selected_paths: set[str] = set()
        for index, match in enumerate(matches):
            path = match.group(1).split(" [", 1)[0].strip().replace("\\", "/")
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            content = text[match.end() : end].strip()
            searchable = f"{path}\n{content[:2_000]}".lower()
            relevant = path in targets or any(term in searchable for term in terms)
            if relevant and path not in selected_paths:
                sections.append((path, content))
                selected_paths.add(path)
            if len(sections) >= 8:
                break
        return sections

    def _dependency_state(self, snapshot: dict[str, object]) -> str:
        """只保留当前 Work 与直接依赖状态，不发送完整 WorkList。"""

        items = snapshot.get("items")
        selected = []
        if isinstance(items, list):
            wanted = {self.work.id, *self.work.dependencies}
            selected = [
                item
                for item in items
                if isinstance(item, dict) and str(item.get("id")) in wanted
            ]
        return f"WORK DEPENDENCIES:\n{json.dumps(selected, ensure_ascii=False)}"

    def _project_metadata(self, project_tree: str) -> str:
        """把完整项目树转换为语言、规模和顶层目录摘要。"""

        lines = [line.strip() for line in project_tree.splitlines() if line.strip()]
        top_level = list(dict.fromkeys(line.split("/", 1)[0] for line in lines))[:20]
        languages = []
        if any(line.endswith(".py") for line in lines):
            languages.append("Python")
        if any(line.endswith((".ts", ".tsx")) for line in lines):
            languages.append("TypeScript")
        return (
            f"项目文件约 {len(lines)} 个；语言：{', '.join(languages) or '未知'}；"
            f"顶层：{', '.join(top_level)}"
        )

    def _persist(self) -> None:
        """把当前会话状态写回 WorkerState，交由现有 Checkpoint 保存。"""

        self.state.work_context = self.context.to_json()
        self.state.reasoning_state = self.reasoning.to_json()
        self.state.reasoning_memory = self.memory.to_json()
        self.state.failure_summary = self.failure.to_json()
        self.state.token_budget = self.budget.snapshot()


__all__ = ["WorkIntelligenceSession", "WorkSessionPrompt"]
