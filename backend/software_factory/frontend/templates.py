"""生成框架无关的 TypeScript 电商数据层模板。"""

from __future__ import annotations

import json
import re
from typing import Any

from backend.software_factory.contracts import EntitySpec, FactoryBlueprint, FieldSpec


def render_contracts(blueprint: FactoryBlueprint) -> str:
    """从领域蓝图生成前端 TypeScript 接口。"""

    sections = [
        "/**",
        " * 本文件由 Software Factory 根据 domain-schema.json 生成。",
        " * 修改领域字段时应先更新单一事实源，再重新生成类型和 Mock。",
        " */",
        "",
    ]
    for entity in blueprint.entities:
        sections.extend(_render_entity(entity))
        sections.append("")
    return "\n".join(sections).rstrip() + "\n"


def render_mock_data(mock_payload: dict[str, Any]) -> str:
    """把标准 Mock JSON 转换成低行数、强类型的 TypeScript 常量。"""

    # 机器生成的大型 JSON 使用单行字符串保存，避免默认 12 个商品时超过 500 行。
    serialized = json.dumps(mock_payload, ensure_ascii=False, separators=(",", ":"))
    string_literal = json.dumps(serialized, ensure_ascii=False)
    return f"""/**
 * 本文件由 Software Factory 生成，数据只用于本地开发和自动化测试。
 * 正式环境必须切换为 API 数据源，不能把示例销量、用户或订单当成真实数据。
 */

import type {{
  Address,
  CartItem,
  Category,
  CheckoutRequest,
  Coupon,
  Order,
  OrderItem,
  Product,
  Sku,
  User,
}} from "./contracts";

export interface CommerceMockData {{
  categories: Category[];
  skus: Sku[];
  products: Product[];
  cartItems: CartItem[];
  addresses: Address[];
  users: User[];
  coupons: Coupon[];
  orderItems: OrderItem[];
  orders: Order[];
  checkoutRequests: CheckoutRequest[];
}}

const serializedMockData = {string_literal};

export const commerceMockData = JSON.parse(
  serializedMockData,
) as CommerceMockData;
"""


def render_api_client(blueprint: FactoryBlueprint) -> str:
    """根据前端技术栈生成 fetch 或微信 request 版本的 API 客户端。"""

    request_runtime = (
        _wechat_request_runtime()
        if blueprint.frontend_stack == "wechat-miniprogram"
        else _fetch_request_runtime()
    )
    imports = _contract_imports(blueprint)
    methods = "\n\n".join(_render_api_method(endpoint) for endpoint in blueprint.endpoints)
    return f"""/**
 * 真实 API 数据源。所有页面只依赖 data-source.ts，不应直接调用 wx.request 或 fetch。
 */

import type {{ {imports} }} from "./contracts";

export interface CommerceApiConfig {{
  baseUrl: string;
  headers?: Record<string, string>;
}}

{request_runtime}

export const createCommerceApi = (config: CommerceApiConfig) => {{
  const request = createRequest(config);

  return {{
{_indent(methods, 4)}
  }};
}};

export type CommerceApi = ReturnType<typeof createCommerceApi>;
"""


def render_mock_repository(blueprint: FactoryBlueprint) -> str:
    """生成与真实 API Client 方法完全一致的内存 Mock Repository。"""

    del blueprint
    return """/**
 * 可变内存 Mock Repository。
 * 每次创建 Repository 都会深拷贝初始数据，测试之间不会互相污染。
 */

import type {
  Address,
  CartItem,
  Category,
  CheckoutRequest,
  Coupon,
  Order,
  Product,
  Sku,
  User,
} from "./contracts";
import { commerceMockData } from "./mock-data";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const createCommerceMockRepository = () => {
  const categories: Category[] = clone(commerceMockData.categories);
  const skus: Sku[] = clone(commerceMockData.skus);
  const products: Product[] = clone(commerceMockData.products);
  const cartItems: CartItem[] = clone(commerceMockData.cartItems);
  const addresses: Address[] = clone(commerceMockData.addresses);
  const users: User[] = clone(commerceMockData.users);
  const coupons: Coupon[] = clone(commerceMockData.coupons);
  const orders: Order[] = clone(commerceMockData.orders);

  return {
    async listCategories(): Promise<Category[]> {
      return clone(categories);
    },

    async listProducts(): Promise<Product[]> {
      return clone(products);
    },

    async getProduct(productId: string): Promise<Product> {
      const product = products.find((item) => item.id === productId);
      if (!product) throw new Error(`Mock 商品不存在：${productId}`);
      return clone(product);
    },

    async listSkus(): Promise<Sku[]> {
      return clone(skus);
    },

    async getCart(): Promise<CartItem[]> {
      return clone(cartItems);
    },

    async addCartItem(input: CartItem): Promise<CartItem> {
      const existing = cartItems.find((item) => item.skuId === input.skuId);
      if (existing) {
        existing.quantity += input.quantity;
        return clone(existing);
      }
      cartItems.push(clone(input));
      return clone(input);
    },

    async updateCartItem(
      cartItemId: string,
      input: CartItem,
    ): Promise<CartItem> {
      const index = cartItems.findIndex((item) => item.id === cartItemId);
      if (index < 0) throw new Error(`Mock 购物车条目不存在：${cartItemId}`);
      cartItems[index] = clone(input);
      return clone(cartItems[index]);
    },

    async removeCartItem(cartItemId: string): Promise<CartItem> {
      const index = cartItems.findIndex((item) => item.id === cartItemId);
      if (index < 0) throw new Error(`Mock 购物车条目不存在：${cartItemId}`);
      const [removed] = cartItems.splice(index, 1);
      return clone(removed);
    },

    async getCurrentUser(): Promise<User> {
      const user = users[0];
      if (!user) throw new Error("Mock 用户不存在");
      return clone(user);
    },

    async listAddresses(): Promise<Address[]> {
      return clone(addresses);
    },

    async listCoupons(): Promise<Coupon[]> {
      return clone(coupons);
    },

    async listOrders(): Promise<Order[]> {
      return clone(orders);
    },

    async getOrder(orderId: string): Promise<Order> {
      const order = orders.find((item) => item.id === orderId);
      if (!order) throw new Error(`Mock 订单不存在：${orderId}`);
      return clone(order);
    },

    async createOrder(input: CheckoutRequest): Promise<Order> {
      const now = new Date();
      const selectedItems = cartItems.filter((item) =>
        input.cartItemIds.includes(item.id),
      );
      const goodsAmount = selectedItems.reduce((total, item) => {
        const sku = skus.find((candidate) => candidate.id === item.skuId);
        return total + (sku?.price ?? 0) * item.quantity;
      }, 0);
      const order: Order = {
        id: `order-mock-${now.getTime()}`,
        orderNo: now.toISOString().replace(/\\D/g, "").slice(0, 14),
        userId: users[0]?.id ?? "user-001",
        addressId: input.addressId,
        itemIds: selectedItems.map((item) => item.id),
        couponId: input.couponId,
        status: "pending_payment",
        goodsAmount,
        discountAmount: 0,
        payAmount: goodsAmount,
        createdAt: now.toISOString(),
      };
      orders.unshift(order);
      return clone(order);
    },
  };
};

export type CommerceMockRepository = ReturnType<
  typeof createCommerceMockRepository
>;
"""


def render_data_source() -> str:
    """生成 Mock 与真实 API 可切换的统一数据源入口。"""

    return """/**
 * 页面层唯一允许依赖的电商数据源入口。
 * 开发阶段使用 mock，联调和生产环境切换为 api，页面代码无需改动。
 */

import { createCommerceApi, type CommerceApiConfig } from "./api-client";
import { createCommerceMockRepository } from "./mock-repository";

export type CommerceDataMode = "mock" | "api";

export interface CommerceDataSourceConfig extends CommerceApiConfig {
  mode: CommerceDataMode;
}

export const createCommerceDataSource = (
  config: CommerceDataSourceConfig,
) => {
  if (config.mode === "mock") {
    return createCommerceMockRepository();
  }
  return createCommerceApi(config);
};

export type CommerceDataSource = ReturnType<
  typeof createCommerceDataSource
>;
"""


def render_integration_guide(blueprint: FactoryBlueprint) -> str:
    """生成指导 Code Agent 将数据源接入现有页面的中文说明。"""

    return f"""# Commerce Software Factory 产物

## 生成目标

- 技术栈：`{blueprint.frontend_stack}`
- 源码根目录：`{blueprint.source_root}`
- 生成目录：`{blueprint.output_root}`
- Mock 商品数量：`{blueprint.mock_count}`

## 单一事实源

`domain-schema.json` 是实体字段的单一事实源；`openapi.json`、`contracts.ts`、
`mock-data.json` 与 `mock-data.ts` 均由它派生。不要在页面中重新定义 Product、Sku、
CartItem 或 Order 类型。

## 页面接入顺序

1. 在应用启动配置中调用 `createCommerceDataSource`，开发阶段传入 `mode: "mock"`。
2. 将数据源通过现有依赖注入、Context、Store 或页面模块传入商品列表、详情和购物车。
3. 删除页面内部硬编码数组，改为调用 `listProducts`、`getProduct` 和 `getCart`。
4. 页面必须分别处理 loading、error、empty 和 success 四种状态。
5. 后端接口完成后仅把 mode 切换为 `api`，并配置 `baseUrl`，页面不得再次改模型字段。
6. 执行 `software_factory.validate`，再运行项目的 lint、typecheck、test 和 build。

## 重要边界

生成器只负责建立可靠的数据契约和可切换数据层。Code Agent 仍需要读取真实页面、路由、
状态管理和组件代码，把数据源注入项目已有架构；不能只生成本目录后就宣称页面已经接通。
"""


def _render_entity(entity: EntitySpec) -> list[str]:
    """把单个实体渲染成带字段注释的 TypeScript interface。"""

    lines = [f"/** {entity.description} */", f"export interface {entity.name} {{"]
    for field in entity.fields:
        optional = "" if field.required else "?"
        lines.append(f"  /** {field.description} */")
        lines.append(f"  {field.name}{optional}: {_typescript_type(field)};")
    lines.append("}")
    return lines


def _typescript_type(field: FieldSpec) -> str:
    """把领域字段类型映射成 TypeScript 类型。"""

    if field.enum_values:
        return " | ".join(json.dumps(value, ensure_ascii=False) for value in field.enum_values)
    return {
        "string": "string",
        "integer": "number",
        "number": "number",
        "boolean": "boolean",
        "datetime": "string",
        "string_array": "string[]",
    }[field.field_type]


def _contract_imports(blueprint: FactoryBlueprint) -> str:
    """返回 API 客户端使用的去重实体类型列表。"""

    names = {
        endpoint.response_entity
        for endpoint in blueprint.endpoints
        if endpoint.response_entity
    }
    names.update(
        endpoint.request_entity
        for endpoint in blueprint.endpoints
        if endpoint.request_entity
    )
    return ", ".join(sorted(names))


def _render_api_method(endpoint: Any) -> str:
    """把一个 EndpointSpec 转换成 API 客户端方法。"""

    path_parameters = re.findall(r"\{([^}]+)\}", endpoint.path)
    parameters: list[str] = [f"{name}: string" for name in path_parameters]
    if endpoint.request_entity:
        parameters.append(f"input: {endpoint.request_entity}")
    parameter_text = ", ".join(parameters)
    path = endpoint.path
    for name in path_parameters:
        path = path.replace(f"{{{name}}}", f"${{encodeURIComponent({name})}}")
    path_literal = f"`{path}`" if path_parameters else json.dumps(path)
    response_type = endpoint.response_entity
    if endpoint.collection_response:
        response_type += "[]"
    body_option = ", body: input" if endpoint.request_entity else ""
    return (
        f"async {endpoint.operation_id}({parameter_text}): Promise<{response_type}> {{\n"
        f"  return request<{response_type}>({path_literal}, "
        f"{{ method: \"{endpoint.method}\"{body_option} }});\n"
        "},"
    )


def _fetch_request_runtime() -> str:
    """返回浏览器和 Electron React 使用的 fetch 封装。"""

    return """interface RequestOptions {
  method: string;
  body?: unknown;
}

const createRequest = (config: CommerceApiConfig) =>
  async <T>(path: string, options: RequestOptions): Promise<T> => {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: options.method,
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw new Error(`Commerce API 请求失败：${response.status}`);
    }
    return (await response.json()) as T;
  };"""


def _wechat_request_runtime() -> str:
    """返回微信小程序环境使用的 wx.request Promise 封装。"""

    return """interface RequestOptions {
  method: string;
  body?: unknown;
}

const createRequest = (config: CommerceApiConfig) =>
  <T>(path: string, options: RequestOptions): Promise<T> =>
    new Promise((resolve, reject) => {
      wx.request<T>({
        url: `${config.baseUrl}${path}`,
        method: options.method as WechatMiniprogram.RequestOption["method"],
        header: {
          "Content-Type": "application/json",
          ...config.headers,
        },
        data: options.body,
        success(response) {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(response.data);
            return;
          }
          reject(new Error(`Commerce API 请求失败：${response.statusCode}`));
        },
        fail(error) {
          reject(new Error(error.errMsg));
        },
      });
    });"""


def _indent(text: str, spaces: int) -> str:
    """给多行模板增加固定缩进。"""

    prefix = " " * spaces
    return "\n".join(prefix + line if line else line for line in text.splitlines())
