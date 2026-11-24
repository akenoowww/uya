import { createStore } from "zustand/vanilla";
import type {
  ConversationSummary, EditorSelection, EffortLevel, ProjectRuleFile, Provider,
  RenderedPrompt, RoutingMode, RoutingRule, RpcCall, RunDetail, RunSummary, TextContext, WorkspaceInfo,
} from "@ide/protocol";
import type { Bridge } from "./bridge";
import type { EditorDrafts } from "./editorDrafts";

export interface PaneConfig {
  conversationId?: string;
  providerId?: string;
  model?: string;
  effort?: EffortLevel;
  mode?: "structured" | "terminal";
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

export type SidebarView = "explorer" | "git" | "history" | null;

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

export function shortModelName(model: string | undefined): string {
  if (!model) return "";
  return model.includes("/") ? model.split("/").at(-1) ?? model : model;
}

export function paneDisplayTitle(provider: Provider | undefined, config: PaneConfig, index: number): string {
  if (!provider) return `Split ${index + 1}`;
  const model = resolveModel(provider, config.model);
  if (config.mode === "terminal") return `${provider.name} (TUI)`;
  return model ? `${provider.name} · ${shortModelName(model)}` : provider.name;
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
