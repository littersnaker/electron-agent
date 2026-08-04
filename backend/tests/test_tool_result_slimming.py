"""工具结果瘦身与结构化依赖事实注入的测试。

覆盖：
1. read 未变化文件不重复注入完整内容（工具结果瘦身）；
2. 文件变化后 read 仍返回完整内容（保证模型可见性）；
3. replace oldText 失配时返回可恢复轮并携带真实代码行；
4. 已成功依赖折叠为 VERIFIED FACTS，不再重复验证；
5. transcript_versions 指纹可随 Checkpoint 往返。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.agent.loop_protocol import AgentAction, EditOperation
from backend.services.agent.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.runtime.work_session import WorkIntelligenceSession
from backend.services.agent.work_action_handler import (
    WorkActionEnvironment,
    WorkActionHandler,
)
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkWorkerState


async def _ignore_emit(_role: str, _payload: dict[str, object]) -> None:
    """测试中忽略生命周期事件。"""


async def _noop_checkpoint() -> None:
    """测试中使用空 Checkpoint 回调。"""


def _make_handler(
    tmp_path: Path,
    state: WorkWorkerState,
    work_id: str = "W001",
    objective: str = "按验收标准调整目标文件",
) -> WorkActionHandler:
    """构造一个可执行真实文件工具的测试 Handler。"""

    work = WorkItem(
        work_id,
        f"{work_id} 标题",
        objective,
        target_files=["a.ts"],
        acceptance_criteria=["修改符合预期"],
    )
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
            agent_id=f"test-worker:{work_id}",
        )
    )


@pytest.mark.asyncio
async def test_read_dedup_does_not_reinject_unchanged_content(tmp_path: Path) -> None:
    """同一文件内容未变化时，第二次 read 只追加“未变化”提示。"""

    (tmp_path / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    state = WorkWorkerState()
    handler = _make_handler(tmp_path, state)

    first = await handler.execute(AgentAction("read", work_id="W001", paths=["a.ts"]))
    assert first.kind == "continue"
    assert "export const a = 1;" in "\n".join(state.transcript)
    assert state.transcript_versions.get("a.ts")

    second = await handler.execute(
        AgentAction("read", work_id="W001", paths=["a.ts"])
    )
    assert second.kind == "continue"
    joined = "\n".join(state.transcript)
    assert "未变化" in joined
    assert joined.count("export const a = 1;") == 1


@pytest.mark.asyncio
async def test_read_reinjects_full_content_after_file_change(tmp_path: Path) -> None:
    """文件被修改后重新 read 必须返回完整新内容，不能误判为未变化。"""

    (tmp_path / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    state = WorkWorkerState()
    handler = _make_handler(tmp_path, state)

    await handler.execute(AgentAction("read", work_id="W001", paths=["a.ts"]))
    (tmp_path / "a.ts").write_text("export const a = 2;\n", encoding="utf-8")
    await handler.execute(AgentAction("read", work_id="W001", paths=["a.ts"]))

    joined = "\n".join(state.transcript)
    assert "export const a = 2;" in joined
    assert joined.count("export const a = 2;") == 1


@pytest.mark.asyncio
async def test_replace_mismatch_returns_continue_with_nearby_lines(
    tmp_path: Path,
) -> None:
    """replace 的 oldText 未命中时，同一轮内返回可恢复提示并附真实代码行。"""

    (tmp_path / "a.ts").write_text("const value = 1;\n", encoding="utf-8")
    state = WorkWorkerState()
    handler = _make_handler(tmp_path, state)

    outcome = await handler.execute(
        AgentAction(
            "edit",
            work_id="W001",
            operations=[
                EditOperation(
                    type="replace",
                    path="a.ts",
                    old_text="const value = 999;",
                    new_text="const value = 2;",
                    reason="修正常量",
                )
            ],
        )
    )

    assert outcome.kind == "continue"
    joined = "\n".join(state.transcript)
    assert "EDIT RETRY REQUIRED" in joined
    assert "const value = 1;" in joined


def test_dependency_state_renders_verified_facts() -> None:
    """已成功依赖应折叠为结构化事实，且不再携带冗余规划字段。"""

    work = WorkItem(
        "W002",
        "页面尺寸收尾",
        "调整页面尺寸",
        target_files=["src/pages/index/index.scss"],
        dependencies=["W001"],
    )
    session = WorkIntelligenceSession(work, WorkWorkerState())
    snapshot = {
        "items": [
            {
                "id": "W001",
                "status": "succeeded",
                "targetFiles": ["config/index.ts", "src/index.html"],
                "changedFiles": [],
                "summary": "designWidth=750 已确认，无需修改。",
                "objective": "全局配置检查",
                "acceptanceCriteria": ["config 正确"],
                "priority": 10,
            },
            {"id": "W002", "status": "running"},
        ]
    }

    text = session._dependency_state(snapshot)

    assert "[W001] 状态=已成功" in text
    assert "无需重新读取验证" in text
    assert "designWidth=750" in text
    assert "objective" not in text
    assert '{"id": "W002"' in text


def test_initialize_records_transcript_versions(tmp_path: Path) -> None:
    """首轮注入 RELATED FILES 的文件应登记内容指纹，供后续 read 瘦身。"""

    (tmp_path / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    work = WorkItem(
        "W001",
        "标题",
        "目标",
        target_files=["a.ts"],
    )
    session = WorkIntelligenceSession(work, WorkWorkerState())
    session.initialize(
        initial_context="--- FILE: a.ts ---\nexport const a = 1;\n",
        project_tree="a.ts\n",
        ledger_snapshot={"items": []},
        harness_context="",
        root=tmp_path,
    )

    assert session.state.transcript_versions.get("a.ts")
    assert "--- FILE: a.ts ---" in "\n".join(session.state.transcript)


def test_transcript_versions_survive_checkpoint_round_trip() -> None:
    """transcript_versions 指纹必须随 Checkpoint 持久化与恢复。"""

    state = WorkWorkerState(
        transcript=["ACTION read paths=['a.ts']"],
        read_versions={"a.ts": "v1"},
        transcript_versions={"a.ts": "v1"},
    )
    restored = WorkWorkerState.from_json(state.to_json())

    assert restored.transcript_versions == {"a.ts": "v1"}
    assert restored.read_versions == {"a.ts": "v1"}
