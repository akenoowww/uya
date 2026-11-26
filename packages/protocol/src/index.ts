export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ExecutionMode = "isolated" | "read-only" | "agent";
export type ToolKind = "read" | "search" | "edit" | "write" | "shell" | "fetch" | "other";
export type ToolStatus = "running" | "done" | "error";
export type ApprovalDecision = "allow_once" | "allow_session" | "reject";
export type CapabilityDomain = "code" | "webdev" | "text" | "vision" | "search" | "audio" | "image" | "video";
export type CapabilityOutputKind = "text" | "json" | "audio" | "image" | "video" | "file";

export interface OriginActor {
  alias: string;
  providerId: string;
  kind: "consult" | "handoff" | "red_team" | "mission" | "forward";
}

export interface SplitPresence {
  paneId: string;
  alias: string;
  role?: string;
  providerId: string;
  providerName: string;
  model?: string;
  effort?: EffortLevel;
  accessMode: ExecutionMode;
  busy: boolean;
}

export interface WorkbenchSnapshot {
  workspacePath: string | null;
  gitBranch: string | null;
  activeFilePath?: string;
  selectionPath?: string;
  splits: SplitPresence[];
}

export interface ArtifactItem {
  id: string;
  kind: CapabilityOutputKind;
  label: string;
  path: string;
  mimeType?: string;
  bytes?: number;
  sourceId?: string;
  createdAt: number;
}

export interface SynapseCallInfo {
  id: string;
  kind: "consult" | "red_team" | "capability" | "verify" | "handoff";
  target: string;
  domain?: CapabilityDomain;
  status: "running" | "done" | "error";
  summary?: string;
  childRunId?: string;
}

export interface UiCommand {
  action: "open_file" | "open_diff" | "focus_split";
  path?: string;
  line?: number;
  paneId?: string;
}

export interface ToolMeta {
  id?: string;
  name: string;
  kind: ToolKind;
  status: ToolStatus;
  path?: string;
  command?: string;
  summary?: string;
  output?: string;
}

export interface ApprovalOption {
  id: string;
  label: string;
  kind: "allow_once" | "allow_session" | "reject_once" | "reject_always";
}

export interface ApprovalRequest {
  requestId: string;
  runId: string;
  toolName: string;
  toolKind: ToolKind;
  title: string;
  detail?: string;
  path?: string;
  command?: string;
  options: ApprovalOption[];
  createdAt: number;
}

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
  supportedModes?: ExecutionMode[];
  supportsPersistentSession?: boolean;
  supportsMcp?: boolean;
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
  accessMode?: ExecutionMode;
  includeWorkspaceMap?: boolean;
  activeFilePath?: string;
  arenaId?: string;
  arenaSlotId?: string;
  createCheckpoint?: boolean;
  synapseEnabled?: boolean;
  workbenchSnapshot?: WorkbenchSnapshot;
  originActor?: OriginActor;
  broadcastGroupId?: string;
  includeProjectRules?: boolean;
  prompt: string;
  contextPaths?: string[];
  attachments?: TextContext[];
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
  broadcastGroupId?: string;
  providerId: string;
  providerName?: string;
  model?: string;
  effort?: EffortLevel;
  accessMode?: ExecutionMode;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  ttftMs?: number;
  exitCode?: number;
  error?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  checkpointId?: string;
  arenaId?: string;
  arenaSlotId?: string;
  providerSessionId?: string;
  originActor?: OriginActor;
  promptVersion?: string;
}

export type RunEvent = { runId: string; seq: number } & (
  | { type: "text" | "thinking"; text: string }
  | { type: "tool"; text: string; meta?: ToolMeta }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; requestId: string; decision: ApprovalDecision }
  | { type: "artifact"; artifact: ArtifactItem }
  | { type: "synapse_call"; call: SynapseCallInfo }
  | { type: "mission_proposed"; mission: MissionPlan }
  | { type: "ui_command"; command: UiCommand }
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

export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  glob?: string;
  maxResults?: number;
  workspacePath?: string;
}

export interface SearchMatch {
  line: number;
  column: number;
  text: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  query: string;
  files: SearchFileResult[];
  totalMatches: number;
  truncated: boolean;
  engine: "rg" | "native";
}

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

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
  commit?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitCommitResult {
  hash: string;
  shortHash: string;
  branch: string;
  subject: string;
}

export interface CheckpointSummary {
  id: string;
  runId?: string;
  workspacePath: string;
  createdAt: number;
  label: string;
  filesCount: number;
  restoredAt?: number;
}

export interface CheckpointRestoreResult {
  id: string;
  restoredFiles: string[];
  removedFiles: string[];
}

export interface ArenaSlotFileStat {
  path: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
}

export interface ArenaVerifySummary {
  command: string;
  status: "idle" | "running" | "passed" | "failed" | "cancelled";
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
}

export interface ArenaSlotInput {
  paneId: string;
  providerId: string;
  providerName: string;
  model?: string;
  effort?: EffortLevel;
}

export interface ArenaSlot {
  id: string;
  arenaId: string;
  paneId: string;
  providerId: string;
  providerName: string;
  model?: string;
  effort?: EffortLevel;
  runId?: string;
  branch: string;
  worktreePath: string;
  status: "ready" | "running" | "succeeded" | "failed" | "applied" | "discarded";
  filesChanged: number;
  additions: number;
  deletions: number;
  files: ArenaSlotFileStat[];
  verify?: ArenaVerifySummary;
}

export interface ArenaSummary {
  id: string;
  workspacePath: string;
  baseBranch: string;
  baseCommit: string;
  prompt: string;
  createdAt: number;
  status: "active" | "applied" | "discarded";
  appliedSlotId?: string;
  slots: ArenaSlot[];
}

export interface ArenaApplyResult {
  arenaId: string;
  slotId: string;
  mode: "workspace" | "branch";
  branchName?: string;
  checkpointId?: string;
  appliedFiles: string[];
}

export interface VerifyPreset {
  id: string;
  label: string;
  command: string;
  source: string;
}

export interface VerifyRun {
  id: string;
  workspacePath: string;
  cwd: string;
  command: string;
  status: "running" | "passed" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  output: string;
  truncated: boolean;
}

export interface ProjectRuleFile {
  path: string;
  bytes: number;
}

export interface ConversationSummary {
  id: string;
  workspacePath: string | null;
  title: string;
  providerId: string;
  providerName?: string;
  model?: string;
  effort?: EffortLevel;
  turnCount: number;
  lastRunAt: number;
  lastStatus: RunStatus;
}

export interface ProviderUsageStats {
  providerId: string;
  providerName: string;
  runs: number;
  succeeded: number;
  failed: number;
  avgTtftMs?: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  estimatedCostUsd?: number;
  efforts: Record<string, number>;
}

export interface UsageStats {
  days: number;
  totalRuns: number;
  byProvider: ProviderUsageStats[];
}

export interface BinaryFile {
  path: string;
  mimeType: string;
  base64: string;
  bytes: number;
}

export interface ArenaBenchmarkEntry {
  modelSlug: string;
  displayName: string;
  organization?: string;
  domain: CapabilityDomain;
  elo: number;
  rank: number;
  updatedAt: number;
}

export interface DomainPreferenceOverride {
  providerId: string;
  model?: string;
  effort?: EffortLevel;
}

export interface ModelCapabilityScore {
  providerId: string;
  providerName: string;
  model: string;
  domainScores: Partial<Record<CapabilityDomain, { elo: number; rank?: number }>>;
  localRuns: number;
  localVerifyPassed: number;
  localVerifyTotal: number;
  localArenaWins: number;
  avgTtftMs?: number;
  cacheHitRate?: number;
  compositeScore: number;
  recommendedEffort: EffortLevel;
}

export interface SpecialistRecommendation {
  domain: CapabilityDomain;
  providerId: string;
  providerName: string;
  model?: string;
  effort: EffortLevel;
  elo?: number;
  localWinRate?: number;
  reason: string;
}

export interface CapabilityMatrixSnapshot {
  syncedAt: number | null;
  source: string;
  entriesCount: number;
  models: ModelCapabilityScore[];
  recommendations: Partial<Record<CapabilityDomain, SpecialistRecommendation>>;
  overrides: Partial<Record<CapabilityDomain, DomainPreferenceOverride>>;
}

export interface CapabilityInputField {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  enum?: string[];
}

export interface CapabilityPollSpec {
  urlTemplate: string;
  statusPath: string;
  doneValues: string[];
  failedValues: string[];
  resultUrlPath: string;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface CapabilityRestSpec {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  inputSchema: CapabilityInputField[];
  outputKind: CapabilityOutputKind;
  outputPathTemplate?: string;
  responsePath?: string;
  poll?: CapabilityPollSpec;
}

export interface CapabilityMcpSpec {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface CapabilityPack {
  id: string;
  name: string;
  description: string;
  domain: CapabilityDomain;
  kind: "rest" | "mcp-stdio" | "mcp-http";
  enabled: boolean;
  builtin?: boolean;
  scope?: "builtin" | "global" | "project";
  requiresApproval: boolean;
  secretKeys: string[];
  configuredSecrets?: string[];
  rest?: CapabilityRestSpec;
  mcp?: CapabilityMcpSpec;
}

export interface CapabilityInvokeResult {
  text: string;
  artifact?: ArtifactItem;
}

export interface MissionStep {
  id: string;
  title: string;
  domain: CapabilityDomain;
  kind: "agent" | "capability" | "verify";
  providerId?: string;
  providerName?: string;
  model?: string;
  effort?: EffortLevel;
  accessMode?: ExecutionMode;
  capabilityId?: string;
  capabilityArgs?: Record<string, unknown>;
  contract: string;
  verifyCommand?: string;
  status: "proposed" | "running" | "succeeded" | "failed" | "skipped";
  runId?: string;
  summary?: string;
  artifact?: ArtifactItem;
}

export interface MissionPlan {
  id: string;
  workspacePath: string | null;
  title: string;
  objective: string;
  createdByRunId?: string;
  status: "proposed" | "running" | "completed" | "cancelled" | "failed";
  autonomous: boolean;
  maxHops: number;
  hopsUsed: number;
  steps: MissionStep[];
  createdAt: number;
  updatedAt: number;
}

type Empty = Record<string, never>;

export interface RpcMethods {
  "providers.list": [{ refresh?: boolean }, Provider[]];
  "providers.add": [CustomProviderInput, Provider];
  "providers.update": [CustomProviderInput & { id: string }, Provider];
  "providers.remove": [{ id: string }, null];
  "runs.start": [RunInput, RunSummary];
  "runs.get": [{ id: string }, RunDetail];
  "runs.list": [{ limit?: number; query?: string; workspacePath?: string | null }, RunSummary[]];
  "runs.conversation": [{ id: string; workspacePath: string | null }, RunDetail[]];
  "runs.conversations": [{ limit?: number; query?: string; workspacePath?: string | null }, ConversationSummary[]];
  "runs.fork": [{ conversationId: string; upToRunId?: string; workspacePath: string | null }, { conversationId: string; runs: RunDetail[] }];
  "runs.delete": [{ id: string }, null];
  "runs.deleteConversation": [{ id: string; workspacePath: string | null }, null];
  "runs.usage": [{ days?: number }, UsageStats];
  "runs.cancel": [{ id: string }, null];
  "runs.respondApproval": [{ runId: string; requestId: string; decision: ApprovalDecision }, null];
  "runs.closeSession": [{ conversationId: string; workspacePath: string | null }, null];
  "runs.getRules": [Empty, RoutingRule[]];
  "runs.setRules": [{ rules: RoutingRule[] }, RoutingRule[]];
  "workspace.open": [{ path: string }, WorkspaceInfo];
  "workspace.close": [{ path: string }, null];
  "workspace.list": [{ path?: string; workspacePath?: string }, DirectoryEntry[]];
  "workspace.files": [{ query?: string; limit?: number; workspacePath?: string }, string[]];
  "workspace.search": [SearchOptions, SearchResponse];
  "workspace.read": [{ path: string; workspacePath?: string }, TextFile];
  "workspace.readBinary": [{ path: string; workspacePath?: string }, BinaryFile];
  "workspace.write": [{ path: string; text: string; revision: string; workspacePath?: string }, TextFile];
  "workspace.create": [{ path: string; kind: "file" | "directory"; text?: string; workspacePath?: string }, DirectoryEntry];
  "workspace.rename": [{ from: string; to: string; workspacePath?: string }, DirectoryEntry];
  "workspace.remove": [{ path: string; workspacePath?: string }, null];
  "workspace.projectRules": [{ workspacePath?: string }, ProjectRuleFile[]];
  "git.status": [{ workspacePath?: string }, GitStatus];
  "git.diff": [{ path?: string; staged?: boolean; workspacePath?: string }, GitDiffResult];
  "git.stage": [{ paths?: string[]; all?: boolean; workspacePath?: string }, GitStatus];
  "git.unstage": [{ paths?: string[]; all?: boolean; workspacePath?: string }, GitStatus];
  "git.discard": [{ paths: string[]; workspacePath?: string }, GitStatus];
  "git.commit": [{ message: string; workspacePath?: string }, GitCommitResult];
  "git.branches": [{ workspacePath?: string }, GitBranch[]];
  "git.checkout": [{ branch: string; workspacePath?: string }, GitStatus];
  "git.createBranch": [{ name: string; checkout?: boolean; workspacePath?: string }, GitStatus];
  "git.log": [{ limit?: number; workspacePath?: string }, GitCommit[]];
  "checkpoints.list": [{ workspacePath?: string; limit?: number }, CheckpointSummary[]];
  "checkpoints.restore": [{ id: string; workspacePath?: string }, CheckpointRestoreResult];
  "arena.create": [{ workspacePath?: string; prompt: string; slots: ArenaSlotInput[]; includeDirty?: boolean }, ArenaSummary];
  "arena.get": [{ id: string }, ArenaSummary];
  "arena.list": [{ workspacePath?: string; limit?: number }, ArenaSummary[]];
  "arena.slotDiff": [{ arenaId: string; slotId: string; path?: string }, GitDiffResult];
  "arena.verify": [{ arenaId: string; slotId: string; command: string }, ArenaSlot];
  "arena.apply": [{ arenaId: string; slotId: string; mode: "workspace" | "branch"; branchName?: string; cleanup?: boolean }, ArenaApplyResult];
  "arena.discard": [{ arenaId: string }, null];
  "verify.presets": [{ workspacePath?: string }, VerifyPreset[]];
  "verify.start": [{ command: string; workspacePath?: string; arenaId?: string; arenaSlotId?: string }, VerifyRun];
  "verify.get": [{ id: string }, VerifyRun];
  "verify.cancel": [{ id: string }, null];
  "prompts.list": [Empty, PromptSummary[]];
  "prompts.read": [{ ref: PromptRef }, PromptDocument];
  "prompts.write": [{ ref: PromptRef; source: string; revision?: string }, PromptDocument];
  "prompts.render": [{ ref: PromptRef; values: Record<string, string> }, RenderedPrompt];
  "synapse.matrix": [{ workspacePath?: string | null }, CapabilityMatrixSnapshot];
  "synapse.syncArena": [Empty, CapabilityMatrixSnapshot];
  "synapse.setOverride": [{ domain: CapabilityDomain; providerId: string | null; model?: string; effort?: EffortLevel; workspacePath?: string | null }, CapabilityMatrixSnapshot];
  "synapse.recommend": [{ domain: CapabilityDomain; workspacePath?: string | null; preferWarmProviderId?: string }, SpecialistRecommendation | null];
  "capabilities.list": [{ workspacePath?: string | null }, CapabilityPack[]];
  "capabilities.save": [{ pack: CapabilityPack }, CapabilityPack];
  "capabilities.remove": [{ id: string }, null];
  "capabilities.setSecret": [{ key: string; value: string | null }, { configuredKeys: string[] }];
  "capabilities.invoke": [{ id: string; args: Record<string, unknown>; workspacePath?: string | null; runId?: string }, CapabilityInvokeResult];
  "missions.list": [{ workspacePath?: string | null; limit?: number }, MissionPlan[]];
  "missions.get": [{ id: string }, MissionPlan];
  "missions.approve": [{ id: string; autonomous?: boolean; stepOverrides?: Array<{ stepId: string; providerId?: string; model?: string; effort?: EffortLevel }> }, MissionPlan];
  "missions.cancel": [{ id: string }, MissionPlan];
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M][0];
export type RpcResult<M extends RpcMethod> = RpcMethods[M][1];
export type RpcCall = <M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
) => Promise<RpcResult<M>>;
