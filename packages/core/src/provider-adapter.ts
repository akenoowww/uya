import type {
  ApprovalDecision, ApprovalOption, ConversationMessage, EffortLevel, ExecutionMode, Provider, ToolKind, ToolMeta,
} from "@ide/protocol";

export const effortLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
export const executionModes = ["isolated", "read-only", "agent"] as const satisfies readonly ExecutionMode[];

export function normalizeEffortLevel(value: unknown): EffortLevel | undefined {
  return effortLevels.find((level) => level === value);
}

export function normalizeExecutionMode(value: unknown): ExecutionMode | undefined {
  return executionModes.find((mode) => mode === value);
}

export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  model?: string;
  providerSessionId?: string;
}

export interface AdapterOutput {
  emit(type: "text" | "thinking" | "tool", text: string, meta?: ToolMeta): void;
  raw(line: string): void;
}

export interface AdapterApprovalPrompt {
  toolName: string;
  toolKind: ToolKind;
  title: string;
  detail?: string;
  path?: string;
  command?: string;
  options: ApprovalOption[];
}

export interface AdapterRequest {
  provider: Provider;
  prompt: string;
  model?: string;
  effort?: EffortLevel;
  accessMode?: ExecutionMode;
  workspacePath?: string;
  workingDirectory?: string;
  conversationKey?: string;
  providerSessionId?: string;
  requestApproval?: (prompt: AdapterApprovalPrompt) => Promise<ApprovalDecision>;
  signal: AbortSignal;
  output: AdapterOutput;
  messages?: readonly ConversationMessage[];
}

export interface ProviderAdapter {
  readonly id: string;
  discover(refresh?: boolean): Promise<Provider> | Provider;
  run?(request: AdapterRequest): Promise<Usage>;
  closeSession?(conversationKey: string): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export class AdapterError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message);
    this.name = "AdapterError";
  }
}
