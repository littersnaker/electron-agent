"""跨境电商目标市场配置。

前端只传递简短的站点代码，本模块负责补全语言、币种、域名和搜索地区。
把这类固定配置放在一个文件中，后续增加市场时不需要修改业务流程。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Marketplace:
    """描述一个跨境电商目标市场。"""

    code: str
    label: str
    locale: str
    currency: str
    amazon_domain: str
    country_name: str


MARKETPLACES: dict[str, Marketplace] = {
    "US": Marketplace("US", "美国站", "en_US", "USD", "www.amazon.com", "United States"),
    "CA": Marketplace("CA", "加拿大站", "en_CA", "CAD", "www.amazon.ca", "Canada"),
    "UK": Marketplace("UK", "英国站", "en_GB", "GBP", "www.amazon.co.uk", "United Kingdom"),
    "DE": Marketplace("DE", "德国站", "de_DE", "EUR", "www.amazon.de", "Germany"),
    "FR": Marketplace("FR", "法国站", "fr_FR", "EUR", "www.amazon.fr", "France"),
    "IT": Marketplace("IT", "意大利站", "it_IT", "EUR", "www.amazon.it", "Italy"),
    "ES": Marketplace("ES", "西班牙站", "es_ES", "EUR", "www.amazon.es", "Spain"),
    "JP": Marketplace("JP", "日本站", "ja_JP", "JPY", "www.amazon.co.jp", "Japan"),
}


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
