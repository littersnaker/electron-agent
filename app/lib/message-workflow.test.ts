// 模块说明：真实事件形状、消息归属、状态收束与快照保存的回归检查。
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { Message } from "../constants/page-constants";
import type { AgentLifecycleEventPayload, StreamPacket } from "../types/workspace";
import { StepsTimeline } from "../components/assistant-message-row/steps-timeline";
import {
  createWorkflow,
  createWorkflowSaver,
  deriveWorkflowSteps,
  finishWorkflow,
  recordWorkflowPacket,
  updateWorkflowMessage,
  workflowDisplayStatus,
} from "./message-workflow";

const life = (id: string, patch: Partial<AgentLifecycleEventPayload> = {}): StreamPacket => ({
  type: "AGENT_LIFECYCLE",
  payload: {
    id,
    agentId: "worker:A",
    role: "modify_worker",
    status: "RUNNING",
    iteration: 0,
    detail: "正在读取文件",
    currentFiles: ["app/page.tsx"],
    createdAt: new Date(1000).toISOString(),
    ...patch,
  },
});
const tool = (content: string): StreamPacket => ({ type: "TOOL_STATUS", content });

afterEach(() => vi.useRealTimers());
describe("工作快照", () => {
  it("普通 QA 和内部推理不产生工作步骤", () => {
    const workflow = createWorkflow("qa", undefined, 0);
    expect(
      recordWorkflowPacket(workflow, { type: "TEXT", content: "<INTERNAL_THINK_START>推理" }),
    ).toBe(workflow);
    expect(recordWorkflowPacket(workflow, { type: "STATUS", content: "正在回答" })).toBe(workflow);
    expect(renderToStaticMarkup(createElement(StepsTimeline, { workflow }))).toBe("");
  });
  it("重复工具更新不加行，完整保存超过八步的记录", () => {
    let workflow = createWorkflow("code", undefined, 0);
    workflow = recordWorkflowPacket(workflow, tool("read_file_from_disk"), 1000);
    workflow = recordWorkflowPacket(workflow, tool("read_file_from_disk"), 2000);
    expect(workflow.toolActivities).toHaveLength(1);
    expect(workflow.toolActivities[0].startedAt).toBe(1000);
    for (let index = 0; index < 12; index++)
      workflow = recordWorkflowPacket(workflow, tool(`工具 ${index}`), 3000 + index);
    expect(deriveWorkflowSteps(finishWorkflow(workflow, "completed", "", 4000))).toHaveLength(13);
  });
  it("并行生命周期按 Agent 合并，并保留文件与返工轮次", () => {
    let workflow = createWorkflow("code", undefined, 0);
    const event = life("a1");
    workflow = recordWorkflowPacket(workflow, event, 1000);
    expect(recordWorkflowPacket(workflow, event)).toBe(workflow);
    workflow = recordWorkflowPacket(workflow, life("b1", { agentId: "worker:B" }), 1200);
    workflow = recordWorkflowPacket(
      workflow,
      life("a2", {
        status: "COMPLETED",
        detail: "已修改文件",
        currentFiles: ["app/layout.tsx"],
        createdAt: new Date(2000).toISOString(),
      }),
      2000,
    );
    let steps = deriveWorkflowSteps(workflow, true);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      status: "completed",
      startedAt: 1000,
      files: ["app/page.tsx", "app/layout.tsx"],
      detail: "已修改文件",
    });
    workflow = recordWorkflowPacket(workflow, life("retry", { iteration: 1 }), 2200);
    steps = deriveWorkflowSteps(workflow, true);
    expect(steps).toHaveLength(3);
    expect(steps.some((step) => step.iteration === 1)).toBe(true);
  });
  it("漫剧各动作可追溯，命中角色库与分镜阶段都保留", () => {
    let workflow = createWorkflow("media", undefined, 0);
    for (const [index, detail] of [
      "提取角色卡",
      "小夜：命中角色库",
      "分镜 1：生成画面",
      "分镜 2：生成视频",
      "合成成片",
    ].entries()) {
      workflow = recordWorkflowPacket(
        workflow,
        life(`media${index}`, {
          agentId: "media_agent",
          role: "media_agent",
          detail,
          createdAt: new Date(index + 1000).toISOString(),
        }),
        index + 1000,
      );
    }
    const steps = deriveWorkflowSteps(finishWorkflow(workflow, "completed", "", 5000));
    expect(steps.map((step) => step.label)).toEqual([
      "提取角色卡",
      "小夜：命中角色库",
      "分镜 1：生成画面",
      "分镜 2：生成视频",
      "合成成片",
    ]);
    expect(steps.every((step) => step.status === "completed")).toBe(true);
  });
  it("电商同阶段进度更新归为一步", () => {
    let workflow = createWorkflow("commerce-research", undefined, 0);
    for (let index = 1; index < 4; index++)
      workflow = recordWorkflowPacket(
        workflow,
        {
          type: "COMMERCE_PROGRESS",
          payload: { stage: "collect", progress: 20 + index, detail: `采集 ${index}` },
        },
        1000 + index,
      );
    expect(workflow.toolActivities).toHaveLength(1);
    expect(workflow.toolActivities[0].detail).toBe("采集 3");
  });
  it("图片识别使用真实 payload 阶段，更新不新增行且保留错误", () => {
    let workflow = createWorkflow("image", undefined, 0);
    for (const detail of ["识别照片 1", "识别照片 2"])
      workflow = recordWorkflowPacket(
        workflow,
        { type: "STATUS", payload: { stage: "recognizing", detail } },
        1000,
      );
    expect(workflow.toolActivities).toHaveLength(1);
    expect(workflow.detail).toBe("识别照片 2");
    workflow = recordWorkflowPacket(
      workflow,
      { type: "STATUS", payload: { stage: "error", detail: "识别失败" } },
      2000,
    );
    expect(finishWorkflow(workflow, "completed").status).toBe("failed");
    expect(workflow.detail).toBe("识别失败");
  });
  it.each(["failed", "stopped", "waiting", "interrupted", "completed"] as const)(
    "结束状态 %s 不被统一标为完成",
    (status) => {
      const workflow = recordWorkflowPacket(
        createWorkflow("code", undefined, 0),
        tool("运行测试"),
        1000,
      );
      const finished = finishWorkflow(workflow, status, "真实结果", 2000);
      expect(finished.status).toBe(status);
      expect(deriveWorkflowSteps(finished)[0].status).toBe(status === "failed" ? "error" : status);
      expect(finished.detail).toBe("真实结果");
    },
  );
  it("失败事件即使正常 EOF 也保留失败，恢复后可继续同一轮", () => {
    let workflow = recordWorkflowPacket(
      createWorkflow("code", undefined, 0),
      tool("运行测试"),
      1000,
    );
    workflow = recordWorkflowPacket(
      workflow,
      { type: "AGENT_ERROR", agent: { currentTask: "测试失败" } },
      2000,
    );
    expect(finishWorkflow(workflow, "completed").status).toBe("failed");
    const waiting = finishWorkflow(workflow, "waiting", "等待批准", 3000);
    const resumed = createWorkflow("code", waiting, 4000);
    expect(resumed.id).toBe(waiting.id);
    expect(resumed.toolActivities).toEqual(waiting.toolActivities);
    expect(resumed.endedAt).toBeUndefined();
    expect(workflowDisplayStatus(resumed, false)).toBe("interrupted");
    expect(workflowDisplayStatus(resumed, true)).toBe("running");
  });
  it("等待确认事件记录原因；正文和后续卡片不覆盖工作历史", () => {
    const workflow = recordWorkflowPacket(
      createWorkflow("media"),
      life("start", { role: "media_agent" }),
    );
    const pending = recordWorkflowPacket(workflow, {
      type: "INTERACTIVE_REQUEST",
      payload: {
        id: "approve",
        prompt: "请确认分镜",
        command: "",
        mode: "normal",
        suggestedMode: "user",
        options: [],
        promptRound: 0,
        recentOutput: "",
      },
    });
    expect(pending.status).toBe("waiting");
    expect(pending.detail).toBe("请确认分镜");
    const other = createWorkflow("code");
    const messages: Message[] = [
      { role: "assistant", content: "旧回复", workflow: other },
      {
        role: "assistant",
        content: "",
        workflow,
        attachments: [{ name: "image", type: "image/png" }],
      },
      { role: "assistant", content: "后续 Review" },
    ];
    const next = updateWorkflowMessage(messages, pending, { content: "已生成分镜" });
    expect(next[0]).toBe(messages[0]);
    expect(next[2]).toBe(messages[2]);
    expect(next[1].attachments).toEqual(messages[1].attachments);
    expect(JSON.parse(JSON.stringify(next))[1].workflow).toEqual(pending);
  });
  it("工作清单快照保留，失败工作不会被标为成功", () => {
    const workflow = createWorkflow("code");
    workflow.workListSnapshot = {
      items: [{ id: "work", status: "failed", title: "构建", error: "编译失败" }],
    } as any;
    expect(finishWorkflow(workflow, "completed").status).toBe("failed");
    expect(renderToStaticMarkup(createElement(StepsTimeline, { workflow }))).toContain("工作流程");
  });
  it("默认只显示最近三步，成功折叠且错误原因持续可见", () => {
    let workflow = createWorkflow("code", undefined, 0);
    for (let index = 0; index < 5; index++)
      workflow = recordWorkflowPacket(workflow, tool(`动作 ${index}`), index + 1000);
    const markup = renderToStaticMarkup(createElement(StepsTimeline, { workflow, isLive: true }));
    expect((markup.match(/<li /g) || []).length).toBe(3);
    const completed = renderToStaticMarkup(
      createElement(StepsTimeline, { workflow: finishWorkflow(workflow, "completed", "", 5000) }),
    );
    expect(completed).toContain("已完成");
    expect(completed).not.toContain("<li ");
    expect(
      renderToStaticMarkup(
        createElement(StepsTimeline, { workflow: finishWorkflow(workflow, "failed", "构建失败") }),
      ),
    ).toContain("构建失败");
  });
  it("保存合并快照且串行，最终状态不会被旧请求覆盖", async () => {
    vi.useFakeTimers();
    const saves: string[] = [];
    let release!: () => void;
    const saver = createWorkflowSaver(async (messages) => {
      saves.push(messages[0].content);
      if (messages[0].content === "旧")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    });
    saver.schedule([{ role: "assistant", content: "丢弃" }]);
    saver.schedule([{ role: "assistant", content: "旧" }]);
    await vi.advanceTimersByTimeAsync(1000);
    saver.schedule([{ role: "assistant", content: "待保存" }]);
    const final = saver.flush([{ role: "assistant", content: "最终" }]);
    expect(saves).toEqual(["旧"]);
    release();
    await final;
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toEqual(["旧", "最终"]);
  });
});
