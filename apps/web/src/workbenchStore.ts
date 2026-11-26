import { createStore } from "zustand/vanilla";
import type {
  ArenaSummary, CheckpointSummary, ConversationSummary, EditorSelection, EffortLevel, ExecutionMode,
  MissionPlan, ProjectRuleFile, Provider, RenderedPrompt, RoutingMode, RoutingRule, RpcCall, RunDetail,
  RunSummary, SplitPresence, TextContext, VerifyPreset, VerifyRun, WorkbenchSnapshot, WorkspaceInfo,
} from "@ide/protocol";
import type { Bridge } from "./bridge";
import type { EditorDrafts } from "./editorDrafts";

export interface PaneConfig {
  conversationId?: string;
  providerId?: string;
  model?: string;
  effort?: EffortLevel;
  accessMode?: ExecutionMode;
  mode?: "structured" | "terminal";
  alias?: string;
  role?: string;
}

export interface ChatPane {
  id: string;
  config: PaneConfig;
}

export interface DockSnapshot {
  chatPanes: ChatPane[];
  activePaneId?: string;
  lastChatPaneId?: string;
  editorId?: string;
  filePath?: string;
}

export type SidebarView = "explorer" | "search" | "git" | "history" | null;

export const MAX_CONTEXT_BYTES = 256 * 1024;

export interface WorkbenchState {
  bridge: Bridge | null;
  connectionError: string;
  connectionAttempt: number;
  providers: Provider[];
  rules: RoutingRule[];
  workspace: WorkspaceInfo | null;
  recentWorkspaces: string[];
  gitBranch: string | null;
  gitChangeCount: number;
  projectRules: ProjectRuleFile[];
  includeProjectRules: boolean;
  includeWorkspaceMap: boolean;
  checkpoints: CheckpointSummary[];
  verifyPresets: VerifyPreset[];
  activeVerify: VerifyRun | null;
  arenaEnabled: boolean;
  activeArena: ArenaSummary | null;
  synapseEnabled: boolean;
  missionsById: Record<string, MissionPlan>;
  pendingTerminalCommand: { command: string; nonce: number } | null;
  searchQuerySeed: { query: string; nonce: number } | null;
  editorDrafts: EditorDrafts;
  choosingProject: boolean;
  refreshKey: number;
  dock: DockSnapshot;
  sidebar: SidebarView;
  history: RunSummary[];
  conversations: ConversationSummary[];
  details: Record<string, RunDetail>;
  paneRuns: Record<string, string[]>;
  paneDrafts: Record<string, string>;
  panePromptHistory: Record<string, string[]>;
  composer: string;
  template: RenderedPrompt | null;
  broadcast: boolean;
  broadcastCollapsed: boolean;
  broadcastTargets: string[];
  lastBroadcastGroupId: string | null;
  lastBroadcastRunIds: string[];
  routing: RoutingMode;
  tags: string;
  fallbackIds: string[];
  contextPaths: string[];
  contextSizes: Record<string, number>;
  attachments: TextContext[];
  selection: EditorSelection | null;
  submitting: boolean;
  submittingPanes: string[];
  error: string;
}

export function createWorkbenchStore() {
  return createStore<WorkbenchState>(() => ({
    bridge: null,
    connectionError: "",
    connectionAttempt: 0,
    providers: [],
    rules: [],
    workspace: null,
    recentWorkspaces: [],
    gitBranch: null,
    gitChangeCount: 0,
    projectRules: [],
    includeProjectRules: true,
    includeWorkspaceMap: true,
    checkpoints: [],
    verifyPresets: [],
    activeVerify: null,
    arenaEnabled: false,
    activeArena: null,
    synapseEnabled: true,
    missionsById: {},
    pendingTerminalCommand: null,
    searchQuerySeed: null,
    editorDrafts: new Map(),
    choosingProject: false,
    refreshKey: 0,
    dock: { chatPanes: [] },
    sidebar: "explorer",
    history: [],
    conversations: [],
    details: {},
    paneRuns: {},
    paneDrafts: {},
    panePromptHistory: {},
    composer: "",
    template: null,
    broadcast: true,
    broadcastCollapsed: true,
    broadcastTargets: [],
    lastBroadcastGroupId: null,
    lastBroadcastRunIds: [],
    routing: "manual",
    tags: "",
    fallbackIds: [],
    contextPaths: [],
    contextSizes: {},
    attachments: [],
    selection: null,
    submitting: false,
    submittingPanes: [],
    error: "",
  }));
}

export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>;

export const unavailable: RpcCall = async () => { throw new Error("The local runtime is disconnected."); };

export function workspaceLabel(path: string) {
  return path.split("/").pop() || path;
}

export function conversationKey(root: string | null, id: string | undefined) {
  return JSON.stringify([root, id]);
}

export function providerForPane(providers: Provider[], config: PaneConfig, index: number) {
  if (config.providerId) return providers.find((provider) => provider.id === config.providerId && provider.available);
  const available = providers.filter((provider) => provider.available);
  const structured = available.filter((provider) => provider.structured);
  const choices = structured.length ? structured : available;
  return choices.length ? choices[Math.max(0, index) % choices.length] : undefined;
}

export function resolveModel(provider: Provider | undefined, configuredModel: string | undefined): string | undefined {
  if (!provider) return undefined;
  const trimmed = configuredModel?.trim() || undefined;
  if (provider.kind === "runtime") {
    return trimmed && provider.models?.includes(trimmed) ? trimmed : provider.models?.[0];
  }
  return trimmed;
}

export function resolveAccessMode(
  provider: Provider | undefined,
  configuredMode: ExecutionMode | undefined,
  hasWorkspace: boolean,
): ExecutionMode {
  if (!hasWorkspace) return "isolated";
  const supported = provider?.supportedModes ?? ["isolated"];
  if (configuredMode && supported.includes(configuredMode)) return configuredMode;
  if (supported.includes("read-only")) return "read-only";
  return "isolated";
}

export function shortModelName(model: string | undefined): string {
  if (!model) return "";
  return model.includes("/") ? model.split("/").at(-1) ?? model : model;
}

export function formatDurationCompact(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

export function paneAlias(provider: Provider | undefined, config: PaneConfig, index: number): string {
  const custom = config.alias?.trim();
  if (custom) return custom;
  return provider ? `${provider.id}-${index + 1}` : `split-${index + 1}`;
}

export function paneDisplayTitle(provider: Provider | undefined, config: PaneConfig, index: number): string {
  if (!provider) return `Split ${index + 1}`;
  const model = resolveModel(provider, config.model);
  if (config.mode === "terminal") return `${provider.name} (TUI)`;
  return model ? `${provider.name} · ${shortModelName(model)}` : provider.name;
}

export function buildWorkbenchSnapshot(state: WorkbenchState): WorkbenchSnapshot {
  const hasWorkspace = Boolean(state.workspace);
  const splits: SplitPresence[] = state.dock.chatPanes.flatMap((pane, index) => {
    const provider = providerForPane(state.providers, pane.config, index);
    if (!provider || pane.config.mode === "terminal") return [];
    return [{
      paneId: pane.id,
      alias: paneAlias(provider, pane.config, index),
      ...(pane.config.role ? { role: pane.config.role } : {}),
      providerId: provider.id,
      providerName: provider.name,
      model: resolveModel(provider, pane.config.model),
      effort: pane.config.effort,
      accessMode: resolveAccessMode(provider, pane.config.accessMode, hasWorkspace),
      busy: isPaneBusy(state, pane),
    }];
  });
  return {
    workspacePath: state.workspace?.path ?? null,
    gitBranch: state.gitBranch,
    activeFilePath: state.dock.filePath,
    selectionPath: state.selection?.path,
    splits,
  };
}

export function activeChatPane(dock: DockSnapshot): ChatPane | undefined {
  return dock.chatPanes.find((pane) => pane.id === dock.activePaneId)
    ?? dock.chatPanes.find((pane) => pane.id === dock.lastChatPaneId)
    ?? dock.chatPanes[0];
}

export function routingTargets(
  providers: Provider[],
  dock: DockSnapshot,
  broadcast: boolean,
  broadcastTargets: readonly string[] = [],
) {
  const targets = dock.chatPanes.flatMap((pane, index) => {
    const provider = providerForPane(providers, pane.config, index);
    return provider?.structured && pane.config.mode !== "terminal" ? [{ ...pane, provider, index }] : [];
  });
  const currentChat = activeChatPane(dock);
  const selected = currentChat ? targets.find((pane) => pane.id === currentChat.id) ?? targets[0] : targets[0];
  const useBroadcast = broadcast && targets.length > 1;
  const selectedSubset = broadcastTargets.length
    ? targets.filter((pane) => broadcastTargets.includes(pane.id))
    : targets;
  const destinations = useBroadcast
    ? (selectedSubset.length ? selectedSubset : targets)
    : selected ? [selected] : [];
  return { targets, currentChat, selected, destinations, useBroadcast };
}

export function isPaneBusy(state: WorkbenchState, pane: ChatPane): boolean {
  if (state.submittingPanes.includes(pane.id)) return true;
  const root = state.workspace?.path ?? null;
  return (state.paneRuns[conversationKey(root, pane.config.conversationId)] ?? [])
    .some((id) => state.details[id]?.run.status === "running");
}

export function hasBusyDestination(state: WorkbenchState, destinations: ChatPane[]) {
  return destinations.some((pane) => isPaneBusy(state, pane));
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function estimateContextBudget(state: Pick<
  WorkbenchState,
  "contextPaths" | "contextSizes" | "attachments" | "selection" | "projectRules" | "includeProjectRules"
>) {
  let bytes = 0;
  for (const path of state.contextPaths) {
    bytes += state.contextSizes[path] ?? 0;
  }
  for (const attachment of state.attachments) {
    bytes += utf8Bytes(attachment.text);
  }
  if (state.selection) {
    bytes += utf8Bytes(state.selection.text);
  }
  if (state.includeProjectRules) {
    for (const rule of state.projectRules) {
      bytes += rule.bytes;
    }
  }
  return {
    bytes,
    approxTokens: Math.max(0, Math.round(bytes / 4)),
    limitBytes: MAX_CONTEXT_BYTES,
    ratio: bytes / MAX_CONTEXT_BYTES,
  };
}
