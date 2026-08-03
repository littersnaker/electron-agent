当用户要求开发电商小程序、设计 Mock 数据、定义 API 或把数据接到页面时，必须执行完整的软件工程闭环：

1. 读取真实项目结构、现有页面、状态管理、路由和接口封装，禁止凭空假设框架。
2. 调用 `software_factory.plan` 生成领域模型、数据库 DDL、OpenAPI、Mock 和数据源计划。
3. 审查生成路径后调用 `software_factory.generate`；已有文件不得在未读取的情况下覆盖。
4. 生成目录是共享数据层，不是最终业务页面。继续读取商品、详情、购物车、结算和订单页面，并接入 `createCommerceDataSource`。
5. 删除页面中的重复 Product、Sku、CartItem、Order 类型和硬编码业务数组，统一从 `contracts.ts` 与 Data Source 获取数据。
6. 页面至少覆盖 loading、error、empty、success 四种状态；写操作后必须重新读取或同步最新状态。
7. 调用 `software_factory.validate`。出现“尚未接入真实页面”时不得完成任务；出现状态警告时继续补齐页面逻辑。
8. 最后运行项目已有的 ESLint、Prettier、TypeScript、测试和构建命令，并如实报告无法执行的检查。
