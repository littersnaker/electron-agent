"""Code Agent 单个 Work 的可恢复状态与执行结果。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from backend.services.agent.command_runner import CommandResult
from backend.services.llm.types import LlmUsage


@dataclass(slots=True)
class WorkWorkerState:
    """保存一个并行 Worker 可持久化恢复的安全状态。"""

    transcript: list[str] = field(default_factory=list)
    read_versions: dict[str, str] = field(default_factory=dict)
    # path -> 内容指纹：记录“完整内容当前已在 transcript 中”的文件版本，
    # 用于工具结果瘦身（未变化文件不再重复注入全文，避免每轮全量重发）。
    transcript_versions: dict[str, str] = field(default_factory=dict)
    changed_files: list[str] = field(default_factory=list)
    commands: list[CommandResult] = field(default_factory=list)
    usage: LlmUsage = field(default_factory=LlmUsage)
    model_name: str = ""
    invalid_rounds: int = 0
    iterations: int = 0
    factory_validations: dict[str, bool] = field(default_factory=dict)
    work_context: dict[str, Any] = field(default_factory=dict)
    reasoning_state: dict[str, Any] = field(default_factory=dict)
    reasoning_memory: list[dict[str, Any]] = field(default_factory=list)
    failure_summary: dict[str, Any] = field(default_factory=dict)
    token_budget: dict[str, Any] = field(default_factory=dict)
    decision_gate: dict[str, Any] = field(default_factory=dict)
    reflection: dict[str, Any] = field(default_factory=dict)
    regression_baseline: dict[str, Any] = field(default_factory=dict)
    quality: dict[str, Any] = field(default_factory=dict)
    # 执行守卫字段必须进入 Checkpoint，恢复后仍能识别重复读取与无限分析。
    action_history: list[str] = field(default_factory=list)
    context_action_history: list[str] = field(default_factory=list)
    context_actions: int = 0
    post_write_context_actions: int = 0
    write_actions: int = 0
    guard_rejections: int = 0
    last_progress_iteration: int = 0
    # 连续"有效但无进展"的轮次（协议错误轮不计入），用于停滞守卫判定。
    stall_rounds: int = 0
    # 以下字段只描述当前尝试；每次 retry/replan 都会清零，避免旧守卫状态污染新尝试。
    attempt_number: int = 0
    attempt_iterations: int = 0
    attempt_invalid_rounds: int = 0
    runtime_failures: int = 0

    def begin_attempt(self, attempt_number: int) -> None:
        """开始一次新的 Work 尝试，并重置仅属于单次执行的收敛计数。"""

        normalized = max(1, int(attempt_number))
        if self.attempt_number == normalized:
            return
        previous = self.attempt_number
        self.attempt_number = normalized
        self.attempt_iterations = 0
        self.attempt_invalid_rounds = 0
        self.invalid_rounds = 0
        self.context_actions = 0
        self.post_write_context_actions = 0
        self.write_actions = 0
        self.guard_rejections = 0
        self.action_history.clear()
        self.context_action_history.clear()
        self.last_progress_iteration = 0
        self.stall_rounds = 0
        if previous > 0:
            # 保留失败摘要、已修改文件和推理事实，但删除上一尝试的大段工具观察。
            summary = self.failure_summary.get("error") if self.failure_summary else ""
            changed = ", ".join(self.changed_files[-20:]) or "无"
            self.transcript = [
                f"RETRY ATTEMPT {normalized}: 上一尝试已结束。",
                f"FAILURE SUMMARY: {str(summary)[:4_000] or '请根据当前代码状态继续。'}",
                f"EXISTING CHANGED FILES: {changed}",
            ]
            # 上一尝试的完整文件内容已从 transcript 移除，指纹必须同步清空，
            # 否则恢复后的 read 会把“未变化”误判为已在上下文中。
            self.transcript_versions.clear()

    def append_transcript(self, entry: str) -> None:
        """追加一条工具观察；单次任务内完整保留，不做截断或总量裁剪。

        压缩只发生在整段聊天的记忆层，不发生在单个任务的工作循环里。
        """

        self.transcript.append(str(entry or ""))

    def to_json(self) -> dict[str, Any]:
        """转换成 Checkpoint 可存储的 JSON。"""

        return {
            "transcript": self.transcript,
            "readVersions": self.read_versions,
            "transcriptVersions": self.transcript_versions,
            "changedFiles": self.changed_files,
            "commands": [
                {
                    "command": item.command,
                    "exitCode": item.exit_code,
                    "output": item.output,
                    "timedOut": item.timed_out,
                    "blockedReason": item.blocked_reason,
                }
                for item in self.commands
            ],
            "usage": {
                "prompt": self.usage.prompt,
                "completion": self.usage.completion,
                "total": self.usage.total,
            },
            "modelName": self.model_name,
            "invalidRounds": self.invalid_rounds,
            "iterations": self.iterations,
            "factoryValidations": dict(self.factory_validations),
            "workContext": dict(self.work_context),
            "reasoningState": dict(self.reasoning_state),
            "reasoningMemory": list(self.reasoning_memory),
            "failureSummary": dict(self.failure_summary),
            "tokenBudget": dict(self.token_budget),
            "decisionGate": dict(self.decision_gate),
            "reflection": dict(self.reflection),
            "regressionBaseline": dict(self.regression_baseline),
            "quality": dict(self.quality),
            "actionHistory": list(self.action_history),
            "contextActionHistory": list(self.context_action_history),
            "contextActions": self.context_actions,
            "postWriteContextActions": self.post_write_context_actions,
            "writeActions": self.write_actions,
            "guardRejections": self.guard_rejections,
            "lastProgressIteration": self.last_progress_iteration,
            "stallRounds": self.stall_rounds,
            "attemptNumber": self.attempt_number,
            "attemptIterations": self.attempt_iterations,
            "attemptInvalidRounds": self.attempt_invalid_rounds,
            "runtimeFailures": self.runtime_failures,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "WorkWorkerState":
        """从 Checkpoint 恢复 Worker 状态。"""

        commands = [
            CommandResult(
                command=str(item.get("command") or ""),
                exit_code=int(item.get("exitCode") or 0),
                output=str(item.get("output") or ""),
                timed_out=bool(item.get("timedOut")),
                blocked_reason=str(item.get("blockedReason") or ""),
            )
            for item in value.get("commands", [])
            if isinstance(item, dict)
        ]
        usage_raw = dict(value.get("usage") or {})
        return cls(
            transcript=[str(item) for item in value.get("transcript", [])],
            read_versions={
                str(path): str(version)
                for path, version in dict(value.get("readVersions") or {}).items()
            },
            transcript_versions={
                str(path): str(version)
                for path, version in dict(value.get("transcriptVersions") or {}).items()
            },
            changed_files=[str(item) for item in value.get("changedFiles", [])],
            commands=commands,
            usage=LlmUsage(
                prompt=int(usage_raw.get("prompt") or 0),
                completion=int(usage_raw.get("completion") or 0),
                total=int(usage_raw.get("total") or 0),
            ),
            model_name=str(value.get("modelName") or ""),
            invalid_rounds=int(value.get("invalidRounds") or 0),
            iterations=int(value.get("iterations") or 0),
            factory_validations={
                str(path): bool(passed)
                for path, passed in dict(
                    value.get("factoryValidations") or {}
                ).items()
            },
            work_context=dict(value.get("workContext") or {}),
            reasoning_state=dict(value.get("reasoningState") or {}),
            reasoning_memory=[
                dict(item)
                for item in value.get("reasoningMemory", [])
                if isinstance(item, dict)
            ],
            failure_summary=dict(value.get("failureSummary") or {}),
            token_budget=dict(value.get("tokenBudget") or {}),
            decision_gate=dict(value.get("decisionGate") or {}),
            reflection=dict(value.get("reflection") or {}),
            regression_baseline=dict(value.get("regressionBaseline") or {}),
            quality=dict(value.get("quality") or {}),
            action_history=[str(item) for item in value.get("actionHistory", [])],
            context_action_history=[
                str(item) for item in value.get("contextActionHistory", [])
            ],
            context_actions=int(value.get("contextActions") or 0),
            post_write_context_actions=int(
                value.get("postWriteContextActions") or 0
            ),
            write_actions=int(value.get("writeActions") or 0),
            guard_rejections=int(value.get("guardRejections") or 0),
            last_progress_iteration=int(value.get("lastProgressIteration") or 0),
            stall_rounds=int(value.get("stallRounds") or 0),
            attempt_number=int(value.get("attemptNumber") or 0),
            attempt_iterations=int(value.get("attemptIterations") or 0),
            attempt_invalid_rounds=int(value.get("attemptInvalidRounds") or 0),
            runtime_failures=int(value.get("runtimeFailures") or 0),
        )


FailureKind = Literal["code", "runtime", "validation", "resource", "guard"]


@dataclass(slots=True)
class WorkExecutionResult:
    """保存一个 Work Worker 的真实终态。"""

    work_id: str
    succeeded: bool
    summary: str
    error: str
    state: WorkWorkerState
    failure_kind: FailureKind = "code"
