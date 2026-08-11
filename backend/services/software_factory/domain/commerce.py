"""电商小程序领域模型与 API 契约预设。"""

from __future__ import annotations

from backend.services.software_factory.contracts import (
    EndpointSpec,
    EntitySpec,
    FactoryBlueprint,
    FieldSpec,
)
from backend.services.software_factory.frontend.detector import FrontendProjectProfile


def build_commerce_blueprint(
    *,
    request_text: str,
    profile: FrontendProjectProfile,
    output_root: str,
    mock_count: int,
) -> FactoryBlueprint:
    """构建覆盖商品、购物车、订单、用户、地址和优惠券的电商蓝图。"""

    entities = (
        _category_entity(),
        _sku_entity(),
        _product_entity(),
        _cart_item_entity(),
        _address_entity(),
        _user_entity(),
        _coupon_entity(),
        _order_item_entity(),
        _order_entity(),
        _checkout_request_entity(),
    )
    endpoints = _commerce_endpoints()
    return FactoryBlueprint(
        domain_id="commerce-miniapp",
        project_name=profile.project_name,
        request_text=request_text.strip(),
        frontend_stack=profile.stack,
        source_root=profile.source_root,
        output_root=output_root,
        mock_count=max(3, min(mock_count, 100)),
        entities=entities,
        endpoints=endpoints,
        metadata={
            "evidence": list(profile.evidence),
            "singleSourceOfTruth": "domain-schema.json",
            "generatedFor": "电商小程序 Mock 与真实 API 可切换数据层",
        },
    )


def _field(
    name: str,
    field_type: str,
    description: str,
    *,
    required: bool = True,
    example: object = None,
    enum_values: tuple[str, ...] = (),
) -> FieldSpec:
    """用紧凑参数创建字段，同时保持实体定义可读。"""

    return FieldSpec(
        name=name,
        field_type=field_type,  # type: ignore[arg-type]
        description=description,
        required=required,
        example=example,
        enum_values=enum_values,
    )


def _category_entity() -> EntitySpec:
    """返回商品分类实体。"""

    return EntitySpec(
        "Category",
        "商品分类，用于首页导航和商品筛选。",
        (
            _field("id", "string", "分类唯一标识", example="category-dress"),
            _field("name", "string", "分类展示名称", example="孕妇连衣裙"),
            _field("imageUrl", "string", "分类封面图片", example="/images/category/dress.jpg"),
            _field("sortOrder", "integer", "前端展示顺序", example=10),
        ),
    )


def _sku_entity() -> EntitySpec:
    """返回商品库存单位实体。"""

    return EntitySpec(
        "Sku",
        "商品可购买规格，是价格和库存的最小单位。",
        (
            _field("id", "string", "SKU 唯一标识", example="sku-001-m-beige"),
            _field("productId", "string", "所属商品 ID", example="product-001"),
            _field("name", "string", "规格组合名称", example="米白色 / M"),
            _field("price", "number", "当前销售价格", example=299.0),
            _field("originalPrice", "number", "划线价格", required=False, example=359.0),
            _field("stock", "integer", "可售库存", example=88),
            _field("imageUrl", "string", "规格图片", required=False, example="/images/products/001.jpg"),
        ),
    )


def _product_entity() -> EntitySpec:
    """返回商品聚合实体。"""

    return EntitySpec(
        "Product",
        "商品列表和详情页共享的标准商品模型。",
        (
            _field("id", "string", "商品唯一标识", example="product-001"),
            _field("categoryId", "string", "所属分类 ID", example="category-dress"),
            _field("name", "string", "商品名称", example="柔软针织孕妇连衣裙"),
            _field("subtitle", "string", "商品副标题", example="宽松剪裁，适合通勤与日常"),
            _field("price", "number", "商品起售价", example=299.0),
            _field("originalPrice", "number", "商品划线价", required=False, example=359.0),
            _field("coverUrl", "string", "主图地址", example="/images/products/001-cover.jpg"),
            _field("imageUrls", "string_array", "详情轮播图片", example=["/images/products/001-a.jpg"]),
            _field("salesCount", "integer", "展示销量", example=1268),
            _field("rating", "number", "商品评分", example=4.8),
            _field("tags", "string_array", "商品标签", example=["柔软", "通勤"]),
            _field("skuIds", "string_array", "可购买 SKU ID", example=["sku-001-m-beige"]),
            _field("description", "string", "商品详情说明", example="适合孕期多阶段穿着。"),
            _field("isFeatured", "boolean", "是否首页推荐", example=True),
        ),
    )


def _cart_item_entity() -> EntitySpec:
    """返回购物车条目实体。"""

    return EntitySpec(
        "CartItem",
        "用户购物车中的 SKU 数量记录。",
        (
            _field("id", "string", "购物车条目 ID", example="cart-item-001"),
            _field("userId", "string", "所属用户 ID", example="user-001"),
            _field("productId", "string", "商品 ID", example="product-001"),
            _field("skuId", "string", "SKU ID", example="sku-001-m-beige"),
            _field("quantity", "integer", "购买数量", example=1),
            _field("selected", "boolean", "是否参与结算", example=True),
        ),
    )


def _address_entity() -> EntitySpec:
    """返回收货地址实体。"""

    return EntitySpec(
        "Address",
        "订单结算使用的收货地址。",
        (
            _field("id", "string", "地址 ID", example="address-001"),
            _field("userId", "string", "所属用户 ID", example="user-001"),
            _field("recipient", "string", "收货人姓名", example="李女士"),
            _field("phone", "string", "联系电话", example="13800000000"),
            _field("province", "string", "省份", example="浙江省"),
            _field("city", "string", "城市", example="杭州市"),
            _field("district", "string", "区县", example="西湖区"),
            _field("detail", "string", "详细地址", example="文一路 88 号"),
            _field("isDefault", "boolean", "是否默认地址", example=True),
        ),
    )


def _user_entity() -> EntitySpec:
    """返回用户实体。"""

    return EntitySpec(
        "User",
        "小程序登录用户的公开资料。",
        (
            _field("id", "string", "用户 ID", example="user-001"),
            _field("nickname", "string", "昵称", example="Leo"),
            _field("avatarUrl", "string", "头像地址", example="/images/avatar/default.png"),
            _field("phone", "string", "绑定手机号", required=False, example="13800000000"),
            _field("memberLevel", "string", "会员等级", example="silver"),
            _field("points", "integer", "会员积分", example=860),
        ),
    )


def _coupon_entity() -> EntitySpec:
    """返回优惠券实体。"""

    return EntitySpec(
        "Coupon",
        "结算时可用的优惠券规则摘要。",
        (
            _field("id", "string", "优惠券 ID", example="coupon-001"),
            _field("name", "string", "优惠券名称", example="新客立减 30 元"),
            _field("discountType", "string", "优惠类型", example="fixed", enum_values=("fixed", "percent")),
            _field("discountValue", "number", "优惠数值", example=30.0),
            _field("minimumAmount", "number", "最低使用金额", example=199.0),
            _field("expiresAt", "datetime", "过期时间", example="2026-12-31T23:59:59Z"),
        ),
    )


def _order_item_entity() -> EntitySpec:
    """返回订单商品快照实体。"""

    return EntitySpec(
        "OrderItem",
        "下单时保存的商品和 SKU 快照。",
        (
            _field("id", "string", "订单明细 ID", example="order-item-001"),
            _field("orderId", "string", "所属订单 ID", example="order-001"),
            _field("productId", "string", "商品 ID", example="product-001"),
            _field("skuId", "string", "SKU ID", example="sku-001-m-beige"),
            _field("productName", "string", "下单时商品名称", example="柔软针织孕妇连衣裙"),
            _field("skuName", "string", "下单时规格名称", example="米白色 / M"),
            _field("unitPrice", "number", "成交单价", example=299.0),
            _field("quantity", "integer", "购买数量", example=1),
        ),
    )


def _order_entity() -> EntitySpec:
    """返回订单实体。"""

    return EntitySpec(
        "Order",
        "订单列表、详情和支付状态共享模型。",
        (
            _field("id", "string", "订单 ID", example="order-001"),
            _field("orderNo", "string", "用户可见订单号", example="202608020001"),
            _field("userId", "string", "用户 ID", example="user-001"),
            _field("addressId", "string", "收货地址 ID", example="address-001"),
            _field("itemIds", "string_array", "订单明细 ID", example=["order-item-001"]),
            _field("couponId", "string", "优惠券 ID", required=False, example="coupon-001"),
            _field("status", "string", "订单状态", example="pending_payment", enum_values=("pending_payment", "paid", "shipped", "completed", "cancelled")),
            _field("goodsAmount", "number", "商品总额", example=299.0),
            _field("discountAmount", "number", "优惠金额", example=30.0),
            _field("payAmount", "number", "应付金额", example=269.0),
            _field("createdAt", "datetime", "创建时间", example="2026-08-02T08:00:00Z"),
        ),
    )


def _checkout_request_entity() -> EntitySpec:
    """返回创建订单请求实体。"""

    return EntitySpec(
        "CheckoutRequest",
        "由购物车创建订单时提交的请求体。",
        (
            _field("cartItemIds", "string_array", "参与结算的购物车条目", example=["cart-item-001"]),
            _field("addressId", "string", "收货地址 ID", example="address-001"),
            _field("couponId", "string", "优惠券 ID", required=False, example="coupon-001"),
            _field("remark", "string", "订单备注", required=False, example="请勿放快递柜"),
        ),
    )


def _commerce_endpoints() -> tuple[EndpointSpec, ...]:
    """返回电商 MVP 前后端共享的 API 列表。"""

    return (
        EndpointSpec("GET", "/categories", "listCategories", "查询商品分类", "Category", collection_response=True),
        EndpointSpec("GET", "/products", "listProducts", "查询商品列表", "Product", collection_response=True),
        EndpointSpec("GET", "/products/{productId}", "getProduct", "查询商品详情", "Product"),
        EndpointSpec("GET", "/skus", "listSkus", "查询 SKU 列表", "Sku", collection_response=True),
        EndpointSpec("GET", "/cart", "getCart", "查询购物车", "CartItem", collection_response=True),
        EndpointSpec("POST", "/cart", "addCartItem", "加入购物车", "CartItem", request_entity="CartItem"),
        EndpointSpec("PATCH", "/cart/{cartItemId}", "updateCartItem", "修改购物车数量", "CartItem", request_entity="CartItem"),
        EndpointSpec("DELETE", "/cart/{cartItemId}", "removeCartItem", "移除购物车商品", "CartItem"),
        EndpointSpec("GET", "/users/me", "getCurrentUser", "查询当前用户", "User"),
        EndpointSpec("GET", "/addresses", "listAddresses", "查询收货地址", "Address", collection_response=True),
        EndpointSpec("GET", "/coupons", "listCoupons", "查询可用优惠券", "Coupon", collection_response=True),
        EndpointSpec("GET", "/orders", "listOrders", "查询订单列表", "Order", collection_response=True),
        EndpointSpec("GET", "/orders/{orderId}", "getOrder", "查询订单详情", "Order"),
        EndpointSpec("POST", "/orders", "createOrder", "创建订单", "Order", request_entity="CheckoutRequest"),
    )
