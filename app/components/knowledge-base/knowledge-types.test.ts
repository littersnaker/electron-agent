// 模块说明：知识库页面纯函数工具的单测。
import { describe, expect, it } from "vitest";

import { formatBytes, formatTokens, statusLabel } from "./knowledge-types";

describe("formatBytes", () => {
  it("小于 1KB 显示字节", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("KB 与 MB 进制换算", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("恰好 1024 归入 KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });
});

describe("formatTokens", () => {
  it("小数值原样显示", () => {
    expect(formatTokens(999)).toBe("999");
  });

  it("千位与百万位紧凑显示", () => {
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});

describe("statusLabel", () => {
  it("三种索引状态对应中文标签", () => {
    expect(statusLabel("pending")).toBe("待索引");
    expect(statusLabel("ready")).toBe("已就绪");
    expect(statusLabel("error")).toBe("失败");
  });
});
