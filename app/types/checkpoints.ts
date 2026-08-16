import type {
  AttachedFile,
  CodeAgentExecutionMode,
  ComposerMode,
  ImageEditFidelity,
  TypographyPolicy,
} from "../constants/page-constants";
import type { CommerceWorkflowMode } from "../lib/commerce/listing/types";
import type { CommerceMarketplaceCode } from "../lib/commerce/types";

export type AgentCheckpointKind = "qa" | "code" | "media" | "commerce" | "image";
export type AgentCheckpointStatus =
  | "running"
  | "paused"
  | "interrupted"
  | "failed"
  | "completed"
  | "discarded";

export interface AgentCheckpointRequest {
  input: string;
  selectedModel: string;
  composerMode: ComposerMode;
  codeAgentMode: CodeAgentExecutionMode;
  attachments: AttachedFile[];
  commerceWorkflowMode: CommerceWorkflowMode;
  commerceMarketplace: CommerceMarketplaceCode;
  typographyPolicy: TypographyPolicy;
  imageEditFidelity: ImageEditFidelity;
  enableQualityGuard: boolean;
}

export interface AgentCheckpoint {
  id: string;
  sessionId: string;
  agentKind: AgentCheckpointKind;
  route: string;
  status: AgentCheckpointStatus;
  resumable: boolean;
  request: AgentCheckpointRequest;
  state: Record<string, unknown>;
  label: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface CheckpointFinishResult {
  status: "completed" | "paused" | "interrupted" | "failed";
  error?: string;
}
