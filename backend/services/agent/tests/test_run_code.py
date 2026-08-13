"""run_code 批量执行通道测试：协议解析、Schema 门控、SDK 注入、解释器解析。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.services.agent.shared.loop_protocol import parse_agent_action
from backend.services.agent.shared.tool_registry import (
    build_openai_tools,
    code_mode_enabled,
    tool_names_for_mode,
)


def test_parse_run_code_action() -> None:
    """run_code 动作应解析出 code 字段。"""

    action = parse_agent_action(
        json.dumps({"action": "run_code", "workId": "W001", "code": "print(1)"})
    )
    assert action.action == "run_code"
    assert action.code == "print(1)"


def test_run_code_requires_code() -> None:
    """run_code 缺 code 应校验失败。"""

    from pydantic import ValidationError

    from backend.services.agent.shared.loop_protocol import ActionRequestModel

    with pytest.raises(ValidationError):
        ActionRequestModel(action="run_code", work_id="W001")


def test_code_mode_tool_gating(monkeypatch) -> None:
    """CODE_AGENT_CODE_MODE 关闭时 run_code 不出现在工具集，开启后出现。"""

    monkeypatch.delenv("CODE_AGENT_CODE_MODE", raising=False)
    assert not code_mode_enabled()
    assert "run_code" not in tool_names_for_mode(execution_mode="full_auto")
    tools = build_openai_tools(execution_mode="full_auto")
    assert all(tool["function"]["name"] != "run_code" for tool in tools)

    monkeypatch.setenv("CODE_AGENT_CODE_MODE", "1")
    assert code_mode_enabled()
    assert "run_code" in tool_names_for_mode(execution_mode="full_auto")
    # 自动编辑模式仍不暴露（run_code 只在 full_auto）。
    assert "run_code" not in tool_names_for_mode(execution_mode="auto_edit")
    tools = build_openai_tools(execution_mode="full_auto")
    assert any(tool["function"]["name"] == "run_code" for tool in tools)


def test_sdk_block_injected_when_enabled(monkeypatch) -> None:
    """CODE_AGENT_CODE_MODE 开启时 worker system prompt 含 SDK 说明。"""

    from backend.services.agent.harness import build_project_harness
    from backend.services.agent.worker.work_prompt import _worker_prompt

    monkeypatch.setenv("CODE_AGENT_CODE_MODE", "1")
    from backend.services.agent.shared.work_models import WorkItem

    work = WorkItem(id="W001", title="t", objective="o")
    harness = build_project_harness(
        root=Path("."), request_text="测试任务", runtime_context=""
    )
    prompt = _worker_prompt(work=work, harness=harness, execution_mode="full_auto")
    assert "tools.read" in prompt
    assert "run_code SDK" in prompt


def test_python_interpreter_resolution(monkeypatch) -> None:
    """解释器解析：env 优先、开发模式 sys.executable。"""

    from backend.services.agent.code_mode.runner import resolve_python_interpreter

    monkeypatch.setenv("CODE_AGENT_PYTHON", "/opt/embed/python.exe")
    assert resolve_python_interpreter() == "/opt/embed/python.exe"

    monkeypatch.delenv("CODE_AGENT_PYTHON", raising=False)
    resolved = resolve_python_interpreter()
    assert resolved  # 开发模式应解析到 sys.executable
    assert Path(resolved).is_file()
