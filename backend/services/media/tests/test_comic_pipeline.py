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
    title, characters, shots = await _extract_storyboard(text)
    assert title == "机械猫"
    assert len(shots) == 1
    assert shots[0]["index"] == 1
    assert shots[0]["image_prompt"] == "废墟少年与机械猫"
    # 新字段缺省回退：景别默认中景、时长钳制到 5 秒、台词/角色为空。
    assert shots[0]["shot_type"] == "中景"
    assert shots[0]["duration"] == 5
    assert shots[0]["dialogue"] == ""
    assert shots[0]["characters"] == []
    assert characters == []


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
async def test_confirmed_pipeline_generates_images_videos_and_merges(monkeypatch, tmp_path) -> None:
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


@pytest.mark.asyncio
async def test_extract_storyboard_rich_fields_and_clamps() -> None:
    """新字段全量解析：角色卡、景别、台词、时长钳制到 2-10 秒。"""

    text = """{"title":"试镜","characters":[
        {"name":"小满","appearance":"短发黑发少女","outfit":"蓝色校服"},
        {"bad": true},
        {"name":""}],
      "shots":[
        {"title":"开场","shot_type":"远景","image_prompt":"校园全景","video_prompt":"镜头横移","dialogue":"小满:今天也是新学期","duration":99,"characters":["小满"]},
        {"title":"特写","shot_type":"特写","image_prompt":"小满回头","video_prompt":"回眸","duration":1}]}"""
    title, characters, shots = await _extract_storyboard(text)
    assert title == "试镜"
    assert [item["name"] for item in characters] == ["小满"]
    assert characters[0]["appearance"] == "短发黑发少女"
    assert shots[0]["duration"] == 10  # 钳制上限
    assert shots[0]["dialogue"].startswith("小满:")
    assert shots[0]["characters"] == ["小满"]
    assert shots[1]["duration"] == 2  # 钳制下限
    assert shots[1]["characters"] == []


def test_build_srt_timing_and_skip_empty() -> None:
    """SRT 按时长累计时间轴；无台词分镜只占位不出字幕。"""

    from backend.services.media.audio import build_srt

    shots = [
        {"index": 1, "dialogue": "", "duration": 3},
        {"index": 2, "dialogue": "小满:你好", "duration": 4},
    ]
    srt = build_srt(shots)
    assert "00:00:03,000 --> 00:00:07,000" in srt
    assert "小满:你好" in srt
    assert "1\n" not in srt.split("00:00:03")[0].splitlines()[0]


@pytest.mark.asyncio
async def test_synthesize_dialogue_degrades_on_error(monkeypatch, tmp_path) -> None:
    """TTS 接口失败时返回 None（调用方降级为无声），不抛异常。"""

    from backend.services.media.audio import synthesize_dialogue

    class _FailingClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            return None

        async def __aenter__(self) -> "_FailingClient":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, *args: object, **kwargs: object):
            import httpx as httpx_module

            raise httpx_module.ConnectError("network down")

    monkeypatch.setattr("backend.services.media.audio.httpx.AsyncClient", _FailingClient)
    result = await synthesize_dialogue("小满:你好", "key", tmp_path / "a.wav")
    assert result is None


def test_normalize_characters_skips_invalid() -> None:
    """角色卡规范化：跳过无名/非法项，上限 4 个。"""

    from backend.services.media.comic_pipeline import _normalize_characters

    raw = [
        {"name": "甲", "appearance": "a", "outfit": "o"},
        {"name": ""},
        "not-a-dict",
        {"name": "乙"},
        {"name": "丙"},
        {"name": "丁"},
        {"name": "戊"},
    ]
    characters = _normalize_characters(raw)
    assert [item["name"] for item in characters] == ["甲", "乙", "丙", "丁"]
