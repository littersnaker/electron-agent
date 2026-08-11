"""火山引擎（豆包）媒体生成客户端测试。"""

from __future__ import annotations

import pytest

import backend.services.media.volcengine as volcengine
from backend.schemas.media import MediaGenerateBody


class _FakeResponse:
    """模拟 httpx.Response。"""

    def __init__(self, payload, content: bytes = b"", status_code: int = 200) -> None:
        self._payload = payload
        self._content = content
        self.status_code = status_code
        self.headers = {
            "content-type": (
                "video/mp4"
                if self._payload.get("content") or self._payload.get("data")
                else "image/png"
            )
        }

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload

    @property
    def content(self) -> bytes:
        return self._content

    @property
    def text(self) -> str:
        return str(self._payload)


class _FakeClient:
    """模拟 httpx.AsyncClient 的异步上下文。"""

    def __init__(self, handler) -> None:
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> bool:
        return False

    async def post(self, url, **kwargs):
        return self._handler("post", url, kwargs)

    async def get(self, url, **kwargs):
        return self._handler("get", url, kwargs)


def _patch_client(monkeypatch, handler) -> None:
    monkeypatch.setattr(
        volcengine.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(handler),
    )


def test_resolve_volcengine_base_default() -> None:
    """未配置 Base URL 时应使用方舟公网默认地址。"""

    assert volcengine.resolve_volcengine_base(None) == volcengine.DEFAULT_BASE_URL
    assert (
        volcengine.resolve_volcengine_base("https://custom.example/api/v3/")
        == "https://custom.example/api/v3"
    )


@pytest.mark.asyncio
async def test_volcengine_image_downloads_attachment(monkeypatch) -> None:
    """方舟文生图应下载返回图片并转成 Data URL 附件。"""

    def handler(method, _url, _kwargs):
        if method == "post":
            return _FakeResponse({"data": [{"url": "https://img.example/1.png"}]})
        return _FakeResponse({}, content=b"PNG-DATA")

    _patch_client(monkeypatch, handler)
    body = MediaGenerateBody(
        model_id="doubao:doubao-seedream-3-0-t2i",
        mode="text-to-image",
        prompt="一只机械猫",
        size="1024*1024",
    )

    result = await volcengine.generate_volcengine_image(body, "key", None)

    assert result["attachments"]
    attachment = result["attachments"][0]
    assert attachment["assetKind"] == "image"
    assert attachment["dataUrl"].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_volcengine_image_accepts_base64_response(monkeypatch) -> None:
    """方舟返回 b64_json 时也应生成可展示的 Data URL。"""

    def handler(_method, _url, _kwargs):
        return _FakeResponse({"data": [{"b64_json": "QUJD"} for _ in range(1)]})

    _patch_client(monkeypatch, handler)
    body = MediaGenerateBody(
        model_id="doubao:doubao-seedream-3-0-t2i",
        mode="text-to-image",
        prompt="一只猫",
    )

    result = await volcengine.generate_volcengine_image(body, "key", None)

    assert result["attachments"][0]["dataUrl"].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_volcengine_video_polls_until_success(monkeypatch) -> None:
    """方舟文生视频应轮询任务直到成功并下载成片。"""

    monkeypatch.setattr(volcengine, "VIDEO_POLL_INTERVAL_SECONDS", 0.01)

    def handler(method, _url, _kwargs):
        if method == "post":
            return _FakeResponse({"id": "task-1"})
        return _FakeResponse(
            {"status": "success", "content": {"video_url": "https://v.example/1.mp4"}}
        )

    _patch_client(monkeypatch, handler)
    body = MediaGenerateBody(
        model_id="doubao:doubao-seedance-1-0-t2v",
        mode="text-to-video",
        prompt="一只机械猫走过废墟",
    )

    result = await volcengine.generate_volcengine_video(body, "key", None)

    assert result["attachments"]
    assert result["attachments"][0]["assetKind"] == "video"


@pytest.mark.asyncio
async def test_volcengine_video_raises_on_failed_task(monkeypatch) -> None:
    """任务失败时应抛出明确错误而不是无限轮询。"""

    monkeypatch.setattr(volcengine, "VIDEO_POLL_INTERVAL_SECONDS", 0.01)

    def handler(method, _url, _kwargs):
        if method == "post":
            return _FakeResponse({"id": "task-1"})
        return _FakeResponse({"status": "failed", "error": "quota exhausted"})

    _patch_client(monkeypatch, handler)
    body = MediaGenerateBody(
        model_id="doubao:doubao-seedance-1-0-t2v",
        mode="text-to-video",
        prompt="测试",
    )

    with pytest.raises(ValueError, match="视频生成失败"):
        await volcengine.generate_volcengine_video(body, "key", None)
