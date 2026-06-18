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
