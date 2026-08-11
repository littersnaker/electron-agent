"""所有 Agent 的 SQLite Checkpoint 与无限文件批次回归测试。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.core.config import get_settings
from backend.main import app
from backend.services.agent.loop.checkpoint_runtime import (
    command_from_json,
    ledger_from_json,
    plan_from_json,
    plan_to_json,
)
from backend.services.agent.loop.runner import stream_autonomous_loop
from backend.services.agent.planner.task_planner import CodeTaskPlan, WorkItem, WorkLedger
from backend.services.agent.shared.command_runner import CommandResult
from backend.services.agent.shared.loop_protocol import parse_agent_action
from backend.services.agent.shared.workspace_tools import apply_edit_operations
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage


def _request_payload() -> dict[str, object]:
    """构造前端保存的通用任务请求。"""

    return {
        "input": "继续完成项目修改",
        "selectedModel": "auto",
        "composerMode": "chat",
        "codeAgentMode": "full_auto",
        "attachments": [],
        "commerceWorkflowMode": "research",
        "commerceMarketplace": "US",
        "typographyPolicy": "avoid-generated-text",
        "imageEditFidelity": "precise",
        "enableQualityGuard": True,
    }


def test_checkpoint_crud_survives_restart(tmp_path: Path, monkeypatch) -> None:
    """验证 Checkpoint 写入 SQLite，模拟重启后仍可恢复。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    with TestClient(app) as client:
        response = client.post(
            "/api/checkpoints",
            json={
                "sessionId": "session-code",
                "agentKind": "code",
                "route": "/api/chat",
                "request": _request_payload(),
                "label": "Code Agent · 恢复测试",
            },
        )
        assert response.status_code == 200
        checkpoint = response.json()["checkpoint"]
        checkpoint_id = checkpoint["id"]
        updated = client.put(
            f"/api/checkpoints/{checkpoint_id}",
            json={
                "status": "interrupted",
                "state": {"codeLoop": {"nextIteration": 17}},
                "errorMessage": "应用关闭",
            },
        )
        assert updated.status_code == 200

    with sqlite3.connect(get_settings().database_path) as connection:
        stored = connection.execute(
            "SELECT status, state_json FROM agent_checkpoints WHERE id = ?",
            (checkpoint_id,),
        ).fetchone()
    assert stored is not None
    assert stored[0] == "interrupted"
    assert json.loads(stored[1])["codeLoop"]["nextIteration"] == 17

    get_settings.cache_clear()
    with TestClient(app) as restarted_client:
        latest = restarted_client.get(
            "/api/checkpoints/latest",
            params={"sessionId": "session-code"},
        )
        assert latest.status_code == 200
        restored = latest.json()["checkpoint"]
        assert restored["id"] == checkpoint_id
        assert restored["state"]["codeLoop"]["nextIteration"] == 17
        assert restarted_client.delete(
            f"/api/checkpoints/{checkpoint_id}"
        ).json() == {"deleted": True}


def test_checkpoint_api_accepts_all_agent_kinds(tmp_path: Path, monkeypatch) -> None:
    """验证 QA、Code、Media 和 Commerce 共用同一持久化能力。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "all-agent-data"))
    get_settings.cache_clear()
    with TestClient(app) as client:
        for kind, route in (
            ("qa", "/api/qa"),
            ("code", "/api/chat"),
            ("media", "/api/media/generate"),
            ("commerce", "/api/commerce/research"),
        ):
            response = client.post(
                "/api/checkpoints",
                json={
                    "sessionId": f"session-{kind}",
                    "agentKind": kind,
                    "route": route,
                    "request": _request_payload(),
                    "label": kind,
                },
            )
            assert response.status_code == 200
            assert response.json()["checkpoint"]["agentKind"] == kind


def test_code_checkpoint_preserves_successful_work_and_commands() -> None:
    """验证精确恢复保留成功 Work、失败 Work、文件和命令结果。"""

    plan = CodeTaskPlan(
        raw_request="修改项目",
        optimized_prompt="读取项目并完成修改",
        objective="完成项目修改",
        constraints=["不重复成功 Work"],
        acceptance_criteria=["测试通过"],
        non_goals=[],
        validation_commands=["python -m pytest"],
        works=[
            WorkItem("W001", "成功任务", "完成 A"),
            WorkItem("W002", "失败任务", "完成 B"),
        ],
    )
    ledger = WorkLedger(plan.works)
    ledger.begin("W001")
    ledger.add_artifacts("W001", ["a.py"])
    ledger.succeed("W001", "A 已完成")
    ledger.begin("W002")
    ledger.fail("W002", "B 测试失败")

    restored_plan = plan_from_json(plan_to_json(plan))
    restored_ledger = ledger_from_json(ledger.snapshot())
    restored_command = command_from_json(
        {
            "command": "python -m pytest",
            "exitCode": 1,
            "output": "1 failed",
            "timedOut": False,
            "blockedReason": "",
        }
    )

    assert restored_plan.validation_commands == ["python -m pytest"]
    assert restored_ledger.get("W001").status == "succeeded"  # type: ignore[union-attr]
    assert restored_ledger.get("W001").changed_files == ["a.py"]  # type: ignore[union-attr]
    assert restored_ledger.get("W002").status == "failed"  # type: ignore[union-attr]
    assert restored_command == CommandResult(
        "python -m pytest", 1, "1 failed", False, ""
    )


def test_edit_action_has_no_artificial_file_count_limit(tmp_path: Path) -> None:
    """验证单个工具动作可处理超过旧 32 文件限制的正常项目修改。"""

    file_count = 80
    action = parse_agent_action(
        json.dumps(
            {
                "action": "edit",
                "workId": "W001",
                "summary": "批量创建正常项目模块",
                "operations": [
                    {
                        "type": "write",
                        "path": f"src/features/feature_{index}.ts",
                        "content": f"export const feature{index} = {index};\n",
                    }
                    for index in range(file_count)
                ],
            },
            ensure_ascii=False,
        )
    )
    result = apply_edit_operations(tmp_path, action.operations)

    assert len(action.operations) == file_count
    assert len(result.changed_files) == file_count
    assert (tmp_path / "src/features/feature_79.ts").is_file()


@pytest.mark.asyncio
async def test_code_loop_checkpoints_after_safe_actions(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """验证文件落盘和 Work 完成后都会产生可恢复安全快照。"""

    responses = iter(
        [
            {
                "action": "edit",
                "workId": "W001",
                "summary": "写入文件",
                "operations": [
                    {"type": "write", "path": "a.py", "content": "A = 1\n"}
                ],
            },
            {"action": "complete_work", "workId": "W001", "summary": "完成"},
            {"action": "finish", "summary": "任务完成", "tests": []},
        ]
    )
    snapshots: list[dict[str, object]] = []

    async def fake_complete(**_kwargs):
        """依次返回可完成任务的工具动作。"""

        return (
            json.dumps(next(responses), ensure_ascii=False),
            LlmUsage(prompt=2, completion=1, total=3),
            SimpleNamespace(name="Checkpoint Test Model"),
        )

    async def fake_save(_checkpoint_id: str, **kwargs) -> None:
        """记录循环请求写入的安全快照。"""

        snapshots.append(
            {
                "changed": list(kwargs["changed_files"]),
                "ledger": kwargs["ledger"].snapshot(),
            }
        )

    monkeypatch.setattr("backend.services.agent.loop.runner.GATEWAY.complete", fake_complete)
    monkeypatch.setattr("backend.services.agent.loop.runner.save_loop_checkpoint", fake_save)
    plan = CodeTaskPlan(
        raw_request="创建 a.py",
        optimized_prompt="创建 a.py 并完成验证",
        objective="创建 a.py",
        constraints=[],
        acceptance_criteria=["a.py 存在"],
        non_goals=[],
        validation_commands=[],
        works=[WorkItem("W001", "创建文件", "创建 a.py")],
    )
    async for _event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=plan,
        initial_context="",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
        checkpoint_id="cp-test",
    ):
        pass

    assert any("a.py" in snapshot["changed"] for snapshot in snapshots)
    assert any(
        snapshot["ledger"]["succeeded"] == 1  # type: ignore[index]
        for snapshot in snapshots
    )
