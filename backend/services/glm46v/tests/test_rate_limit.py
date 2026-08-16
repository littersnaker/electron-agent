"""GLM-4.6V 共享层全局限流测试：节拍器、429 长退避、并发信号量。"""

from __future__ import annotations

import asyncio
import base64

import httpx
import pytest

from backend.services.glm46v import rate_limit
from backend.services.glm46v.client import (
    GLM46VClient,
    GLM46VError,
    GLM46VSettings,
    normalize_image_data,
)

_MOCK_RESPONSE = {
    "id": "req_t",
    "model": "glm-4.6v-flash",
    "choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}],
    "usage": {"total_tokens": 5},
}


def tiny_png_base64() -> str:
    return base64.b64encode(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    ).decode("ascii")


def _image():
    return normalize_image_data(
        name="shelf.png",
        mime_type="image/png",
        data=tiny_png_base64(),
        max_image_mb=1,
    )


def _client(handler, *, retries: int = 0) -> GLM46VClient:
    settings = GLM46VSettings(
        api_key="secret",
        endpoint="https://example.test/chat/completions",
        retries=retries,
    )
    return GLM46VClient(settings, transport=httpx.MockTransport(handler))


async def _analyze(client: GLM46VClient) -> dict[str, object]:
    return await client.analyze_images([_image()], prompt="分析货架")


class _FakeAsyncio:
    """只记录 sleep 调用的 asyncio 替身，供特定模块 patch 使用。"""

    def __init__(self, sleeps: list[float]) -> None:
        self.sleeps = sleeps

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)


@pytest.mark.asyncio
async def test_back_to_back_requests_waits_min_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    """两次紧邻请求应被节拍器强制间隔最小时长。"""

    sleeps: list[float] = []
    monkeypatch.setattr(rate_limit, "asyncio", _FakeAsyncio(sleeps))
    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.05)
    monkeypatch.setattr(rate_limit, "MAX_CONCURRENCY", 8)
    monkeypatch.setattr(rate_limit, "_concurrency_semaphore", asyncio.Semaphore(8))

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_MOCK_RESPONSE)

    client = _client(handler)
    await _analyze(client)  # 首次：无历史打点，不等待
    sleeps.clear()
    await _analyze(client)  # 第二次：应等待约 0.05s

    assert sleeps, "第二次请求应等待最小间隔"
    assert any(delay >= 0.04 for delay in sleeps)


@pytest.mark.asyncio
async def test_zero_interval_does_not_block(monkeypatch: pytest.MonkeyPatch) -> None:
    """GLM46V_MIN_INTERVAL_SECONDS=0 时应完全跳过等待。"""

    sleeps: list[float] = []
    monkeypatch.setattr(rate_limit, "asyncio", _FakeAsyncio(sleeps))
    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(rate_limit, "MAX_CONCURRENCY", 8)
    monkeypatch.setattr(rate_limit, "_concurrency_semaphore", asyncio.Semaphore(8))

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_MOCK_RESPONSE)

    client = _client(handler)
    await _analyze(client)
    await _analyze(client)
    assert sleeps == []


@pytest.mark.asyncio
async def test_429_uses_longer_exponential_backoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """429 限流应使用独立的、更长的指数退避（15s、30s…），等待免费档额度恢复。"""

    from backend.services.glm46v import client as client_module

    calls = {"count": 0}
    sleeps: list[float] = []
    monkeypatch.setattr(client_module, "asyncio", _FakeAsyncio(sleeps))
    # 关闭全局节拍器，只观察 429 退避本身。
    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.0)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(429, json={"error": {"message": "访问量过大"}})

    client = _client(handler, retries=0)
    with pytest.raises(GLM46VError, match="429"):
        await client.analyze_images([_image()], prompt="分析")

    # 默认 429 重试预算 3 次（retries_429=3），不消耗常规 retries。
    assert calls["count"] == 4
    assert sleeps == [15.0, 30.0, 60.0]


@pytest.mark.asyncio
async def test_429_budget_is_separate_from_regular_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """429 有自己的重试预算；用尽 429 预算后不再消耗常规 retries。"""

    from backend.services.glm46v import client as client_module

    calls = {"count": 0}
    sleeps: list[float] = []
    monkeypatch.setattr(client_module, "asyncio", _FakeAsyncio(sleeps))
    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.0)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    settings = GLM46VSettings(
        api_key="secret",
        endpoint="https://example.test/chat/completions",
        retries=0,
        retries_429=1,
    )
    client = GLM46VClient(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(GLM46VError, match="429"):
        await client.analyze_images([_image()], prompt="分析")

    assert calls["count"] == 2  # 原始请求 + 1 次 429 重试（retries=0 不参与）
    assert sleeps == [15.0]


@pytest.mark.asyncio
async def test_429_respects_retry_after_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """429 响应带 retry-after 头时优先使用服务端指定的等待时长。"""

    from backend.services.glm46v import client as client_module

    calls = {"count": 0}
    sleeps: list[float] = []
    monkeypatch.setattr(client_module, "asyncio", _FakeAsyncio(sleeps))
    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.0)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(
            429,
            headers={"retry-after": "2.0"},
            json={"error": {"message": "rate limited"}},
        )

    settings = GLM46VSettings(
        api_key="secret",
        endpoint="https://example.test/chat/completions",
        retries=0,
        retries_429=1,
    )
    client = GLM46VClient(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(GLM46VError, match="429"):
        await client.analyze_images([_image()], prompt="分析")

    assert sleeps == [2.0]


@pytest.mark.asyncio
async def test_concurrent_requests_capped_by_semaphore(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """并发请求数应被全局信号量限制，防止多消费方叠加突破速率窗口。"""

    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(rate_limit, "MAX_CONCURRENCY", 2)
    monkeypatch.setattr(rate_limit, "_concurrency_semaphore", asyncio.Semaphore(2))

    active = 0
    max_active = 0
    release = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.wait_for(release.wait(), timeout=3.0)
        active -= 1
        return httpx.Response(200, json=_MOCK_RESPONSE)

    client = _client(handler)
    tasks = [asyncio.create_task(_analyze(client)) for _ in range(4)]
    await asyncio.sleep(0.1)  # 让信号量饱和后断言在途并发数
    assert max_active == 2
    release.set()
    results = await asyncio.gather(*tasks)
    assert len(results) == 4
    assert max_active <= 2


@pytest.mark.asyncio
async def test_analyze_images_still_works_with_throttling_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """开启节流后正常请求不受影响（回到默认间隔，单次调用无等待）。"""

    sleeps: list[float] = []
    monkeypatch.setattr(rate_limit, "asyncio", _FakeAsyncio(sleeps))
    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.5)
    monkeypatch.setattr(rate_limit, "MAX_CONCURRENCY", 2)
    monkeypatch.setattr(rate_limit, "_concurrency_semaphore", asyncio.Semaphore(2))
    monkeypatch.setattr(rate_limit, "_last_request_at", 0.0)  # 清除前序测试打点

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_MOCK_RESPONSE)

    client = _client(handler)
    result = await client.analyze_images([_image()], prompt="分析")
    assert result["content"] == "OK"
    assert sleeps == []  # 首次调用无历史，不等待
