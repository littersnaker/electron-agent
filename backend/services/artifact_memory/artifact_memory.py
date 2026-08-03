"""Artifact Memory 模块。

减少重复生成，支持 artifact 去重、重复任务复用和增量更新。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ArtifactMemory:
    """Artifact 记忆条目。"""

    artifact_id: str
    hash: str
    type: str
    source_work: str
    dependencies: list[str] = field(default_factory=list)
    created_at: str = ""

    def to_json(self) -> dict[str, Any]:
        """序列化为 JSON。"""

        return {
            "artifactId": self.artifact_id,
            "hash": self.hash,
            "type": self.type,
            "sourceWork": self.source_work,
            "dependencies": list(self.dependencies),
            "createdAt": self.created_at,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "ArtifactMemory":
        """从 JSON 恢复。"""

        return cls(
            artifact_id=str(value.get("artifactId") or ""),
            hash=str(value.get("hash") or ""),
            type=str(value.get("type") or ""),
            source_work=str(value.get("sourceWork") or ""),
            dependencies=[str(item) for item in value.get("dependencies", [])],
            created_at=str(value.get("createdAt") or ""),
        )


class ArtifactMemoryStore:
    """Artifact 记忆存储，支持去重和复用。"""

    def __init__(self) -> None:
        """初始化空存储。"""

        self._store: dict[str, ArtifactMemory] = {}
        # 按 hash 索引，用于快速去重
        self._hash_index: dict[str, str] = {}
        # 按 type 索引，用于快速查找
        self._type_index: dict[str, list[str]] = {}

    def _update_indexes(self, artifact: ArtifactMemory) -> None:
        """更新索引。"""

        if artifact.hash:
            self._hash_index[artifact.hash] = artifact.artifact_id
        if artifact.type:
            self._type_index.setdefault(artifact.type, []).append(artifact.artifact_id)

    def save(self, artifact: ArtifactMemory) -> bool:
        """保存 artifact，如果 hash 已存在则返回 False（表示重复）。"""

        if artifact.hash and artifact.hash in self._hash_index:
            return False

        self._store[artifact.artifact_id] = artifact
        self._update_indexes(artifact)
        return True

    def get(self, artifact_id: str) -> ArtifactMemory | None:
        """按 ID 获取。"""

        return self._store.get(artifact_id)

    def find_by_hash(self, content_hash: str) -> ArtifactMemory | None:
        """按 hash 查找（用于去重）。"""

        artifact_id = self._hash_index.get(content_hash)
        if artifact_id:
            return self._store.get(artifact_id)
        return None

    def find_by_type(self, artifact_type: str) -> list[ArtifactMemory]:
        """按类型查找。"""

        ids = self._type_index.get(artifact_type, [])
        return [self._store[aid] for aid in ids if aid in self._store]

    def find_reusable(
        self, *, artifact_type: str, dependencies: list[str] | None = None
    ) -> ArtifactMemory | None:
        """查找可复用的 artifact。

        匹配规则：
        1. 类型相同
        2. 依赖是子集（当前需要的依赖不超过已有 artifact 的依赖）
        """

        candidates = self.find_by_type(artifact_type)
        if not candidates:
            return None

        deps = set(dependencies or [])
        for candidate in candidates:
            candidate_deps = set(candidate.dependencies)
            if deps.issubset(candidate_deps):
                return candidate

        return None

    def delete(self, artifact_id: str) -> bool:
        """删除 artifact。"""

        artifact = self._store.pop(artifact_id, None)
        if not artifact:
            return False

        # 清理索引
        if artifact.hash and self._hash_index.get(artifact.hash) == artifact_id:
            del self._hash_index[artifact.hash]
        if artifact.type:
            self._type_index.setdefault(artifact.type, [])
            if artifact_id in self._type_index[artifact.type]:
                self._type_index[artifact.type].remove(artifact_id)

        return True

    def list_all(self) -> list[ArtifactMemory]:
        """返回所有 artifact。"""

        return list(self._store.values())

    def snapshot(self) -> dict[str, Any]:
        """导出快照。"""

        return {
            "artifacts": [a.to_json() for a in self._store.values()],
            "totalCount": len(self._store),
            "uniqueHashes": len(self._hash_index),
        }

    def restore(self, snapshot: dict[str, Any]) -> None:
        """从快照恢复。"""

        self._store.clear()
        self._hash_index.clear()
        self._type_index.clear()

        for data in snapshot.get("artifacts", []):
            artifact = ArtifactMemory.from_json(data)
            self._store[artifact.artifact_id] = artifact
            self._update_indexes(artifact)

    def clear(self) -> None:
        """清空。"""

        self._store.clear()
        self._hash_index.clear()
        self._type_index.clear()


@dataclass(slots=True)
class ArtifactReuseResult:
    """Artifact 复用结果。"""

    reused: bool
    artifact_id: str = ""
    source_work: str = ""
    message: str = ""


def compute_content_hash(content: str) -> str:
    """计算内容 hash。"""

    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


__all__ = [
    "ArtifactMemory",
    "ArtifactMemoryStore",
    "ArtifactReuseResult",
    "compute_content_hash",
]
