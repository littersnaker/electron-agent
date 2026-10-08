"""角色设定图库：按描述哈希去重入库，跨会话/跨集复用设定图。

漫剧管线每次生成都会重新抽角色卡、重新生成设定图，导致连续剧第二集角色
和第一集长得不一样（一致性断裂），且同角色反复烧图片额度。本模块把设定图
按 ``sha256(appearance + outfit + model_id)`` 去重落盘入库：同描述同模型 =
同一张图，命中直接复用本地文件，一次生成边际成本归零。换出图模型视为
新图（不同模型出图风格不同，混用反而伤一致性）。

文件落 ``data_dir/media-cache/library/{asset_id}.png``（本地单用户，
不跨项目隔离）；库全局共享，用户可在角色库 UI 删除。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import os
import re
import uuid
from pathlib import Path
from typing import Any

from PIL import Image

from backend.core.config import get_settings
from backend.services.workspace.database import open_database, utc_now_iso

KIND_CHARACTER_SHEET = "character_sheet"
_LIBRARY_SUBDIR = "library"


def character_content_hash(*, appearance: str, outfit: str, model_id: str) -> str:
    """计算角色设定图的内容哈希（去重键）。

    描述文本统一小写、去除首尾空白后拼接（\x00 分隔防串接歧义）；
    模型 ID 参与哈希——换出图模型视为新图。
    """

    material = "\x00".join(
        (
            (appearance or "").strip().lower(),
            (outfit or "").strip().lower(),
            (model_id or "").strip(),
        )
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def character_library_dir() -> Path:
    """角色库文件目录（media-cache/library）。"""

    directory = get_settings().media_cache_dir / _LIBRARY_SUBDIR
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _asset_path(file_path: str) -> Path:
    """相对路径以库目录为根；兼容旧库绝对路径，但拒绝越界与符号链接。"""

    path = Path(file_path)
    if not path.is_absolute():
        path = character_library_dir() / path
    allowed = {
        character_library_dir().resolve(),
        (get_settings().media_cache_dir / "character-library").resolve(),
    }
    if path.is_symlink() or path.resolve().parent not in allowed:
        raise ValueError("角色设定图路径超出角色库。")
    return path


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


async def find_character_sheet(*, content_hash: str, model_id: str) -> dict[str, Any] | None:
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
    if not _asset_path(asset["filePath"]).is_file():
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
    prompt: str = "",
    image_data_url: str = "",
    image_base64: str = "",
) -> tuple[dict[str, Any], bool]:
    """保存角色设定图：哈希命中直接返回已有记录，未命中落盘入库。

    支持 generate_media 产出的 ``image_data_url`` 或裸 ``image_base64``。
    返回 ``(资产, 是否新建)``。
    """

    content_hash = character_content_hash(appearance=appearance, outfit=outfit, model_id=model_id)
    target: Path | None = None
    try:
        async with open_database() as connection:
            # SQLite 写事务串行化查重与落盘，复用现有连接锁，不另建锁系统。
            await connection.execute("BEGIN IMMEDIATE")
            existing = await find_character_sheet(content_hash=content_hash, model_id=model_id)
            if existing is not None:
                return existing, False

            raw = _decode_data_url(image_data_url or image_base64)
            if not raw:
                raise ValueError("角色设定图数据无效（无法解码 Base64）。")
            # 服务可能返回 JPEG/WebP；统一编码 PNG，文件扩展名与预览 MIME 一致。
            buffer = io.BytesIO()
            with Image.open(io.BytesIO(raw)) as image:
                image.convert("RGBA").save(buffer, format="PNG")
            asset_id = f"asset_{uuid.uuid4().hex}"
            target = character_library_dir() / f"{asset_id}.png"
            with os.fdopen(
                os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
            ) as handle:
                handle.write(buffer.getvalue())

            now = utc_now_iso()
            await connection.execute(
                "INSERT INTO media_assets (id, kind, name, file_path, content_hash, "
                "prompt, model_id, provider, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    asset_id,
                    KIND_CHARACTER_SHEET,
                    (name or "").strip()[:120] or "未命名角色",
                    target.name,
                    content_hash,
                    prompt[:2000],
                    model_id,
                    provider,
                    now,
                    now,
                ),
            )
            cursor = await connection.execute(
                "SELECT * FROM media_assets WHERE id = ?", (asset_id,)
            )
            asset = _row_to_asset(await cursor.fetchone())
    except BaseException:
        if target is not None:
            target.unlink(missing_ok=True)
        raise
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
        _asset_path(row["file_path"]).unlink(missing_ok=True)
        await connection.execute(
            "DELETE FROM media_assets WHERE id = ? AND kind = ?",
            (asset_id, KIND_CHARACTER_SHEET),
        )
    return True


def read_asset_data_url(file_path: str) -> str | None:
    """把库内文件读回 Data URL（管线复用与列表预览共用）。"""

    path = _asset_path(file_path)
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    suffix = path.suffix.lower().lstrip(".")
    mime = "image/png" if suffix == "png" else f"image/{suffix or 'png'}"
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _decode_data_url(data_url: str) -> bytes:
    stripped = (data_url or "").strip()
    if stripped.startswith("data:"):
        _, _, payload = stripped.partition(",")
        stripped = payload.strip() if payload else ""
    try:
        return base64.b64decode("".join(stripped.split()), validate=True)
    except (ValueError, binascii.Error):
        return b""


def is_safe_asset_id(value: str) -> bool:
    """校验资产 ID 白名单（防路径穿越）。"""

    return bool(re.fullmatch(r"asset_[A-Za-z0-9]{1,80}", value))


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
