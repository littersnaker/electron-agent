// 模块说明：工具活动面板纯函数（思考流解析与标签清洗）的单测。
import { describe, expect, it } from "vitest";

import {
  parseThinkingStream,
  sanitizeToolLabel,
  THINK_END,
  THINK_START,
} from "./tool-activity-panel";

describe("parseThinkingStream", () => {
  it("无思考标记时全部为正文", () => {
    const parsed = parseThinkingStream("普通回答");
    expect(parsed).toEqual({ thinking: "", finalText: "普通回答", isThinking: false });
  });

  it("只有开始标记时处于思考中", () => {
    const parsed = parseThinkingStream(`${THINK_START}思考中内容`);
    expect(parsed.isThinking).toBe(true);
    expect(parsed.thinking).toBe("思考中内容");
    expect(parsed.finalText).toBe("");
  });

  it("开始与结束标记齐全时拆出思考与正文", () => {
    const parsed = parseThinkingStream(`${THINK_START}先想想${THINK_END}最终回答`);
    expect(parsed.isThinking).toBe(false);
    expect(parsed.thinking).toBe("先想想");
    expect(parsed.finalText).toBe("最终回答");
  });
});

describe("sanitizeToolLabel", () => {
  it("剥离 emoji 前缀（含变体选择符）", () => {
    expect(sanitizeToolLabel("🛠️ 运行终端命令")).toBe("运行终端命令");
    expect(sanitizeToolLabel("⚙️ 系统设置")).toBe("系统设置");
  });

  it("剥离执行状态前缀", () => {
    // 前缀正则只剥一层（正在/调用/执行…），与既有线上行为一致。
    expect(sanitizeToolLabel("正在调用搜索工具")).toBe("调用搜索工具");
    expect(sanitizeToolLabel("执行搜索")).toBe("搜索");
  });

  it("普通标签原样保留", () => {
    expect(sanitizeToolLabel("读取文件")).toBe("读取文件");
  });
});
