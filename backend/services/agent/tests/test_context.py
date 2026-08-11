"""Work Context 隔离模块测试。"""

from backend.services.agent.runtime.work_session import WorkIntelligenceSession
from backend.services.agent.context import (
    CompactionResult,
    ContextCompactor,
    ContextStore,
    WorkContext,
    MAX_WORK_CONTEXT_TOKEN,
)
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkWorkerState


class TestWorkContext:
    def test_basic_creation(self):
        """验证 test basic creation 场景的输入、执行结果与兼容行为。"""
        ctx = WorkContext(work_id="W001", objective="测试目标")
        assert ctx.work_id == "W001"
        assert ctx.objective == "测试目标"
        assert ctx.estimate_tokens() >= 0

    def test_add_action(self):
        """验证 test add action 场景的输入、执行结果与兼容行为。"""
        ctx = WorkContext(work_id="W001")
        ctx.add_action("读取文件 a.py")
        assert len(ctx.recent_actions) == 1
        assert ctx.recent_actions[0] == "读取文件 a.py"

    def test_add_action_limit(self):
        """验证 test add action limit 场景的输入、执行结果与兼容行为。"""
        ctx = WorkContext(work_id="W001")
        for i in range(35):
            ctx.add_action(f"动作 {i}")
        assert len(ctx.recent_actions) == 30
        assert ctx.recent_actions[-1] == "动作 34"

    def test_add_artifact_ref(self):
        """验证 test add artifact ref 场景的输入、执行结果与兼容行为。"""
        ctx = WorkContext(work_id="W001")
        ctx.add_artifact_ref("schema.json")
        ctx.add_artifact_ref("schema.json")  # 重复
        assert ctx.artifact_refs == ["schema.json"]

    def test_token_usage(self):
        """验证 test token usage 场景的输入、执行结果与兼容行为。"""
        ctx = WorkContext(work_id="W001")
        ctx.update_token_usage(prompt=100, completion=50)
        ctx.update_token_usage(prompt=50)
        assert ctx.token_usage["prompt"] == 150
        assert ctx.token_usage["completion"] == 50

    def test_to_json(self):
        """验证 test to json 场景的输入、执行结果与兼容行为。"""
        ctx = WorkContext(work_id="W001", objective="测试")
        ctx.add_action("action1")
        data = ctx.to_json()
        assert data["workId"] == "W001"
        assert data["objective"] == "测试"
        assert "estimatedTokens" in data

    def test_from_json(self):
        """验证 test from json 场景的输入、执行结果与兼容行为。"""
        data = {
            "workId": "W002",
            "objective": "恢复测试",
            "relevantFiles": ["a.py"],
            "recentActions": ["read a.py"],
            "failureSummary": {"error": "e"},
            "artifactRefs": ["ref1"],
            "tokenUsage": {"total": 100},
        }
        ctx = WorkContext.from_json(data)
        assert ctx.work_id == "W002"
        assert ctx.objective == "恢复测试"
        assert ctx.token_usage["total"] == 100


class TestContextStore:
    def test_create_and_get(self):
        """验证 test create and get 场景的输入、执行结果与兼容行为。"""
        store = ContextStore()
        ctx = store.create("W001", "测试目标")
        assert ctx.work_id == "W001"
        assert store.get("W001") is ctx

    def test_get_missing(self):
        """验证 test get missing 场景的输入、执行结果与兼容行为。"""
        store = ContextStore()
        assert store.get("MISSING") is None

    def test_save(self):
        """验证 test save 场景的输入、执行结果与兼容行为。"""
        store = ContextStore()
        ctx = WorkContext(work_id="W001")
        ctx.add_action("action")
        store.save(ctx)
        assert store.get("W001").recent_actions == ["action"]

    def test_delete(self):
        """验证 test delete 场景的输入、执行结果与兼容行为。"""
        store = ContextStore()
        store.create("W001")
        assert store.delete("W001") is True
        assert store.delete("W001") is False

    def test_list_work_ids(self):
        """验证 test list work ids 场景的输入、执行结果与兼容行为。"""
        store = ContextStore()
        store.create("W001")
        store.create("W002")
        assert sorted(store.list_work_ids()) == ["W001", "W002"]

    def test_snapshot_and_restore(self):
        """验证 test snapshot and restore 场景的输入、执行结果与兼容行为。"""
        store = ContextStore()
        ctx = store.create("W001", "目标")
        ctx.add_action("a1")
        snapshot = store.snapshot()
        assert "W001" in snapshot

        new_store = ContextStore()
        new_store.restore(snapshot)
        assert new_store.get("W001").objective == "目标"


class TestContextCompactor:
    def test_compact_actions(self):
        """验证 test compact actions 场景的输入、执行结果与兼容行为。"""
        compactor = ContextCompactor()
        ctx = WorkContext(work_id="W001")
        ctx.recent_actions = [
            "TOOL OUTPUT: 很长的输出" * 100,
            "DEBUG: 完成某项任务",
            "DEBUG: success 测试通过",
            "正常操作1",
            "正常操作2",
        ]
        result = compactor.compact(ctx)
        assert isinstance(result, CompactionResult)
        assert result.estimated_tokens_before >= result.estimated_tokens_after
        # 已完成的 debug log 应该被删除
        assert not any("DEBUG: 完成" in a for a in ctx.recent_actions)

    def test_compact_truncate_tool_output(self):
        """验证 test compact truncate tool output 场景的输入、执行结果与兼容行为。"""
        compactor = ContextCompactor()
        ctx = WorkContext(work_id="W001")
        long_output = "TOOL OUTPUT: " + "x" * 20_000
        ctx.recent_actions = [long_output]
        compactor.compact(ctx)
        # 工具输出应该被截断
        assert len(ctx.recent_actions[0]) < len(long_output)

    def test_compact_transcript_small(self):
        """验证 test compact transcript small 场景的输入、执行结果与兼容行为。"""
        compactor = ContextCompactor()
        transcript = ["a", "b", "c"]
        compacted, stats = compactor.compact_transcript(transcript)
        assert compacted == transcript
        assert stats["removed"] == 0

    def test_compact_over_budget(self):
        """验证 test compact over budget 场景的输入、执行结果与兼容行为。"""
        compactor = ContextCompactor(max_work_context_token=100)
        ctx = WorkContext(work_id="W001", objective="x" * 10_000)
        ctx.recent_actions = ["a" * 5_000]
        result = compactor.compact(ctx)
        # 应该被压缩到预算内
        assert result.estimated_tokens_after <= MAX_WORK_CONTEXT_TOKEN


def test_compact_transcript_windows_recent_tail_and_summarizes_older() -> None:
    """开窗透传：超过窗口时，最近条目逐字保留，更早的大观察折叠为动作摘要。"""

    compactor = ContextCompactor()
    old_entries = [
        f"ACTION read paths=['file_{index}.ts']\nOBSERVATION:\n" + ("文件内容" * 600)
        for index in range(15)
    ]
    recent = [
        "ACTION edit a.ts\nCHANGED: a.ts\nDIFF: x",
        "ACTION complete_work\nDONE: 完成",
    ]
    transcript = [*old_entries, *recent]

    compacted, stats = compactor.compact_transcript(transcript)

    # 窗口内最近条目完整保留在末尾。
    assert compacted[-2:] == recent
    # 窗口外历史被折叠为动作摘要，且存在"前期动作摘要"标记。
    assert any(item.startswith("== 前期动作摘要") for item in compacted)
    assert stats["removed"] > 0
    # 折叠掉大观察后总量远小于原来的完整历史。
    assert stats["saved_tokens"] > 0
    assert stats["after_tokens"] < stats["before_tokens"]


def test_compact_transcript_preserves_huge_tool_outputs() -> None:
    """超大工具观察在窗口内必须完整保留，不得按 Token 预算截断。"""

    compactor = ContextCompactor(max_work_context_token=500, max_tool_output_token=100)
    huge = "ACTION read paths=['src/app.ts']\nOBSERVATION:\n" + ("代码内容" * 2_000)
    transcript = [
        "WORK CONTEXT: 商城改造",
        huge,
        "下一步应修改页面",
    ]

    compacted, stats = compactor.compact_transcript(transcript)

    # 3 条记录未超过窗口，等价于完整透传。
    assert stats["after_tokens"] == stats["before_tokens"]
    assert compacted == transcript
    assert ("代码内容" * 2_000) in compacted[1]


def test_worker_session_includes_memory_notes() -> None:
    """Runtime 的 Memory 段落必须进入 Worker 初始上下文，而不是被解析器丢弃。"""

    work = WorkItem(
        id="W001",
        title="优化购物车",
        objective="优化购物车加载速度",
        target_files=["src/cart.ts"],
    )
    session = WorkIntelligenceSession(work, WorkWorkerState())
    context = """## Memory · episodic · mem_abc
Agent=coding
Request=用户之前问过如何优化购物车加载速度。
Status=completed
--- FILE: src/cart.ts ---
export const cart = []
"""

    session.initialize(
        initial_context=context,
        project_tree="src/cart.ts\n",
        ledger_snapshot={"items": []},
        harness_context="",
    )

    joined = "\n".join(session.state.transcript)
    assert "MEMORY NOTES:" in joined
    assert "购物车加载速度" in joined
