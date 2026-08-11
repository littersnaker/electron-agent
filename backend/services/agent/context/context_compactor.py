"""Work Context 记忆压缩器。

整段聊天级别的记忆压缩仍由 Runtime/Memory 层负责；单个 Work 的工作循环内
不做任何压缩或截断，确保模型每次都能看到完整的工具观察与文件内容。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from backend.services.agent.context.work_context import WorkContext

# 阈值配置
MAX_WORK_CONTEXT_TOKEN = 10_000
MAX_TOOL_OUTPUT_TOKEN = 3_000
# 预算紧急压缩时完整保留的最近观察条数（更早的观察只做工具结果瘦身）。
BUDGET_KEEP_RECENT_ENTRIES = 6
# 开窗透传：每次模型调用完整保留的最近条目数（一次编辑-验证周期约 3~6 条，
# 窗口覆盖最近约两轮周期）；更早的历史折叠为动作摘要。
SLIDING_WINDOW_ENTRIES = 10
# 窗口内完整内容的总量保险（给 64k/128k 模型窗口留裕量，超出后从最老条目瘦身）。
MAX_WINDOW_TOKENS = 40_000
# 折叠时保留的头部结构条目最大字符数（防止 WORK CONTEXT 内嵌大文件全文）。
_PRESERVE_HEAD_ENTRY_CHARS = 1_500
# 折叠时保留的最近一次 edit 结果最大字符数：模型需要知道"上一轮改了什么"，
# 否则会基于旧内容盲重复 edit（日志实测：成功 edit 后下一轮重复同内容再失配）。
_PRESERVE_EDIT_RESULT_CHARS = 2_500
# 折叠时保留的最近一次 read 观察最大字符数：模型需要看到最近读到的文件内容，
# 否则"读而不见"会触发循环 read（日志实测：4 次 read 同一组文件、0 次 edit）。
_PRESERVE_READ_RESULT_CHARS = 12_000


@dataclass(slots=True)
class CompactionResult:
    """压缩结果。"""

    context: WorkContext
    removed_actions: list[str] = field(default_factory=list)
    estimated_tokens_before: int = 0
    estimated_tokens_after: int = 0


class ContextCompactor:
    """按策略压缩 Work Context，控制 token 使用量。"""

    def __init__(
        self,
        *,
        max_work_context_token: int = MAX_WORK_CONTEXT_TOKEN,
        max_tool_output_token: int = MAX_TOOL_OUTPUT_TOKEN,
    ) -> None:
        """初始化压缩器，允许自定义阈值。"""

        self._max_work_context_token = max_work_context_token
        self._max_tool_output_token = max_tool_output_token

    def compact(self, ctx: WorkContext) -> CompactionResult:
        """压缩上下文并返回结果统计。"""

        before = ctx.estimate_tokens()
        removed: list[str] = []

        # 1. 压缩 recent_actions：合并重复操作，保留关键错误和最新动作
        if ctx.recent_actions:
            compacted = self._compact_actions(ctx.recent_actions)
            removed = [a for a in ctx.recent_actions if a not in compacted]
            ctx.recent_actions = compacted

        # 2. 限制 relevant_files 数量
        if len(ctx.relevant_files) > 50:
            ctx.relevant_files = ctx.relevant_files[:50]

        # 3. 清理过期的 artifact_refs（保留最近 20 个）
        if len(ctx.artifact_refs) > 20:
            ctx.artifact_refs = ctx.artifact_refs[-20:]

        # 4. 如果仍然超过预算，裁剪 objective 和 recent_actions
        after = ctx.estimate_tokens()
        if after > self._max_work_context_token:
            ctx.recent_actions = ctx.recent_actions[-10:]
            after = ctx.estimate_tokens()

        if after > self._max_work_context_token:
            # 最终手段：截断 objective
            max_obj_len = self._max_work_context_token * 2 - sum(
                len(a) for a in ctx.recent_actions
            )
            if max_obj_len > 0 and len(ctx.objective) > max_obj_len:
                ctx.objective = ctx.objective[:max_obj_len] + "\n（上下文已压缩）"
            after = ctx.estimate_tokens()

        return CompactionResult(
            context=ctx,
            removed_actions=removed,
            estimated_tokens_before=before,
            estimated_tokens_after=after,
        )

    def _compact_actions(self, actions: list[str]) -> list[str]:
        """压缩动作列表，去重并保留关键信息。

        保留：
        - 当前目标相关动作
        - 最新错误
        - 未完成事项
        - 验收状态

        删除：
        - 重复 tool output
        - 已完成 debug log
        - 大段代码 diff
        """

        result: list[str] = []
        seen: set[str] = set()

        for action in actions:
            normalized = self._normalize_action(action)
            if not normalized:
                continue

            # 去重
            if normalized in seen:
                continue
            seen.add(normalized)

            # 删除已完成 debug log
            if self._is_completed_debug_log(action):
                continue

            # 截断过长的工具输出
            if self._is_tool_output(action):
                action = self._truncate_tool_output(action)

            result.append(action)

        # 始终保留最后 5 条动作摘要（但跳过已被过滤的 debug 完成日志）
        for action in actions[-5:]:
            if action in result:
                continue
            if self._is_completed_debug_log(action):
                continue
            result.append(action)

        return result

    def _normalize_action(self, action: str) -> str:
        """归一化动作文本用于去重判断。"""

        # 移除行号、时间戳等变化部分
        text = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}", "", action)
        text = re.sub(r"line \d+", "line N", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:200]

    def _is_completed_debug_log(self, action: str) -> bool:
        """判断是否为已完成的 debug log。"""

        completed_patterns = [
            "DEBUG: 完成",
            "DEBUG: success",
            "DEBUG: passed",
            "已修复",
            "已解决",
            "test passed",
            "lint passed",
        ]
        lowered = action.lower()
        return any(p.lower() in lowered for p in completed_patterns)

    def _is_tool_output(self, action: str) -> bool:
        """判断是否为工具输出。"""

        tool_patterns = [
            "TOOL OUTPUT:",
            "Command output:",
            "SEARCH RESULT:",
            "READ FILE:",
            "```",
        ]
        return any(p in action for p in tool_patterns)

    def _truncate_tool_output(self, action: str) -> str:
        """截断过长的工具输出。"""

        max_len = self._max_tool_output_token * 2
        if len(action) <= max_len:
            return action
        return action[:max_len] + "\n（工具输出已截断）"

    def compact_transcript(
        self, transcript: list[str]
    ) -> tuple[list[str], dict[str, Any]]:
        """开窗透传 transcript：完整保留最近若干轮，更早历史折叠为动作摘要。

        旧实现每次模型调用都完整重发全部历史，导致单 Work 的输入量随轮数
        平方级增长（第 N 轮重发前 N-1 轮的全部 ACTION/OBSERVATION 与文件内容）。
        本方法改为滑动窗口：窗口内（最近 SLIDING_WINDOW_ENTRIES 条）逐字保留，
        窗口外记录降级为动作轨迹摘要 + 工具输出瘦身，把单轮输入量控制在
        O(窗口) 量级。

        安全性：任务目标（objective）与验收标准（acceptanceCriteria）在
        system prompt（_worker_prompt）中有独立备份，折叠 transcript 头部
        不会让模型失忆；窗口内保留最近的文件观察，read 工具结果瘦身
        （work_action_handler）仍保证"文件未变化不重复注入全文"。

        调用方在折叠后必须清空 transcript_versions，防止 read 瘦身误以为
        被折叠的文件内容仍在上下文中。
        """

        entries = list(transcript)
        if not entries:
            return entries, {
                "removed": 0,
                "before_tokens": 0,
                "after_tokens": 0,
                "saved_tokens": 0,
            }
        before_tokens = sum(self._estimate_tokens(item) for item in entries)
        if len(entries) <= SLIDING_WINDOW_ENTRIES:
            # 未超过窗口，等价于完整透传。
            return entries, {
                "removed": 0,
                "before_tokens": before_tokens,
                "after_tokens": before_tokens,
                "saved_tokens": 0,
            }
        recent_tail = entries[-SLIDING_WINDOW_ENTRIES:]
        older = entries[:-SLIDING_WINDOW_ENTRIES]
        summary = self._summarize_entries(older)
        # 保留头部短小的结构上下文（WORK CONTEXT 依赖事实、任务规格等），
        # 避免模型在后期失去依赖结论；超大条目（如 RELATED FILES 全文）不保留，
        # 需要时由模型重新 read（折叠时指纹已清空）。
        head = self._preserve_head_context(older)
        # 保留窗口外最近一次 edit 的修改结果（CHANGED/DIFF）：模型据此知道
        # 上一轮改了什么，不会基于旧内容盲重复 edit。
        last_edit = self._last_edit_result(older)
        # 保留窗口外最近一次 read 的完整观察：模型据此能看到最近读到的文件
        # 内容，不会因"读而不见"而循环 read 同一批文件。
        last_read = self._last_read_result(older)
        preserved_middle: list[str] = []
        if last_edit:
            preserved_middle.append(last_edit)
        if last_read:
            preserved_middle.append(last_read)
        if summary:
            preserved_middle.append(summary)
        windowed = self._fit_window_to_budget(recent_tail)
        result = [*head, *preserved_middle, *windowed]
        after_tokens = sum(self._estimate_tokens(item) for item in result)
        return result, {
            "removed": max(0, len(entries) - len(result)),
            "before_tokens": before_tokens,
            "after_tokens": after_tokens,
            "saved_tokens": max(0, before_tokens - after_tokens),
        }

    def _last_edit_result(self, entries: list[str]) -> str:
        """保留窗口外最近一次 edit 的修改结果，供模型判断文件现状。

        edit 结果条目形如 "ACTION edit: <summary>\\nCHANGED: [files]\\nDIFF:\\n<diff>"。
        折叠历史时若把 DIFF 一并摘要掉，模型会不知道上一轮改了什么，从而
        基于旧内容重复编辑；这里从窗口外倒序找最近的 edit 结果并完整保留，
        超长时截断并提示模型"请基于此判断现状，勿用更早内容重复编辑"。
        """

        for entry in reversed(entries):
            if "ACTION edit" not in entry and "\nCHANGED:" not in entry:
                continue
            marker = "\n（上次编辑结果已保留，请基于此判断文件现状，勿用更早内容重复编辑）"
            limit = _PRESERVE_EDIT_RESULT_CHARS
            if len(entry) <= limit:
                return entry
            return entry[: max(0, limit - len(marker))] + marker
        return ""

    def _last_read_result(self, entries: list[str]) -> str:
        """保留窗口外最近一次 read 的完整观察，供模型掌握文件现场。

        read 观察条目形如 "ACTION read paths=[...]\\nOBSERVATION:\\n<文件内容>"。
        折叠历史时若把观察一并摘要掉，模型会"读而不见"——知道自己 read 过但
        看不到内容，从而循环 read 同一批文件。这里从窗口外倒序找最近的、
        含真实内容的 read 观察并完整保留；超长时截断并提示用 offsets 分页
        读取指定区域，而不是全量重读。

        "未变化"瘦身提示（OBSERVATION（以下文件未变化…））不含文件内容，
        不视为有效观察，跳过。
        """

        for entry in reversed(entries):
            if "ACTION read" not in entry or "OBSERVATION:" not in entry:
                continue
            if "以下文件未变化" in entry:
                continue
            marker = (
                "\n（最近一次读取结果已保留；内容过长已截断，如需完整内容"
                "请用 read offsets 分页读取指定区域，不要全量重读）"
            )
            limit = _PRESERVE_READ_RESULT_CHARS
            if len(entry) <= limit:
                return entry
            return entry[: max(0, limit - len(marker))] + marker
        return ""

    def _preserve_head_context(self, entries: list[str]) -> list[str]:
        """保留 transcript 头部短小的结构上下文条目，超出阈值即停止。"""

        preserved: list[str] = []
        for entry in entries:
            stripped = entry.lstrip()
            if not stripped.startswith(
                ("WORK CONTEXT:", "TASK SPEC:", "MEMORY NOTES:", "RELATED FILES:")
            ):
                break
            if len(entry) > _PRESERVE_HEAD_ENTRY_CHARS:
                break
            preserved.append(entry)
        return preserved

    def _summarize_entries(self, entries: list[str]) -> str:
        """从窗口外记录生成动作轨迹摘要，让模型回顾前期进展而不是失忆。

        零 LLM 成本的确定性摘要：提取每条记录的 ACTION 行与观察概要，
        合并连续重复动作，最多保留 40 条轨迹。
        """

        lines: list[str] = []
        previous_action = ""
        for entry in entries:
            action_line = self._action_line(entry)
            if not action_line:
                continue
            if action_line == previous_action:
                continue
            previous_action = action_line
            summary_line = action_line[:150]
            observation = self._observation_summary(entry)
            if observation:
                summary_line += f" → {observation}"
            lines.append(f"- {summary_line}")
            if len(lines) >= 40:
                break
        if not lines:
            return ""
        return (
            "== 前期动作摘要（详情已随窗口折叠，需要时可重新 read 查看）==\n"
            + "\n".join(lines)
        )

    @staticmethod
    def _action_line(entry: str) -> str:
        """提取记录中的 ACTION 行（可能跨行，取首个 ACTION 前缀行）。"""

        for line in entry.splitlines():
            stripped = line.strip()
            if stripped.startswith("ACTION"):
                return " ".join(stripped.split())[:200]
        return ""

    @staticmethod
    def _observation_summary(entry: str) -> str:
        """提取 OBSERVATION 后的首行内容摘要，用于动作轨迹的可读化。"""

        marker = "OBSERVATION:"
        index = entry.find(marker)
        if index < 0:
            return ""
        tail = entry[index + len(marker) :].strip()
        if not tail:
            return ""
        first_line = tail.splitlines()[0].strip()[:100]
        return first_line or ""

    def _fit_window_to_budget(self, entries: list[str]) -> list[str]:
        """窗口内完整保留，但总量超过保险值时从最老条目开始瘦身。"""

        fitted = list(entries)
        total = sum(self._estimate_tokens(item) for item in fitted)
        if total <= MAX_WINDOW_TOKENS:
            return fitted
        for index in range(len(fitted)):
            if total <= MAX_WINDOW_TOKENS:
                break
            original = fitted[index]
            slimmed = self._compact_transcript_entry(original)
            if slimmed == original:
                continue
            total += self._estimate_tokens(slimmed) - self._estimate_tokens(original)
            fitted[index] = slimmed
        return fitted

    def compact_transcript_budget(
        self, transcript: list[str]
    ) -> tuple[list[str], dict[str, Any]]:
        """预算耗尽前的一次性紧急压缩：完整保留最近若干轮，旧观察做工具结果瘦身。

        这是预算硬性耗尽时的兜底路径（而不是正常循环的默认行为）：完整保留
        最近 BUDGET_KEEP_RECENT_ENTRIES 条观察，只对更早的工具观察截断大段
        源码/Diff，避免模型完全失去正在处理的文件内容；调用方会同时清空
        transcript_versions，防止模型误以为截断后的内容仍是完整版本。
        """

        entries = list(transcript)
        if not entries:
            return entries, {
                "removed": 0,
                "before_tokens": 0,
                "after_tokens": 0,
                "saved_tokens": 0,
            }
        before_tokens = sum(self._estimate_tokens(item) for item in entries)
        recent_tail = entries[-BUDGET_KEEP_RECENT_ENTRIES:]
        older = entries[:-BUDGET_KEEP_RECENT_ENTRIES]
        slimmed = [self._compact_transcript_entry(entry) for entry in older]
        fitted = self._fit_entries_to_budget(slimmed)
        result = fitted + recent_tail
        after_tokens = sum(self._estimate_tokens(item) for item in result)
        saved_tokens = max(0, before_tokens - after_tokens)
        return result, {
            "removed": max(0, len(entries) - len(result)),
            "before_tokens": before_tokens,
            "after_tokens": after_tokens,
            "saved_tokens": saved_tokens,
        }

    def _compact_transcript_entry(self, entry: str) -> str:
        """截断单条工具观察中的大段源码或 Diff，保留动作与结果开头。"""

        tool_entry = entry.startswith("ACTION ") or "\nOBSERVATION:\n" in entry
        if not tool_entry:
            return entry
        limit = self._max_tool_output_token * 2
        if len(entry) <= limit:
            return entry
        marker = "\n（单条工具观察已按 Token 预算截断）"
        return entry[: max(0, limit - len(marker))] + marker

    def _fit_entries_to_budget(self, entries: list[str]) -> list[str]:
        """在记录数量很少但单条很大时，按 Token 预算缩短最长记录。"""

        fitted = list(entries)
        while fitted:
            total = sum(self._estimate_tokens(item) for item in fitted)
            if total <= self._max_work_context_token:
                break
            index = max(range(len(fitted)), key=lambda item: self._estimate_tokens(fitted[item]))
            current_tokens = self._estimate_tokens(fitted[index])
            removable = max(0, current_tokens - 256)
            if removable <= 0:
                break
            target = max(256, current_tokens - min(removable, total - self._max_work_context_token))
            fitted[index] = self._truncate_to_tokens(fitted[index], target)
        return fitted

    def _truncate_to_tokens(self, text: str, token_limit: int) -> str:
        """使用二分查找截断文本，使 UTF-8 Token 估算不超过目标值。"""

        marker = "\n（上下文已按 Work Token 预算截断）"
        if self._estimate_tokens(text) <= token_limit:
            return text
        low = 0
        high = len(text)
        while low < high:
            middle = (low + high + 1) // 2
            candidate = text[:middle] + marker
            if self._estimate_tokens(candidate) <= token_limit:
                low = middle
            else:
                high = middle - 1
        return text[:low] + marker

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """使用 UTF-8 字节数估算中英文混合文本 Token 数。"""

        if not text:
            return 0
        return max(1, (len(text.encode("utf-8")) + 3) // 4)
