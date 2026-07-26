"use client";
/**
 * 模块职责：Component AssistantMessageRow 对外兼容入口。
 * 说明：内部实现已按企业级单一职责拆分；保留原导入路径，避免影响调用方。
 */
export { ToolActivity } from "./assistant-message-row/tool-activity-panel";
export { ToolActivityStatus } from "./assistant-message-row/tool-activity-panel";
export { AssistantMessageRow as default } from "./assistant-message-row/assistant-message-row";
