"""角色设定图库测试：哈希去重、命中复用不重复生成、删除清理。"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any

import pytest

from backend.core.config import get_settings
from backend.services.llm.credentials import LlmCredentials
from backend.services.media import comic_pipeline
from backend.services.media.asset_library import (
    character_content_hash,
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
    base = character_content_hash(
        appearance="白发红瞳少女", outfit="蓝色校服", model_id="qwen:a"
    )
    same = character_content_hash(
        appearance=" 白发红瞳少女 ", outfit="蓝色校服", model_id="qwen:a"
    )
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
    assert Path(first["filePath"]).is_file()


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
        find_character_sheet(
            content_hash=hit_hash, model_id="qwen:qwen-image-2.0-pro"
        )
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
    file_path = Path(asset["filePath"])
    assert file_path.is_file()

    deleted = asyncio.run(delete_character_sheet(str(asset["id"])))
    assert deleted is True
    assert not file_path.exists()
    assert asyncio.run(list_character_sheets()) == []

    assert asyncio.run(delete_character_sheet(str(asset["id"]))) is False


def test_find_ignores_stale_file(media_data_dir: Path) -> None:
    """文件被手动清理后视为未命中，库记录同步清掉。"""

    asset, _created = _save()
    Path(asset["filePath"]).unlink()
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


async def _emit_noop(event: str, payload: dict[str, Any]) -> None:
    return None


def _run_design(
    characters: list[dict[str, Any]],
    image_model_id: str = "qwen:qwen-image-2.0-pro",
) -> list[dict[str, Any]]:
    """跑管线到 character_design 节点（writer 幂等、confirmed=False 提前 END）。"""

    graph = comic_pipeline.build_comic_pipeline(
        credentials=LlmCredentials(values={"qwen": "k"}),
        preferred_model_id="auto",
        emit=_emit_noop,
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

    async def _fail_generate(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise AssertionError("命中角色库时不应调用 generate_media")

    monkeypatch.setattr(comic_pipeline, "generate_media", _fail_generate)

    characters = _run_design(
        [{"name": "小夜", "appearance": "白发红瞳少女", "outfit": "蓝色校服"}]
    )
    assert characters, "character_design 应产出角色"
    image = characters[0]["image"]
    assert image["downloadName"] == f"角色设定-{asset['name']}.png"
    assert image["data_url"].startswith("data:image/png;base64,")


def test_character_design_miss_generates_and_saves(
    media_data_dir: Path, monkeypatch: pytest.MonkeyPatch
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
                    "data_url": _tiny_png(),
                }
            ]
        }

    monkeypatch.setattr(comic_pipeline, "generate_media", _fake_generate)

    characters_first = _run_design(
        [{"name": "小夜", "appearance": "银发少年", "outfit": "黑色风衣"}]
    )
    assert len(generated) == 1
    assert characters_first[0]["image"]["data_url"].startswith("data:image/png;base64,")
    assets = asyncio.run(list_character_sheets())
    assert len(assets) == 1

    # 第二集：同描述角色，命中库不再生成。
    _run_design([{"name": "小夜", "appearance": "银发少年", "outfit": "黑色风衣"}])
    assert len(generated) == 1  # 未再生成
