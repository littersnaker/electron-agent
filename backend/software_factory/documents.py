"""Software Factory 需求与实施文档生成器。"""

from __future__ import annotations

from backend.software_factory.contracts import FactoryBlueprint


def render_requirements_document(blueprint: FactoryBlueprint) -> str:
    """生成可供产品、前端、后端和测试共同审阅的需求基线。"""

    modules = (
        "商品分类与推荐",
        "商品列表、搜索与详情",
        "SKU 选择、价格与库存",
        "购物车增删改查",
        "地址、优惠券与结算",
        "订单创建、列表与详情",
        "Mock/真实 API 数据源切换",
    )
    endpoint_lines = "\n".join(
        f"- `{endpoint.method} {endpoint.path}`：{endpoint.summary}"
        for endpoint in blueprint.endpoints
    )
    module_lines = "\n".join(f"- {module}" for module in modules)
    return f"""# 电商小程序需求基线

## 原始目标

{blueprint.request_text or '构建可使用 Mock 开发并可平滑切换真实 API 的电商小程序。'}

## 本期业务范围

{module_lines}

## API 范围

{endpoint_lines}

## 页面验收标准

- 商品列表、详情、购物车和订单不得各自重复定义数据模型。
- 开发环境使用 Mock Repository，联调和生产使用真实 API Client。
- 页面必须覆盖 loading、error、empty、success 四种状态。
- 购物车修改后再次读取能够看到最新状态。
- 创建订单后订单列表能够看到新订单。
- 未提供的价格、库存、用户和订单数据必须明确标记为 Mock。

## 工程验收标准

- `domain-schema.json`、`openapi.json`、数据库 DDL 和 TypeScript 类型字段一致。
- 所有生成与手写源码文件不超过 500 行。
- Python 方法具有中文 docstring，关键分支具有中文行内注释。
- TypeScript 通过 ESLint、Prettier、typecheck、test 和 build。
- `software_factory.validate` 能识别真实页面是否已经接入统一 Data Source。
"""
