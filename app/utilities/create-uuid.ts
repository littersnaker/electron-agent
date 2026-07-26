// 模块说明：创建具备会话前缀的本地唯一标识。
/** 创建聊天会话 ID。 */
export function createChatSessionId(): string {
  const randomSegment = Math.random().toString(36).slice(2, 9);
  return `session_${Date.now()}${randomSegment}`;
}

/** @deprecated 请使用 createChatSessionId。 */
export const createSessionId = createChatSessionId;
