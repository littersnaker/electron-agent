"""单个 Work 的独立工具循环，可由调度器并行运行。"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from backend.services.agent.command_runner import CommandResult, run_safe_command
from backend.services.agent.loop_protocol import parse_agent_action
from backend.services.agent.loop_support import (
    ExecutionMode,
    command_observation,
    trim_transcript,
    usage_add,
)
from backend.services.agent.resource_coordinator import (
    SPECIAL_TERMINAL_RESOURCE,
    WorkspaceResourceCoordinator,
)
from backend.services.agent.task_planner import CodeTaskPlan
from backend.services.agent.tool_registry import render_tool_catalog
from backend.services.agent.work_models import WorkItem
from backend.services.agent.workspace_tools import (
    apply_edit_operations,
    file_version,
    read_workspace_files_with_versions,
    search_workspace,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage, LlmUsage


EmitCallback = Callable[[str, dict[str, Any]], Awaitable[None]]
CheckpointCallback = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class WorkWorkerState:
    """一个并行 Worker 可持久化恢复的安全状态。"""

    transcript: list[str] = field(default_factory=list)
    read_versions: dict[str, str] = field(default_factory=dict)
    changed_files: list[str] = field(default_factory=list)
    commands: list[CommandResult] = field(default_factory=list)
    usage: LlmUsage = field(default_factory=LlmUsage)
    model_name: str = ""
    invalid_rounds: int = 0
    iterations: int = 0

    def to_json(self) -> dict[str, Any]:
        """转换成 Checkpoint 可存储的 JSON。"""

        return {
            "transcript": self.transcript,
            "readVersions": self.read_versions,
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
        )


@dataclass(slots=True)
class WorkExecutionResult:
    """一个 Work Worker 的真实终态。"""

    work_id: str
    succeeded: bool
    summary: str
    error: str
    state: WorkWorkerState



def _worker_prompt(
    task_plan: CodeTaskPlan,
    work: WorkItem,
    execution_mode: ExecutionMode,
) -> str:
    """生成只允许处理当前 Work 的工具协议提示词。"""

    run_rule = (
        "允许 run 执行受限验证命令。"
        if execution_mode == "full_auto"
        else "当前为自动编辑模式，run 会被跳过。"
    )
    return f"""你是 Code Agent 的并行 Worker，只负责当前 WORK，不得执行其他 Work。
工具目录：
{render_tool_catalog()}

每轮只返回一个 JSON 对象，不得附加 Markdown。
规则：
- workId 必须是 {work.id}，或留空由后端补全；不得引用其他 Work。
- 先 search/read 真实代码，再 edit；完成后必须 complete_work。
- 当前 Work 与其他 Worker 并行。修改同一文件时后端会按 priority={work.priority} 串行加锁。
- 如果文件在 read 后被其他 Work 修改，后端会拒绝旧补丁；必须重新 read 再生成精确修改。
- 不读取 .env、密钥和二进制文件，不越出项目根目录。
- 每个手写源码文件不超过 500 行，复杂模块应拆分。
- {run_rule}

TASK SPEC:
{task_plan.to_prompt_json()}

CURRENT WORK:
{json.dumps(work.to_json(), ensure_ascii=False, indent=2)}
"""


async def execute_work(
    *,
    root: Path,
    task_plan: CodeTaskPlan,
    work: WorkItem,
    initial_context: str,
    project_tree: str,
    ledger_snapshot: dict[str, Any],
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """持续执行一个 Work，直到成功完成或出现需要 Planner 处理的错误。"""

    if not state.transcript:
        state.transcript.extend(
            [
                f"PROJECT TREE:\n{project_tree}",
                f"INITIAL RELATED FILES:\n{initial_context}",
                f"FULL WORKLIST SNAPSHOT:\n{json.dumps(ledger_snapshot, ensure_ascii=False, indent=2)}",
            ]
        )
    agent_id = f"modify_worker:{work.id}"

    while True:
        await checkpoint()
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", _worker_prompt(task_plan, work, execution_mode)),
                LlmMessage("user", trim_transcript(state.transcript)),
            ],
            temperature=0.1,
        )
        usage_add(state.usage, usage)
        state.model_name = model.name
        state.iterations += 1
        await emit(
            "usage",
            {
                "workId": work.id,
                "prompt": usage.prompt,
                "completion": usage.completion,
                "total": usage.total,
            },
        )

        try:
            action = parse_agent_action(text)
            state.invalid_rounds = 0
        except ValueError as exc:
            state.invalid_rounds += 1
            state.transcript.append(f"PROTOCOL ERROR: {exc}\n请返回合法单动作 JSON。")
            if state.invalid_rounds >= 3:
                return WorkExecutionResult(
                    work.id,
                    False,
                    "",
                    f"模型连续返回无效工具协议：{exc}",
                    state,
                )
            continue

        if action.work_id and action.work_id != work.id:
            state.transcript.append(
                f"WORK ID ERROR: 当前 Worker 只能处理 {work.id}，不能处理 {action.work_id}。"
            )
            continue

        if action.action == "finish":
            state.transcript.append(
                "FINISH REJECTED: 并行 Worker 必须使用 complete_work 提交当前 Work 结果。"
            )
            continue

        if action.action == "search":
            await emit(
                "lifecycle",
                {
                    "role": "modify_worker",
                    "agentId": agent_id,
                    "slot": slot,
                    "status": "running",
                    "detail": f"{work.id} · {work.title}：搜索 {action.query}",
                    "toolName": "search_codebase",
                },
            )
            result = await asyncio.to_thread(search_workspace, root, action.query)
            state.transcript.append(
                f"ACTION search query={action.query}\nOBSERVATION:\n{result}"
            )
            await checkpoint()
            continue

        if action.action == "read":
            await emit(
                "lifecycle",
                {
                    "role": "modify_worker",
                    "agentId": agent_id,
                    "slot": slot,
                    "status": "running",
                    "detail": f"{work.id} · {work.title}：读取 {len(action.paths)} 个文件",
                    "toolName": "read_file_from_disk",
                },
            )
            read_result = await asyncio.to_thread(
                read_workspace_files_with_versions, root, action.paths
            )
            state.read_versions.update(read_result.versions)
            state.transcript.append(
                f"ACTION read paths={action.paths}\nOBSERVATION:\n{read_result.content}"
            )
            await checkpoint()
            continue

        if action.action == "edit":
            paths = {operation.path for operation in action.operations}
            await emit(
                "lifecycle",
                {
                    "role": "modify_worker",
                    "agentId": agent_id,
                    "slot": slot,
                    "status": "running",
                    "detail": f"{work.id} · {work.title}：等待并写入 {len(paths)} 个文件",
                    "toolName": "apply_file_change",
                },
            )
            try:
                async with coordinator.reserve(
                    paths,
                    owner=work.id,
                    priority=work.priority,
                ):
                    expected = {
                        path: state.read_versions[path]
                        for path in paths
                        if path in state.read_versions
                    }
                    edit_result = await asyncio.to_thread(
                        apply_edit_operations,
                        root,
                        action.operations,
                        expected_versions=expected,
                    )
                    for path in edit_result.changed_files:
                        state.read_versions[path] = file_version(root, path)
            except Exception as exc:
                error_text = str(exc)
                if "并行冲突" in error_text:
                    # 另一个高优先级 Work 已先写入同一文件。这里不把任务判失败，
                    # 而是要求当前 Worker 重新读取最新版本后继续生成补丁。
                    state.transcript.append(
                        f"EDIT RETRY REQUIRED: {error_text}\n"
                        "请先 read 冲突文件，再基于最新内容重新 edit。"
                    )
                    await emit(
                        "lifecycle",
                        {
                            "role": "modify_worker",
                            "agentId": agent_id,
                            "slot": slot,
                            "status": "running",
                            "detail": f"{work.id} 检测到并行文件更新，正在读取最新版本后重试",
                            "toolName": "read_file_from_disk",
                        },
                    )
                    await checkpoint()
                    continue
                return WorkExecutionResult(
                    work.id,
                    False,
                    "",
                    f"EDIT FAILED: {exc}",
                    state,
                )
            for path in edit_result.changed_files:
                if path not in state.changed_files:
                    state.changed_files.append(path)
            state.transcript.append(
                f"ACTION edit: {action.summary}\nCHANGED: {edit_result.changed_files}\n"
                f"DIFF:\n{edit_result.diff_preview}"
            )
            await emit(
                "lifecycle",
                {
                    "role": "merge_agent",
                    "agentId": f"merge_agent:{work.id}",
                    "slot": slot,
                    "status": "completed",
                    "detail": f"{work.id} 已串行合并 {len(edit_result.changed_files)} 个文件",
                    "toolName": "apply_file_change",
                },
            )
            await checkpoint()
            continue

        if action.action == "run":
            if execution_mode != "full_auto":
                state.transcript.append(
                    f"ACTION run skipped: {action.command}\n自动编辑模式不执行命令。"
                )
                await checkpoint()
                continue
            await emit(
                "lifecycle",
                {
                    "role": "verification_agent",
                    "agentId": f"verification_agent:{work.id}",
                    "slot": slot,
                    "status": "running",
                    "detail": f"{work.id}：执行 {action.command}",
                    "toolName": "run_terminal_command",
                },
            )
            async with coordinator.reserve(
                {SPECIAL_TERMINAL_RESOURCE},
                owner=work.id,
                priority=work.priority,
            ):
                command_result = await run_safe_command(root, action.command)
            state.commands.append(command_result)
            observation = command_observation(command_result)
            state.transcript.append(observation)
            await checkpoint()
            if not command_result.succeeded:
                return WorkExecutionResult(
                    work.id,
                    False,
                    "",
                    observation,
                    state,
                )
            await emit(
                "lifecycle",
                {
                    "role": "verification_agent",
                    "agentId": f"verification_agent:{work.id}",
                    "slot": slot,
                    "status": "completed",
                    "detail": f"{work.id} 验证通过：{action.command}",
                },
            )
            continue

        return WorkExecutionResult(
            work.id,
            True,
            action.summary or f"{work.title} 已完成",
            "",
            state,
        )
