"""Code Intelligence 测试。"""

from pathlib import Path

from backend.code_intelligence.service import CodeIntelligenceService


def test_code_intelligence_reports_symbols_calls_and_impact(tmp_path: Path) -> None:
    """服务应提取符号、调用边和直接导入方。"""

    package = tmp_path / "pkg"
    package.mkdir()
    (package / "core.py").write_text(
        '"""核心。"""\n\n'
        "def run() -> None:\n"
        '    """运行。"""\n\n'
        "    print('ok')\n",
        "utf-8",
    )
    (tmp_path / "consumer.py").write_text(
        '"""调用方。"""\n\nfrom pkg import core\n',
        "utf-8",
    )

    result = CodeIntelligenceService().inspect(
        tmp_path,
        paths=["pkg/core.py"],
        query="run",
    )

    assert "function run" in result
    assert "run -> print" in result
    assert "consumer.py" in result
