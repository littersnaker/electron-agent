"""P2 Patch、验证、回归和质量门测试。"""

import asyncio

from backend.quality.code_gate import CodeGate
from backend.quality.patch_analyzer import PatchAnalyzer
from backend.quality.regression_detector import RegressionDetector
from backend.quality.validation_engine import ValidationEngine
from backend.services.agent.command_runner import CommandResult


def test_patch_analyzer_scales_validation_with_risk() -> None:
    """验证高影响 Patch 会提升风险并增加回归和构建检查。"""

    analysis = PatchAnalyzer().analyze(
        changed_files=["backend/api/router.py", "app/page.tsx"],
        dependency_graph={
            "backend/api/router.py": ["backend/main.py"],
            "backend/main.py": ["app/lib/api-client.ts"],
        },
        artifact_dependencies=["contracts/schema.json"],
        business_importance=10,
    )

    assert analysis.risk.score >= 25
    assert "backend/main.py" in analysis.affected_files
    assert "integration-test" in analysis.validation_required


def test_validation_engine_uses_injected_runner(tmp_path) -> None:
    """验证 Validation Engine 可按风险计划并执行注入的安全命令。"""

    async def runner(root, command):
        """返回稳定成功结果，避免测试真正启动外部进程。"""

        assert root == tmp_path
        return CommandResult(command=command, exit_code=0, output="passed")

    report = asyncio.run(
        ValidationEngine(runner).execute(
            root=tmp_path,
            changed_files=["backend/service.py"],
            risk="medium",
        )
    )

    assert report.executed is True
    assert report.passed is True
    assert len(report.checks) >= 2


def test_regression_detector_reports_contract_change_without_false_failure(tmp_path) -> None:
    """验证公共 API 变化会被提示，但验证通过时不会误判功能回归。"""

    target = tmp_path / "api.py"
    target.write_text("def fetch(value):\n    return value\n", "utf-8")
    detector = RegressionDetector()
    baseline = detector.capture(tmp_path, ["api.py"])
    target.write_text("def fetch(value, default=None):\n    return value or default\n", "utf-8")
    validation = ValidationEngine().from_existing_results(
        risk="medium",
        results=[CommandResult("python -m pytest", 0, "passed")],
    )
    report = detector.detect(
        root=tmp_path,
        baseline=baseline,
        validation=validation,
    )

    assert report.api_contract_changed is True
    assert report.regression is False


def test_code_gate_blocks_files_over_limit(tmp_path) -> None:
    """验证提交前质量门会阻止超过五百行的手写源码。"""

    target = tmp_path / "large.py"
    target.write_text("\n".join(["# 行"] * 501), "utf-8")
    patch = PatchAnalyzer().analyze(changed_files=["large.py"])
    validation = ValidationEngine().from_existing_results(
        risk=patch.risk.level.value,
        results=[CommandResult("python -m compileall", 0, "passed")],
    )
    regression = RegressionDetector().detect(
        root=tmp_path,
        baseline=RegressionDetector().capture(tmp_path, []),
        validation=validation,
    )
    gate = CodeGate().evaluate(
        root=tmp_path,
        changed_files=["large.py"],
        risk=patch.risk,
        validation=validation,
        regression=regression,
    )

    assert gate.passed is False
    assert any("超过 500 行" in issue for issue in gate.issues)


def test_final_quality_report_exposes_ui_metrics(tmp_path) -> None:
    """验证最终审查会输出 UI 需要的变更、风险、验证和回归指标。"""

    from backend.services.agent.final_quality import review_execution
    from backend.services.agent.work_state import WorkWorkerState

    target = tmp_path / "module.py"
    target.write_text('"""测试模块。"""\n\ndef value():\n    """返回稳定值。"""\n    return 1\n', "utf-8")
    report = asyncio.run(
        review_execution(
            root=tmp_path,
            changed_files=["module.py"],
            command_results=[],
            worker_states={"W001": WorkWorkerState(changed_files=["module.py"])},
            execution_mode="auto_edit",
        )
    )

    payload = report.to_json()
    assert payload["changes"] == 1
    assert "riskScore" in payload
    assert payload["validationExecuted"] is False
    assert payload["regression"] is False
