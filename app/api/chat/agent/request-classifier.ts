import type { AgentRequestMode } from "./types";

const CHANGE_REQUEST_PATTERN =
  /(修改|改造|重构|优化|修复|实现|新增|添加|加上|创建|开发|删除|迁移|替换|更新|写代码|apply|fix|refactor|implement|create|delete)/i;
const WORKSPACE_INFO_PATTERN =
  /(当前目录|工作目录|项目路径|项目根目录|文件夹名|项目名称|当前项目|绑定项目)/i;
const PROJECT_CONTENT_PATTERN =
  /(有哪些|有什么|包含|结构|文件(?!夹)|代码|内容|依赖|模块|搜索|查找|分析)/i;

/**
 * 使用确定性规则分类 Code Agent 请求。
 *
 * 修改意图优先级最高，避免“修改当前项目”被误判成工作区查询；
 * 询问目录内容时走 read_only，只有纯路径/名称问题才走 workspace_info。
 */
export function classifyAgentRequest(userRequest: string): AgentRequestMode {
  if (userRequest.startsWith("[INTERACTIVE_REPLY]")) {
    return "code_change";
  }
  if (CHANGE_REQUEST_PATTERN.test(userRequest)) {
    return "code_change";
  }
  if (
    WORKSPACE_INFO_PATTERN.test(userRequest) &&
    !PROJECT_CONTENT_PATTERN.test(userRequest)
  ) {
    return "workspace_info";
  }
  return "read_only";
}
