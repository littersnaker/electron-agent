"""电商 Agent 的 LLM 参与层：结构化输出 + 校验 + 静默回退。

设计约束（与用户确认的 P0）：
- LLM 未配置 Key / 输出非法 / 调用失败时一律回退到确定性实现；
- 所有模型输出必须通过 Pydantic 校验，格式错/低置信直接丢弃；
- 绝不阻塞主流程：try_complete_json 永远不抛异常。
"""

from __future__ import annotations

import logging
from typing import Any, TypeVar

from pydantic import BaseModel

from backend.core import request_audit
from backend.services.agent.reflection.schema import extract_json_object
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage

LOGGER = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class CommerceCategoryAnalysis(BaseModel):
    """LLM 品类/意图解析。"""

    categoryName: str
    categoryNameEn: str = ""
    keywords: list[str]
    targetAudience: str = ""
    sellingPoints: list[str] = []
    complianceRisks: list[str] = []
    assumptions: list[str] = []


class CommerceListingDraft(BaseModel):
    """LLM Listing 文案草稿。"""

    title: str
    bulletPoints: list[str]
    productDescription: str
    searchTerms: str = ""


class CommerceInsights(BaseModel):
    """LLM 市场洞察。"""

    summary: str
    opportunities: list[str]
    risks: list[str]
    actions: list[str]


class LlmConfig:
    """一次电商工作流使用的 LLM 配置（凭证 + 模型）。"""

    def __init__(
        self,
        *,
        credentials: LlmCredentials | None,
        model_id: str = "auto",
    ) -> None:
        self.credentials = credentials
        self.model_id = (model_id or "auto").strip() or "auto"

    @property
    def available(self) -> bool:
        """至少配置了一个厂商 Key 才认为可用。"""

        return bool(
            self.credentials is not None
            and any((self.credentials.values or {}).values())
        )


async def try_complete_json(
    llm: LlmConfig | None,
    *,
    system_prompt: str,
    user_prompt: str,
    schema_cls: type[T],
    temperature: float = 0.2,
) -> T | None:
    """调用 LLM 并解析为指定 Schema；任何失败返回 None（走兜底）。"""

    if llm is None or not llm.available:
        return None
    try:
        text, _usage, _model = await GATEWAY.complete(
            preferred_model_id=llm.model_id,
            credentials=llm.credentials,
            messages=[
                LlmMessage("system", system_prompt),
                LlmMessage("user", user_prompt),
            ],
            temperature=temperature,
            timeout_seconds=120,
            stall_timeout_seconds=60,
            audit={
                "agentId": "commerce:llm",
                "agentRole": "commerce_llm",
            },
        )
    except Exception as exc:
        LOGGER.warning("电商 LLM 调用失败，回退确定性实现：%s", exc)
        return None
    try:
        payload = extract_json_object(text)
        return schema_cls.model_validate(payload)
    except Exception as exc:
        LOGGER.info("电商 LLM 输出校验失败，回退确定性实现：%s", exc)
        return None
