import fs from "fs";
import path from "path";
import type { WorkspaceRuntimeInfo } from "./types";

/** 从 LangGraph 状态中的路径生成稳定的工作区描述。 */
export function buildWorkspaceRuntimeInfo(
  workingDir: string,
  projectId: string,
): WorkspaceRuntimeInfo {
  const rootPath = path.resolve(workingDir);
  const pathExists = fs.existsSync(rootPath);
  const isDirectory = pathExists && fs.statSync(rootPath).isDirectory();

  return {
    projectId,
    folderName: path.basename(rootPath) || rootPath,
    rootPath,
    pathExists,
    isDirectory,
  };
}

/**
 * 将工作区信息转换成模型可读文本。
 * Code Agent 已经获得用户授权操作所选项目，因此这里保留绝对路径，
 * 让“当前目录是什么”以及跨工具路径判断可以得到确定答案。
 */
export function formatWorkspaceContext(
  workspace: WorkspaceRuntimeInfo,
): string {
  return [
    `当前项目 ID：${workspace.projectId}`,
    `当前项目文件夹名称：${workspace.folderName}`,
    `当前项目根目录：${workspace.rootPath}`,
    `目录存在：${workspace.pathExists ? "是" : "否"}`,
    `路径类型：${workspace.isDirectory ? "目录" : "无效路径"}`,
  ].join("\n");
}
