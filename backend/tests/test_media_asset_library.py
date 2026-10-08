"""角色设定图库测试：哈希去重、命中复用不重复生成、删除清理。"""

from __future__ import annotations

import asyncio
import base64
import io
import os
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from backend.core.config import get_settings
from backend.services.llm.credentials import LlmCredentials
from backend.services.media import comic_pipeline
from backend.services.media.asset_library import (
    character_content_hash,
    character_library_dir,
    delete_character_sheet,
    find_character_sheet,
    list_character_sheets,
    read_asset_data_url,
    save_character_sheet,
)
from backend.services.workspace.database import initialize_database


@pytest.fixture()
def media_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """独立的 data 目录与已初始化数据库（含迁移 008）。"""

    data_dir = tmp_path / "media-data"
    monkeypatch.setenv("AGENT_DATA_DIR", str(data_dir))
    get_settings.cache_clear()
    asyncio.run(initialize_database())
    return data_dir


def _tiny_png() -> str:
    raw = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    return f"data:image/png;base64,{base64.b64encode(raw).decode('ascii')}"


def _save(appearance: str = "白发红瞳少女", model_id: str = "qwen:qwen-image-2.0-pro"):
    return asyncio.run(
        save_character_sheet(
            name="小夜",
            appearance=appearance,
            outfit="蓝色校服",
            model_id=model_id,
            provider="qwen",
            prompt="角色设定图，全身立绘",
            image_data_url=_tiny_png(),
        )
    )


def test_character_content_hash_varies_by_description_and_model() -> None:
    base = character_content_hash(appearance="白发红瞳少女", outfit="蓝色校服", model_id="qwen:a")
    same = character_content_hash(appearance=" 白发红瞳少女 ", outfit="蓝色校服", model_id="qwen:a")
    other_outfit = character_content_hash(
        appearance="白发红瞳少女", outfit="黑色校服", model_id="qwen:a"
    )
    other_model = character_content_hash(
        appearance="白发红瞳少女", outfit="蓝色校服", model_id="qwen:b"
    )
    assert base == same  # 空白差异不算新角色
    assert base != other_outfit
    assert base != other_model  # 换出图模型视为新图


def test_save_character_sheet_dedupes_by_hash(media_data_dir: Path) -> None:
    first, created_first = _save()
    second, created_second = _save()

    assert created_first is True
    assert created_second is False  # 同描述同模型：命中，不重复入库
    assert second["id"] == first["id"]
    assert len(asyncio.run(list_character_sheets())) == 1
    assert (character_library_dir() / first["filePath"]).is_file()


def test_save_character_sheet_persists_png(media_data_dir: Path) -> None:
    asset, _created = _save()
    data_url = read_asset_data_url(str(asset["filePath"]))
    assert data_url is not None
    assert data_url.startswith("data:image/png;base64,")


def test_find_character_sheet_hit_and_miss(media_data_dir: Path) -> None:
    _save()
    hit_hash = character_content_hash(
        appearance="白发红瞳少女", outfit="蓝色校服", model_id="qwen:qwen-image-2.0-pro"
    )
    hit = asyncio.run(
        find_character_sheet(content_hash=hit_hash, model_id="qwen:qwen-image-2.0-pro")
    )
    assert hit is not None
    miss = asyncio.run(
        find_character_sheet(
            content_hash=character_content_hash(
                appearance="别的角色", outfit="别的衣服", model_id="qwen:qwen-image-2.0-pro"
            ),
            model_id="qwen:qwen-image-2.0-pro",
        )
    )
    assert miss is None


def test_delete_character_sheet_removes_file_and_row(media_data_dir: Path) -> None:
    asset, _created = _save()
    file_path = character_library_dir() / asset["filePath"]
    assert file_path.is_file()

    deleted = asyncio.run(delete_character_sheet(str(asset["id"])))
    assert deleted is True
    assert not file_path.exists()
    assert asyncio.run(list_character_sheets()) == []

    assert asyncio.run(delete_character_sheet(str(asset["id"]))) is False


def test_find_ignores_stale_file(media_data_dir: Path) -> None:
    """文件被手动清理后视为未命中，库记录同步清掉。"""

    asset, _created = _save()
    (character_library_dir() / asset["filePath"]).unlink()
    hit = asyncio.run(
        find_character_sheet(
            content_hash=asset["contentHash"],
            model_id="qwen:qwen-image-2.0-pro",
        )
    )
    assert hit is None
    assert asyncio.run(list_character_sheets()) == []


def _pipeline_state(characters: list[dict[str, Any]]) -> dict[str, Any]:
    """writer 幂等跳过（带 storyboard），只驱动 character_design → END。"""

    return {
        "script": "一个测试剧本",
        "title": "测试",
        "characters": characters,
        "storyboard": [{"shot": 1, "description": "开场"}],
        "shots": [],
        "confirmed": False,  # 未确认 → after_design 走 END，不进分镜
        "output_dir": "",
        "merged_path": None,
        "report": {},
        "errors": [],
    }


def _run_design(
    characters: list[dict[str, Any]],
    image_model_id: str = "qwen:qwen-image-2.0-pro",
    events: list[str] | None = None,
) -> list[dict[str, Any]]:
    """跑管线到 character_design 节点（writer 幂等、confirmed=False 提前 END）。"""

    async def emit(event: str, payload: dict[str, Any]) -> None:
        if events is not None:
            events.append(str(payload.get("detail") or ""))

    graph = comic_pipeline.build_comic_pipeline(
        credentials=LlmCredentials(values={"qwen": "k"}),
        preferred_model_id="auto",
        emit=emit,
        image_model_id=image_model_id,
        video_model_id="qwen:wan2.7-i2v",
    )
    final: dict[str, Any] = {}
    for chunk in asyncio.run(_collect(graph, _pipeline_state(characters))):
        # stream_mode="updates" 每个 chunk 是 {node_name: update}，取节点内 update。
        for _node, update in chunk.items():
            if isinstance(update, dict) and "characters" in update:
                final["characters"] = update["characters"]
    return final.get("characters", [])


async def _collect(graph: Any, state: dict[str, Any]) -> list[dict[str, Any]]:
    updates: list[dict[str, Any]] = []
    async for chunk in graph.astream(state, stream_mode="updates"):
        updates.append(chunk)
    return updates


def test_character_design_uses_library_hit_without_generation(
    media_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """命中角色库：不再调用 generate_media，直接复用本地文件。"""

    asset, _created = _save()

    generate = AsyncMock(side_effect=AssertionError("命中角色库时不应调用 generate_media"))
    monkeypatch.setattr(comic_pipeline, "generate_media", generate)

    characters = _run_design([{"name": "小夜", "appearance": "白发红瞳少女", "outfit": "蓝色校服"}])
    generate.assert_not_awaited()
    assert characters, "character_design 应产出角色"
    image = characters[0]["image"]
    assert image["downloadName"] == f"角色设定-{asset['name']}.png"
    assert image["dataUrl"].startswith("data:image/png;base64,")


@pytest.mark.parametrize("data_key", ["dataUrl", "data_url"])
def test_character_design_miss_generates_and_saves(
    media_data_dir: Path, monkeypatch: pytest.MonkeyPatch, data_key: str
) -> None:
    """未命中：生成后自动入库，同描述第二次不再生成（跨集复用）。"""

    generated: list[str] = []

    async def _fake_generate(body, api_key, api_base=None) -> dict[str, Any]:
        generated.append(body.prompt)
        return {
            "attachments": [
                {
                    "name": "角色设定-小夜.png",
                    "downloadName": "角色设定-小夜.png",
                    "type": "image/png",
                    "assetKind": "image",
                    data_key: _tiny_png(),
                }
            ]
        }

    monkeypatch.setattr(comic_pipeline, "generate_media", _fake_generate)

    characters_first = _run_design(
        [{"name": "小夜", "appearance": "银发少年", "outfit": "黑色风衣"}]
    )
    assert len(generated) == 1
    assert characters_first[0]["image"][data_key].startswith("data:image/png;base64,")
    assets = asyncio.run(list_character_sheets())
    assert len(assets) == 1

    # 第二集：同描述角色，命中库不再生成。
    events: list[str] = []
    _run_design([{"name": "小夜", "appearance": "银发少年", "outfit": "黑色风衣"}], events=events)
    assert len(generated) == 1  # 未再生成
    assert any("命中角色库" in event for event in events)

    # 换模型或改描述均重新生成。
    _run_design(
        [{"name": "小夜", "appearance": "银发少年", "outfit": "黑色风衣"}],
        image_model_id="qwen:qwen-image-plus",
    )
    _run_design([{"name": "小夜", "appearance": "黑发少年", "outfit": "黑色风衣"}])
    assert len(generated) == 3
    assert len(asyncio.run(list_character_sheets())) == 3


def test_private_relative_png_and_invalid_data(media_data_dir: Path) -> None:
    asset, _ = _save()
    assert not Path(asset["filePath"]).is_absolute()
    path = character_library_dir() / asset["filePath"]
    assert path.parent == media_data_dir / "media-cache" / "library"
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValueError):
        asyncio.run(
            save_character_sheet(
                name="坏图",
                appearance="坏图",
                outfit="",
                model_id="qwen:a",
                provider="qwen",
                prompt="",
                image_data_url="%%%",
            )
        )
    assert len(list(character_library_dir().iterdir())) == 1
    assert len(asyncio.run(list_character_sheets())) == 1


def test_jpeg_is_saved_as_png(media_data_dir: Path) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (1, 1)).save(buffer, format="JPEG")
    asset, _ = asyncio.run(
        save_character_sheet(
            name="角色",
            appearance="JPEG",
            outfit="",
            model_id="qwen:a",
            provider="qwen",
            prompt="",
            image_base64=base64.b64encode(buffer.getvalue()).decode(),
        )
    )
    with Image.open(character_library_dir() / asset["filePath"]) as image:
        assert image.format == "PNG"


def test_concurrent_saves_leave_one_row_and_file(media_data_dir: Path) -> None:
    async def save_twice():
        kwargs = dict(
            name="角色",
            appearance="白发",
            outfit="蓝衣",
            model_id="qwen:a",
            provider="qwen",
            prompt="",
            image_data_url=_tiny_png(),
        )
        return await asyncio.gather(save_character_sheet(**kwargs), save_character_sheet(**kwargs))

    results = asyncio.run(save_twice())
    assert results[0][0]["id"] == results[1][0]["id"]
    assert sorted(result[1] for result in results) == [False, True]
    assert len(asyncio.run(list_character_sheets())) == 1
    assert len(list(character_library_dir().iterdir())) == 1


def test_library_api_preview_delete_and_validation(media_data_dir: Path) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.api.media import router

    asset, _ = _save()
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        response = client.get("/api/media/library")
        assert response.status_code == 200
        preview = response.json()["assets"][0]
        assert preview["dataUrl"].startswith("data:image/png;base64,")
        assert preview["modelId"] == asset["modelId"]
        assert preview["createdAt"]
        assert client.delete("/api/media/library/invalid").status_code == 400
        assert client.delete(f"/api/media/library/{asset['id']}").status_code == 200
        assert client.delete(f"/api/media/library/{asset['id']}").status_code == 404
        assert client.get("/api/media/library").json() == {"assets": []}
    assert not (character_library_dir() / asset["filePath"]).exists()


def test_read_rejects_paths_outside_library(media_data_dir: Path) -> None:
    outside = media_data_dir / "private.png"
    outside.write_bytes(b"private")
    for path in (str(outside), "../../private.png"):
        with pytest.raises(ValueError):
            read_asset_data_url(path)


def test_delete_failure_preserves_record(media_data_dir: Path, monkeypatch) -> None:
    asset, _ = _save()

    def fail_unlink(*args, **kwargs):
        raise PermissionError("locked")

    monkeypatch.setattr(Path, "unlink", fail_unlink)
    with pytest.raises(PermissionError):
        asyncio.run(delete_character_sheet(asset["id"]))
    assert len(asyncio.run(list_character_sheets())) == 1


def test_insert_failure_cleans_file(media_data_dir: Path) -> None:
    from backend.services.workspace.database import open_database

    async def reject_inserts():
        async with open_database() as connection:
            await connection.execute(
                "CREATE TRIGGER reject_asset BEFORE INSERT ON media_assets "
                "BEGIN SELECT RAISE(ABORT, 'test insert failure'); END"
            )

    asyncio.run(reject_inserts())
    with pytest.raises(Exception, match="test insert failure"):
        _save()
    assert list(character_library_dir().iterdir()) == []
    assert asyncio.run(list_character_sheets()) == []


def test_design_generation_failure_degrades_without_reference(
    media_data_dir: Path, monkeypatch
) -> None:
    generate = AsyncMock(side_effect=ValueError("provider unavailable"))
    monkeypatch.setattr(comic_pipeline, "generate_media", generate)
    monkeypatch.setattr(comic_pipeline.asyncio, "sleep", AsyncMock())
    characters = _run_design([{"name": "角色", "appearance": "白发", "outfit": "蓝衣"}])
    assert characters[0]["image"] is None
    assert generate.await_count == 2
    assert asyncio.run(list_character_sheets()) == []
