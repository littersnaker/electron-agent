"""Artifact Index、相似度和增量更新测试。"""

from backend.services.artifact_memory import (
    ArtifactIndex,
    ArtifactRecord,
    ArtifactSimilarityEngine,
)


def test_artifact_index_persists_and_reuses_hash(tmp_path) -> None:
    """验证索引可持久化，并按相同内容哈希复用已有 Artifact。"""

    storage = tmp_path / "artifact-index.json"
    index = ArtifactIndex(storage)
    first, reused = index.upsert(
        ArtifactRecord(id="A001", hash="same", type="json", path="a.json")
    )
    duplicate, duplicate_reused = index.upsert(
        ArtifactRecord(id="A002", hash="same", type="json", path="b.json")
    )
    restored = ArtifactIndex(storage)

    assert reused is False
    assert duplicate_reused is True
    assert duplicate.id == first.id
    assert restored.get("A001") is not None


def test_artifact_similarity_selects_best_candidate() -> None:
    """验证相似度引擎优先选择哈希、类型和依赖均匹配的产物。"""

    candidates = [
        ArtifactRecord(
            id="A001",
            hash="old",
            type="json",
            dependencies=["schema"],
            path="data/product.json",
        ),
        ArtifactRecord(
            id="A002",
            hash="target",
            type="json",
            dependencies=["schema"],
            path="data/product.json",
        ),
    ]
    result = ArtifactSimilarityEngine().find_best(
        candidates,
        content_hash="target",
        artifact_type="json",
        dependencies=["schema"],
        path="data/product.json",
    )

    assert result is not None
    assert result.artifact_id == "A002"
    assert result.score == 1.0
