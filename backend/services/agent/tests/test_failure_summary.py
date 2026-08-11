"""Failure Summary 模块测试。"""

from backend.services.agent.shared.failure_summary import FailureSummary, FailureSummaryStore


class TestFailureSummary:
    def test_initial_state(self):
        """验证 test initial state 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        assert summary.attempts == 0
        assert summary.error == ""

    def test_add_attempt(self):
        """验证 test add attempt 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        summary.add_attempt("文件不存在", "尝试创建文件")
        assert summary.attempts == 1
        assert "文件不存在" in summary.error
        assert "尝试创建文件" in summary.tried_solutions

    def test_add_attempt_dedup(self):
        """验证 test add attempt dedup 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        summary.add_attempt("error", "solution A")
        summary.add_attempt("error", "solution A")  # 重复
        assert summary.attempts == 2
        assert len(summary.tried_solutions) == 1

    def test_add_attempt_limit(self):
        """验证 test add attempt limit 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        for i in range(15):
            summary.add_attempt(f"error {i}", f"solution {i}")
        assert len(summary.tried_solutions) == 10
        assert summary.tried_solutions[-1] == "solution 14"

    def test_set_root_cause(self):
        """验证 test set root cause 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        summary.set_root_cause("依赖版本冲突")
        assert summary.root_cause == "依赖版本冲突"

    def test_set_next_recommendation(self):
        """验证 test set next recommendation 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        summary.set_next_recommendation("降级依赖版本")
        assert summary.next_recommendation == "降级依赖版本"

    def test_add_changed_file(self):
        """验证 test add changed file 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        summary.add_changed_file("a.py")
        summary.add_changed_file("a.py")  # 重复
        assert summary.changed_files == ["a.py"]

    def test_to_json(self):
        """验证 test to json 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary(error="err", attempts=2)
        data = summary.to_json()
        assert data["error"] == "err"
        assert data["attempts"] == 2

    def test_to_retry_prompt(self):
        """验证 test to retry prompt 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary(
            error="模块导入失败",
            root_cause="循环依赖",
            attempts=2,
            changed_files=["a.py", "b.py"],
            tried_solutions=["方案1", "方案2"],
            next_recommendation="重构导入",
        )
        prompt = summary.to_retry_prompt()
        assert "失败摘要" in prompt
        assert "模块导入失败" in prompt
        assert "a.py" in prompt
        assert "建议: 重构导入" in prompt

    def test_to_retry_prompt_minimal(self):
        """验证 test to retry prompt minimal 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary()
        prompt = summary.to_retry_prompt()
        assert prompt == ""

    def test_from_error(self):
        """验证 test from error 场景的输入、执行结果与兼容行为。"""
        summary = FailureSummary.from_error(
            "文件未找到", changed_files=["x.py"], root_cause="路径错误"
        )
        assert summary.error == "文件未找到"
        assert summary.root_cause == "路径错误"
        assert "x.py" in summary.changed_files


class TestFailureSummaryStore:
    def test_get_create(self):
        """验证 test get create 场景的输入、执行结果与兼容行为。"""
        store = FailureSummaryStore()
        summary = store.get("W001")
        assert isinstance(summary, FailureSummary)
        assert store.get("W001") is summary

    def test_save_and_delete(self):
        """验证 test save and delete 场景的输入、执行结果与兼容行为。"""
        store = FailureSummaryStore()
        summary = FailureSummary(error="test")
        store.save("W001", summary)
        assert store.get("W001").error == "test"
        assert store.delete("W001") is True
        assert store.delete("W001") is False

    def test_clear(self):
        """验证 test clear 场景的输入、执行结果与兼容行为。"""
        store = FailureSummaryStore()
        store.get("W001")
        store.clear()
        assert store.snapshot() == {}

    def test_snapshot(self):
        """验证 test snapshot 场景的输入、执行结果与兼容行为。"""
        store = FailureSummaryStore()
        store.get("W001").add_attempt("error")
        snapshot = store.snapshot()
        assert "W001" in snapshot
        assert snapshot["W001"]["attempts"] == 1
