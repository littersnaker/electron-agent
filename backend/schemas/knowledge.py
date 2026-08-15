"""知识库接口的数据结构。"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

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


class KnowledgeEvalCase(FlexibleModel):
    """检索评估中的单条测试用例：问题 + 期望命中的文档路径片段。"""

    question: str
    expect: str


class KnowledgeEvalRequest(FlexibleModel):
    """检索效果评估请求体。"""

    cases: list[KnowledgeEvalCase]
    recall_k: int | None = Field(default=None, alias="recallK")
    top_k: int | None = Field(default=None, alias="topK")
