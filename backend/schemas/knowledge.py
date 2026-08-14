"""知识库接口的数据结构。"""

from __future__ import annotations

from typing import Literal

from backend.schemas.common import FlexibleModel


class KnowledgeDocument(FlexibleModel):
    """知识库中单个上传文档的元数据。"""

    id: str
    filename: str
    size: int
    status: Literal["pending", "ready", "error"]
    chunk_count: int = 0
    error_message: str = ""
    created_at: str
    updated_at: str
