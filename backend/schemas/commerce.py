"""跨境电商研究与 Listing 接口数据结构。"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from backend.schemas.common import FlexibleModel, FrontendMessage


MarketplaceCode = Literal["US", "CA", "UK", "DE", "FR", "IT", "ES", "JP"]


class CommerceRequest(FlexibleModel):
    """市场研究或 Listing Demo 请求。"""

    query: str
    marketplace: MarketplaceCode = "US"
    sample_size: int = Field(default=24, alias="sampleSize", ge=1, le=100)
    messages: list[FrontendMessage] = Field(default_factory=list)
