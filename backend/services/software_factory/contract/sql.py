"""从电商领域蓝图生成可审查的关系型数据库 DDL。"""

from __future__ import annotations

import re

from backend.software_factory.contracts import EntitySpec, FactoryBlueprint, FieldSpec


def render_database_schema(blueprint: FactoryBlueprint) -> str:
    """生成兼容 SQLite 的建表语句和常用查询索引。"""

    sections = [
        "-- 本文件由 Software Factory 根据 domain-schema.json 生成。",
        "-- 正式生产环境仍需由后端工程师补充迁移版本、审计字段和数据库方言优化。",
        "PRAGMA foreign_keys = ON;",
        "",
    ]
    for entity in blueprint.entities:
        sections.append(_render_table(entity))
        sections.append("")
    sections.extend(_render_indexes())
    return "\n".join(sections).rstrip() + "\n"


def _render_table(entity: EntitySpec) -> str:
    """把单个实体转换成 CREATE TABLE 语句。"""

    table_name = _table_name(entity.name)
    columns: list[str] = []
    for field in entity.fields:
        column = f"  {_column_name(field.name)} {_sql_type(field)}"
        if field.name == "id":
            column += " PRIMARY KEY"
        elif field.required:
            column += " NOT NULL"
        columns.append(column)

    # 关联约束只写入确定的一对一外键；数组字段由应用层或关联表管理。
    columns.extend(_foreign_keys(entity.name))
    return f"CREATE TABLE IF NOT EXISTS {table_name} (\n" + ",\n".join(columns) + "\n);"


def _sql_type(field: FieldSpec) -> str:
    """把领域字段类型映射到 SQLite 存储类型。"""

    return {
        "string": "TEXT",
        "integer": "INTEGER",
        "number": "REAL",
        "boolean": "INTEGER",
        "datetime": "TEXT",
        "string_array": "TEXT",
    }[field.field_type]


def _foreign_keys(entity_name: str) -> list[str]:
    """返回电商核心实体可以确定的外键约束。"""

    mapping = {
        "Sku": [("product_id", "products", "id")],
        "Product": [("category_id", "categories", "id")],
        "CartItem": [
            ("user_id", "users", "id"),
            ("product_id", "products", "id"),
            ("sku_id", "skus", "id"),
        ],
        "Address": [("user_id", "users", "id")],
        "OrderItem": [
            ("order_id", "orders", "id"),
            ("product_id", "products", "id"),
            ("sku_id", "skus", "id"),
        ],
        "Order": [
            ("user_id", "users", "id"),
            ("address_id", "addresses", "id"),
            ("coupon_id", "coupons", "id"),
        ],
    }
    return [
        f"  FOREIGN KEY ({column}) REFERENCES {table} ({target})"
        for column, table, target in mapping.get(entity_name, [])
    ]


def _render_indexes() -> list[str]:
    """返回商品、购物车和订单常用查询索引。"""

    return [
        "CREATE INDEX IF NOT EXISTS idx_products_category_id "
        "ON products (category_id);",
        "CREATE INDEX IF NOT EXISTS idx_skus_product_id ON skus (product_id);",
        "CREATE INDEX IF NOT EXISTS idx_cart_items_user_id ON cart_items (user_id);",
        "CREATE INDEX IF NOT EXISTS idx_orders_user_status "
        "ON orders (user_id, status);",
        "CREATE INDEX IF NOT EXISTS idx_order_items_order_id "
        "ON order_items (order_id);",
    ]


def _table_name(entity_name: str) -> str:
    """把实体名转换成约定的 snake_case 复数表名。"""

    special = {
        "Category": "categories",
        "Address": "addresses",
        "CheckoutRequest": "checkout_requests",
    }
    return special.get(entity_name, _column_name(entity_name) + "s")


def _column_name(value: str) -> str:
    """把 camelCase 或 PascalCase 名称转换成 snake_case。"""

    first_pass = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", value)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", first_pass).lower()
