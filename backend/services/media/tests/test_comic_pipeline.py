"""漫剧 LangGraph 管线测试。"""

import json
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage
from backend.services.media.comic_pipeline import (
    _extract_storyboard,
    build_comic_pipeline,
)


@pytest.mark.asyncio
async def test_extract_storyboard_parses_json() -> None:
    text = """```json
{"title":"机械猫","shots":[{"title":"开场","image_prompt":"废墟少年与机械猫","video_prompt":"镜头缓缓推进","negative_prompt":"模糊"}]}
```"""
    title, shots = await _extract_storyboard(text)
    assert title == "机械猫"
    assert len(shots) == 1
    assert shots[0]["index"] == 1
    assert shots[0]["image_prompt"] == "废墟少年与机械猫"


@pytest.mark.asyncio
async def test_storyboard_phase_stops_before_generation(monkeypatch) -> None:
    """未确认时，管线只产出分镜表，不进入并行生成。"""

    emitted: list[dict[str, object]] = []

    async def fake_complete(**_kwargs):
        return (
            json.dumps(
                {
                    "title": "机械猫",
                    "shots": [
                        {
                            "title": "开场",
                            "image_prompt": "废墟少年与机械猫",
                            "video_prompt": "镜头推进",
                            "negative_prompt": "模糊",
                        },
                        {
                            "title": "相遇",
                            "image_prompt": "机械猫开口说话",
                            "video_prompt": "特写",
                            "negative_prompt": "模糊",
                        },
                    ],
                }
            ),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Writer Model"),
        )

    async def emit(kind: str, payload: dict[str, object]) -> None:
        emitted.append({"kind": kind, "detail": payload.get("detail")})

    monkeypatch.setattr(
        "backend.services.media.comic_pipeline.GATEWAY.complete",
        fake_complete,
    )
    graph = build_comic_pipeline(
        credentials=LlmCredentials(values={}),
        preferred_model_id="auto",
        emit=emit,
    )
    state = await graph.ainvoke(
        {
            "script": "少年在废墟捡到机械猫",
            "title": "",
            "storyboard": [],
            "shots": [],
            "confirmed": False,
            "output_dir": "",
            "merged_path": None,
            "report": {},
            "errors": [],
        }
    )
    assert len(state["storyboard"]) == 2
    assert state["shots"] == []
    assert any("分镜表" in str(item.get("detail")) for item in emitted)


@pytest.mark.asyncio
async def test_confirmed_pipeline_generates_images_videos_and_merges(
    monkeypatch, tmp_path
) -> None:
    """确认后：并行出图 → 图生视频 → 合并 → 质检通过。"""

    from backend.services.media import comic_pipeline as pipeline

    class FakeResponse:
        content = b"fake-video-bytes"

        def raise_for_status(self) -> None:
            pass

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, _url):
            return FakeResponse()

    async def fake_generate_media(body, _api_key, _api_base):
        if body.mode == "text-to-image":
            return {
                "attachments": [
                    {
                        "name": "img.png",
                        "dataUrl": "data:image/png;base64,AAAA",
                        "assetKind": "image",
                    }
                ]
            }
        return {
            "attachments": [
                {
                    "name": "vid.mp4",
                    "url": "http://example.com/v.mp4",
                    "assetKind": "video",
                }
            ]
        }

    async def fake_merge(videos, output, **_kwargs):
        Path(output).write_bytes(b"merged")
        return {"outputPath": output, "videoCount": len(videos)}

    async def _noop_throttle() -> None:
        return None

    monkeypatch.setattr(pipeline, "generate_media", fake_generate_media)
    monkeypatch.setattr(pipeline, "merge_videos", fake_merge)
    monkeypatch.setattr(
        pipeline,
        "throttle_media_request",
        _noop_throttle,
    )
    monkeypatch.setattr(
        pipeline,
        "httpx",
        types.SimpleNamespace(
            AsyncClient=lambda **_kwargs: FakeClient(),
            Timeout=lambda *_args, **_kwargs: None,
        ),
    )

    emitted: list[dict[str, object]] = []

    async def emit(kind: str, payload: dict[str, object]) -> None:
        emitted.append({"kind": kind, "detail": payload.get("detail")})

    graph = build_comic_pipeline(
        credentials=LlmCredentials(values={"qwen": "fake-key"}),
        preferred_model_id="auto",
        emit=emit,
    )
    state = await graph.ainvoke(
        {
            "script": "少年与机械猫",
            "title": "",
            "storyboard": [
                {
                    "index": 1,
                    "title": "开场",
                    "image_prompt": "废墟少年",
                    "video_prompt": "镜头推进",
                    "negative_prompt": "模糊",
                }
            ],
            "shots": [],
            "confirmed": True,
            "output_dir": str(tmp_path),
            "merged_path": None,
            "report": {},
            "errors": [],
        }
    )
    assert state["report"]["passed"] is True, json.dumps(
        {
            "report": state.get("report"),
            "shots": state.get("shots"),
            "merged": state.get("merged_path"),
        },
        ensure_ascii=False,
        default=str,
    )
    assert state["report"]["shotTotal"] == 1
    assert (tmp_path / "episode.mp4").is_file()
    assert any("合并" in str(item.get("detail")) for item in emitted)
