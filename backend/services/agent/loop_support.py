"""Code Agent 循环的协议提示词与重规划辅助函数。"""

from __future__ import annotations

import json
from typing import Literal

from backend.services.agent.command_runner import CommandResult
from backend.services.agent.loop_protocol import AgentAction
from backend.services.agent.tool_registry import render_tool_catalog
from backend.services.agent.task_planner import (
    CodeTaskPlan,
    ReplanResult,
    WorkItem,
    WorkLedger,
    replan_after_failure,
    replan_after_failures,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage

ExecutionMode = Literal["auto_edit", "full_auto"]
MAX_TRANSCRIPT_CHARS = 220_000


def system_prompt(execution_mode: ExecutionMode) -> str:
    """生成包含 WorkList 约束的单动作代理协议提示词。"""

    command_rule = (
        "你可以使用 run 执行受限的 test、lint、build、typecheck。失败后系统会把完整 WorkList 交给 Planner 重规划。"
        if execution_mode == "full_auto"
        else "当前为自动编辑模式，run 不会真正执行；完成每个 Work 后仍需 complete_work。"
    )
    return f"""你是本地软件工程代理。必须依照 TASK SPEC 和 FULL WORKLIST 真实完成代码修改，不能只输出步骤文档。
后端实际提供的工具目录如下，工具不会因为前端切换模型或重启而消失：
{render_tool_catalog()}

每轮只返回一个 JSON 对象，不得附加 Markdown。字段必须与上面的示例一致。
规则：
- FULL WORKLIST 是唯一任务清单；只执行 pending/running Work，禁止重复 succeeded/skipped Work。
- 每个 search/read/edit/run 必须关联 workId；完成一个 Work 必须显式 complete_work。
- 先读真实文件再改；文件、Work、读取路径和累计编辑数量均不设人为数量上限。
- 单轮内容仍应保持聚焦，超出模型上下文时主动分批并继续下一轮。
- edit 后根据真实 diff 继续；验证失败时不要自行假设其他成功 Work 也失败。
- 系统重规划时会提供成功、失败、待办 Work 的完整 JSON；成功 Work 已落盘且不可重做。
- 每个手写源码文件不超过 500 行，复杂模块必须拆分。
- 不读取 .env、密钥、二进制文件，不使用绝对路径，不越出项目根目录。
- 只有全部 Work succeeded/skipped 后才能 finish。
- {command_rule}
"""


def trim_transcript(entries: list[str]) -> str:
    """从最新记录向前保留有限上下文。"""

    selected: list[str] = []
    consumed = 0
    for entry in reversed(entries):
        remaining = MAX_TRANSCRIPT_CHARS - consumed
        if remaining <= 0:
            break
        selected.append(entry[-remaining:])
        consumed += min(len(entry), remaining)
    selected.reverse()
    return "\n\n".join(selected)


def usage_add(total: LlmUsage, current: LlmUsage) -> None:
    """累加多轮模型调用 Token 用量。"""

    total.prompt += current.prompt
    total.completion += current.completion
    total.total += current.total


def command_observation(result: CommandResult) -> str:
    """把命令结果转换成下一轮模型可理解的观察。"""

    if result.blocked_reason:
        return f"RUN BLOCKED: {result.command}\n原因：{result.blocked_reason}"
    status = "TIMEOUT" if result.timed_out else f"EXIT {result.exit_code}"
    return f"RUN {status}: {result.command}\n{result.output or '（命令没有输出）'}"


def ledger_text(ledger: WorkLedger) -> str:
    """生成完整 WorkList JSON。"""

    return json.dumps(ledger.snapshot(), ensure_ascii=False, indent=2)


def resolve_work(ledger: WorkLedger, action: AgentAction) -> WorkItem:
    """解析动作所属 Work，并阻止对已成功工作重复操作。"""

    item = ledger.begin(action.work_id)
    if action.work_id and item.id != action.work_id:
        raise ValueError(f"Work {action.work_id} 不可执行；当前可执行 Work 为 {item.id}")
    return item


def _fallback_replan(ledger: WorkLedger, failed_work_id: str, error: str) -> ReplanResult:
    """Planner 调用失败时仅重试失败 Work。"""

    current = ledger.get(failed_work_id)
    retry = WorkItem(
        id=failed_work_id,
        title=current.title if current else "重试失败工作",
        objective=current.objective if current else "根据真实错误继续修复",
        acceptance_criteria=current.acceptance_criteria if current else [],
        dependencies=current.dependencies if current else [],
        priority=current.priority if current else 100,
        target_files=current.target_files if current else [],
        serial_group=current.serial_group if current else "",
        execution_type=current.execution_type if current else "agent",
        file_operations=current.file_operations if current else [],
    )
    return ReplanResult(
        reason=f"Planner 暂时不可用，保留全部成功 Work，仅重试 {failed_work_id}：{error[:300]}",
        retry_items=[retry],
        new_items=[],
        skipped_ids=[],
        usage=LlmUsage(),
        model_name="",
    )


async def perform_replan(
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    failed_work_id: str,
    failure_observation: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ReplanResult:
    """调用 Planner，并在失败时返回安全重试方案。"""

    try:
        return await replan_after_failure(
            plan=plan,
            ledger=ledger,
            failed_work_id=failed_work_id,
            failure_observation=failure_observation,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
        )
    except Exception as exc:
        return _fallback_replan(ledger, failed_work_id, str(exc))


async def perform_batch_replan(
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    failed_work_ids: list[str],
    failure_observation: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ReplanResult:
    """一次重规划整个并行波次，避免成功 Work 被重复创建或执行。"""

    try:
        return await replan_after_failures(
            plan=plan,
            ledger=ledger,
            failed_work_ids=failed_work_ids,
            failure_observation=failure_observation,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
        )
    except Exception as exc:
        retry_items: list[WorkItem] = []
        for work_id in failed_work_ids:
            current = ledger.get(work_id)
            if current:
                retry_items.append(
                    WorkItem(
                        id=current.id,
                        title=current.title,
                        objective=current.objective,
                        acceptance_criteria=current.acceptance_criteria,
                        dependencies=current.dependencies,
                        priority=current.priority,
                        target_files=current.target_files,
                        serial_group=current.serial_group,
                        execution_type=current.execution_type,
                        file_operations=current.file_operations,
                    )
                )
        return ReplanResult(
            reason=(
                "Planner 暂时不可用，已保留全部成功 Work，仅重试本波次失败项："
                f"{str(exc)[:300]}"
            ),
            retry_items=retry_items,
            new_items=[],
            skipped_ids=[],
            usage=LlmUsage(),
            model_name="",
        )
