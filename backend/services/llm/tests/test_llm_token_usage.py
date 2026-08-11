"""LLM 流式 usage 缺失时的真实网关与本地估算测试。"""

import pytest

from backend.services.llm.catalog import ModelDefinition
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import LlmGateway
from backend.services.llm.protocols import ProviderRequestError
from backend.services.llm.token_usage import (
    ensure_usage,
    estimate_prompt_tokens,
    estimate_text_tokens,
)
from backend.services.llm.types import LlmChunk, LlmMessage, LlmUsage


def test_estimate_mixed_chinese_and_english_text() -> None:
    """中英文混合内容应得到稳定的非零估算。"""

    assert estimate_text_tokens("完善微信小程序 shopping cart") > 0
    assert estimate_prompt_tokens([LlmMessage("user", "读取项目并修改")]) > 0


def test_ensure_usage_falls_back_when_provider_omits_usage() -> None:
    """供应商未返回 usage 时仍应为预算和 UI 生成完整统计。"""

    usage = ensure_usage(
        LlmUsage(),
        messages=[
            LlmMessage("system", "你是代码代理"),
            LlmMessage("user", "完成购物车功能"),
        ],
        output_text='{"action":"read","paths":["src/app.ts"]}',
    )

    assert usage.prompt > 0
    assert usage.completion > 0
    assert usage.total == usage.prompt + usage.completion


def test_ensure_usage_preserves_provider_total() -> None:
    """供应商提供真实总量时不得被本地估算覆盖。"""

    usage = ensure_usage(
        LlmUsage(prompt=80, completion=20, total=100),
        messages=[LlmMessage("user", "测试")],
        output_text="完成",
    )

    assert usage == LlmUsage(prompt=80, completion=20, total=100)


@pytest.mark.asyncio
async def test_gateway_emits_nonzero_usage_when_stream_has_no_usage(monkeypatch) -> None:
    """验证 Token 估算已经接入真实网关，而不是只存在于孤立工具函数中。"""

    gateway = LlmGateway()
    model = ModelDefinition(
        id="test:kimi",
        provider="kimi",
        model="kimi-test",
        name="Kimi Test",
        description="测试模型",
        capabilities=("text", "stream"),
    )

    async def fake_stream_model(**_kwargs):
        """模拟只返回文本、不返回 usage 的兼容流。"""

        yield LlmChunk(text_delta='{"action":"complete_work"}')

    monkeypatch.setattr(
        gateway,
        "resolve_candidates",
        lambda *_args, **_kwargs: (model,),
    )
    monkeypatch.setattr(gateway, "_stream_model", fake_stream_model)
    monkeypatch.setattr(
        "backend.services.llm.gateway.AVAILABILITY.mark_success",
        lambda *_args, **_kwargs: None,
    )

    text, usage, selected = await gateway.complete(
        preferred_model_id=model.id,
        credentials=LlmCredentials(values={}),
        messages=[LlmMessage("user", "完成当前工作")],
    )

    assert text == '{"action":"complete_work"}'
    assert usage.prompt > 0
    assert usage.completion > 0
    assert usage.total == usage.prompt + usage.completion
    assert selected is model


@pytest.mark.asyncio
async def test_gateway_kills_hung_stream_with_stall_timeout(monkeypatch) -> None:
    """长时间没有新数据必须被终止，不能占用执行槽。"""

    import asyncio

    gateway = LlmGateway()
    model = ModelDefinition(
        id="test:kimi",
        provider="kimi",
        model="kimi-test",
        name="Kimi Test",
        description="测试模型",
        capabilities=("text", "stream"),
    )

    async def hung_stream(**_kwargs):
        """首块后不再返回任何数据。"""

        yield LlmChunk(text_delta="start")
        await asyncio.sleep(60)

    monkeypatch.setattr(gateway, "resolve_candidates", lambda *_a, **_k: (model,))
    monkeypatch.setattr(gateway, "_stream_model", hung_stream)
    monkeypatch.setattr(
        "backend.services.llm.gateway.AVAILABILITY.mark_failure",
        lambda *_args, **_kwargs: None,
    )

    with pytest.raises(ProviderRequestError, match="未返回数据"):
        await gateway.complete(
            preferred_model_id=model.id,
            credentials=LlmCredentials(values={}),
            messages=[LlmMessage("user", "测试")],
            stall_timeout_seconds=0.5,
        )


@pytest.mark.asyncio
async def test_gateway_allows_slow_but_streaming_response(monkeypatch) -> None:
    """持续输出数据的慢速生成不应被卡死检测误杀。"""

    import asyncio

    gateway = LlmGateway()
    model = ModelDefinition(
        id="test:kimi",
        provider="kimi",
        model="kimi-test",
        name="Kimi Test",
        description="测试模型",
        capabilities=("text", "stream"),
    )

    async def slow_stream(**_kwargs):
        """每个数据块之间间隔较长，但一直有进展。"""

        for index in range(5):
            yield LlmChunk(text_delta=f"part-{index}")
            await asyncio.sleep(0.05)

    monkeypatch.setattr(gateway, "resolve_candidates", lambda *_a, **_k: (model,))
    monkeypatch.setattr(gateway, "_stream_model", slow_stream)
    monkeypatch.setattr(
        "backend.services.llm.gateway.AVAILABILITY.mark_success",
        lambda *_args, **_kwargs: None,
    )

    text, _usage, selected = await gateway.complete(
        preferred_model_id=model.id,
        credentials=LlmCredentials(values={}),
        messages=[LlmMessage("user", "测试")],
        timeout_seconds=5,
        stall_timeout_seconds=1,
    )

    assert text == "part-0part-1part-2part-3part-4"
    assert selected is model
