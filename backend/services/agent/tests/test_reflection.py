"""复盘循环单元测试：Schema、脱敏、去重、容量、门控。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from backend.core import request_audit
from backend.core.config import get_settings
from backend.memory.semantic import SemanticMemoryStore
from backend.services.agent.reflection import digest as digest_module
from backend.services.agent.reflection import eval as eval_module
from backend.services.agent.reflection import runner as runner_module
from backend.services.agent.reflection import search as search_module
from backend.services.agent.reflection import skills as skills_module
from backend.services.agent.reflection import store as store_module
from backend.services.agent.reflection.runner import run_work_review
from backend.services.agent.reflection.schema import (
    filter_review_output,
    parse_review_output,
    review_output_has_content,
)
from backend.services.agent.reflection.settings import (
    ReviewSettings,
    read_review_settings,
    write_review_settings,
)
from backend.services.llm.credentials import LlmCredentials
from backend.skills.loader import SkillLoader
from backend.services.workspace.database import initialize_database


@pytest.fixture()
def db(monkeypatch, tmp_path) -> object:
    """隔离的 SQLite 数据库。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    asyncio.run(initialize_database())
    yield tmp_path
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Schema 校验与过滤
# ---------------------------------------------------------------------------


def test_parse_review_output_with_markdown_fence() -> None:
    text = '```json\n{"facts": [{"content": "Taro 适配需改 designWidth", "confidence": "high"}]}\n```'
    output = parse_review_output(text)
    assert output.facts[0].content == "Taro 适配需改 designWidth"


def test_filter_drops_low_confidence_and_keeps_content() -> None:
    raw = {
        "facts": [
            {"content": "保留事实", "confidence": "high"},
            {"content": "低置信丢弃", "confidence": "low"},
        ],
        "lessons": [{"content": "经验教训", "trigger": "下次同类任务", "confidence": "medium"}],
        "skill_updates": [{"action": "create", "name": "adapt-sop", "diff_summary": "补充步骤"}],
    }
    filtered = filter_review_output(parse_review_output(json.dumps(raw, ensure_ascii=False)))
    assert [item.content for item in filtered.facts] == ["保留事实"]
    assert len(filtered.lessons) == 1
    assert len(filtered.skill_updates) == 1
    assert review_output_has_content(filtered)


def test_parse_invalid_json_raises() -> None:
    with pytest.raises(ValueError):
        parse_review_output("这不是 JSON")


# ---------------------------------------------------------------------------
# 复盘材料（脱敏 + 信息量阈值）
# ---------------------------------------------------------------------------


def test_sanitize_digest_text_masks_pii() -> None:
    cleaned = digest_module.sanitize_digest_text(
        "联系 a@b.com 电话 13812345678，订单号 123456789012345678"
    )
    assert "a@b.com" not in cleaned
    assert "13812345678" not in cleaned
    assert "[REDACTED]" in cleaned


def test_build_work_digest_below_threshold_returns_none() -> None:
    digest = digest_module.build_work_digest(
        work_id="W001",
        succeeded=True,
        summary="",
        error="",
        failure_kind="",
        changed_files=[],
        transcript_tail=[],
        project_id="p",
    )
    assert digest is None


@pytest.mark.asyncio
async def test_build_work_digest_includes_audit_trail(
    monkeypatch,
    tmp_path,
) -> None:
    audit_dir = tmp_path / "audit"
    monkeypatch.setenv("REQUEST_AUDIT_ENABLED", "1")
    monkeypatch.setenv("REQUEST_AUDIT_DIR", str(audit_dir))
    request_audit.record(
        kind="llm.complete",
        request_id="req-test",
        status="success",
        duration_ms=120,
        request={"model": "deepseek:deepseek-v4-flash"},
        response={"text": "已修改并验证通过"},
        agent={"parentRequestId": "W001", "agentId": "modify_worker:W001"},
    )
    digest = digest_module.build_work_digest(
        work_id="W001",
        succeeded=True,
        summary="完成移动端适配",
        error="",
        failure_kind="",
        changed_files=["src/pages/cart/index.tsx"],
        transcript_tail=["读取文件", "写入修改"],
        project_id="p",
    )
    assert digest is not None
    assert "W001" in digest
    assert "AUDIT_TRAIL" in digest


# ---------------------------------------------------------------------------
# SQLite 存储：去重、审批、容量淘汰
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_review_artifact_roundtrip_and_duplicate(db) -> None:
    artifact_id = await store_module.record_review_artifact(
        work_id="W001",
        agent_kind="code",
        scope_id="p",
        model="deepseek:deepseek-v4-flash",
        digest_hash_value="hash-1",
        output={"facts": []},
        status="pending",
    )
    duplicate = await store_module.find_duplicate_review(
        work_id="W001",
        digest_hash_value="hash-1",
    )
    assert duplicate is not None and duplicate["id"] == artifact_id
    assert (
        await store_module.find_duplicate_review(
            work_id="W001",
            digest_hash_value="hash-2",
        )
        is None
    )
    pending = await store_module.list_review_artifacts(status="pending")
    assert any(item["id"] == artifact_id for item in pending)
    assert await store_module.update_review_artifact_status(artifact_id, "approved") is True
    approved = await store_module.list_review_artifacts(status="approved")
    assert any(item["id"] == artifact_id for item in approved)


@pytest.mark.asyncio
async def test_write_semantic_knowledge_dedup(db) -> None:
    first = await store_module.write_semantic_knowledge(
        scope_id="p",
        kind="fact",
        content="Taro 适配需改 designWidth",
        work_id="W001",
        confidence="high",
    )
    second = await store_module.write_semantic_knowledge(
        scope_id="p",
        kind="fact",
        content="Taro 适配需改 designWidth",
        work_id="W002",
        confidence="high",
    )
    assert first is True
    assert second is False
    store = SemanticMemoryStore()
    found = await store.search(query="Taro", scope_ids=("p",), top_k=10)
    assert len(found) == 1


@pytest.mark.asyncio
async def test_enforce_semantic_capacity_evicts_oldest(
    monkeypatch,
    db,
) -> None:
    monkeypatch.setattr(store_module, "MAX_SEMANTIC_ENTRIES_PER_SCOPE", 3)
    store = SemanticMemoryStore()
    for index in range(5):
        await store.save(scope_id="p", content=f"memory-{index}")
        await asyncio.sleep(0.002)
    await store_module.enforce_semantic_capacity("p")
    found = await store.search(query="", scope_ids=("p",), top_k=50)
    assert len(found) == 3
    contents = {item.content for item in found}
    assert "memory-4" in contents
    assert "memory-0" not in contents


# ---------------------------------------------------------------------------
# 设置与门控
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_review_settings_roundtrip(db) -> None:
    settings = await read_review_settings()
    assert settings.model_id == "deepseek:deepseek-v4-flash"
    saved = await write_review_settings(
        ReviewSettings(model_id="deepseek:deepseek-v4-pro", enabled=False)
    )
    assert saved.model_id == "deepseek:deepseek-v4-pro"
    assert saved.enabled is False
    reloaded = await read_review_settings()
    assert reloaded.model_id == "deepseek:deepseek-v4-pro"
    assert reloaded.enabled is False


@pytest.mark.asyncio
async def test_review_settings_accepts_bare_model_name(db) -> None:
    saved = await write_review_settings(
        ReviewSettings(model_id="deepseek-v4-flash", enabled=True)
    )
    assert saved.model_id == "deepseek:deepseek-v4-flash"
    data = saved.to_json()
    assert data["modelId"] == "deepseek-v4-flash"


@pytest.mark.asyncio
async def test_bare_model_name_prefers_native_provider(db) -> None:
    """deepseek-v4-pro 裸名应解析到 DeepSeek 原生厂商，而非百炼托管。"""

    saved = await write_review_settings(
        ReviewSettings(model_id="deepseek-v4-pro", enabled=True)
    )
    assert saved.model_id == "deepseek:deepseek-v4-pro"


@pytest.mark.asyncio
async def test_review_settings_rejects_unknown_model(db) -> None:
    with pytest.raises(ValueError):
        await write_review_settings(ReviewSettings(model_id="nope:does-not-exist"))


@pytest.mark.asyncio
async def test_run_work_review_skips_without_deepseek_key(db) -> None:
    await run_work_review(
        work_id="W001",
        succeeded=True,
        summary="完成",
        error="",
        failure_kind="",
        changed_files=["a.ts"],
        transcript_tail=["步骤" * 100],
        project_id="p",
        credentials=LlmCredentials({"qwen": "sk-test"}),
    )
    assert await store_module.list_review_artifacts(status=None) == []


@pytest.mark.asyncio
async def test_run_work_review_skips_thin_digest(db) -> None:
    await run_work_review(
        work_id="W001",
        succeeded=True,
        summary="",
        error="",
        failure_kind="",
        changed_files=[],
        transcript_tail=[],
        project_id="p",
        credentials=LlmCredentials({"deepseek": "sk-test"}),
    )
    assert await store_module.list_review_artifacts(status=None) == []


# ---------------------------------------------------------------------------
# 跨境电商 Agent 复盘（P2）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_build_runtime_digest_includes_marketplace_and_audit(
    monkeypatch,
    tmp_path,
) -> None:
    audit_dir = tmp_path / "audit"
    monkeypatch.setenv("REQUEST_AUDIT_ENABLED", "1")
    monkeypatch.setenv("REQUEST_AUDIT_DIR", str(audit_dir))
    request_audit.record(
        kind="llm.complete",
        request_id="req-commerce",
        status="success",
        duration_ms=90,
        request={"model": "deepseek:deepseek-v4-flash"},
        response={"text": "完成亚马逊市场分析"},
        agent={"parentRequestId": "task-1", "agentId": "commerce"},
    )
    digest = digest_module.build_runtime_digest(
        task_id="task-1",
        agent_id="commerce",
        status="completed",
        request_text="分析亚马逊按摩椅市场",
        result_summary="已输出机会与风险报告",
        error_message="",
        event_count=12,
        project_id="",
        session_id="session-1",
        marketplace="amazon",
    )
    assert digest is not None
    assert "MARKETPLACE: amazon" in digest
    assert "AUDIT_TRAIL" in digest


def test_build_runtime_digest_below_threshold_returns_none() -> None:
    digest = digest_module.build_runtime_digest(
        task_id="task-1",
        agent_id="commerce",
        status="completed",
        request_text="",
        result_summary="",
        error_message="",
        event_count=0,
        project_id="",
        session_id="",
        marketplace="",
    )
    assert digest is None


@pytest.mark.asyncio
async def test_run_runtime_review_skips_without_deepseek_key(db) -> None:
    await runner_module.run_runtime_review(
        task_id="task-1",
        agent_id="commerce",
        status="completed",
        request_text="分析市场" * 60,
        result_summary="完成",
        error_message="",
        event_count=5,
        project_id="",
        session_id="session-1",
        marketplace="amazon",
        credentials=LlmCredentials({"qwen": "sk-test"}),
    )
    assert await store_module.list_review_artifacts(status=None) == []


@pytest.mark.asyncio
async def test_run_runtime_review_writes_pending_artifact(
    monkeypatch,
    db,
) -> None:
    class FakeGateway:
        """替换 GATEWAY，返回合法复盘 JSON，避免真实网络调用。"""

        async def complete(self, **_: object) -> tuple[str, object, object]:
            payload = {
                "facts": [
                    {
                        "content": "亚马逊按摩椅类目价格带集中在 200-400 美元",
                        "scope": "business",
                        "confidence": "high",
                    }
                ],
                "lessons": [
                    {
                        "content": "Keepa 数据缺失时改用公开搜索采样",
                        "trigger": "亚马逊历史价格数据不可用",
                        "confidence": "medium",
                    }
                ],
                "skill_updates": [],
                "risks": [],
            }
            return json.dumps(payload, ensure_ascii=False), object(), object()

    monkeypatch.setattr(runner_module, "GATEWAY", FakeGateway())
    await runner_module.run_runtime_review(
        task_id="task-1",
        agent_id="commerce",
        status="completed",
        request_text="分析亚马逊按摩椅市场" * 40,
        result_summary="已输出机会与风险报告",
        error_message="",
        event_count=12,
        project_id="",
        session_id="session-1",
        marketplace="amazon",
        credentials=LlmCredentials({"deepseek": "sk-test"}),
    )
    items = await store_module.list_review_artifacts(status="pending")
    assert len(items) == 1
    assert items[0]["agentKind"] == "commerce"
    assert items[0]["scopeId"] == "commerce:amazon"
    output = items[0]["output"]
    assert output["facts"][0]["content"].startswith("亚马逊按摩椅")
    store = SemanticMemoryStore()
    found = await store.search(query="亚马逊", scope_ids=("commerce:amazon",), top_k=10)
    assert any("价格带" in item.content for item in found)


# ---------------------------------------------------------------------------
# P3：技能自动落盘 / 会话搜索 / 记忆命中评估
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_skill_updates_creates_and_patches(db) -> None:
    created = skills_module.create_skill_from_review(
        name="Shopify Checkout Review",
        diff_summary="校验 Webhook 签名后落单",
        evidence="W001",
    )
    assert created["status"] == "created"
    skill_path = Path(created["path"])
    assert skill_path.is_file()
    loader = SkillLoader()
    skill = loader.load(skill_path, scope="user")
    assert "Webhook" in skill.prompt

    patched = skills_module.patch_skill_from_review(
        name="Shopify Checkout Review",
        diff_summary="增加幂等键处理",
        evidence="W002",
    )
    assert patched["status"] == "patched"
    reloaded = loader.load(skill_path, scope="user")
    assert "幂等键" in reloaded.prompt

    again = skills_module.create_skill_from_review(
        name="Shopify Checkout Review",
        diff_summary="x",
        evidence="",
    )
    assert again["status"] == "exists"


@pytest.mark.asyncio
async def test_session_search_fts_and_like(db) -> None:
    store = SemanticMemoryStore()
    await store.save(
        scope_id="p",
        content="Taro designWidth config needs sync",
        metadata={"kind": "fact"},
    )
    await store.save(
        scope_id="p",
        content="移动端适配需要改 designWidth 和 pxtransform",
        metadata={"kind": "fact"},
    )
    fts = await search_module.session_search(query="designWidth", scope_ids=("p",))
    assert fts["engine"] == "fts5"
    assert any("Taro designWidth" in item["content"] for item in fts["items"])
    like = await search_module.session_search(query="移动端适配", scope_ids=("p",))
    assert like["engine"] == "like"
    assert any("移动端适配" in item["content"] for item in like["items"])


@pytest.mark.asyncio
async def test_memory_eval_hits_and_stats(
    monkeypatch,
    tmp_path,
    db,
) -> None:
    audit_dir = tmp_path / "audit"
    monkeypatch.setenv("REQUEST_AUDIT_ENABLED", "1")
    monkeypatch.setenv("REQUEST_AUDIT_DIR", str(audit_dir))
    store = SemanticMemoryStore()
    memory = await store.save(
        scope_id="p",
        content="购物车页面懒加载优化",
        metadata={"kind": "fact"},
    )
    request_audit.record(
        kind="llm.complete",
        request_id="req-eval",
        status="success",
        duration_ms=1,
        request={"model": "m"},
        response={"text": "已完成购物车页面懒加载优化，验证通过"},
        agent={"parentRequestId": "task-1", "agentId": "code"},
    )
    await eval_module.record_memory_eval(
        task_id="task-1",
        agent_id="code",
        memory_ids=[memory.id],
    )
    stats = await eval_module.memory_eval_stats()
    assert stats["injected"] == 1
    assert stats["hit"] == 1
    assert stats["hitRate"] == 1.0


@pytest.mark.asyncio
async def test_approve_endpoint_applies_skills(monkeypatch, db) -> None:
    artifact_id = await store_module.record_review_artifact(
        work_id="W001",
        agent_kind="code",
        scope_id="p",
        model="m",
        digest_hash_value="hash-skill",
        output={
            "facts": [],
            "lessons": [],
            "skill_updates": [
                {
                    "action": "create",
                    "name": "Taro Adapt",
                    "diff_summary": "统一改 designWidth",
                    "evidence": "W001",
                }
            ],
        },
        status="pending",
    )
    from backend.api.review import approve_review_artifact

    result = await approve_review_artifact(artifact_id)
    assert result["ok"] is True
    assert result["appliedSkills"][0]["status"] == "created"
    item = await store_module.get_review_artifact(artifact_id)
    assert item is not None and item["status"] == "approved"


@pytest.mark.asyncio
async def test_review_stats_endpoint(db) -> None:
    await store_module.record_review_artifact(
        work_id="W001",
        agent_kind="code",
        scope_id="p",
        model="m",
        digest_hash_value="hash-stats",
        output={"facts": [{"content": "fact-1"}], "lessons": [], "skill_updates": []},
        status="approved",
    )
    from backend.api.review import get_review_stats

    stats = await get_review_stats()
    assert stats["artifacts"]["total"] == 1
    assert stats["knowledge"]["facts"] == 1
    assert "memoryEval" in stats


def test_review_api_router_registered() -> None:
    from backend.api.review import router

    paths = {getattr(route, "path", "") for route in router.routes}
    assert "/api/agent/review-settings" in paths
    assert "/api/agent/review-artifacts" in paths
    assert "/api/agent/session-search" in paths
    assert "/api/agent/review-stats" in paths
