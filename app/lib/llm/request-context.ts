import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmCredentials } from "./types";

const credentialStorage = new AsyncLocalStorage<LlmCredentials>();

/**
 * 在一次服务端请求的异步调用链中注入模型凭证。
 *
 * 凭证不会进入 LangGraph State，也不会被 Checkpointer 写入 SQLite。
 * AsyncLocalStorage 会把同一请求下的并行 Agent 和 Dynamic Worker 隔离开。
 */
export function runWithLlmCredentials<T>(
  credentials: LlmCredentials,
  callback: () => Promise<T>,
): Promise<T> {
  return credentialStorage.run(credentials, callback);
}

/** 获取当前请求的 Provider 凭证；未建立上下文时返回空对象。 */
export function getRequestLlmCredentials(): LlmCredentials {
  return credentialStorage.getStore() || {};
}
