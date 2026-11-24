import type { ConversationMessage, EffortLevel, Provider } from "@ide/protocol";

export const effortLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];

export function normalizeEffortLevel(value: unknown): EffortLevel | undefined {
  return effortLevels.find((level) => level === value);
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface AdapterOutput {
  emit(type: "text" | "thinking" | "tool", text: string): void;
  raw(line: string): void;
}

export interface AdapterRequest {
  provider: Provider;
  prompt: string;
  model?: string;
  effort?: EffortLevel;
  signal: AbortSignal;
  output: AdapterOutput;
  messages?: readonly ConversationMessage[];
}

export interface ProviderAdapter {
  readonly id: string;
  discover(refresh?: boolean): Promise<Provider> | Provider;
  run?(request: AdapterRequest): Promise<Usage>;
}

export class AdapterError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message);
    this.name = "AdapterError";
  }
}
