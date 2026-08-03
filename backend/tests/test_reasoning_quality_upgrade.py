"""P0 推理智能和 P1 上下文稳定性接入测试。"""

from backend.services.agent.loop_protocol import EditOperation
from backend.services.agent.runtime.action_guard import guard_edit
from backend.services.agent.runtime.work_session import WorkIntelligenceSession
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkWorkerState


def test_work_session_isolates_relevant_context() -> None:
    """验证 Work 会话只保留目标相关文件并生成结构化推理状态。"""

    work = WorkItem(
        id="W001",
        title="修改用户服务",
        objective="修复 user_service 登录逻辑",
        target_files=["backend/user_service.py"],
    )
    state = WorkWorkerState()
    session = WorkIntelligenceSession(work, state)
    session.initialize(
        initial_context=(
            "--- FILE: backend/user_service.py ---\n登录代码\n"
            "--- FILE: docs/unrelated.md ---\n无关文档"
        ),
        project_tree="backend/user_service.py\ndocs/unrelated.md",
        ledger_snapshot={"items": [work.to_json()]},
    )

    assert state.work_context["relevantFiles"] == ["backend/user_service.py"]
    assert state.reasoning_state["workId"] == "W001"
    assert "docs/unrelated.md" not in session.build_prompt().text


def test_failure_replaces_large_transcript_with_summary() -> None:
    """验证失败后不继续携带完整历史，而是恢复为有限摘要。"""

    work = WorkItem(id="W002", title="修复测试", objective="修复失败测试")
    state = WorkWorkerState(transcript=["x" * 8_000 for _ in range(30)])
    session = WorkIntelligenceSession(work, state)
    session.record_failure(action="run", error="pytest failed")

    assert state.failure_summary["attempts"] == 1
    assert len(state.transcript) <= 4
    assert "pytest failed" in "\n".join(state.transcript)


def test_decision_gate_captures_regression_baseline(tmp_path) -> None:
    """验证代码写入前会记录目的、验证方案和公共契约基线。"""

    target = tmp_path / "service.py"
    target.write_text("def public_api(value):\n    return value\n", "utf-8")
    work = WorkItem(
        id="W003",
        title="调整服务",
        objective="保持兼容地调整公共服务",
        acceptance_criteria=["相关测试通过"],
    )
    state = WorkWorkerState()
    result = guard_edit(
        root=tmp_path,
        work=work,
        state=state,
        operations=[
            EditOperation(
                type="write",
                path="service.py",
                content="def public_api(value):\n    return str(value)\n",
                reason="统一返回值格式并保持参数契约",
            )
        ],
    )

    assert result.approved is True
    assert state.decision_gate["validation"]
    assert "service.py" in state.regression_baseline["signatures"]
