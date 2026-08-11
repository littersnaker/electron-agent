"""安装包后端启动布局与健康检查回归测试。"""

from __future__ import annotations

from pathlib import Path

from backend.api import health as health_module

ROOT = Path(__file__).resolve().parents[2]


def test_health_modified_time_tolerates_virtual_bundle_path(
    tmp_path: Path,
) -> None:
    """验证 PyInstaller 逻辑 ``__file__`` 不存在时不会触发 HTTP 500。"""

    missing_file = tmp_path / "_MEI-test" / "backend" / "api" / "health.py"
    assert health_module._safe_modified_at(missing_file) is None


def test_python_backend_uses_onedir_layout() -> None:
    """验证发布构建不再使用每次启动都要解压的 onefile。"""

    build_script = (ROOT / "scripts" / "build-python-backend.py").read_text("utf-8")
    assert '"--onedir"' in build_script
    assert '"--onefile"' not in build_script
    assert '"--contents-directory=_internal"' in build_script


def test_electron_builder_copies_complete_onedir_bundle() -> None:
    """验证 Electron 安装包会复制后端可执行文件及其 _internal 依赖。"""

    builder_config = (ROOT / "electron-builder.yml").read_text("utf-8")
    assert "from: python-dist/multi-agent-backend" in builder_config
    assert "to: backend" in builder_config
