"""Work 级智能会话。

该模块把上下文隔离、Token 预算、结构化推理、失败摘要和动作反思组合成一个
可恢复会话，但不改变现有 Orchestrator、Planner 或 Work DAG 调度模型。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from backend.services.agent.context import ContextCompactor, WorkContext
from backend.services.agent.runtime.reasoning_controller import ReasoningController
from backend.services.agent.runtime.reasoning_memory import ReasoningMemory
from backend.services.agent.runtime.reasoning_state import ReasoningState
from backend.services.agent.runtime.reflection_engine import ReflectionEngine
from backend.services.agent.runtime.replanner import Replanner
from backend.services.agent.shared.failure_summary import FailureSummary
from backend.services.agent.shared.token_budget import TokenBudgetGuard
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import WorkWorkerState

_FILE_HEADER = re.compile(r"^--- FILE:\s*(.+?)\s*---$", re.MULTILINE)
_MEMORY_HEADER = re.compile(r"^## Memory · ([^\n]+)$", re.MULTILINE)

# Token 预算软信号：剩余低于"上限比例或绝对值"时，向模型注入收尾指令，
# 而不是在调用前硬性终止 Work。
BUDGET_WARNING_RATIO = 0.75
BUDGET_WARNING_MIN_TOKENS = 8_000


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
        root: Path | None = None,
    ) -> None:
        """仅在首轮建立当前 Work 的独立上下文，避免注入全局完整历史。"""

        if self.state.transcript:
            self._persist()
            return
        selected = self._select_relevant_file_sections(
            f"{harness_context}\n\n{initial_context}"
        )
        self.context.relevant_files = [path for path, _ in selected]
        # 注意：预读文件不登记 transcript_versions 指纹。若这里预置指纹，
        # 模型首轮 read 同一文件时会命中"未变化"瘦身，完整内容被吞，导致
        # 模型反复 read 却始终拿不到内容（日志实测连续 5 轮只读循环）。
        # read 的真实指纹由 work_action_handler._read 在首次注入后写入。
        dependency_state = self._dependency_state(ledger_snapshot)
        metadata = self._project_metadata(project_tree)
        file_context = "\n\n".join(
            f"--- FILE: {path} ---\n{content}" for path, content in selected
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
        """组装本轮模型输入：开窗透传最近观察，更早历史折叠为动作摘要。"""

        compacted, stats = self.compactor.compact_transcript(self.state.transcript)
        before = int(stats.get("before_tokens") or 0)
        after = int(stats.get("after_tokens") or 0)
        saved = max(0, before - after)
        if saved:
            self.budget.get("context").record_compressed(saved)
            # 折叠后，被压缩的旧文件内容不再完整在上下文中，清空指纹，
            # 防止 read 工具结果瘦身误判"文件未变化"而不再注入全文。
            self.state.transcript_versions.clear()
        retry_prompt = self.failure.to_retry_prompt()
        directive = self.controller.build_directive(self.reasoning)
        prompt_parts = [*compacted, directive]
        if retry_prompt:
            prompt_parts.append(retry_prompt)
        text = "\n\n".join(part for part in prompt_parts if part.strip())
        estimate = max(1, (len(text.encode("utf-8")) + 3) // 4)
        self.context.token_usage["active"] = estimate
        self._persist()
        return WorkSessionPrompt(text=text, estimated_tokens=estimate)

    def budget_directive(
        self,
        worker_budget: object,
        estimated_tokens: int,
    ) -> str:
        """根据 Worker Token 剩余情况生成软信号指令；正常时返回空串。"""

        consumed = int(getattr(worker_budget, "consumed", 0) or 0)
        if consumed <= 0:
            return ""
        remaining = int(getattr(worker_budget, "remaining", 0) or 0)
        limit = max(int(getattr(worker_budget, "limit", 1) or 1), 1)
        urgent = remaining < estimated_tokens + 2_000 or consumed >= limit
        soft_limit = max(int(limit * BUDGET_WARNING_RATIO), BUDGET_WARNING_MIN_TOKENS)
        if urgent:
            compacted = bool(self.state.quality.get("budgetCompacted"))
            note = "（上下文已完成一次压缩）" if compacted else "（尚未压缩）"
            return (
                "TOKEN BUDGET EXHAUSTED"
                f"{note}：Worker Token 预算已接近或超过上限，"
                "剩余空间不足以再做新读取。本轮必须立即输出最有价值的动作："
                "要么一次最小 edit 完成核心修改，要么直接 complete_work 总结现状；"
                "禁止 read/search/inspect/factory，禁止空转。"
            )
        if remaining <= soft_limit:
            return (
                "TOKEN BUDGET WARNING：Worker Token 预算剩余不多，"
                "请优先完成核心修改并尽快 complete_work，不要再读取新文件或扩大上下文。"
            )
        return ""

    def compact_for_budget(self) -> bool:
        """预算耗尽前的一次性紧急压缩，返回是否实际执行了压缩。"""

        if bool(self.state.quality.get("budgetCompacted")):
            return False
        compacted, stats = self.compactor.compact_transcript_budget(
            self.state.transcript
        )
        if not compacted:
            return False
        saved = max(0, int(stats.get("saved_tokens") or 0))
        if saved > 0:
            self.budget.get("context").record_compressed(saved)
        self.state.quality["budgetCompacted"] = True
        self.state.quality["budgetCompactionStats"] = stats
        self.state.transcript = compacted
        # 截断后的文件内容不再是完整版本，必须清空指纹，避免模型误读。
        self.state.transcript_versions.clear()
        self.state.append_transcript(
            "CONTEXT COMPACTED: 预算耗尽前已完成工具结果瘦身与旧观察裁剪，"
            "保留最近若干轮完整内容；请勿再重复读取文件，直接基于现有信息完成。"
        )
        self._persist()
        return True

    def record_usage(self, total_tokens: int) -> bool:
        """记录 Worker Token；严重超限时先压缩一次让循环收尾，而不是立即失败。"""

        within_budget = self.budget.consume("worker", total_tokens)
        mitigation = self.budget.apply_mitigation("worker")
        actions = [str(item) for item in mitigation.get("actions", [])]
        self.context.update_token_usage(total=max(0, total_tokens))
        self.state.quality["tokenMitigation"] = mitigation
        if "block" in actions:
            if not bool(self.state.quality.get("budgetCompacted")):
                # 首次触发终止阈值：压缩上下文并允许再跑一轮收尾（edit 或 complete_work）。
                # 若上下文本来就很小、压缩无事可做，则立即停止，避免无限放行。
                return self.compact_for_budget()
            return False
        self._persist()
        return True

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
        # 折叠 transcript 后，旧的完整文件内容不再在上下文中，指纹必须清空。
        self.state.transcript_versions.clear()
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
        """只保留当前 Work 与直接依赖状态，不发送完整 WorkList。

        已成功依赖折叠为结构化 VERIFIED FACTS（确认范围 + 修改文件 + 结论），
        并明确标注可直接引用、无需重新读取验证，避免下游 Worker 重复验证
        同一批文件而空耗 Token；未成功或当前 Work 保留完整 JSON。
        """

        items = snapshot.get("items")
        selected = []
        if isinstance(items, list):
            wanted = {self.work.id, *self.work.dependencies}
            selected = [
                item
                for item in items
                if isinstance(item, dict) and str(item.get("id")) in wanted
            ]
        blocks: list[str] = ["WORK DEPENDENCIES:"]
        for item in selected:
            item_id = str(item.get("id") or "")
            succeeded = str(item.get("status") or "").lower() == "succeeded"
            if succeeded and item_id != self.work.id:
                blocks.append(self._dependency_facts(item))
            else:
                blocks.append(json.dumps(item, ensure_ascii=False))
        return "\n\n".join(blocks)

    @staticmethod
    def _dependency_facts(item: dict[str, object]) -> str:
        """把已成功依赖折叠为结构化事实：确认范围、修改文件与最终结论。"""

        dep_id = str(item.get("id") or "")
        scope = [str(path) for path in (item.get("targetFiles") or [])]
        changed = [str(path) for path in (item.get("changedFiles") or [])]
        summary = " ".join(str(item.get("summary") or "").split())
        lines = [f"[{dep_id}] 状态=已成功（结论可信，直接引用即可）"]
        if scope:
            lines.append(f"已确认文件（无需重新读取验证）: {', '.join(scope)}")
        if changed:
            lines.append(f"已修改文件: {', '.join(changed)}")
        lines.append(f"结论: {summary or '该 Work 已成功完成。'}")
        return "\n".join(lines)

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
