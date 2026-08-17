// 模块说明：右侧 Agent 执行图（DAG），所有 Agent 共用。
// 由 lifecycle 事件 + 工具活动实时构建节点/边，节点状态着色，可缩放平移。
"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { AgentLifecycleEventPayload } from "../../types/workspace";
import type { ToolActivity } from "../AssistantMessageRow";

const COLORS = {
  text: "var(--text-primary)",
  textSubtle: "var(--text-tertiary)",
  border: "var(--border)",
  green: "var(--accent-green)",
  red: "var(--accent-red)",
  amber: "var(--accent-amber)",
  blue: "var(--accent-blue)",
};

type GraphNodeData = {
  label: string;
  category: "stage" | "tool";
  status?: string;
  detail?: string;
};

function ExecutionNode({ data }: NodeProps<Node<GraphNodeData>>) {
  const failed = data.status === "error" || data.status === "failed";
  const running = data.status === "running";
  const color = failed ? COLORS.red : running ? COLORS.amber : COLORS.green;
  return (
    <div
      className="rounded-[10px] border px-2.5 py-1.5 text-[11px]"
      style={{
        borderColor: color,
        background: "var(--glass)",
        color: COLORS.text,
        minWidth: 120,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="font-semibold" style={{ color }}>
        {data.category === "tool" ? "🛠 " : ""}
        {data.label}
      </div>
      {data.detail ? (
        <div
          className="mt-0.5 break-words text-[10px]"
          style={{ color: COLORS.textSubtle }}
        >
          {data.detail}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { execution: ExecutionNode };

export default function ExecutionGraphPanel({
  lifecycleEvents,
  toolActivities,
}: {
  lifecycleEvents: AgentLifecycleEventPayload[];
  toolActivities: ToolActivity[];
}) {
  const { nodes, edges } = useMemo(() => {
    const built: Node<GraphNodeData>[] = [];
    const links: Edge[] = [];
    let cursor = 0;

    const push = (node: Node<GraphNodeData>) => {
      if (built.length > 0) {
        links.push({
          id: `e-${built.length}`,
          source: built[built.length - 1].id,
          target: node.id,
          style: { stroke: COLORS.border },
        });
      }
      built.push(node);
    };

    for (const event of lifecycleEvents) {
      const detail = (event.detail || "").slice(0, 80);
      push({
        id: `lf-${event.id || cursor}`,
        type: "execution",
        position: { x: 0, y: cursor * 86 },
        data: {
          label: `${event.role}${event.iteration > 1 ? ` #${event.iteration}` : ""}`,
          category: "stage",
          status: event.status,
          detail,
        },
      });
      cursor += 1;
    }

    for (const activity of toolActivities) {
      push({
        id: `tool-${activity.id || cursor}`,
        type: "execution",
        position: { x: 0, y: cursor * 86 },
        data: {
          label: activity.label || "工具调用",
          category: "tool",
          status: activity.status,
          detail: (activity.detail || "").slice(0, 80),
        },
      });
      cursor += 1;
    }
    return { nodes: built, edges: links };
  }, [lifecycleEvents, toolActivities]);

  if (nodes.length === 0) {
    return (
      <div
        className="rounded-[12px] border px-3 py-2 text-[11px]"
        style={{ borderColor: COLORS.border, color: COLORS.textSubtle }}
      >
        暂无执行步骤，运行 Agent 后这里会展示执行图。
      </div>
    );
  }

  return (
    <div className="rounded-[12px] border" style={{ borderColor: COLORS.border }}>
      <div
        className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em]"
        style={{ color: COLORS.textSubtle }}
      >
        Agent 执行图
      </div>
      <div className="h-[260px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          nodesDraggable
          minZoom={0.4}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
