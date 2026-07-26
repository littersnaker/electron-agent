/**
 * 模块职责：Api Commerce Research Route 对外兼容入口。
 * 说明：内部实现已按企业级单一职责拆分；保留原导入路径，避免影响调用方。
 */
export { POST } from "./route/research-route-handler";
export { runtime } from "./route/research-route-helpers";
