"""pytest 全局夹具：默认关闭请求审计，避免测试过程在项目根目录写日志。"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _disable_request_audit(monkeypatch, tmp_path) -> None:
    """把审计开关默认关闭，并把目录指到临时目录；需要审计的测试自行开启。"""

    monkeypatch.setenv("REQUEST_AUDIT_ENABLED", "0")
    monkeypatch.setenv("REQUEST_AUDIT_DIR", str(tmp_path / "request-audit"))
