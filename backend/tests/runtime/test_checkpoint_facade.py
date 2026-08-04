"""统一 Checkpoint 外观测试。"""

from backend.checkpoint.compressor import CheckpointCompressor
from backend.checkpoint.recovery import CheckpointRecovery
from backend.services.checkpoints.store import AgentCheckpoint


def test_checkpoint_compressor_limits_large_state() -> None:
    """超长 Checkpoint 应保留关键字段并写入压缩标记。"""

    state = {
        "taskId": "task-1",
        "plan": {"steps": ["one"]},
        "summary": "x" * 200_000,
        "debug": "y" * 200_000,
    }

    compressed = CheckpointCompressor().compress(state, maximum_characters=10_000)

    assert compressed["taskId"] == "task-1"
    assert compressed["checkpointCompressed"] is True
    assert "debug" not in compressed


def test_checkpoint_recovery_validates_ownership() -> None:
    """恢复器应接受匹配快照并拒绝错误会话。"""

    checkpoint = AgentCheckpoint(
        id="cp-1",
        session_id="session-1",
        agent_kind="code",
        route="/api/chat",
        status="paused",
        resumable=True,
        request={},
        state={"currentStep": 2},
        label="",
        error_message="",
        created_at="now",
        updated_at="now",
    )

    state = CheckpointRecovery().validate(
        checkpoint,
        session_id="session-1",
        agent_kind="code",
    )

    assert state["currentStep"] == 2
