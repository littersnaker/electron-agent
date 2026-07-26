// 模块说明：负责 types 状态管理与业务编排。
import type { Dispatch, SetStateAction } from "react";
import type { AgentInstance } from "../../components/AgentPanel";

/** Agent 列表状态更新器，供不同业务动作 Hook 复用。 */
export type AgentStateSetter = Dispatch<SetStateAction<AgentInstance[]>>;
