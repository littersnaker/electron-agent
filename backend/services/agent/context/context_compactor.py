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
        """单次任务内完整透传 transcript，不做截断、去重或总量裁剪。

        文件大小未知，压缩会导致模型看不到完整内容而陷入循环读取；
        因此本方法保留全部记录，仅返回统计信息供调用方使用。
        """

        before_tokens = sum(self._estimate_tokens(item) for item in transcript)
        return list(transcript), {
            "removed": 0,
            "before_tokens": before_tokens,
            "after_tokens": before_tokens,
        }

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
