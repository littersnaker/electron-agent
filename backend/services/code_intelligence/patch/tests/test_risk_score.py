"""Patch Risk Score 模块测试。"""

from backend.services.code_intelligence.patch.risk_score import (
    PatchRiskAnalyzer,
    PatchRiskScore,
    RiskLevel,
)


class TestPatchRiskAnalyzer:
    def test_low_risk_single_file(self):
        """验证 test low risk single file 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(changed_files=["src/utils.py"])
        assert result.risk == RiskLevel.LOW.value
        assert result.score < 20

    def test_medium_risk_multiple_files(self):
        """验证 test medium risk multiple files 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(changed_files=[f"src/file_{i}.py" for i in range(5)])
        assert result.risk == RiskLevel.MEDIUM.value

    def test_high_risk_with_depth(self):
        """验证 test high risk with depth 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(
            changed_files=["src/core.py", "src/api.py"],
            dependency_depth=7,
        )
        assert result.risk in {RiskLevel.HIGH.value, RiskLevel.CRITICAL.value}

    def test_critical_risk_core_file(self):
        """验证 test critical risk core file 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(
            changed_files=["backend/main.py", "backend/__init__.py"],
            dependency_depth=5,
            artifact_dependencies=["schema", "config"],
        )
        assert result.risk == RiskLevel.CRITICAL.value

    def test_test_coverage_reduces_risk(self):
        """验证 test test coverage reduces risk 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        without_tests = analyzer.analyze(
            changed_files=["src/a.py", "src/b.py"],
            has_tests=False,
        )
        with_tests = analyzer.analyze(
            changed_files=["src/a.py", "src/b.py"],
            has_tests=True,
        )
        assert with_tests.score < without_tests.score

    def test_recommended_validation(self):
        """验证 test recommended validation 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(
            changed_files=["src/main.py"],
            has_tests=False,
        )
        assert len(result.recommended_validation) > 0
        assert "建议补充测试用例" in result.recommended_validation

    def test_python_validation_commands(self):
        """验证 test python validation commands 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(changed_files=["src/app.py"])
        validations = result.recommended_validation
        assert any("pytest" in v for v in validations)

    def test_typescript_validation_commands(self):
        """验证 test typescript validation commands 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(changed_files=["src/app.tsx"])
        validations = result.recommended_validation
        assert any("tsc" in v for v in validations)

    def test_quick_check(self):
        """验证 test quick check 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        level = analyzer.quick_check(["a.py"])
        assert level == RiskLevel.LOW.value

    def test_custom_weights(self):
        """验证 test custom weights 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer(weights={"changed_files": 50})
        result = analyzer.analyze(changed_files=["a.py"])
        assert result.score > 20

    def test_to_json(self):
        """验证 test to json 场景的输入、执行结果与兼容行为。"""
        analyzer = PatchRiskAnalyzer()
        result = analyzer.analyze(changed_files=["src/a.py"])
        data = result.to_json()
        assert "risk" in data
        assert "score" in data
        assert "details" in data


class TestPatchRiskScore:
    def test_creation(self):
        """验证 test creation 场景的输入、执行结果与兼容行为。"""
        score = PatchRiskScore(risk="low", score=10)
        assert score.risk == "low"
        assert score.score == 10
