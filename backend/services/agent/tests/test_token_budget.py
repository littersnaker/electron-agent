"""Token Budget 模块测试。"""

from backend.services.agent.token_budget import TokenBudget, TokenBudgetGuard, TOKEN_LIMITS


class TestTokenBudget:
    def test_initial_state(self):
        """验证 test initial state 场景的输入、执行结果与兼容行为。"""
        budget = TokenBudget(limit=1000)
        assert budget.remaining == 1000
        assert not budget.exceeded
        assert budget.usage_ratio == 0.0

    def test_consume(self):
        """验证 test consume 场景的输入、执行结果与兼容行为。"""
        budget = TokenBudget(limit=1000)
        budget.consume(300)
        assert budget.consumed == 300
        assert budget.remaining == 700
        assert budget.usage_ratio == 0.3

    def test_exceeded(self):
        """验证 test exceeded 场景的输入、执行结果与兼容行为。"""
        budget = TokenBudget(limit=100)
        budget.consume(150)
        assert budget.exceeded
        assert budget.remaining == 0

    def test_record_compressed(self):
        """验证 test record compressed 场景的输入、执行结果与兼容行为。"""
        budget = TokenBudget(limit=1000)
        budget.record_compressed(200)
        assert budget.compressed == 200

    def test_to_json(self):
        """验证 test to json 场景的输入、执行结果与兼容行为。"""
        budget = TokenBudget(limit=1000, consumed=500)
        data = budget.to_json()
        assert data["limit"] == 1000
        assert data["consumed"] == 500
        assert data["remaining"] == 500
        assert data["usageRatio"] == 0.5


class TestTokenBudgetGuard:
    def test_default_limits(self):
        """验证 test default limits 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard()
        assert guard.get("planner").limit == TOKEN_LIMITS["planner"]
        assert guard.get("worker").limit == TOKEN_LIMITS["worker"]

    def test_custom_limits(self):
        """验证 test custom limits 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard(limits={"planner": 5000, "custom": 2000})
        assert guard.get("planner").limit == 5000
        assert guard.get("custom").limit == 2000

    def test_consume_and_check(self):
        """验证 test consume and check 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard(limits={"worker": 32_000})
        assert guard.consume("worker", 1000) is True
        assert guard.check("worker", 31000) is True
        assert guard.check("worker", 33000) is False

    def test_exceed_budget(self):
        """验证 test exceed budget 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard(limits={"test": 100})
        guard.consume("test", 150)
        assert guard.any_exceeded()
        assert "test" in guard.exceedance_report()

    def test_mitigation_compress(self):
        # 轻度超预算 (1.0 < ratio <= 1.5) -> compress + clean
        """验证 test mitigation compress 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard(limits={"test": 100})
        guard.consume("test", 120)
        result = guard.apply_mitigation("test")
        assert result["mitigated"] is True
        assert "compress" in result["actions"]

    def test_mitigation_downgrade(self):
        # 中度超预算 (1.5 < ratio <= 2.0) -> downgrade + clean
        """验证 test mitigation downgrade 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard(limits={"test": 100})
        guard.consume("test", 170)
        result = guard.apply_mitigation("test")
        assert result["mitigated"] is True
        assert "downgrade" in result["actions"]

    def test_mitigation_block(self):
        # 严重超预算 (ratio > 2.0) -> block
        """验证 test mitigation block 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard(limits={"test": 100})
        guard.consume("test", 220)
        result = guard.apply_mitigation("test")
        assert result["mitigated"] is True
        assert "block" in result["actions"]

    def test_mitigation_no_action(self):
        """验证 test mitigation no action 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard(limits={"test": 100})
        guard.consume("test", 50)
        result = guard.apply_mitigation("test")
        assert result["mitigated"] is False

    def test_total_consumed(self):
        """验证 test total consumed 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard()
        guard.consume("planner", 1000)
        guard.consume("worker", 2000)
        assert guard.total_consumed() == 3000

    def test_ui_metrics(self):
        """验证 test ui metrics 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard()
        guard.consume("planner", 1000)
        guard.get("planner").record_compressed(200)
        metrics = guard.to_ui_metrics()
        assert metrics["totalTokens"] == 1000
        assert metrics["compressedTokens"] == 200
        assert "domains" in metrics

    def test_snapshot(self):
        """验证 test snapshot 场景的输入、执行结果与兼容行为。"""
        guard = TokenBudgetGuard()
        guard.consume("planner", 500)
        snapshot = guard.snapshot()
        assert "planner" in snapshot
        assert snapshot["planner"]["consumed"] == 500
