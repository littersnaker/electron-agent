"""跨境电商目标市场配置。

前端只传递简短的站点代码，本模块负责补全语言、币种、域名和搜索地区。
把这类固定配置放在一个文件中，后续增加市场时不需要修改业务流程。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

MARKETPLACE_CONFIG_PATH = (
    Path(__file__).resolve().parents[3] / "config" / "marketplaces.json"
)


@dataclass(frozen=True, slots=True)
class Marketplace:
    """描述一个跨境电商目标市场。"""

    code: str
    label: str
    locale: str
    currency: str
    amazon_domain: str
    country_name: str
    sp_api_marketplace_id: str = ""


def _load_marketplaces() -> dict[str, Marketplace]:
    """从配置 JSON 加载市场，避免新增市场时修改业务流程代码。"""

    try:
        raw = json.loads(MARKETPLACE_CONFIG_PATH.read_text("utf-8"))
    except (OSError, ValueError):
        raw = {}
    markets: dict[str, Marketplace] = {}
    for code, item in (raw.items() if isinstance(raw, dict) else []):
        if not isinstance(item, dict):
            continue
        normalized = str(code)
        markets[normalized] = Marketplace(
            code=normalized,
            label=str(item.get("label") or ""),
            locale=str(item.get("locale") or ""),
            currency=str(item.get("currency") or ""),
            amazon_domain=str(item.get("amazonDomain") or ""),
            sp_api_marketplace_id=str(item.get("spApiMarketplaceId") or ""),
            country_name=str(item.get("countryName") or ""),
        )
    return markets


MARKETPLACES: dict[str, Marketplace] = _load_marketplaces()


def get_marketplace(code: str) -> Marketplace:
    """根据站点代码返回市场配置。

    参数：
        code: 前端传来的站点代码，例如 ``US`` 或 ``JP``。

    返回：
        对应的 :class:`Marketplace` 对象。

    异常：
        当站点代码不在支持列表中时抛出 ``ValueError``。
    """

    marketplace = MARKETPLACES.get(code.upper())
    if marketplace is None:
        raise ValueError(f"暂不支持目标市场：{code}")
    return marketplace
