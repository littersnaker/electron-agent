export type Message = {
  role: "user" | "assistant";
  content: string;
};

export type AttachedFile = {
  name: string;
  type: string;
  base64: string;
  textContent?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
};
export interface StreamPacket {
  type?: "TEXT" | "STATUS" | "TOOL_STATUS" | "DIFF_READY";
  content?: string;
  payload?: unknown;
}

export const ToolNameMap: Record<string, string> = {
  list_directory: "🔍 正在扫描文件目录...",
  propose_file_change: "✍️ 正在构思代码修改...",
  read_file_from_disk: "📖 正在读取文件内容...",
  run_terminal_command: "⚙️ 正在执行终端指令...",
  apply_file_change: "✅ 正在应用代码修改...",
  get_diff: "📊 正在对比代码差异...",
  search_codebase: "🔎 正在搜索代码库...",
  get_code_outline:"📝 正在分析代码结构...",
  get_local_time: "⏰ 正在获取本地时间...",
  get_file_content: "📄 正在获取文件内容..."};
