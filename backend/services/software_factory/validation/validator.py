"""校验领域蓝图、Mock 数据和生成代码是否保持一致。"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

from backend.software_factory.contracts import (
    FactoryBlueprint,
    FactoryValidation,
    GeneratedArtifact,
)

SOURCE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx"}
MAXIMUM_SOURCE_LINES = 500


def validate_factory_artifacts(
    blueprint: FactoryBlueprint,
    mock_payload: dict[str, Any],
    artifacts: tuple[GeneratedArtifact, ...],
) -> FactoryValidation:
    """执行跨领域模型、API、Mock 和前端文件的一致性检查。"""

    errors: list[str] = []
    warnings: list[str] = []
    checks: list[str] = []

    _validate_blueprint(blueprint, errors, checks)
    _validate_mock_payload(blueprint, mock_payload, errors, warnings, checks)
    _validate_artifact_contents(artifacts, errors, checks)
    _validate_cross_references(blueprint, artifacts, errors, checks)

    return FactoryValidation(
        ok=not errors,
        errors=tuple(errors),
        warnings=tuple(warnings),
        checks=tuple(checks),
    )


def _validate_blueprint(
    blueprint: FactoryBlueprint,
    errors: list[str],
    checks: list[str],
) -> None:
    """检查实体、字段和 API 引用是否唯一且完整。"""

    entity_names = [entity.name for entity in blueprint.entities]
    duplicates = [name for name, count in Counter(entity_names).items() if count > 1]
    if duplicates:
        errors.append(f"领域实体名称重复：{', '.join(duplicates)}")

    known_entities = set(entity_names)
    for entity in blueprint.entities:
        field_names = [field.name for field in entity.fields]
        repeated_fields = [
            name for name, count in Counter(field_names).items() if count > 1
        ]
        if repeated_fields:
            errors.append(
                f"实体 {entity.name} 字段重复：{', '.join(repeated_fields)}"
            )
        if "id" not in field_names and entity.name != "CheckoutRequest":
            errors.append(f"实体 {entity.name} 缺少 id 字段")

    operation_ids = [endpoint.operation_id for endpoint in blueprint.endpoints]
    repeated_operations = [
        name for name, count in Counter(operation_ids).items() if count > 1
    ]
    if repeated_operations:
        errors.append(f"API operationId 重复：{', '.join(repeated_operations)}")

    for endpoint in blueprint.endpoints:
        if endpoint.response_entity not in known_entities:
            errors.append(
                f"接口 {endpoint.operation_id} 引用了未知响应实体 "
                f"{endpoint.response_entity}"
            )
        if endpoint.request_entity and endpoint.request_entity not in known_entities:
            errors.append(
                f"接口 {endpoint.operation_id} 引用了未知请求实体 "
                f"{endpoint.request_entity}"
            )
    checks.append("领域实体、字段和 API 引用完整性")


def _validate_mock_payload(
    blueprint: FactoryBlueprint,
    mock_payload: dict[str, Any],
    errors: list[str],
    warnings: list[str],
    checks: list[str],
) -> None:
    """检查 Mock 集合、必填字段和关键外键关系。"""

    collection_names = {_collection_name(entity.name) for entity in blueprint.entities}
    missing_collections = sorted(collection_names - set(mock_payload))
    if missing_collections:
        errors.append(f"Mock 缺少实体集合：{', '.join(missing_collections)}")

    for entity in blueprint.entities:
        collection_name = _collection_name(entity.name)
        items = mock_payload.get(collection_name)
        if not isinstance(items, list):
            continue
        required_fields = {field.name for field in entity.fields if field.required}
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                errors.append(f"Mock {collection_name}[{index}] 不是对象")
                continue
            missing_fields = sorted(required_fields - set(item))
            if missing_fields:
                errors.append(
                    f"Mock {collection_name}[{index}] 缺少必填字段："
                    f"{', '.join(missing_fields)}"
                )

    _validate_commerce_relations(mock_payload, errors, warnings)
    checks.append("Mock 集合、必填字段和电商外键关系")


def _validate_commerce_relations(
    payload: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    """校验商品、SKU、购物车和订单之间的引用关系。"""

    products = {
        item.get("id"): item
        for item in payload.get("products", [])
        if isinstance(item, dict)
    }
    skus = {
        item.get("id"): item
        for item in payload.get("skus", [])
        if isinstance(item, dict)
    }
    cart_items = [
        item for item in payload.get("cartItems", []) if isinstance(item, dict)
    ]

    for sku_id, sku in skus.items():
        if sku.get("productId") not in products:
            errors.append(f"SKU {sku_id} 引用了不存在的商品")
    for product_id, product in products.items():
        for sku_id in product.get("skuIds", []):
            if sku_id not in skus:
                errors.append(f"商品 {product_id} 引用了不存在的 SKU {sku_id}")
    for item in cart_items:
        if item.get("productId") not in products:
            errors.append(f"购物车 {item.get('id')} 引用了不存在的商品")
        if item.get("skuId") not in skus:
            errors.append(f"购物车 {item.get('id')} 引用了不存在的 SKU")

    if not products:
        warnings.append("Mock 商品集合为空，商品列表页无法演示正常状态")


def _validate_artifact_contents(
    artifacts: tuple[GeneratedArtifact, ...],
    errors: list[str],
    checks: list[str],
) -> None:
    """检查文件路径唯一、源码行数和 JSON 格式。"""

    paths = [artifact.path for artifact in artifacts]
    duplicates = [path for path, count in Counter(paths).items() if count > 1]
    if duplicates:
        errors.append(f"生成文件路径重复：{', '.join(duplicates)}")

    for artifact in artifacts:
        suffix = _suffix(artifact.path)
        line_count = len(artifact.content.splitlines())
        if suffix in SOURCE_SUFFIXES and line_count > MAXIMUM_SOURCE_LINES:
            errors.append(
                f"生成源码 {artifact.path} 有 {line_count} 行，超过 500 行限制"
            )
        if suffix == ".json":
            try:
                json.loads(artifact.content)
            except json.JSONDecodeError as exc:
                errors.append(f"生成 JSON {artifact.path} 无效：{exc.msg}")
    checks.append("生成文件路径、JSON 格式和 500 行限制")


def _validate_cross_references(
    blueprint: FactoryBlueprint,
    artifacts: tuple[GeneratedArtifact, ...],
    errors: list[str],
    checks: list[str],
) -> None:
    """检查 TypeScript 类型和 API 方法是否覆盖蓝图。"""

    content_by_name = {artifact.path.rsplit("/", 1)[-1]: artifact.content for artifact in artifacts}
    contracts = content_by_name.get("contracts.ts", "")
    api_client = content_by_name.get("api-client.ts", "")

    for entity in blueprint.entities:
        if f"interface {entity.name}" not in contracts:
            errors.append(f"contracts.ts 缺少实体接口 {entity.name}")
    for endpoint in blueprint.endpoints:
        if f"async {endpoint.operation_id}(" not in api_client:
            errors.append(f"api-client.ts 缺少方法 {endpoint.operation_id}")
    checks.append("TypeScript 实体和 API 方法覆盖率")


def _collection_name(entity_name: str) -> str:
    """把 PascalCase 实体名转换成约定的 lowerCamel 复数集合名。"""

    special = {
        "Category": "categories",
        "Sku": "skus",
        "Product": "products",
        "CartItem": "cartItems",
        "Address": "addresses",
        "User": "users",
        "Coupon": "coupons",
        "OrderItem": "orderItems",
        "Order": "orders",
        "CheckoutRequest": "checkoutRequests",
    }
    return special.get(entity_name, entity_name[:1].lower() + entity_name[1:] + "s")


def _suffix(path: str) -> str:
    """返回不依赖 pathlib 的小写扩展名。"""

    filename = path.rsplit("/", 1)[-1]
    return "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
