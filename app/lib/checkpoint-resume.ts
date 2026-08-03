import type { AgentCheckpointRequest } from "../types/checkpoints";

/**
 * 构造恢复任务请求。
 *
 * Checkpoint 只保存任务状态和原始配置快照；恢复时应优先使用用户此刻在界面
 * 选中的模型。这样旧模型额度耗尽、Key 失效或 Base URL 调整后，可以直接
 * 切换模型继续未完成 Work，而不会重新执行已经成功的 Work。
 */
export function buildCheckpointResumeRequest(
  savedRequest: AgentCheckpointRequest,
  currentSelectedModel: string,
): AgentCheckpointRequest {
  const selectedModel = currentSelectedModel.trim() || savedRequest.selectedModel;
  return {
    ...savedRequest,
    selectedModel,
  };
}
