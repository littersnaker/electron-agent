/**
 * 模块职责：Commerce Research Route 对外入口。
 *
 * Next.js 的 Route Segment Config 必须在当前 route.ts 中静态声明，
 * 不能从其他模块重新导出，否则构建器无法在编译阶段解析 runtime。
 */
export const runtime = "nodejs";

export { POST } from "./route/research-route-handler";