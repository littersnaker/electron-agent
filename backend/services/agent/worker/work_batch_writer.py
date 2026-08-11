"""Code Agent Work 的批量直写快速路径与共享助手。

从原 work_worker.py 拆分：目标文件已知时用单次 LLM 调用批量写入全部文件，
以及生成/审查路径共用的文件判定、分块与常量。不包含多轮 ReAct 主循环。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import cast

from backend.services.agent.runtime.action_guard import guard_edit
from backend.services.agent.shared.loop_protocol import parse_agent_action
from backend.services.agent.shared.loop_support import ExecutionMode, usage_add
from backend.services.agent.shared.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import (
    CheckpointCallback,
    EmitCallback,
    WorkExecutionResult,
    WorkWorkerState,
)
from backend.services.agent.shared.workspace_tools import (
    EditBatchResult,
    read_workspace_files_with_versions,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.tools.code_tools import execute_code_tool
from backend.services.workspace.indexer import iter_project_files

LOGGER = logging.getLogger(__name__)


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数环境变量并限制在安全区间，异常值回退默认。"""

    try:
        value = int(os.getenv(name, str(default)).strip())
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


MAX_BATCH_WRITE_FILES = _env_int("CODE_AGENT_BATCH_WRITE_FILES", 16, 1, 64)


def _split_read_content(content: str) -> list[tuple[str, str]]:
    """把 read 工具输出按文件头拆回 (路径, 内容) 对。"""

    sections: list[tuple[str, str]] = []
    current_path = ""
    current_lines: list[str] = []
    for line in content.splitlines():
        if line.startswith("--- ") and line.endswith(" ---"):
            if current_path:
                sections.append((current_path, "\n".join(current_lines)))
            current_path = line[5:-4].split(" [", 1)[0].strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_path:
        sections.append((current_path, "\n".join(current_lines)))
    return sections


def _is_generation_work(work: WorkItem, root: Path) -> bool:
    """按项目实际状态判断是否为“生成/补齐类”Work，不依赖标题关键词。

    - 有 targetFiles：目标文件大多尚不存在 → 批量写入快路径；
      目标文件大多已存在 → 常规循环做精准修改。
    - 无 targetFiles：只有空项目才走一键整站生成（空项目里“修改”无从谈起）；
      非空项目交给常规循环，模型先读文件再决定新建或修改。
    """

    targets = [path for path in work.target_files if path.strip()]
    if not targets:
        # Planner 没给 targetFiles 说明文件尚未创建：一律按“新建+全量写入”处理，
        # 不再进多轮循环；是否从零整站生成由项目是否为空决定。
        return True
    existing = sum(1 for path in targets if _exists(root, path))
    return existing <= len(targets) // 2


def _is_greenfield_root(root: Path, *, max_source_files: int = 5) -> bool:
    """判断项目目录是否基本为空（按可索引文件数，带上限避免大项目全量扫描）。"""

    try:
        count = 0
        for _ in iter_project_files(root):
            count += 1
            if count > max_source_files:
                return False
        return True
    except OSError:
        return False


def _exists(root: Path, path: str) -> bool:
    """检查相对路径在项目根下是否存在（安全解析）。"""

    try:
        return root.joinpath(*path.split("/")).is_file()
    except (OSError, ValueError):
        return False


def _file_byte_size(root: Path, path: str) -> int:
    """用文件字节数作为字符数的保守上界（UTF-8 下字节数 ≥ 字符数）。"""

    try:
        target = root.joinpath(*path.split("/"))
        return int(target.stat().st_size) if target.is_file() else 0
    except (OSError, ValueError):
        return 0


def _chunk_batch_targets(
    targets: list[str],
    root: Path,
    *,
    max_files: int = MAX_BATCH_WRITE_FILES,
    max_bytes: int = 44_000,
) -> list[list[str]]:
    """把目标文件切成可单次批量直写的大小：文件数 ≤16、总字节 ≤44K。"""

    chunks: list[list[str]] = []
    current: list[str] = []
    current_size = 0
    for path in targets:
        size = _file_byte_size(root, path)
        if current and (len(current) + 1 > max_files or current_size + size > max_bytes):
            chunks.append(current)
            current = []
            current_size = 0
        current.append(path)
        current_size += size
    if current:
        chunks.append(current)
    return chunks


async def _try_batch_write(
    *,
    root: Path,
    work: WorkItem,
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
    targets_override: list[str] | None = None,
) -> tuple[WorkExecutionResult | None, str]:
    """目标文件已知时，用单次 LLM 调用批量写入全部文件。

    返回 None 表示不适合批量写入（模型未配合/写入失败），调用方转入常规多轮循环。
    """

    if os.getenv("CODE_AGENT_BATCH_WRITE", "1").strip().lower() not in {
        "1",
        "true",
        "on",
    }:
        return None, "disabled"
    targets = list(
        dict.fromkeys(
            path
            for path in (targets_override or work.target_files)
            if path and path.strip()
        )
    )
    if not targets:
        return None, "empty_targets"
    if state.transcript and not targets_override:
        return None, "transcript"
    if len(targets) > MAX_BATCH_WRITE_FILES and not targets_override:
        return None, "too_many"
    read = read_workspace_files_with_versions(root, targets)

    system = """你是一次性批量写入 Agent。CURRENT WORK 的目标文件全文已在输入中。
直接返回一个 edit 动作 JSON，禁止返回 search/read/run 等其他动作，禁止附加 Markdown：
{"action":"edit","workId":"W001","summary":"一句话说明写入内容","operations":[{"type":"write","path":"相对路径","content":"完整文件内容","reason":"为什么这么写"}]}
规则：
- operations 一次覆盖全部目标文件，不要分批；已有文件可用 replace（oldText 必须与输入中的原文精确匹配），新文件用 write；
- 内容已满足验收标准的文件可以不包含 operation；
- 每个 operation 都必须带 reason；
- 输出必须能被 json.loads 解析。"""
    files_text = "\n\n".join(
        f"--- FILE: {path} ---\n{content}"
        for path, content in _split_read_content(read.content)
    )
    work_payload = {
        "id": work.id,
        "title": work.title,
        "objective": work.objective[:1_500],
        "acceptanceCriteria": work.acceptance_criteria[:8],
        "targetFiles": targets,
        "executionMode": execution_mode,
    }
    user = (
        "CURRENT WORK:\n"
        + json.dumps(work_payload, ensure_ascii=False)
        + "\n\n目标文件全文：\n"
        + files_text
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[LlmMessage("system", system), LlmMessage("user", user)],
            temperature=0.1,
            timeout_seconds=300,
            stall_timeout_seconds=90,
            audit={
                "agentId": f"modify_worker:{work.id}",
                "agentRole": "batch_write",
                "parentRequestId": work.id,
            },
        )
    except Exception:
        return None, "write_failed"
    usage_add(state.usage, usage)
    await emit(
        "usage",
        {
            "workId": work.id,
            "prompt": usage.prompt,
            "completion": usage.completion,
            "total": usage.total,
        },
    )
    state.model_name = model.name
    try:
        action = parse_agent_action(text)
    except ValueError:
        return None, "model_skipped"
    if action.action != "edit":
        state.append_transcript(
            "BATCH WRITE SKIPPED: 模型未返回批量 edit 动作，转入常规循环。"
        )
        return None, "model_skipped"
    if not action.operations:
        # 批量直写提示词允许“内容已满足验收标准的文件可以不包含 operation”，
        # 此时空 operations 表示无需修改，直接成功收尾，避免被判协议错误。
        state.append_transcript(
            "BATCH WRITE COMPLETED: 目标文件已满足验收标准，无需修改。"
        )
        await checkpoint()
        return (
            WorkExecutionResult(
                work.id,
                True,
                "目标文件已满足验收标准，无需修改",
                "",
                state,
            ),
            "no_changes",
        )
    gate = guard_edit(
        root=root,
        work=work,
        state=state,
        operations=action.operations,
    )
    if not gate.approved:
        state.append_transcript(f"BATCH WRITE GATE REJECTED: {gate.reason}")
        return None, "gate_rejected"

    await emit(
        "lifecycle",
        {
            "role": "modify_worker",
            "agentId": f"modify_worker:{work.id}",
            "slot": slot,
            "status": "running",
            "detail": (
                f"{work.id}：正在写入 "
                f"{len(action.operations)} 个目标文件"
            ),
            "currentFiles": sorted(
                {operation.path for operation in action.operations}
            ),
        },
    )
    paths = {operation.path for operation in action.operations}
    try:
        async with coordinator.reserve(
            paths,
            owner=work.id,
            priority=work.priority,
        ):
            expected = {
                path: read.versions[path]
                for path in paths
                if path in read.versions
            }
            edit_result = cast(
                EditBatchResult,
                await execute_code_tool(
                    "workspace.edit",
                    root=root,
                    arguments={
                        "operations": action.operations,
                        "expected_versions": expected,
                    },
                    permissions={"write"},
                    agent_id=f"batch_write:{work.id}",
                    task_id=work.id,
                ),
            )
    except Exception as exc:
        state.append_transcript(
            f"BATCH WRITE FAILED: {exc}\n转入常规循环重试。"
        )
        return None, "write_failed"
    for path in edit_result.changed_files:
        if path not in state.changed_files:
            state.changed_files.append(path)
    state.append_transcript(
        f"BATCH WRITE APPLIED: {edit_result.changed_files}\n"
        f"DIFF:\n{edit_result.diff_preview[:4_000]}"
    )
    await emit(
        "lifecycle",
        {
            "role": "merge_agent",
            "agentId": f"merge_agent:{work.id}",
            "slot": slot,
            "status": "completed",
            "detail": (
                f"{work.id}：一次性批量写入 "
                f"{len(edit_result.changed_files)} 个文件"
            ),
            "currentFiles": list(edit_result.changed_files),
            "toolName": "apply_file_change",
        },
    )
    await checkpoint()
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=f"已一次性写入 {len(edit_result.changed_files)} 个目标文件。",
        error="",
        state=state,
    ), ""


_REVIEW_SYSTEM = """你是写入结果审查 Agent。目标文件已经一次性写入完成，写入后的文件内容已在输入中。
请基于 CURRENT WORK 的验收标准判断写入结果。只返回一个 JSON 对象，禁止附加 Markdown：
{"verdict":"complete","summary":"一句话结论"}
或
{"verdict":"patch","summary":"说明","operations":[{"type":"replace","path":"相对路径","oldText":"原内容片段","newText":"新内容","reason":"原因"}]}
或
{"verdict":"cannot_fix","reason":"为什么无法通过验收"}
如果写入内容已经满足验收标准，必须返回 complete；只有存在明确缺陷才返回 patch；只有任务本身不可行才返回 cannot_fix。"""


_GENERATE_ALL_SYSTEM = """你是从零生成 Agent。项目为空，CURRENT WORK 定义了要构建的内容，
目标文件尚未创建。请一次性返回一个 edit 动作 JSON，用 operations(type=write) 创建全部需要的文件，
每个文件给出完整内容。禁止 read/search/run，禁止附加 Markdown。输出必须能被 json.loads 解析。"""

_GENERATE_MISSING_SYSTEM = """你是新增文件生成 Agent。CURRENT WORK 定义了要创建的内容，
目标文件尚不存在；项目里已有其他代码，请只创建缺失的新文件，不要重写已有文件。
一次性返回一个 edit 动作 JSON，用 operations(type=write) 创建全部缺失文件，
每个文件给出完整可运行内容；禁止空文件、占位符或分步填空。
禁止 read/search/run，禁止附加 Markdown。输出必须能被 json.loads 解析。"""


__all__ = [
    "_env_int",
    "MAX_BATCH_WRITE_FILES",
    "_split_read_content",
    "_is_generation_work",
    "_is_greenfield_root",
    "_exists",
    "_file_byte_size",
    "_chunk_batch_targets",
    "_try_batch_write",
    "_REVIEW_SYSTEM",
    "_GENERATE_ALL_SYSTEM",
    "_GENERATE_MISSING_SYSTEM",
]
