import type { ConversationMessage, Provider } from "@ide/protocol";

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
  signal: AbortSignal;
  output: AdapterOutput;
  messages?: readonly ConversationMessage[];
}

export interface ProviderAdapter {
  readonly id: string;
  discover(): Promise<Provider> | Provider;
  run?(request: AdapterRequest): Promise<Usage>;
}

export class AdapterError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message);
    this.name = "AdapterError";
  }
}
