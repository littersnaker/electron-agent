"""Code Agent 单轮工具动作的执行器。"""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from uuid import uuid4

from backend.services.agent.runtime.action_guard import guard_edit, record_factory_decision
from backend.services.agent.shared.command_runner import (
    CommandResult,
    command_approval_enabled,
    install_packages_allowed,
    is_high_risk_command,
    requires_user_approval,
)
from backend.services.agent.shared.loop_protocol import AgentAction
from backend.services.agent.shared.loop_support import ExecutionMode, command_observation
from backend.services.agent.shared.resource_coordinator import (
    SPECIAL_TERMINAL_RESOURCE,
    WorkspaceResourceCoordinator,
)
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import WorkWorkerState
from backend.services.agent.shared.workspace_tools import EditBatchResult, ReadBatchResult
from backend.services.agent.spill import SpillStore, maybe_spill_result
from backend.services.agent.worker.pending import (
    consume_pending_command,
    find_pending_command,
    save_pending_command,
)
from backend.services.agent.worker.work_batch_writer import _env_int
from backend.services.tools.code_tools import execute_code_tool

EmitCallback = Callable[[str, dict[str, Any]], Awaitable[None]]
CheckpointCallback = Callable[[], Awaitable[None]]
OutcomeKind = Literal["continue", "success", "failure", "pause"]

# 单个 replace 的 old/new 最大字符数：超过视为整段重写，工具层直接拒绝该
# operation，要求模型用最小定位片段重发（对齐"改已有文件只给最小片段"的
# 结构性约束）。write（新建文件）不受此限制，仍允许完整内容。
MAX_REPLACE_TEXT_CHARS = _env_int("CODE_AGENT_MAX_REPLACE_CHARS", 3_000, 200, 200_000)
# 安装/初始化类命令耗时较长，审批通过后单独放宽超时（默认 10 分钟）。
INSTALL_TIMEOUT_SECONDS = _env_int("CODE_AGENT_INSTALL_TIMEOUT_SECONDS", 600, 60, 600)


@dataclass(frozen=True, slots=True)
class WorkActionOutcome:
    """告诉 Worker 循环继续、成功完成或交给 Planner 重规划。"""

    kind: OutcomeKind
    summary: str = ""
    error: str = ""
    progress_made: bool = False
    refresh_context: bool = False


@dataclass(slots=True)
class WorkActionEnvironment:
    """保存执行单轮动作所需的工作区与回调依赖。"""

    root: Path
    request_text: str
    work: WorkItem
    state: WorkWorkerState
    execution_mode: ExecutionMode
    coordinator: WorkspaceResourceCoordinator
    emit: EmitCallback
    checkpoint: CheckpointCallback
    slot: int
    agent_id: str
    session_id: str = ""
    checkpoint_id: str = ""


class WorkActionHandler:
    """把协议动作映射到受控 Tool Gateway 调用。"""

    def __init__(self, environment: WorkActionEnvironment) -> None:
        """保存当前 Worker 环境，避免每个动作重复传递大量参数。"""

        self._env = environment
        # Spill 落盘：超大工具输出落盘 + 定位符，模型按需 read 取回。
        self._spill_store = SpillStore(environment.root)

    def _spill(self, tool_name: str, text: object) -> str:
        """把工具输出过一遍 spill 策略（只对可能较大的输出调用）。"""

        return maybe_spill_result(
            self._spill_store,
            session_id=self._env.work.id,
            tool_name=tool_name,
            text=str(text or ""),
        )

    async def execute(self, action: AgentAction) -> WorkActionOutcome:
        """执行一个动作并返回 Worker 下一步状态。"""

        handlers = {
            "search": self._search,
            "read": self._read,
            "inspect": self._inspect,
            "factory": self._factory,
            "edit": self._edit,
            "run": self._run,
            "run_code": self._run_code,
            "complete_work": self._complete,
        }
        handler = handlers.get(action.action)
        if handler is None:
            return WorkActionOutcome(
                "failure",
                error=f"Worker 不支持动作：{action.action}",
            )
        return await handler(action)

    async def _search(self, action: AgentAction) -> WorkActionOutcome:
        """执行工作区全文搜索并记录观察。"""

        await self._lifecycle(
            role="modify_worker",
            detail=f"{self._env.work.id} · {self._env.work.title}：搜索 {action.query}",
            tool_name="search_codebase",
        )
        result = await self._tool(
            "workspace.search",
            {"query": action.query},
            {"read"},
        )
        self._env.state.append_transcript(
            f"ACTION search query={action.query}\nOBSERVATION:\n{result}"
        )
        await self._env.checkpoint()
        return WorkActionOutcome("continue")

    async def _read(self, action: AgentAction) -> WorkActionOutcome:
        """读取真实文件，并保存并行写入冲突检测需要的版本指纹。"""

        await self._lifecycle(
            role="modify_worker",
            detail=(
                f"{self._env.work.id} · {self._env.work.title}："
                f"读取 {len(action.paths)} 个文件"
            ),
            tool_name="read_file_from_disk",
            files=list(action.paths),
        )
        arguments: dict[str, Any] = {"paths": action.paths}
        if action.offsets:
            arguments["offsets"] = action.offsets
        result = cast(
            ReadBatchResult,
            await self._tool("workspace.read", arguments, {"read"}),
        )
        state = self._env.state
        state.read_versions.update(result.versions)
        offset_note = f" offsets={action.offsets}" if action.offsets else ""
        # 工具结果瘦身：完整内容已在当前 transcript 中且文件未变化时，
        # 只追加一行“未变化”提示，不再重复注入全文；文件变化或首次读取时
        # 仍返回完整内容，保证模型始终能看到真实文件。
        unchanged: list[str] = []
        fresh_sections: list[str] = []
        if not action.offsets:
            for path in action.paths:
                version = result.versions.get(path)
                if version is None or version in {
                    "missing",
                    "not-file",
                    "unreadable",
                    "blocked-sensitive",
                }:
                    continue
                if state.transcript_versions.get(path) == version:
                    unchanged.append(path)
                else:
                    state.transcript_versions[path] = version
                    section = result.contents.get(path)
                    if section:
                        fresh_sections.append(section)
        observation_parts = [f"ACTION read paths={action.paths}{offset_note}"]
        if unchanged:
            observation_parts.append(
                "OBSERVATION（以下文件未变化，完整内容已在上下文中，无需再次读取）:\n"
                + ", ".join(unchanged)
            )
        if fresh_sections:
            total_chars = sum(len(section) for section in fresh_sections)
            observation_parts.append(
                f"OBSERVATION（完整内容已读取，共 {total_chars} 字符，未截断）:\n"
                + "\n\n".join(fresh_sections)
            )
        if not unchanged and not fresh_sections:
            observation_parts.append(f"OBSERVATION:\n{result.content}")
        transcript_entry = self._spill("read", "\n\n".join(observation_parts))
        state.append_transcript(transcript_entry)
        if result.blocked_paths:
            await self._lifecycle(
                role="modify_worker",
                detail=(
                    f"{self._env.work.id} 已读取 {len(result.versions)} 个安全文件，"
                    f"并过滤 {len(result.blocked_paths)} 个敏感路径；继续执行当前 Work"
                ),
                tool_name="read_file_from_disk",
            )
        await self._env.checkpoint()
        return WorkActionOutcome("continue")

    async def _inspect(self, action: AgentAction) -> WorkActionOutcome:
        """执行 AST、符号、调用图和影响范围分析。"""

        await self._lifecycle(
            role="code_intelligence",
            detail=(
                f"{self._env.work.id} · {self._env.work.title}："
                "分析代码结构与影响范围"
            ),
            tool_name="code_intelligence",
            files=list(action.paths),
        )
        inspection = await self._tool(
            "code.inspect",
            {"paths": action.paths, "query": action.query},
            {"read"},
        )
        self._env.state.append_transcript(
            f"ACTION inspect paths={action.paths} query={action.query}\n"
            f"OBSERVATION:\n{self._spill('inspect', inspection)}"
        )
        await self._env.checkpoint()
        return WorkActionOutcome("continue")

    async def _factory(self, action: AgentAction) -> WorkActionOutcome:
        """执行 Software Factory 的计划、生成或一致性校验。"""

        tool_name = f"software_factory.{action.factory_mode}"
        permission = {"write"} if action.factory_mode == "generate" else {"read"}
        detail_map = {
            "plan": "规划领域模型、Mock 和 API 契约",
            "generate": "生成领域契约、Mock 与前端数据源",
            "validate": "校验领域、Mock、API 和页面数据层",
        }
        await self._lifecycle(
            role="software_factory",
            detail=f"{self._env.work.id}：{detail_map[action.factory_mode]}",
            tool_name=tool_name,
        )

        arguments = {
            "request_text": self._env.request_text,
            "domain_id": action.factory_domain_id,
            "output_root": action.factory_output_root,
            "mock_count": action.factory_mock_count,
            "overwrite": action.factory_overwrite,
        }
        try:
            if action.factory_mode == "generate":
                # 批量生成同样必须记录修改目的、验证方案和失败恢复策略。
                record_factory_decision(
                    work=self._env.work,
                    state=self._env.state,
                    output_root=action.factory_output_root,
                )
                # 生成会同时写入多个相关文件，用输出目录作为共享资源锁键。
                lock_key = action.factory_output_root or "software-factory-default"
                async with self._env.coordinator.reserve(
                    {lock_key},
                    owner=self._env.work.id,
                    priority=self._env.work.priority,
                ):
                    result = await self._tool(tool_name, arguments, permission)
            else:
                result = await self._tool(tool_name, arguments, permission)
        except FileExistsError:
            reuse = await self._reuse_existing_factory_artifacts(action)
            if reuse is not None:
                return reuse
        except Exception as exc:
            return WorkActionOutcome(
                "failure",
                error=f"SOFTWARE FACTORY FAILED: {exc}",
            )

        progress_made = False
        if isinstance(result, dict):
            changed_files = result.get("changedFiles")
            if isinstance(changed_files, list):
                await self._record_generated_files(changed_files)
                progress_made = bool(changed_files)
            if action.factory_mode == "validate":
                # 最终验收结果写入 Checkpoint，避免恢复后模型绕过已失败的页面接入校验。
                output_root = action.factory_output_root.strip()
                self._env.state.factory_validations[output_root] = bool(
                    result.get("ok")
                )
        observation = json.dumps(result, ensure_ascii=False, indent=2, default=str)
        self._env.state.append_transcript(
            f"ACTION factory mode={action.factory_mode}\nOBSERVATION:\n{observation}"
        )
        await self._env.checkpoint()
        return WorkActionOutcome("continue", progress_made=progress_made)

    async def _reuse_existing_factory_artifacts(
        self,
        action: AgentAction,
    ) -> WorkActionOutcome | None:
        """产物已存在时先做一致性校验；通过则直接复用，避免重复生成浪费 Token。"""

        output_root = action.factory_output_root.strip()
        try:
            validation = await self._tool(
                "software_factory.validate",
                {"output_root": output_root},
                {"read"},
            )
        except Exception:
            return None
        ok = bool(validation.get("ok")) if isinstance(validation, dict) else False
        self._env.state.factory_validations[output_root] = ok
        if ok:
            self._env.state.append_transcript(
                "FACTORY REUSE: 输出目录已存在且一致性校验通过，本次直接复用，"
                "不重新生成 Mock/契约；无需重复生成。"
            )
            await self._env.checkpoint()
            await self._lifecycle(
                role="software_factory",
                status="completed",
                detail=(
                    f"{self._env.work.id}：已复用现有契约/Mock 产物，"
                    "跳过重新生成"
                ),
                tool_name="software_factory.validate",
            )
            return WorkActionOutcome("continue", progress_made=False)
        return WorkActionOutcome(
            "failure",
            error=(
                "SOFTWARE FACTORY EXISTING ARTIFACT INVALID: 输出目录已存在但一致性"
                "校验未通过，请先 read 现有产物定位不一致点，再修复或按需调用 "
                "factory generate 补齐，不要盲目覆盖全部产物。"
            ),
        )

    async def _edit(self, action: AgentAction) -> WorkActionOutcome:
        """在文件资源锁内应用事务式编辑，并处理并行版本冲突。"""

        gate = guard_edit(
            root=self._env.root,
            work=self._env.work,
            state=self._env.state,
            operations=action.operations,
        )
        if not gate.approved:
            self._env.state.append_transcript(
                f"DECISION GATE REJECTED: {gate.reason}\n"
                "请补充明确修改原因、影响范围、验证与恢复方案后重试。"
            )
            await self._env.checkpoint()
            return WorkActionOutcome("continue")

        # 记录"尝试过 edit"标记（无论成功、回滚还是被拒）：供 _complete 判断
        # 本 Work 是否真的产生过写入尝试。只用字符串匹配会漏掉回滚分支
        # （版本冲突写的是 EDIT RETRY REQUIRED，不是 ACTION edit）。
        self._env.state.quality["editAttempted"] = True

        # 超长 replace 拦截：单个 replace 的 old/new 超过阈值视为整段重写，
        # 跳过该 operation 并要求模型用最小定位片段重发。write（新建文件）
        # 与其他合法 replace 照常执行——新文件不依赖旧文件修改，不能被超长
        # replace 拖死（整批拒绝会让 write 永远无法落盘）。
        oversized = [
            operation
            for operation in action.operations
            if operation.type == "replace"
            and (
                len(operation.old_text) > MAX_REPLACE_TEXT_CHARS
                or len(operation.new_text) > MAX_REPLACE_TEXT_CHARS
            )
        ]
        if oversized:
            executable = [
                operation
                for operation in action.operations
                if operation not in oversized
            ]
            if not executable:
                # 全部 operation 都是超长 replace，无可执行内容，整批拒绝。
                self._env.state.append_transcript(
                    f"EDIT REJECTED（replace 过大，共 {len(oversized)} 处）:\n"
                    + "\n".join(
                        f"- {operation.path}(old={len(operation.old_text)}字符, "
                        f"new={len(operation.new_text)}字符)"
                        for operation in oversized[:5]
                    )
                    + f"\n单个 replace 的 old/new 不得超过 {MAX_REPLACE_TEXT_CHARS} 字符。"
                    "请只输出足以唯一定位的最小片段（通常 3~8 行）；"
                    "需要多处修改时用多组 operation，不要整段重写。"
                    "新建文件请用 write，不受此限制。"
                )
                await self._env.checkpoint()
                return WorkActionOutcome("continue")
            # 部分超长：跳过超长 replace，其余（含新建文件）照常执行。
            self._env.state.append_transcript(
                f"EDIT PARTIAL REJECTED（{len(oversized)} 处 replace 过大，已跳过）:\n"
                + "\n".join(
                    f"- {operation.path}(old={len(operation.old_text)}字符, "
                    f"new={len(operation.new_text)}字符)"
                    for operation in oversized[:5]
                )
                + f"\n单个 replace 的 old/new 不得超过 {MAX_REPLACE_TEXT_CHARS} 字符。"
                "本轮已执行其余操作（含新建文件）；请下一轮用最小片段重发"
                "这些被跳过的 replace。"
            )
            action.operations = executable

        paths = {operation.path for operation in action.operations}
        await self._lifecycle(
            role="modify_worker",
            detail=(
                f"{self._env.work.id} · {self._env.work.title}："
                f"等待并写入 {len(paths)} 个文件"
            ),
            tool_name="apply_file_change",
            files=sorted(paths),
        )
        try:
            async with self._env.coordinator.reserve(
                paths,
                owner=self._env.work.id,
                priority=self._env.work.priority,
            ):
                expected = {
                    path: self._env.state.read_versions[path]
                    for path in paths
                    if path in self._env.state.read_versions
                }
                edit_result = cast(
                    EditBatchResult,
                    await self._tool(
                        "workspace.edit",
                        {
                            "operations": action.operations,
                            "expected_versions": expected,
                        },
                        {"write"},
                    ),
                )
                await self._refresh_versions(edit_result.changed_files)
        except Exception as exc:
            error_text = str(exc)
            if "内容已变化" in error_text:
                self._env.state.append_transcript(
                    f"EDIT RETRY REQUIRED: {exc}\n"
                    "请先 read 冲突文件，再基于最新内容重新 edit。"
                )
                await self._lifecycle(
                    role="modify_worker",
                    detail=(
                        f"{self._env.work.id} 检测到并行文件更新，"
                        "正在读取最新版本后重试"
                    ),
                    tool_name="read_file_from_disk",
                )
                await self._env.checkpoint()
                return WorkActionOutcome("continue", refresh_context=True)
            if "未找到精确旧文本" in error_text:
                # replace 的 oldText 失配：把最接近的真实代码行反馈给模型，
                # 让本轮直接修正，而不是把整个 Work 交给 Planner 重试。
                self._env.state.append_transcript(
                    f"EDIT RETRY REQUIRED: {exc}\n"
                    "请基于上面给出的真实代码行重新生成 replace 的 oldText；"
                    "不要整文件重写，也不要重复尝试同一个 oldText。"
                )
                await self._env.checkpoint()
                return WorkActionOutcome("continue", refresh_context=True)
            return WorkActionOutcome("failure", error=f"EDIT FAILED: {exc}")

        self._append_changed_files(edit_result.changed_files)
        self._env.state.append_transcript(
            f"ACTION edit: {action.summary}\nCHANGED: {edit_result.changed_files}\n"
            f"DIFF:\n{edit_result.diff_preview}"
        )
        await self._lifecycle(
            role="merge_agent",
            agent_id=f"merge_agent:{self._env.work.id}",
            status="completed",
            detail=(
                f"{self._env.work.id} 已串行合并 "
                f"{len(edit_result.changed_files)} 个文件"
            ),
            tool_name="apply_file_change",
            files=list(edit_result.changed_files),
        )
        await self._env.checkpoint()
        # 只有真实发生文件变更才算进展；空内容/无变化写入会被工具层跳过，
        # 不能误记 progress，否则停滞守卫会被空转“骗过”。
        return WorkActionOutcome(
            "continue",
            progress_made=bool(edit_result.changed_files),
        )

    async def _run(self, action: AgentAction) -> WorkActionOutcome:
        """在全自动模式执行白名单质量命令。"""

        if self._env.execution_mode != "full_auto":
            # 自动编辑模式默认跳过终端命令；安装/初始化类命令在审批门开启时
            # 允许走审批流程（用户确认后执行），其余命令保持跳过。
            if not (
                command_approval_enabled()
                and requires_user_approval(action.command)
            ):
                self._env.state.append_transcript(
                    f"ACTION run skipped: {action.command}\n自动编辑模式不执行命令。"
                )
                await self._env.checkpoint()
                return WorkActionOutcome("continue")

        # 沙箱 A 层：会执行工作区代码/配置的命令（pytest/eslint/脚手架 create 等）
        # 不自动执行——项目内 conftest.py/.eslintrc.js 可能被 Agent 预先写入，触发即
        # 等效任意代码执行。这类命令改为跳过并提示，由用户手动执行或走创建项目骨架。
        approved_command = False
        if is_high_risk_command(action.command):
            if command_approval_enabled() and requires_user_approval(action.command):
                if not install_packages_allowed(action.command):
                    blocked = CommandResult(
                        command=action.command,
                        exit_code=-1,
                        output="",
                        blocked_reason=(
                            "安装白名单拦截：目标包不在 "
                            "CODE_AGENT_INSTALL_PACKAGE_WHITELIST 内，未执行。"
                        ),
                    )
                    self._env.state.commands.append(blocked)
                    self._env.state.append_transcript(command_observation(blocked))
                    await self._env.checkpoint()
                    return WorkActionOutcome("continue")
                decision = await consume_pending_command(
                    self._env.work.id, action.command
                )
                if decision is None:
                    return await self._request_command_approval(action.command)
                if decision == "rejected":
                    blocked = CommandResult(
                        command=action.command,
                        exit_code=-1,
                        output="",
                        blocked_reason="用户拒绝执行该命令，请改用其他方式完成目标",
                    )
                    self._env.state.commands.append(blocked)
                    self._env.state.append_transcript(command_observation(blocked))
                    await self._env.checkpoint()
                    return WorkActionOutcome("continue")
                approved_command = True
            else:
                blocked = CommandResult(
                    command=action.command,
                    exit_code=-1,
                    output="",
                    blocked_reason=(
                        "沙箱拦截：该命令会执行工作区内的项目代码或配置文件。"
                        "为避免配置劫持，不自动执行；如需初始化请使用创建项目的"
                        "“项目骨架”选项，或在真实终端手动运行。"
                    ),
                )
                self._env.state.commands.append(blocked)
                self._env.state.append_transcript(command_observation(blocked))
                await self._env.checkpoint()
                return WorkActionOutcome("continue")

        await self._lifecycle(
            role="verification_agent",
            agent_id=f"verification_agent:{self._env.work.id}",
            detail=f"{self._env.work.id}：执行 {action.command}",
            tool_name="run_terminal_command",
        )
        async with self._env.coordinator.reserve(
            {SPECIAL_TERMINAL_RESOURCE},
            owner=self._env.work.id,
            priority=self._env.work.priority,
        ):
            run_arguments: dict[str, Any] = {"command": action.command}
            if approved_command:
                # approved 仅供审批门内部透传，模型无法通过 action 注入。
                run_arguments["approved"] = True
                run_arguments["timeout_seconds"] = INSTALL_TIMEOUT_SECONDS
            result = cast(
                CommandResult,
                await self._tool(
                    "workspace.run",
                    run_arguments,
                    {"execute"},
                ),
            )
        self._env.state.commands.append(result)
        observation = command_observation(result)
        self._env.state.append_transcript(self._spill("run", observation))
        await self._env.checkpoint()
        if not result.succeeded:
            return WorkActionOutcome("failure", error=observation)

        await self._lifecycle(
            role="verification_agent",
            agent_id=f"verification_agent:{self._env.work.id}",
            status="completed",
            detail=f"{self._env.work.id} 验证通过：{action.command}",
        )
        return WorkActionOutcome("continue")

    async def _request_command_approval(self, command: str) -> WorkActionOutcome:
        """保存待审批命令、发出审批卡片并暂停当前 Work。"""

        existing = await find_pending_command(self._env.work.id)
        if existing is not None and existing["status"] == "pending":
            # 恢复后用户仍未答复：不重复保存/弹窗，直接继续暂停。
            self._env.state.append_transcript(
                f"ACTION run 仍在等待用户审批：{command}\n审批请求：{existing['requestId']}"
            )
            await self._env.checkpoint()
            return WorkActionOutcome("pause")

        request_id = f"approval_{uuid4().hex}"
        await save_pending_command(
            request_id=request_id,
            session_id=self._env.session_id,
            work_id=self._env.work.id,
            command=command,
            checkpoint_id=self._env.checkpoint_id,
        )
        await self._env.emit(
            "interactive",
            {
                "id": request_id,
                "source": "risk_approval",
                "command": "run_command",
                "prompt": f"Agent 准备执行命令：{command}",
                "description": (
                    "该命令属于安装依赖、初始化项目或脚手架类高风险操作，"
                    "会下载并执行第三方代码。请确认是否允许。"
                ),
                "mode": "normal",
                "suggestedMode": "user",
                "kind": "confirm",
                "allowMultiple": False,
                "options": [
                    {"label": "允许并继续", "value": "approve"},
                    {"label": "拒绝", "value": "reject"},
                ],
                "promptRound": 1,
                "recentOutput": command,
                "title": "命令执行需要审批",
                "approvalKind": "command_run",
                "riskLevel": "high",
                "toolName": "run_terminal_command",
                "toolArguments": {"command": command},
            },
        )
        self._env.state.append_transcript(
            f"ACTION run 等待用户审批：{command}\n审批请求：{request_id}\n"
            "用户批准后将继续执行；拒绝后该命令将返回拒绝结果。"
        )
        await self._env.checkpoint()
        return WorkActionOutcome("pause")

    async def _run_code(self, action: AgentAction) -> WorkActionOutcome:
        """执行模型写的 Python 程序（批量工具调用），只有 print/return 回上下文。"""

        if self._env.execution_mode != "full_auto":
            self._env.state.append_transcript(
                "ACTION run_code skipped: 自动编辑模式不执行代码。"
            )
            await self._env.checkpoint()
            return WorkActionOutcome("continue")

        await self._lifecycle(
            role="code_runner",
            agent_id=f"code_runner:{self._env.work.id}",
            detail=f"{self._env.work.id}：执行 run_code 批量程序",
            tool_name="run_code_batch",
        )

        # run_code 也是"执行工作区代码"，与 run 同资源锁，全局串行。
        async with self._env.coordinator.reserve(
            {SPECIAL_TERMINAL_RESOURCE},
            owner=self._env.work.id,
            priority=self._env.work.priority,
        ):
            observation = await self._execute_run_code(action)
        self._env.state.append_transcript(self._spill("run_code", observation))
        await self._env.checkpoint()
        if not observation.startswith("[RUN_CODE OK]"):
            return WorkActionOutcome("failure", error=observation[:4000])
        await self._lifecycle(
            role="code_runner",
            agent_id=f"code_runner:{self._env.work.id}",
            status="completed",
            detail=f"{self._env.work.id} run_code 完成",
        )
        return WorkActionOutcome("continue")

    async def _execute_run_code(self, action: AgentAction) -> str:
        """在子进程跑模型程序，工具调用经桥接回父进程执行。"""

        from backend.services.agent.code_mode import run_code_program, write_tools_sdk

        root = self._env.root
        # 子进程需要 import 的 tools_sdk 放在工作区外的临时目录，避免污染项目。
        import tempfile

        sdk_dir = Path(tempfile.mkdtemp(prefix="run-code-sdk-"))
        bridge = write_tools_sdk(sdk_dir)
        try:
            result = await run_code_program(
                code=action.code,
                work_dir=root,
                bridge_script=bridge.parent,
            )
        finally:
            await asyncio.to_thread(lambda: shutil.rmtree(sdk_dir, ignore_errors=True))
        if not result.get("ok"):
            # Bug C：失败时把程序完整输出带回，模型能看到异常信息自行纠正。
            detail = result.get("output") or result.get("error") or "执行失败"
            return f"[RUN_CODE FAILED] {str(detail)[:6000]}"
        return f"[RUN_CODE OK] exit={result.get('exitCode')}\n{result.get('output') or ''}"

    async def _complete(self, action: AgentAction) -> WorkActionOutcome:
        """把模型明确提交的当前 Work 标记为成功。"""

        if self._requires_factory_validation() and not any(
            self._env.state.factory_validations.values()
        ):
            # 最终验证 Work 必须拿到真实的 ok=true，单靠模型口头声明不能完成任务。
            self._env.state.append_transcript(
                "COMPLETE REJECTED: 当前工作负责 Software Factory 最终验收，"
                "但还没有成功的 factory validate 结果。请先完成真实页面接入并重新校验。"
            )
            await self._env.checkpoint()
            return WorkActionOutcome("continue")

        if (
            self._env.work.execution_type in {"coding", "agent"}
            and not self._env.state.changed_files
            and self._env.state.quality.get("editAttempted")
        ):
            # 编码类 Work 尝试过写入（edit 被调用过，无论成功/回滚/被拒）却
            # 没有任何文件变更时，禁止模型谎报成功（changed_files 为空时
            # review/质量门也会因无变更而校验失效）。
            # 从没尝试过 edit 的 complete（如"目标已满足无需修改"）仍放行。
            self._env.state.append_transcript(
                "COMPLETE REJECTED: 当前 Work 尝试过写入但没有任何文件变更，"
                "不能标记完成。请基于最近一次 edit 的失败反馈重新生成"
                "最小片段的 replace；若目标确实已满足且无需修改，请在"
                "complete_work 中说明原因。"
            )
            await self._env.checkpoint()
            return WorkActionOutcome("continue")

        return WorkActionOutcome(
            "success",
            summary=action.summary or f"{self._env.work.title} 已完成",
        )

    def _requires_factory_validation(self) -> bool:
        """判断当前 Work 是否承担 Software Factory 的最终验收职责。

        只扫描标题与目标中“明确要调用 factory validate 做最终验收”的意图词，
        不再扫描验收文案——避免页面类 Work 因验收里提到“数据闭环/契约”而被误拦，
        写完页面却无法 complete_work，只能空转。
        """

        from backend.services.agent.shared.domain_rules import complete_work_rules

        searchable = " ".join(
            [self._env.work.title, self._env.work.objective]
        ).lower()
        terms = tuple(
            str(item)
            for item in complete_work_rules().get(
                "factoryValidationIntentTerms"
            )
            or ()
        )
        return any(term in searchable for term in terms)

    async def _record_generated_files(self, values: list[object]) -> None:
        """记录生成文件，并读取其最新版本指纹。"""

        paths = [str(value) for value in values if str(value).strip()]
        self._append_changed_files(paths)
        await self._refresh_versions(paths)

    async def _refresh_versions(self, paths: list[str]) -> None:
        """更新一批文件的内容指纹。"""

        for path in paths:
            self._env.state.read_versions[path] = str(
                await self._tool(
                    "workspace.file_version",
                    {"path": path},
                    {"read"},
                )
            )

    def _append_changed_files(self, paths: list[str]) -> None:
        """按首次出现顺序合并修改文件列表。"""

        for path in paths:
            if path not in self._env.state.changed_files:
                self._env.state.changed_files.append(path)

    async def _tool(
        self,
        name: str,
        arguments: dict[str, Any],
        permissions: set[Any],
    ) -> Any:
        """通过统一 Tool Gateway 执行工具。"""

        return await execute_code_tool(
            name,
            root=self._env.root,
            arguments=arguments,
            permissions=permissions,
            agent_id=self._env.agent_id,
            task_id=self._env.work.id,
        )

    async def _lifecycle(
        self,
        *,
        role: str,
        detail: str,
        tool_name: str = "",
        status: str = "running",
        agent_id: str = "",
        files: list[str] | None = None,
    ) -> None:
        """发送统一生命周期事件，供前端显示当前 Worker 动作。"""

        payload: dict[str, Any] = {
            "role": role,
            "agentId": agent_id or self._env.agent_id,
            "slot": self._env.slot,
            "status": status,
            "detail": detail,
        }
        if tool_name:
            payload["toolName"] = tool_name
        if files:
            payload["currentFiles"] = list(files)
        await self._env.emit("lifecycle", payload)
