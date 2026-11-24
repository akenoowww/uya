export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Provider {
  id: string;
  name: string;
  kind: "cli" | "runtime";
  structured: boolean;
  terminal: boolean;
  available: boolean;
  command?: string;
  configuredCommand?: string;
  terminalArgs?: string[];
  structuredArgs?: string[];
  models?: string[];
  defaultModel?: string;
  supportedEfforts?: EffortLevel[];
  defaultEffort?: EffortLevel;
  modelEfforts?: Record<string, EffortLevel[]>;
  detail?: string;
}

export interface CustomProviderInput {
  name: string;
  command: string;
  args: string[];
  structuredArgs?: string[];
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type RoutingMode = "manual" | "rule" | "fallback";

export interface RoutingRule {
  providerId: string;
  tag?: string;
  extension?: string;
  minContextChars?: number;
}

export interface RunInput {
  conversationId?: string;
  workspacePath?: string | null;
  providerId?: string;
  model?: string;
  effort?: EffortLevel;
  prompt: string;
  contextPaths?: string[];
  selection?: EditorSelection;
  mode?: RoutingMode;
  fallbackIds?: string[];
  tags?: string[];
  promptVersion?: string;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface RunSummary {
  id: string;
  conversationId?: string;
  providerId: string;
  providerName?: string;
  model?: string;
  effort?: EffortLevel;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  ttftMs?: number;
  exitCode?: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  promptVersion?: string;
}

export type RunEvent = { runId: string; seq: number } & (
  | { type: "text" | "thinking" | "tool"; text: string }
  | { type: "status"; run: RunSummary }
);

export interface RunDetail {
  run: RunSummary;
  events: RunEvent[];
}

export interface WorkspaceInfo {
  path: string;
  name: string;
}

export interface DirectoryEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export interface TextFile {
  path: string;
  text: string;
  revision: string;
}

export type TextContext = Pick<TextFile, "path" | "text">;
export type EditorSelection = TextFile;

export interface PromptRef {
  scope: "project" | "global";
  path: string;
}

export interface PromptSummary {
  ref: PromptRef;
  title: string;
}

export interface PromptVariable {
  name: string;
  defaultValue?: string;
}

export interface PromptDocument extends PromptSummary {
  parseError?: string;
  source: string;
  revision: string;
  body: string;
  variables: PromptVariable[];
  providerId?: string;
  effort?: EffortLevel;
  mode?: RoutingMode;
}

export interface RenderedPrompt {
  text: string;
  revision: string;
  providerId?: string;
  effort?: EffortLevel;
  mode?: RoutingMode;
}

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  changes: GitFileChange[];
}

export interface GitDiffResult {
  path?: string;
  staged: boolean;
  diff: string;
  original?: string;
  modified?: string;
}

export interface ProjectRuleFile {
  path: string;
  bytes: number;
}

type Empty = Record<string, never>;

export interface RpcMethods {
  "providers.list": [{ refresh?: boolean }, Provider[]];
  "providers.add": [CustomProviderInput, Provider];
  "providers.update": [CustomProviderInput & { id: string }, Provider];
  "providers.remove": [{ id: string }, null];
  "runs.start": [RunInput, RunSummary];
  "runs.get": [{ id: string }, RunDetail];
  "runs.list": [{ limit?: number }, RunSummary[]];
  "runs.conversation": [{ id: string; workspacePath: string | null }, RunDetail[]];
  "runs.cancel": [{ id: string }, null];
  "runs.getRules": [Empty, RoutingRule[]];
  "runs.setRules": [{ rules: RoutingRule[] }, RoutingRule[]];
  "workspace.open": [{ path: string }, WorkspaceInfo];
  "workspace.close": [{ path: string }, null];
  "workspace.list": [{ path?: string; workspacePath?: string }, DirectoryEntry[]];
  "workspace.files": [{ query?: string; limit?: number; workspacePath?: string }, string[]];
  "workspace.read": [{ path: string; workspacePath?: string }, TextFile];
  "workspace.write": [{ path: string; text: string; revision: string; workspacePath?: string }, TextFile];
  "workspace.create": [{ path: string; kind: "file" | "directory"; text?: string; workspacePath?: string }, DirectoryEntry];
  "workspace.rename": [{ from: string; to: string; workspacePath?: string }, DirectoryEntry];
  "workspace.remove": [{ path: string; workspacePath?: string }, null];
  "workspace.projectRules": [{ workspacePath?: string }, ProjectRuleFile[]];
  "git.status": [{ workspacePath?: string }, GitStatus];
  "git.diff": [{ path?: string; staged?: boolean; workspacePath?: string }, GitDiffResult];
  "prompts.list": [Empty, PromptSummary[]];
  "prompts.read": [{ ref: PromptRef }, PromptDocument];
  "prompts.write": [{ ref: PromptRef; source: string; revision?: string }, PromptDocument];
  "prompts.render": [{ ref: PromptRef; values: Record<string, string> }, RenderedPrompt];
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M][0];
export type RpcResult<M extends RpcMethod> = RpcMethods[M][1];
export type RpcCall = <M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
) => Promise<RpcResult<M>>;
