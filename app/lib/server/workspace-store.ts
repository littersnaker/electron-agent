/**
 * 模块职责：Lib Server Workspace Store 对外兼容入口。
 * 说明：内部实现已按企业级单一职责拆分；保留原导入路径，避免影响调用方。
 */
export type { SessionMode } from "./workspace-store/workspace-database";
export type { StoredMessage } from "./workspace-store/workspace-database";
export type { StoredMessageAttachment } from "./workspace-store/workspace-database";
export type { WorkspaceListOptions } from "./workspace-store/workspace-database";
export type { WorkspaceProject } from "./workspace-store/workspace-database";
export type { WorkspaceSession } from "./workspace-store/workspace-database";
export { createProject } from "./workspace-store/workspace-session-repository";
export { createSession } from "./workspace-store/workspace-session-repository";
export { deleteSession } from "./workspace-store/workspace-session-repository";
export { getProjectById } from "./workspace-store/workspace-session-repository";
export { indexProject } from "./workspace-store/workspace-index-repository";
export { listWorkspace } from "./workspace-store/workspace-session-repository";
export { searchProjectIndex } from "./workspace-store/workspace-index-repository";
export { updateSession } from "./workspace-store/workspace-session-repository";
