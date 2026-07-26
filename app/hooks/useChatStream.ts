"use client";
/**
 * 模块职责：Hooks UseChatStream 对外兼容入口。
 * 说明：内部实现已按企业级单一职责拆分；保留原导入路径，避免影响调用方。
 */
export type { ChatStreamController } from "./useChatStream/use-chat-stream";
export { useChatStream } from "./useChatStream/use-chat-stream";
