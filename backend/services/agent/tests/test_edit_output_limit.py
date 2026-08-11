"""Edit 输出量硬拦截测试：超长 replace 拒绝、write 不受限。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.agent.shared.loop_protocol import AgentAction, EditOperation
from backend.services.agent.shared.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import WorkWorkerState
from backend.services.agent.worker import work_action_handler as handler_module
from backend.services.agent.worker.work_action_handler import (
    MAX_REPLACE_TEXT_CHARS,
    WorkActionEnvironment,
    WorkActionHandler,
)


class _ApprovedGate:
    """放行 guard_edit，专注测试输出量拦截逻辑。"""

    approved = True
    reason = ""


async def _ignore_emit(_role: str, _payload: dict[str, object]) -> None:
    """测试中忽略生命周期事件。"""


async def _noop_checkpoint() -> None:
    """测试中使用空 Checkpoint 回调。"""


def _make_handler(tmp_path: Path, state: WorkWorkerState) -> WorkActionHandler:
    """构造可执行真实文件工具的测试 Handler。"""

    work = WorkItem("W001", "标题", "目标", target_files=["a.ts"])
    return WorkActionHandler(
        WorkActionEnvironment(
            root=tmp_path,
            request_text="测试请求",
            work=work,
            state=state,
            execution_mode="auto_edit",
            coordinator=WorkspaceResourceCoordinator(),
            emit=_ignore_emit,
            checkpoint=_noop_checkpoint,
            slot=1,
            agent_id="modify_worker:W001",
        )
    )


@pytest.mark.asyncio
async def test_oversized_replace_is_rejected_before_write(tmp_path, monkeypatch) -> None:
    """超长 replace 应在执行工具前被拒绝，文件不被修改。"""

    (tmp_path / "a.ts").write_text("OLD", encoding="utf-8")
    state = WorkWorkerState()
    handler = _make_handler(tmp_path, state)
    monkeypatch.setattr(handler_module, "guard_edit", lambda **_k: _ApprovedGate())

    action = AgentAction(
        action="edit",
        work_id="W001",
        operations=[
            EditOperation(
                type="replace",
                path="a.ts",
                old_text="O" * (MAX_REPLACE_TEXT_CHARS + 100),
                new_text="N" * 10,
            )
        ],
    )

    outcome = await handler._edit(action)

    assert outcome.kind == "continue"
    assert "EDIT REJECTED" in "\n".join(state.transcript)
    assert "replace 过大" in "\n".join(state.transcript)
    # 工具未执行，文件保持原样。
    assert (tmp_path / "a.ts").read_text("utf-8") == "OLD"


@pytest.mark.asyncio
async def test_write_operation_not_limited(tmp_path, monkeypatch) -> None:
    """新建文件（write）允许完整内容，不受 replace 长度限制。"""

    state = WorkWorkerState()
    handler = _make_handler(tmp_path, state)
    monkeypatch.setattr(handler_module, "guard_edit", lambda **_k: _ApprovedGate())
    new_content = "export const big = " + ("x" * (MAX_REPLACE_TEXT_CHARS + 500))

    action = AgentAction(
        action="edit",
        work_id="W001",
        operations=[
            EditOperation(
                type="write",
                path="new.ts",
                content=new_content,
            )
        ],
    )

    outcome = await handler._edit(action)

    assert outcome.kind == "continue"
    assert outcome.progress_made is True
    assert "EDIT REJECTED" not in "\n".join(state.transcript)
    # 新建文件完整落盘。
    assert (tmp_path / "new.ts").read_text("utf-8") == new_content


@pytest.mark.asyncio
async def test_mixed_write_executes_while_oversized_replace_skipped(
    tmp_path, monkeypatch
) -> None:
    """混合场景：write 新文件照常落盘，仅超长 replace 被跳过并反馈。"""

    (tmp_path / "a.ts").write_text("OLD", encoding="utf-8")
    state = WorkWorkerState()
    handler = _make_handler(tmp_path, state)
    monkeypatch.setattr(handler_module, "guard_edit", lambda **_k: _ApprovedGate())

    action = AgentAction(
        action="edit",
        work_id="W001",
        operations=[
            EditOperation(type="write", path="new.ts", content="NEW FILE"),
            EditOperation(
                type="replace",
                path="a.ts",
                old_text="O" * (MAX_REPLACE_TEXT_CHARS + 100),
                new_text="N",
            ),
        ],
    )

    outcome = await handler._edit(action)

    assert outcome.kind == "continue"
    joined = "\n".join(state.transcript)
    assert "EDIT PARTIAL REJECTED" in joined
    assert "replace 过大" in joined
    # write 的新文件已落盘，旧文件未被超长 replace 触碰。
    assert (tmp_path / "new.ts").read_text("utf-8") == "NEW FILE"
    assert (tmp_path / "a.ts").read_text("utf-8") == "OLD"


@pytest.mark.asyncio
async def test_all_oversized_replace_rejected_wholesale(tmp_path, monkeypatch) -> None:
    """全部 operation 都是超长 replace 时，无可执行内容，整批拒绝。"""

    (tmp_path / "a.ts").write_text("OLD", encoding="utf-8")
    state = WorkWorkerState()
    handler = _make_handler(tmp_path, state)
    monkeypatch.setattr(handler_module, "guard_edit", lambda **_k: _ApprovedGate())

    action = AgentAction(
        action="edit",
        work_id="W001",
        operations=[
            EditOperation(
                type="replace",
                path="a.ts",
                old_text="O" * (MAX_REPLACE_TEXT_CHARS + 100),
                new_text="N",
            ),
            EditOperation(
                type="replace",
                path="a.ts",
                old_text="OLD",
                new_text="N" * (MAX_REPLACE_TEXT_CHARS + 100),
            ),
        ],
    )

    outcome = await handler._edit(action)

    assert outcome.kind == "continue"
    joined = "\n".join(state.transcript)
    assert "EDIT REJECTED" in joined
    assert "EDIT PARTIAL REJECTED" not in joined
    assert (tmp_path / "a.ts").read_text("utf-8") == "OLD"
