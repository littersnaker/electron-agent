"""根据电商领域蓝图生成稳定、可关联的 Mock 数据。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from backend.services.software_factory.contracts import FactoryBlueprint


def generate_mock_payload(blueprint: FactoryBlueprint) -> dict[str, list[dict[str, Any]]]:
    """生成实体间外键一致的电商 Mock 数据集合。"""

    count = blueprint.mock_count
    categories = _categories()
    products = _products(count, categories)
    skus = _skus(products)
    users = _users()
    addresses = _addresses(users)
    coupons = _coupons()
    cart_items = _cart_items(products, skus, users)
    order_items, orders = _orders(products, skus, users, addresses, coupons)

    # 键名使用实体名的 lowerCamel 复数形式，前端和文档都从同一蓝图读取。
    return {
        "categories": categories,
        "skus": skus,
        "products": products,
        "cartItems": cart_items,
        "addresses": addresses,
        "users": users,
        "coupons": coupons,
        "orderItems": order_items,
        "orders": orders,
        "checkoutRequests": [
            {
                "cartItemIds": [item["id"] for item in cart_items if item["selected"]],
                "addressId": addresses[0]["id"],
                "couponId": coupons[0]["id"],
                "remark": "请勿放快递柜",
            }
        ],
    }


def _categories() -> list[dict[str, Any]]:
    """返回固定分类，保证商品筛选和首页导航始终有数据。"""

    return [
        {
            "id": "category-dress",
            "name": "孕妇连衣裙",
            "imageUrl": "/images/category/dress.jpg",
            "sortOrder": 10,
        },
        {
            "id": "category-top",
            "name": "孕妇上装",
            "imageUrl": "/images/category/top.jpg",
            "sortOrder": 20,
        },
        {
            "id": "category-pants",
            "name": "孕妇裤装",
            "imageUrl": "/images/category/pants.jpg",
            "sortOrder": 30,
        },
        {
            "id": "category-nursing",
            "name": "哺乳家居服",
            "imageUrl": "/images/category/nursing.jpg",
            "sortOrder": 40,
        },
    ]


def _products(
    count: int,
    categories: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """按请求数量生成商品，并循环分配分类和可预测价格。"""

    names = (
        "柔软针织孕妇连衣裙",
        "轻盈通勤孕妇衬衫",
        "高腰托腹直筒裤",
        "舒适哺乳家居套装",
        "法式方领孕妇长裙",
        "弹力打底孕妇上衣",
    )
    products: list[dict[str, Any]] = []
    for index in range(count):
        number = index + 1
        category = categories[index % len(categories)]
        price = float(169 + (index % 6) * 30)
        product_id = f"product-{number:03d}"
        products.append(
            {
                "id": product_id,
                "categoryId": category["id"],
                "name": names[index % len(names)],
                "subtitle": "宽松剪裁，适合孕期多阶段日常穿着",
                "price": price,
                "originalPrice": price + 60.0,
                "coverUrl": f"/images/products/{number:03d}-cover.jpg",
                "imageUrls": [
                    f"/images/products/{number:03d}-a.jpg",
                    f"/images/products/{number:03d}-b.jpg",
                ],
                "salesCount": 180 + number * 73,
                "rating": round(4.5 + (index % 4) * 0.1, 1),
                "tags": ["柔软", "宽松", "孕期友好"],
                "skuIds": [
                    f"sku-{number:03d}-m-beige",
                    f"sku-{number:03d}-l-black",
                ],
                "description": "Mock 商品详情：正式上线前请替换为真实商品资料。",
                "isFeatured": index < min(6, count),
            }
        )
    return products


def _skus(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """为每个商品生成两个可购买 SKU，并与商品 skuIds 保持一致。"""

    skus: list[dict[str, Any]] = []
    for index, product in enumerate(products, start=1):
        base_price = float(product["price"])
        skus.extend(
            [
                {
                    "id": f"sku-{index:03d}-m-beige",
                    "productId": product["id"],
                    "name": "米白色 / M",
                    "price": base_price,
                    "originalPrice": base_price + 60.0,
                    "stock": 60 + index,
                    "imageUrl": product["coverUrl"],
                },
                {
                    "id": f"sku-{index:03d}-l-black",
                    "productId": product["id"],
                    "name": "黑色 / L",
                    "price": base_price + 20.0,
                    "originalPrice": base_price + 80.0,
                    "stock": 35 + index,
                    "imageUrl": product["coverUrl"],
                },
            ]
        )
    return skus


def _users() -> list[dict[str, Any]]:
    """返回一个默认登录用户。"""

    return [
        {
            "id": "user-001",
            "nickname": "演示用户",
            "avatarUrl": "/images/avatar/default.png",
            "phone": "13800000000",
            "memberLevel": "silver",
            "points": 860,
        }
    ]


def _addresses(users: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """为默认用户生成一个可用于结算的收货地址。"""

    return [
        {
            "id": "address-001",
            "userId": users[0]["id"],
            "recipient": "李女士",
            "phone": "13800000000",
            "province": "浙江省",
            "city": "杭州市",
            "district": "西湖区",
            "detail": "文一路 88 号",
            "isDefault": True,
        }
    ]


def _coupons() -> list[dict[str, Any]]:
    """生成固定金额券和折扣券，覆盖常见优惠逻辑。"""

    expires_at = (datetime.now(UTC) + timedelta(days=120)).replace(microsecond=0)
    return [
        {
            "id": "coupon-001",
            "name": "新客立减 30 元",
            "discountType": "fixed",
            "discountValue": 30.0,
            "minimumAmount": 199.0,
            "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
        },
        {
            "id": "coupon-002",
            "name": "会员九折券",
            "discountType": "percent",
            "discountValue": 0.9,
            "minimumAmount": 299.0,
            "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
        },
    ]


def _cart_items(
    products: list[dict[str, Any]],
    skus: list[dict[str, Any]],
    users: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """从前两个商品构造购物车数据；商品不足时自动缩减。"""

    items: list[dict[str, Any]] = []
    for index, product in enumerate(products[:2], start=1):
        sku = next(item for item in skus if item["productId"] == product["id"])
        items.append(
            {
                "id": f"cart-item-{index:03d}",
                "userId": users[0]["id"],
                "productId": product["id"],
                "skuId": sku["id"],
                "quantity": index,
                "selected": True,
            }
        )
    return items


def _orders(
    products: list[dict[str, Any]],
    skus: list[dict[str, Any]],
    users: list[dict[str, Any]],
    addresses: list[dict[str, Any]],
    coupons: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """生成一张已支付订单及对应商品快照。"""

    if not products:
        return [], []
    product = products[0]
    sku = next(item for item in skus if item["productId"] == product["id"])
    order_item = {
        "id": "order-item-001",
        "orderId": "order-001",
        "productId": product["id"],
        "skuId": sku["id"],
        "productName": product["name"],
        "skuName": sku["name"],
        "unitPrice": sku["price"],
        "quantity": 1,
    }
    created_at = datetime.now(UTC).replace(microsecond=0)
    order = {
        "id": "order-001",
        "orderNo": created_at.strftime("%Y%m%d0001"),
        "userId": users[0]["id"],
        "addressId": addresses[0]["id"],
        "itemIds": [order_item["id"]],
        "couponId": coupons[0]["id"],
        "status": "paid",
        "goodsAmount": sku["price"],
        "discountAmount": 30.0,
        "payAmount": max(0.0, float(sku["price"]) - 30.0),
        "createdAt": created_at.isoformat().replace("+00:00", "Z"),
    }
    return [order_item], [order]
