"""工厂审计快速通道测试：单次 LLM 判定，不做多轮循环。"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from backend.services.agent.harness.models import ProjectHarness
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import WorkWorkerState
from backend.services.agent.worker.factory_audit_work import execute_factory_audit_work
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage


def _work() -> WorkItem:
    """构造典型的 Mock/契约审计 Work。"""

    return WorkItem(
        id="W001",
        title="审查并补齐 Mock 数据与 Data Source 契约",
        objective="审计 mock 数据与 data source 契约一致性，补齐缺失字段",
        acceptance_criteria=["一致性校验通过"],
        execution_type="coding",
    )


async def _noop(*_args, **_kwargs) -> None:
    """测试用空回调。"""


def _harness() -> ProjectHarness:
    """返回输出目录为 src/features/commerce 的 Harness。"""

    return ProjectHarness(framework="React", source_root="src")


@pytest.mark.asyncio
async def test_audit_reuse_completes_with_single_llm_call(tmp_path, monkeypatch) -> None:
    """校验通过 + LLM 判定复用 → 只调一次模型，不做任何编辑。"""

    calls: list[object] = []

    async def fake_tool(name: str, **_kwargs):
        if name == "software_factory.validate":
            return {"ok": True, "errors": [], "warnings": []}
        raise AssertionError(f"不应调用工具：{name}")

    async def fake_complete(**kwargs):
        calls.append(kwargs["messages"])
        return (
            json.dumps({"verdict": "reuse", "reason": "产物已满足要求"}),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Audit Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.execute_code_tool",
        fake_tool,
    )
    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()

    result = await execute_factory_audit_work(
        root=tmp_path,
        request_text="生成电商 mock",
        work=_work(),
        harness=_harness(),
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result.succeeded is True
    assert len(calls) == 1
    assert state.changed_files == []
    assert state.factory_validations.get("src/features/commerce") is True


@pytest.mark.asyncio
async def test_audit_ignores_page_binding_errors(tmp_path, monkeypatch) -> None:
    """校验错误只涉及页面导入时，数据层审计 Work 应判定成功而不是失败。"""

    async def fake_tool(name: str, **_kwargs):
        if name == "software_factory.validate":
            return {
                "ok": False,
                "errors": [
                    "业务页面 src/pages/cart/index.tsx 需要导入 createCommerceDataSource"
                ],
                "warnings": [],
            }
        raise AssertionError(f"不应调用工具：{name}")

    async def fake_complete(**_kwargs):
        return (
            json.dumps({"verdict": "reuse", "reason": "数据层产物一致，页面接入由页面 Work 处理"}),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Audit Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.execute_code_tool",
        fake_tool,
    )
    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()

    result = await execute_factory_audit_work(
        root=tmp_path,
        request_text="生成电商 mock",
        work=_work(),
        harness=_harness(),
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result.succeeded is True
    assert "直接复用" in result.summary


@pytest.mark.asyncio
async def test_audit_patch_applies_operations(tmp_path, monkeypatch) -> None:
    """LLM 返回 patch 时，只应用其补丁并通过二次校验，不做多余轮次。"""

    output_dir = tmp_path / "src" / "features" / "commerce"
    output_dir.mkdir(parents=True)
    (output_dir / "contracts.ts").write_text("OLD", encoding="utf-8")
    validation_results = [
        {"ok": False, "errors": ["contracts 缺少字段"], "warnings": []},
        {"ok": True, "errors": [], "warnings": []},
    ]

    async def fake_tool(name: str, **_kwargs):
        if name == "software_factory.validate":
            return validation_results.pop(0)
        raise AssertionError(f"不应调用工具：{name}")

    async def fake_complete(**_kwargs):
        return (
            json.dumps(
                {
                    "verdict": "patch",
                    "reason": "补齐契约字段",
                    "operations": [
                        {
                            "type": "replace",
                            "path": "src/features/commerce/contracts.ts",
                            "oldText": "OLD",
                            "newText": "NEW",
                            "reason": "补齐字段",
                        }
                    ],
                }
            ),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Audit Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.execute_code_tool",
        fake_tool,
    )
    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()

    result = await execute_factory_audit_work(
        root=tmp_path,
        request_text="生成电商 mock",
        work=_work(),
        harness=_harness(),
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result.succeeded is True
    assert (output_dir / "contracts.ts").read_text("utf-8") == "NEW"
    assert "src/features/commerce/contracts.ts" in state.changed_files


@pytest.mark.asyncio
async def test_audit_cannot_fix_fails_with_reason(tmp_path, monkeypatch) -> None:
    """LLM 判定无法修复时快速失败，由重规划接手。"""

    async def fake_tool(name: str, **_kwargs):
        if name == "software_factory.validate":
            return {"ok": False, "errors": ["结构漂移"], "warnings": []}
        raise AssertionError(f"不应调用工具：{name}")

    async def fake_complete(**_kwargs):
        return (
            json.dumps({"verdict": "cannot_fix", "reason": "需要整批重新生成"}),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Audit Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.execute_code_tool",
        fake_tool,
    )
    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.GATEWAY.complete",
        fake_complete,
    )

    result = await execute_factory_audit_work(
        root=tmp_path,
        request_text="生成电商 mock",
        work=_work(),
        harness=_harness(),
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        state=WorkWorkerState(),
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result.succeeded is False
    assert "CANNOT FIX" in result.error
    assert result.failure_kind == "code"


@pytest.mark.asyncio
async def test_audit_invalid_verdict_is_runtime_failure(tmp_path, monkeypatch) -> None:
    """审计模型返回非法 JSON 时按协议失败处理。"""

    async def fake_tool(name: str, **_kwargs):
        if name == "software_factory.validate":
            return {"ok": True, "errors": [], "warnings": []}
        raise AssertionError(f"不应调用工具：{name}")

    async def fake_complete(**_kwargs):
        return (
            "这不是 JSON",
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Audit Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.execute_code_tool",
        fake_tool,
    )
    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.GATEWAY.complete",
        fake_complete,
    )

    result = await execute_factory_audit_work(
        root=tmp_path,
        request_text="生成电商 mock",
        work=_work(),
        harness=_harness(),
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        state=WorkWorkerState(),
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result.succeeded is False
    assert result.failure_kind == "runtime"


@pytest.mark.asyncio
async def test_audit_generates_when_manifest_missing(tmp_path, monkeypatch) -> None:
    """产物整体缺失时先确定性生成，不直接丢给模型。"""

    generated: list[dict[str, object]] = []

    async def fake_tool(name: str, **_kwargs):
        if name == "software_factory.validate":
            return {"ok": False, "errors": ["找不到生成清单：x"], "warnings": []}
        if name == "software_factory.generate":
            generated.append(_kwargs)
            return {"changedFiles": ["src/features/commerce/contracts.ts"]}
        raise AssertionError(f"不应调用工具：{name}")

    async def fake_complete(**_kwargs):
        return (
            json.dumps({"verdict": "cannot_fix", "reason": "仍然缺失"}),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Audit Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.execute_code_tool",
        fake_tool,
    )
    monkeypatch.setattr(
        "backend.services.agent.worker.factory_audit_work.GATEWAY.complete",
        fake_complete,
    )

    result = await execute_factory_audit_work(
        root=tmp_path,
        request_text="生成电商 mock",
        work=_work(),
        harness=_harness(),
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        state=WorkWorkerState(),
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert len(generated) == 1
    assert result.succeeded is False
