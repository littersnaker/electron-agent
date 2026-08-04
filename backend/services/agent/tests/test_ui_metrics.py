"""UI Metrics 模块测试。"""

from backend.services.agent.ui_metrics import ExecutionMetrics, MetricsCollector


class TestExecutionMetrics:
    def test_initial_state(self):
        """验证 test initial state 场景的输入、执行结果与兼容行为。"""
        m = ExecutionMetrics()
        assert m.total_tokens == 0
        assert m.completed_works == 0

    def test_to_json(self):
        """验证 test to json 场景的输入、执行结果与兼容行为。"""
        m = ExecutionMetrics(total_tokens=1000, completed_works=5, failed_works=1)
        data = m.to_json()
        assert data["totalTokens"] == 1000
        assert data["completedWorks"] == 5
        assert data["failedWorks"] == 1

    def test_to_ui_summary(self):
        """验证 test to ui summary 场景的输入、执行结果与兼容行为。"""
        m = ExecutionMetrics(total_tokens=847_000, active_tokens=12_000, compressed_tokens=835_000)
        summary = m.to_ui_summary()
        assert summary["tokenUsage"]["total"] == "847k"
        assert summary["tokenUsage"]["active"] == "12k"
        assert summary["tokenUsage"]["compressed"] == "835k"

    def test_format_number(self):
        """验证 test format number 场景的输入、执行结果与兼容行为。"""
        assert ExecutionMetrics._format_number(1_500_000) == "1.5M"
        assert ExecutionMetrics._format_number(12_000) == "12k"
        assert ExecutionMetrics._format_number(500) == "500"


class TestMetricsCollector:
    def test_record_tokens(self):
        """验证 test record tokens 场景的输入、执行结果与兼容行为。"""
        collector = MetricsCollector()
        collector.record_tokens(total=1000, active=500, compressed=200)
        metrics = collector.get_metrics()
        assert metrics.total_tokens == 1000
        assert metrics.active_tokens == 500

    def test_record_work_status(self):
        """验证 test record work status 场景的输入、执行结果与兼容行为。"""
        collector = MetricsCollector()
        collector.record_work_status(completed=10, failed=2, pending=3)
        metrics = collector.get_metrics()
        assert metrics.completed_works == 10
        assert metrics.failed_works == 2
        assert metrics.pending_works == 3

    def test_increment_retry(self):
        """验证 test increment retry 场景的输入、执行结果与兼容行为。"""
        collector = MetricsCollector()
        collector.increment_retry()
        collector.increment_retry()
        assert collector.get_metrics().retry_count == 2

    def test_from_ledger_snapshot(self):
        """验证 test from ledger snapshot 场景的输入、执行结果与兼容行为。"""
        collector = MetricsCollector()
        collector.from_ledger_snapshot(
            {"succeeded": 5, "failed": 1, "pending": 2, "running": 1, "skipped": 1}
        )
        m = collector.get_metrics()
        assert m.completed_works == 5
        assert m.failed_works == 1
        assert m.pending_works == 2
        assert m.running_works == 1
        assert m.skipped_works == 1

    def test_from_token_budget(self):
        """验证 test from token budget 场景的输入、执行结果与兼容行为。"""
        collector = MetricsCollector()
        collector.from_token_budget(
            {
                "totalTokens": 1000,
                "activeTokens": 500,
                "compressedTokens": 200,
                "cleanedTokens": 100,
            }
        )
        m = collector.get_metrics()
        assert m.total_tokens == 1000
        assert m.compressed_tokens == 200
        assert m.cleaned_tokens == 100

    def test_record_work_event(self):
        """验证 test record work event 场景的输入、执行结果与兼容行为。"""
        collector = MetricsCollector()
        collector.record_work_event("W001", "started")
        data = collector.to_json()
        assert data["historyCount"] == 1

    def test_reset(self):
        """验证 test reset 场景的输入、执行结果与兼容行为。"""
        collector = MetricsCollector()
        collector.record_tokens(total=1000)
        collector.record_work_event("W001", "start")
        collector.reset()
        assert collector.get_metrics().total_tokens == 0
        assert collector.to_json()["historyCount"] == 0
