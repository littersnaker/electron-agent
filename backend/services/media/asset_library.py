"""角色设定图库：按描述哈希去重入库，跨会话/跨集复用设定图。

漫剧管线每次生成都会重新抽角色卡、重新生成设定图，导致连续剧第二集角色
和第一集长得不一样（一致性断裂），且同角色反复烧图片额度。本模块把设定图
按 ``sha256(appearance + outfit + model_id)`` 去重落盘入库：同描述同模型 =
同一张图，命中直接复用本地文件，一次生成边际成本归零。换出图模型视为
新图（不同模型出图风格不同，混用反而伤一致性）。

文件落 ``data_dir/media-cache/character-library/{asset_id}.png``（本地单用户，
不跨项目隔离）；库全局共享，用户可在角色库 UI 删除。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import uuid
from pathlib import Path
from typing import Any

from backend.core.config import get_settings
from backend.services.workspace.database import open_database, utc_now_iso

KIND_CHARACTER_SHEET = "character_sheet"
_LIBRARY_SUBDIR = "character-library"


def character_content_hash(
    *, appearance: str, outfit: str, model_id: str
) -> str:
    """计算角色设定图的内容哈希（去重键）。

    描述文本统一小写、去除首尾空白后拼接（\x00 分隔防串接歧义）；
    模型 ID 参与哈希——换出图模型视为新图。
    """

    material = "\x00".join(
        part.strip().lower() for part in ((appearance or ""), (outfit or ""), (model_id or ""))
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def character_library_dir() -> Path:
    """角色库文件目录（media-cache/character-library）。"""

    directory = get_settings().media_cache_dir / _LIBRARY_SUBDIR
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _row_to_asset(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "filePath": row["file_path"],
        "contentHash": row["content_hash"],
        "prompt": row["prompt"],
        "modelId": row["model_id"],
        "provider": row["provider"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


async def find_character_sheet(
    *, content_hash: str, model_id: str
) -> dict[str, Any] | None:
    """按内容哈希查库，命中返回资产记录（含文件路径），未命中返回 None。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM media_assets WHERE kind = ? AND content_hash = ? LIMIT 1",
            (KIND_CHARACTER_SHEET, content_hash),
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    asset = _row_to_asset(row)
    # 文件被手动清理时视为未命中，让管线重新生成并补回。
    if not Path(asset["filePath"]).is_file():
        await delete_character_sheet(str(asset["id"]))
        return None
    return asset


async def save_character_sheet(
    *,
    name: str,
    appearance: str,
    outfit: str,
    model_id: str,
    provider: str,
    prompt: str,
    image_data_url: str,
) -> tuple[dict[str, Any], bool]:
    """保存角色设定图：哈希命中直接返回已有记录，未命中落盘入库。

    ``image_data_url`` 是 generate_media 产出的 Data URL。返回 ``(资产, 是否新建)``。
    """

    content_hash = character_content_hash(
        appearance=appearance, outfit=outfit, model_id=model_id
    )
    existing = await find_character_sheet(content_hash=content_hash, model_id=model_id)
    if existing is not None:
        return existing, False

    raw = _decode_data_url(image_data_url)
    if not raw:
        raise ValueError("角色设定图数据无效（无法解码 Base64）。")

    asset_id = f"asset_{uuid.uuid4().hex}"
    directory = character_library_dir()
    target = directory / f"{asset_id}.png"
    target.write_bytes(raw)

    now = utc_now_iso()
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO media_assets (id, kind, name, file_path, content_hash, "
            "prompt, model_id, provider, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                asset_id,
                KIND_CHARACTER_SHEET,
                (name or "").strip()[:120] or "未命名角色",
                str(target),
                content_hash,
                prompt[:2000],
                model_id,
                provider,
                now,
                now,
            ),
        )
    asset = {
        "id": asset_id,
        "kind": KIND_CHARACTER_SHEET,
        "name": (name or "").strip()[:120] or "未命名角色",
        "filePath": str(target),
        "contentHash": content_hash,
        "prompt": prompt[:2000],
        "modelId": model_id,
        "provider": provider,
        "createdAt": now,
        "updatedAt": now,
    }
    return asset, True


async def list_character_sheets() -> list[dict[str, Any]]:
    """返回全部角色设定图资产（按创建时间倒序）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM media_assets WHERE kind = ? ORDER BY created_at DESC",
            (KIND_CHARACTER_SHEET,),
        )
        rows = await cursor.fetchall()
    return [_row_to_asset(row) for row in rows]


async def delete_character_sheet(asset_id: str) -> bool:
    """删除角色设定图（文件 + 行）；返回是否确实删除了记录。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT file_path FROM media_assets WHERE id = ? AND kind = ?",
            (asset_id, KIND_CHARACTER_SHEET),
        )
        row = await cursor.fetchone()
        if row is None:
            return False
        await connection.execute(
            "DELETE FROM media_assets WHERE id = ? AND kind = ?",
            (asset_id, KIND_CHARACTER_SHEET),
        )
    file_path = Path(row["file_path"])
    if file_path.is_file() and file_path.parent == character_library_dir():
        file_path.unlink(missing_ok=True)
    return True


def read_asset_data_url(file_path: str) -> str | None:
    """把库内文件读回 Data URL（管线复用与列表预览共用）。"""

    path = Path(file_path)
    if not path.is_file():
        return None
    raw = path.read_bytes()
    suffix = path.suffix.lower().lstrip(".")
    mime = "image/png" if suffix == "png" else f"image/{suffix or 'png'}"
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _decode_data_url(data_url: str) -> bytes:
    stripped = (data_url or "").strip()
    if stripped.startswith("data:"):
        _, _, payload = stripped.partition(",")
        stripped = payload.strip() if payload else ""
    try:
        return base64.b64decode("".join(stripped.split()), validate=False)
    except (ValueError, binascii.Error):
        return b""


def is_safe_asset_id(value: str) -> bool:
    """校验资产 ID 白名单（防路径穿越）。"""

    return bool(re.match(r"^asset_[A-Za-z0-9]{1,80}$", value))


__all__ = [
    "KIND_CHARACTER_SHEET",
    "character_content_hash",
    "character_library_dir",
    "delete_character_sheet",
    "find_character_sheet",
    "is_safe_asset_id",
    "list_character_sheets",
    "read_asset_data_url",
    "save_character_sheet",
]
