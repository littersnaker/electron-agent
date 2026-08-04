"""Artifact Memory 的持久化索引。

索引只保存产物元数据和内容哈希，不复制大文件内容，用于去重、复用和增量更新。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class ArtifactRecord:
    """保存一个可复用 Artifact 的稳定索引字段。"""

    id: str
    hash: str
    type: str
    dependencies: list[str] = field(default_factory=list)
    source_work: str = ""
    path: str = ""
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_json(self) -> dict[str, Any]:
        """转换为磁盘索引和 Checkpoint 可复用的 JSON。"""

        return {
            "id": self.id,
            "hash": self.hash,
            "type": self.type,
            "dependencies": list(self.dependencies),
            "sourceWork": self.source_work,
            "path": self.path,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "ArtifactRecord":
        """从旧索引宽松恢复一条 Artifact 记录。"""

        now = datetime.now(UTC).isoformat()
        return cls(
            id=str(value.get("id") or value.get("artifactId") or ""),
            hash=str(value.get("hash") or ""),
            type=str(value.get("type") or ""),
            dependencies=[str(item) for item in value.get("dependencies", [])],
            source_work=str(value.get("sourceWork") or ""),
            path=str(value.get("path") or ""),
            created_at=str(value.get("createdAt") or now),
            updated_at=str(value.get("updatedAt") or now),
        )


class ArtifactIndex:
    """维护 Artifact 的 ID、哈希、类型和路径多重索引。"""

    def __init__(self, storage_path: Path | None = None) -> None:
        """创建内存索引；传入路径时自动读取已有持久化数据。"""

        self.storage_path = storage_path
        self._records: dict[str, ArtifactRecord] = {}
        self._hash_index: dict[str, str] = {}
        self._path_index: dict[str, str] = {}
        if storage_path and storage_path.is_file():
            self.load()

    def upsert(self, record: ArtifactRecord) -> tuple[ArtifactRecord, bool]:
        """新增或增量更新记录，并返回记录和是否复用了相同哈希。"""

        duplicate_id = self._hash_index.get(record.hash) if record.hash else None
        if duplicate_id and duplicate_id != record.id:
            return self._records[duplicate_id], True
        existing = self._records.get(record.id)
        if existing:
            record.created_at = existing.created_at
        record.updated_at = datetime.now(UTC).isoformat()
        self._records[record.id] = record
        self._rebuild_indexes()
        self.save()
        return record, False

    def get(self, artifact_id: str) -> ArtifactRecord | None:
        """按稳定 ID 查询 Artifact。"""

        return self._records.get(artifact_id)

    def find_by_hash(self, content_hash: str) -> ArtifactRecord | None:
        """按内容哈希查找完全相同的可复用 Artifact。"""

        artifact_id = self._hash_index.get(content_hash)
        return self._records.get(artifact_id) if artifact_id else None

    def find_by_type(self, artifact_type: str) -> list[ArtifactRecord]:
        """返回指定类型的全部 Artifact，并按最近更新时间排序。"""

        records = [item for item in self._records.values() if item.type == artifact_type]
        return sorted(records, key=lambda item: item.updated_at, reverse=True)

    def find_by_path(self, path: str) -> ArtifactRecord | None:
        """按项目相对路径查找当前索引记录。"""

        artifact_id = self._path_index.get(path.replace("\\", "/"))
        return self._records.get(artifact_id) if artifact_id else None

    def list_all(self) -> list[ArtifactRecord]:
        """返回索引中的全部 Artifact 记录副本列表。"""

        return list(self._records.values())

    def remove(self, artifact_id: str) -> bool:
        """删除一条索引并同步持久化文件。"""

        removed = self._records.pop(artifact_id, None)
        if not removed:
            return False
        self._rebuild_indexes()
        self.save()
        return True

    def snapshot(self) -> dict[str, Any]:
        """导出可用于测试、Trace 和持久化的索引快照。"""

        return {
            "artifacts": [item.to_json() for item in self._records.values()],
            "totalCount": len(self._records),
            "uniqueHashes": len(self._hash_index),
        }

    def restore(self, snapshot: dict[str, Any]) -> None:
        """从 JSON 快照恢复索引并重新构建派生索引。"""

        self._records = {
            record.id: record
            for value in snapshot.get("artifacts", [])
            if isinstance(value, dict)
            for record in [ArtifactRecord.from_json(value)]
            if record.id
        }
        self._rebuild_indexes()

    def load(self) -> None:
        """从配置的 JSON 文件加载索引；无效内容按空索引处理。"""

        if not self.storage_path or not self.storage_path.is_file():
            return
        try:
            value = json.loads(self.storage_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            value = {}
        self.restore(value if isinstance(value, dict) else {})

    def save(self) -> None:
        """原子写入索引文件；未配置路径时仅保留内存状态。"""

        if not self.storage_path:
            return
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.storage_path.with_suffix(self.storage_path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self.snapshot(), ensure_ascii=False, indent=2),
            "utf-8",
        )
        temporary.replace(self.storage_path)

    def _rebuild_indexes(self) -> None:
        """根据主记录重建哈希与路径索引，避免更新后残留旧键。"""

        self._hash_index = {
            item.hash: item.id for item in self._records.values() if item.hash
        }
        self._path_index = {
            item.path.replace("\\", "/"): item.id
            for item in self._records.values()
            if item.path
        }


__all__ = ["ArtifactIndex", "ArtifactRecord"]
