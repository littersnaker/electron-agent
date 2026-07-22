import path from "path";
import { getProjectById } from "@/app/lib/server/workspace-store";
import {
  areWorkspacePathsEqual,
  assertExistingWorkspaceDirectory,
} from "@/app/lib/server/workspace-path";

export interface ResolvedChatWorkspace {
  projectId: string;
  projectName: string;
  workingDir: string;
}

/**
 * 以数据库中的项目记录作为 Code Agent 工作目录的唯一事实来源。
 *
 * 客户端仍会发送 workingDir，便于发现前端状态与数据库状态不一致；
 * 实际执行时始终使用数据库保存的 rootPath，避免客户端伪造路径。
 */
export function resolveChatWorkspace(
  projectIdValue: unknown,
  requestedWorkingDirValue: unknown,
): ResolvedChatWorkspace {
  const projectId =
    typeof projectIdValue === "string" ? projectIdValue.trim() : "";

  if (!projectId) {
    throw new Error("当前 Code 会话没有绑定项目");
  }

  const project = getProjectById(projectId);
  if (!project) {
    throw new Error("当前 Code 会话绑定的项目不存在");
  }

  assertExistingWorkspaceDirectory(project.rootPath);

  const requestedWorkingDir =
    typeof requestedWorkingDirValue === "string"
      ? requestedWorkingDirValue.trim()
      : "";

  if (
    requestedWorkingDir &&
    !areWorkspacePathsEqual(requestedWorkingDir, project.rootPath)
  ) {
    throw new Error("前端工作目录与项目数据库记录不一致，请重新打开项目");
  }

  return {
    projectId: project.id,
    projectName: project.name,
    workingDir: path.resolve(project.rootPath),
  };
}
