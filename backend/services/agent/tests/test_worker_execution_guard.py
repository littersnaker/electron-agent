"""单 Work 执行收敛守卫测试。"""

from backend.services.agent.loop_protocol import AgentAction, EditOperation
from backend.services.agent.runtime.execution_guard import (
    ExecutionLimits,
    WorkExecutionGuard,
)
from backend.services.agent.work_state import WorkWorkerState


def _limits() -> ExecutionLimits:
    """创建低阈值测试配置，避免依赖运行环境变量。"""

    return ExecutionLimits(
        max_iterations=6,
        max_context_actions=2,
        max_post_write_context_actions=1,
        max_guard_rejections=2,
        model_timeout_seconds=30,
    )


def test_limits_scale_with_target_file_count(monkeypatch) -> None:
    """多文件 Work 应获得更多轮次与读取额度，小任务保持严格。"""

    monkeypatch.delenv("CODE_AGENT_MAX_WORK_ITERATIONS", raising=False)
    monkeypatch.delenv("CODE_AGENT_MAX_CONTEXT_ACTIONS", raising=False)
    monkeypatch.delenv("CODE_AGENT_MAX_POST_WRITE_CONTEXT_ACTIONS", raising=False)
    monkeypatch.delenv("CODE_AGENT_MAX_STALL_ROUNDS", raising=False)
    small = ExecutionLimits.from_environment(target_file_count=0)
    big = ExecutionLimits.from_environment(target_file_count=8)

    assert big.max_iterations >= small.max_iterations + 8
    assert big.max_context_actions > small.max_context_actions
    assert big.max_post_write_context_actions > small.max_post_write_context_actions
    assert big.max_iterations <= 24
    assert big.max_context_actions <= 12


def test_stall_stop_after_no_progress_rounds() -> None:
    """连续多轮无实质进展时应停止，避免空转烧 Token。"""

    state = WorkWorkerState(stall_rounds=5)
    guard = WorkExecutionGuard(state, _limits())

    decision = guard.before_model_call()

    assert not decision.allowed
    assert decision.stop
    assert "无实质进展" in decision.error


def test_invalid_protocol_rounds_do_not_count_toward_stall() -> None:
    """协议解析失败轮次由独立计数器收敛，不应算作"空转"停滞。"""

    state = WorkWorkerState(attempt_iterations=4, stall_rounds=1)
    guard = WorkExecutionGuard(state, _limits())

    decision = guard.before_model_call()

    assert decision.allowed
    assert not decision.stop


def test_context_actions_increment_stall_and_edit_resets() -> None:
    """只读动作累计停滞轮次，真实写入后清零。"""

    state = WorkWorkerState()
    guard = WorkExecutionGuard(state, _limits())
    for path in ("src/a.ts", "src/b.ts", "src/c.ts"):
        guard.record(AgentAction(action="read", paths=[path]), "continue")

    assert state.stall_rounds == 3

    guard.record(
        AgentAction(
            action="edit",
            operations=[
                EditOperation(type="write", path="src/a.ts", content="x")
            ],
        ),
        "continue",
        progress_made=True,
    )

    assert state.stall_rounds == 0
    assert state.write_actions == 1


def test_guard_rejection_increments_stall() -> None:
    """被守卫拒绝的重复读取也属于无进展轮次，计入停滞计数。"""

    state = WorkWorkerState()
    guard = WorkExecutionGuard(state, _limits())
    action = AgentAction(action="read", paths=["src/app.ts"])

    guard.record(action, "continue")
    decision = guard.before_action(action)

    assert not decision.allowed
    assert state.stall_rounds == 2


def test_stall_limit_scales_with_target_file_count(monkeypatch) -> None:
    """多文件 Work 应放宽"无进展"轮次上限，允许先批量读取再编辑。"""

    monkeypatch.delenv("CODE_AGENT_MAX_STALL_ROUNDS", raising=False)
    small = ExecutionLimits.from_environment(target_file_count=1)
    big = ExecutionLimits.from_environment(target_file_count=8)

    assert small.max_stall_rounds == 4
    assert big.max_stall_rounds > small.max_stall_rounds
    assert big.max_stall_rounds <= 10


def test_run_success_counts_as_progress() -> None:
    """运行/完成类动作成功应视为实质进展，刷新停滞计数。"""

    state = WorkWorkerState(attempt_iterations=3)
    guard = WorkExecutionGuard(state, _limits())
    action = AgentAction(action="run", command="pnpm lint")

    guard.record(action, "continue")

    assert state.last_progress_iteration == 3
    assert state.write_actions == 0


def test_duplicate_read_is_rejected_without_reexecuting_tool() -> None:
    """相同阶段重复读取同一文件时应立即拒绝。"""

    state = WorkWorkerState()
    guard = WorkExecutionGuard(state, _limits())
    action = AgentAction(action="read", paths=["src/app.ts"])

    assert guard.before_action(action).allowed
    guard.record(action, "continue")
    decision = guard.before_action(action)

    assert not decision.allowed
    assert not decision.stop
    assert "已经执行过" in decision.feedback


def test_context_limit_stops_repeated_analysis() -> None:
    """模型连续忽略上下文上限时应终止 Work，而不是无限调用。"""

    state = WorkWorkerState(context_actions=2)
    guard = WorkExecutionGuard(state, _limits())

    first = guard.before_action(AgentAction(action="search", query="cart"))
    second = guard.before_action(AgentAction(action="search", query="order"))

    assert not first.allowed
    assert not first.stop
    assert not second.allowed
    assert second.stop


def test_edit_resets_context_phase_for_conflict_reread() -> None:
    """真实写入后应允许基于新版本重新读取必要文件。"""

    state = WorkWorkerState()
    guard = WorkExecutionGuard(state, _limits())
    read = AgentAction(action="read", paths=["src/app.ts"])
    edit = AgentAction(
        action="edit",
        operations=[
            EditOperation(type="replace", path="src/app.ts", old_text="a", new_text="b")
        ],
    )

    guard.record(read, "continue")
    guard.record(edit, "continue", progress_made=True)

    assert guard.before_action(read).allowed
    assert state.write_actions == 1
    assert state.context_action_history == []


def test_parallel_conflict_allows_rereading_same_file_version() -> None:
    """并行版本冲突后必须允许重新读取同一路径，而不能被去重守卫拦截。"""

    state = WorkWorkerState()
    guard = WorkExecutionGuard(state, _limits())
    read = AgentAction(action="read", paths=["src/app.ts"])
    edit = AgentAction(
        action="edit",
        operations=[
            EditOperation(type="replace", path="src/app.ts", old_text="a", new_text="b")
        ],
    )

    guard.record(read, "continue")
    guard.record(edit, "continue", refresh_context=True)

    assert guard.before_action(read).allowed
    assert state.write_actions == 0
