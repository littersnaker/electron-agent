"""Artifact Memory 的统一公共入口。"""

from backend.services.artifact_memory.artifact_index import ArtifactIndex, ArtifactRecord
from backend.services.artifact_memory.artifact_memory import (
    ArtifactMemory,
    ArtifactMemoryStore,
    ArtifactReuseResult,
    compute_content_hash,
)
from backend.services.artifact_memory.artifact_similarity import (
    ArtifactSimilarity,
    ArtifactSimilarityEngine,
)

__all__ = [
    "ArtifactIndex",
    "ArtifactMemory",
    "ArtifactMemoryStore",
    "ArtifactRecord",
    "ArtifactReuseResult",
    "ArtifactSimilarity",
    "ArtifactSimilarityEngine",
    "compute_content_hash",
]
