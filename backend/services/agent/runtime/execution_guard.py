"""单个 Work 的执行收敛守卫。

守卫限制重复读取、无边界分析、超长模型响应和无限工具轮次。它不替代 Planner，
只在 Worker 已经拥有足够上下文时强制其进入修改、验证或完成阶段。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from backend.services.agent.loop_protocol import AgentAction
from backend.services.agent.work_state import WorkWorkerState

_CONTEXT_ACTIONS = {"search", "read", "inspect"}
_PROGRESS_ACTIONS = {"edit", "factory"}


@dataclass(frozen=True, slots=True)
class ExecutionLimits:
    """保存可通过环境变量调整的 Worker 收敛阈值。"""

    max_iterations: int = 12
    max_context_actions: int = 5
    max_post_write_context_actions: int = 2
    max_guard_rejections: int = 2
    model_timeout_seconds: int = 300
    max_stall_rounds: int = 4

    @classmethod
    def from_environment(cls, target_file_count: int = 0) -> "ExecutionLimits":
        """读取环境变量并把异常值限制在安全范围。"""

        base = cls(
            max_iterations=_env_int("CODE_AGENT_MAX_WORK_ITERATIONS", 12, 6, 60),
            max_context_actions=_env_int("CODE_AGENT_MAX_CONTEXT_ACTIONS", 5, 3, 24),
            max_post_write_context_actions=_env_int(
                "CODE_AGENT_MAX_POST_WRITE_CONTEXT_ACTIONS",
                2,
                1,
                12,
            ),
            max_guard_rejections=_env_int(
                "CODE_AGENT_MAX_GUARD_REJECTIONS",
                2,
                1,
                8,
            ),
            model_timeout_seconds=_env_int(
                "CODE_AGENT_MODEL_TIMEOUT_SECONDS",
                300,
                30,
                900,
            ),
            max_stall_rounds=_env_int(
                "CODE_AGENT_MAX_STALL_ROUNDS",
                4,
                2,
                12,
            ),
        )
        # 多文件 Work（购物车 UI + 状态同步等）需要更多读取与编辑轮次；
        # 按目标文件数量自适应放宽，同时保留小任务的高收敛要求。
        files = max(0, int(target_file_count or 0))
        return cls(
            max_iterations=max(6, min(24, base.max_iterations + files)),
            max_context_actions=max(3, min(10, base.max_context_actions + files // 2)),
            max_post_write_context_actions=max(
                1,
                min(5, base.max_post_write_context_actions + files // 4),
            ),
            max_guard_rejections=base.max_guard_rejections,
            model_timeout_seconds=base.model_timeout_seconds,
            # 多文件 Work 需要先批量读取再动手编辑，放宽"无进展"轮次上限，
            # 但保持小任务的高收敛要求，且只统计有效动作轮次（协议错误不计入）。
            max_stall_rounds=max(4, min(10, base.max_stall_rounds + files // 2)),
        )


@dataclass(frozen=True, slots=True)
class GuardDecision:
    """描述当前动作是否允许执行，以及是否应终止 Work。"""

    allowed: bool
    stop: bool = False
    feedback: str = ""
    error: str = ""


class WorkExecutionGuard:
    """基于持久化 Worker 状态阻止重复动作和无限分析。"""

    def __init__(
        self,
        state: WorkWorkerState,
        limits: ExecutionLimits | None = None,
    ) -> None:
        """保存 Worker 状态与本次运行阈值。"""

        self.state = state
        self.limits = limits or ExecutionLimits.from_environment()

    def before_model_call(self) -> GuardDecision:
        """在调用模型前检查总轮次和累计拒绝次数。"""

        if self.state.attempt_iterations >= self.limits.max_iterations:
            return GuardDecision(
                allowed=False,
                stop=True,
                error=(
                    f"Work 已达到 {self.limits.max_iterations} 轮模型调用上限，"
                    "已停止继续消耗并交由 Planner 处理。"
                ),
            )
        if self.state.guard_rejections >= self.limits.max_guard_rejections:
            return GuardDecision(
                allowed=False,
                stop=True,
                error=(
                    "模型连续忽略执行守卫，仍重复读取或搜索；"
                    "已停止当前 Work，避免无限分析。"
                ),
            )
        stall_rounds = self.state.stall_rounds
        if stall_rounds >= self.limits.max_stall_rounds:
            return GuardDecision(
                allowed=False,
                stop=True,
                error=(
                    f"执行守卫终止：Work 已连续 {stall_rounds} 轮无实质进展"
                    "（未成功写入、运行或完成），"
                    "已停止当前 Work 并交由 Planner 重新规划，避免空转消耗 Token。"
                ),
            )
        return GuardDecision(allowed=True)

    def before_action(self, action: AgentAction) -> GuardDecision:
        """在工具执行前阻止重复上下文动作和阶段漂移。"""

        if action.action not in _CONTEXT_ACTIONS:
            return GuardDecision(allowed=True)

        fingerprint = action_fingerprint(action)
        if fingerprint in self.state.context_action_history:
            return self._reject(
                "该读取或搜索动作已经执行过，结果仍在当前上下文中。"
                "禁止重复调用；请直接 edit、factory、run 或 complete_work。"
            )

        if self.state.write_actions <= 0:
            if self.state.context_actions >= self.limits.max_context_actions:
                return self._reject(
                    f"分析阶段已执行 {self.state.context_actions} 个上下文动作，"
                    "信息已达到上限。下一步必须修改代码或明确完成，不能继续扩展读取范围。"
                )
        elif (
            self.state.post_write_context_actions
            >= self.limits.max_post_write_context_actions
        ):
            return self._reject(
                "代码已经发生修改，后续读取次数已达到上限。"
                "请执行验证、修复明确错误或提交 complete_work。"
            )
        return GuardDecision(allowed=True)

    def record(
        self,
        action: AgentAction,
        outcome_kind: str,
        *,
        progress_made: bool = False,
        refresh_context: bool = False,
    ) -> None:
        """记录动作，并仅在真实写入或版本冲突时调整上下文阶段。"""

        fingerprint = action_fingerprint(action)
        self.state.action_history.append(fingerprint)
        self.state.action_history = self.state.action_history[-60:]

        if action.action in _CONTEXT_ACTIONS and outcome_kind != "failure":
            self.state.context_actions += 1
            self.state.post_write_context_actions += int(self.state.write_actions > 0)
            self.state.context_action_history.append(fingerprint)
            self.state.context_action_history = self.state.context_action_history[-30:]
            self.state.stall_rounds += 1
            return

        if refresh_context:
            # 并行文件版本发生变化时，允许再次读取同一路径获取新版本。
            self.state.context_action_history.clear()
            self.state.guard_rejections = 0
            self.state.stall_rounds = 0

        progressed = False
        if action.action == "edit" and progress_made:
            self._record_progress()
            progressed = True
        if (
            action.action == "factory"
            and action.factory_mode == "generate"
            and progress_made
        ):
            self._record_progress()
            progressed = True
        if (
            action.action in {"run", "complete_work"}
            and outcome_kind != "failure"
        ):
            # 运行/完成代表有实质进展，但不应把 write_actions 计数当作“已写文件”阶段。
            self.state.last_progress_iteration = self.state.attempt_iterations
            self.state.stall_rounds = 0
            progressed = True
        if not progressed:
            # 无变化的 edit、被跳过的 run 等仍属于空转轮次，计入停滞计数。
            self.state.stall_rounds += 1

    def prompt_directive(self) -> str:
        """生成每轮附加给模型的短指令，明确剩余执行预算。"""

        remaining = max(0, self.limits.max_iterations - self.state.attempt_iterations)
        if self.state.write_actions > 0:
            post_write_remaining = max(
                0,
                self.limits.max_post_write_context_actions
                - self.state.post_write_context_actions,
            )
            phase = (
                "已修改代码；优先验证并完成 Work，"
                f"最多再读取 {post_write_remaining} 次。"
            )
        else:
            phase = (
                "尚未修改代码；应批量读取必要文件后尽快编辑，"
                f"上下文动作剩余 {max(0, self.limits.max_context_actions - self.state.context_actions)} 次。"
            )
        return (
            "EXECUTION GUARD:\n"
            f"- 模型轮次剩余：{remaining}\n"
            f"- {phase}\n"
            "- 已执行过的 read/search 不得重复；一次 read 应批量包含全部已知关键文件。"
        )

    def _reject(self, feedback: str) -> GuardDecision:
        """累计一次守卫拒绝，并在达到阈值时要求终止。"""

        self.state.guard_rejections += 1
        self.state.stall_rounds += 1
        stop = self.state.guard_rejections >= self.limits.max_guard_rejections
        return GuardDecision(
            allowed=False,
            stop=stop,
            feedback=f"EXECUTION GUARD REJECTED: {feedback}",
            error=(
                "模型连续重复上下文动作，执行守卫已终止当前 Work。"
                if stop
                else ""
            ),
        )

    def _record_progress(self) -> None:
        """记录一次真实写入，并允许基于新代码重新读取必要文件。"""

        self.state.write_actions += 1
        self.state.post_write_context_actions = 0
        self.state.context_action_history.clear()
        self.state.guard_rejections = 0
        self.state.last_progress_iteration = self.state.attempt_iterations
        self.state.stall_rounds = 0


def action_fingerprint(action: AgentAction) -> str:
    """为上下文动作生成稳定且不包含大段代码的指纹。"""

    if action.action == "read":
        payload = {
            "action": "read",
            "paths": sorted(set(action.paths)),
            "offsets": {
                path: action.offsets.get(path, 0)
                for path in sorted(set(action.paths))
            },
        }
    elif action.action == "search":
        payload = {"action": "search", "query": " ".join(action.query.lower().split())}
    elif action.action == "inspect":
        payload = {
            "action": "inspect",
            "paths": sorted(set(action.paths)),
            "query": " ".join(action.query.lower().split()),
        }
    elif action.action == "edit":
        payload = {
            "action": "edit",
            "operations": [
                {"type": item.type, "path": item.path} for item in action.operations
            ],
        }
    elif action.action == "factory":
        payload = {
            "action": "factory",
            "mode": action.factory_mode,
            "outputRoot": action.factory_output_root,
        }
    else:
        payload = {"action": action.action, "command": action.command[:200]}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数环境变量，并把值限制在给定闭区间。"""

    try:
        value = int(os.getenv(name, str(default)).strip())
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


__all__ = [
    "ExecutionLimits",
    "GuardDecision",
    "WorkExecutionGuard",
    "action_fingerprint",
]
