"""Patch Planner 模块测试。"""

from backend.services.code_intelligence.patch.planner import PatchPlanner
from backend.services.code_intelligence.patch.risk_score import RiskLevel


class TestPatchPlanner:
    def test_low_risk_plan(self):
        """验证 test low risk plan 场景的输入、执行结果与兼容行为。"""
        planner = PatchPlanner()
        plan = planner.plan(changed_files=["src/utils.py"])
        assert plan.can_proceed is True
        assert plan.strategy == "direct_apply"
        assert plan.risk_score is not None
        assert plan.risk_score.risk == RiskLevel.LOW.value

    def test_medium_risk_plan(self):
        """验证 test medium risk plan 场景的输入、执行结果与兼容行为。"""
        planner = PatchPlanner()
        plan = planner.plan(
            changed_files=[f"src/file_{i}.py" for i in range(5)]
        )
        assert plan.can_proceed is True
        assert plan.strategy == "local_analysis"

    def test_high_risk_plan(self):
        """验证 test high risk plan 场景的输入、执行结果与兼容行为。"""
        planner = PatchPlanner()
        plan = planner.plan(
            changed_files=["src/core.py", "src/api.py"],
            dependency_depth=6,
        )
        assert plan.can_proceed is True
        assert plan.strategy == "full_analysis"
        assert len(plan.steps) >= 3
        planner = PatchPlanner()
        plan = planner.plan(
            changed_files=["src/core.py", "src/api.py", "src/db.py"],
            dependency_depth=6,
        )
        assert plan.can_proceed is True
        assert plan.strategy == "full_analysis"
        assert len(plan.steps) >= 3
        planner = PatchPlanner()
        plan = planner.plan(
            changed_files=["src/core.py", "src/api.py", "src/db.py"],
            dependency_depth=7,
        )
        assert plan.can_proceed is True
        assert plan.strategy == "full_analysis"
        assert len(plan.steps) >= 3

    def test_critical_risk_plan(self):
        """验证 test critical risk plan 场景的输入、执行结果与兼容行为。"""
        planner = PatchPlanner()
        plan = planner.plan(
            changed_files=["backend/main.py", "backend/__init__.py"],
            dependency_depth=6,
            artifact_dependencies=["schema", "config"],
        )
        assert plan.can_proceed is False
        assert plan.strategy == "manual_review"

    def test_plan_includes_risk_score(self):
        """验证 test plan includes risk score 场景的输入、执行结果与兼容行为。"""
        planner = PatchPlanner()
        plan = planner.plan(changed_files=["src/a.py"])
        assert plan.risk_score is not None
        assert isinstance(plan.risk_score.score, int)

    def test_plan_steps(self):
        """验证 test plan steps 场景的输入、执行结果与兼容行为。"""
        planner = PatchPlanner()
        plan = planner.plan(changed_files=["src/utils.py"])
        assert len(plan.steps) > 0
        assert any(s["action"] == "apply_patch" for s in plan.steps)

    def test_to_json(self):
        """验证 test to json 场景的输入、执行结果与兼容行为。"""
        planner = PatchPlanner()
        plan = planner.plan(changed_files=["src/a.py"])
        data = plan.to_json()
        assert data["canProceed"] is True
        assert data["strategy"] == "direct_apply"
        assert data["riskScore"] is not None

    def test_plan_with_root_path(self, tmp_path):
        """验证 test plan with root path 场景的输入、执行结果与兼容行为。"""
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "a.py").write_text("import b\n")
        (tmp_path / "src" / "b.py").write_text("")

        planner = PatchPlanner(root=tmp_path)
        plan = planner.plan(changed_files=["src/a.py"])
        assert plan.can_proceed is True
