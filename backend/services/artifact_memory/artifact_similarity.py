"""Artifact 相似度与最佳复用候选选择。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath

from backend.services.artifact_memory.artifact_index import ArtifactRecord


@dataclass(slots=True)
class ArtifactSimilarity:
    """保存候选 Artifact 的相似度和可解释评分项。"""

    artifact_id: str
    score: float
    exact_hash: bool
    same_type: bool
    dependency_overlap: float


class ArtifactSimilarityEngine:
    """使用哈希、类型、依赖和文件名计算轻量可解释相似度。"""

    def compare(
        self,
        candidate: ArtifactRecord,
        *,
        content_hash: str = "",
        artifact_type: str = "",
        dependencies: list[str] | None = None,
        path: str = "",
    ) -> ArtifactSimilarity:
        """比较一个候选并返回零到一之间的复用分数。"""

        exact_hash = bool(content_hash and candidate.hash == content_hash)
        same_type = bool(artifact_type and candidate.type == artifact_type)
        expected = set(dependencies or [])
        actual = set(candidate.dependencies)
        union = expected | actual
        overlap = len(expected & actual) / len(union) if union else 1.0
        same_name = bool(
            path
            and candidate.path
            and PurePosixPath(path).name == PurePosixPath(candidate.path).name
        )
        score = (
            (0.65 if exact_hash else 0.0)
            + (0.15 if same_type else 0.0)
            + overlap * 0.15
            + (0.05 if same_name else 0.0)
        )
        return ArtifactSimilarity(
            artifact_id=candidate.id,
            score=min(1.0, score),
            exact_hash=exact_hash,
            same_type=same_type,
            dependency_overlap=round(overlap, 4),
        )

    def find_best(
        self,
        candidates: list[ArtifactRecord],
        *,
        content_hash: str = "",
        artifact_type: str = "",
        dependencies: list[str] | None = None,
        path: str = "",
        threshold: float = 0.6,
    ) -> ArtifactSimilarity | None:
        """返回达到阈值的最高分候选，避免低相似度产物被错误复用。"""

        results = [
            self.compare(
                item,
                content_hash=content_hash,
                artifact_type=artifact_type,
                dependencies=dependencies,
                path=path,
            )
            for item in candidates
        ]
        best = max(results, key=lambda item: item.score, default=None)
        return best if best and best.score >= threshold else None


__all__ = ["ArtifactSimilarity", "ArtifactSimilarityEngine"]
