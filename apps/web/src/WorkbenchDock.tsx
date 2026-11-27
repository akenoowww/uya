import { useCallback, useEffect, useMemo } from "react";
import { Loader, Stack, Text } from "@mantine/core";
import { DockviewReact } from "dockview-react";
import type { IDockviewPanelProps } from "dockview-react";
import { useShallow } from "zustand/react/shallow";
import type { EditorSelection } from "@ide/protocol";
import { DiffEditorPanel } from "./DiffEditorPanel";
import type { DiffTarget } from "./DiffEditorPanel";
import { EditorPanel } from "./EditorPanel";
import { PromptLibrary } from "./PromptLibrary";
import { RunPane, RunStatus, Transcript } from "./RunPane";
import { TerminalPanel } from "./TerminalPanel";
import type { PaneParams } from "./dockLayout";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";
import {
  conversationKey, isPaneBusy, paneAlias, paneDisplayTitle, providerForPane, unavailable,
} from "./workbenchStore";
import type { PaneConfig } from "./workbenchStore";
import "dockview-react/dist/styles/dockview.css";

const emptyConfig: PaneConfig = {};
const emptyHistory: string[] = [];

function EditorTool({ id, path, revealLine, revealNonce, workspacePath }: {
  id: string;
  path: string | null;
  revealLine?: number;
  revealNonce?: number;
  workspacePath?: string;
}) {
  const { selectCode } = useWorkbench();
  const { root, rpc, active, readOnly, drafts, refreshKey } = useWorkbenchState(useShallow((state) => ({
    root: state.workspace?.path ?? null,
    rpc: state.bridge?.rpc ?? unavailable,
    active: state.dock.editorId === id,
    readOnly: state.choosingProject,
    drafts: state.editorDrafts,
    refreshKey: state.refreshKey,
  })));
  const onSelection = useCallback((selection: EditorSelection | null) => selectCode(id, selection), [id, selectCode]);
  return <EditorPanel root={root === workspacePath ? root : null} path={path} api={rpc} drafts={drafts} active={active}
    readOnly={readOnly} refreshKey={refreshKey} revealLine={revealLine} revealNonce={revealNonce} onSelectionChange={onSelection} />;
}

function DiffTool({ target, workspacePath }: { target: DiffTarget | undefined; workspacePath?: string }) {
  const { store, core } = useWorkbench();
  const { root, rpc, refreshKey } = useWorkbenchState(useShallow((state) => ({
    root: state.workspace?.path ?? null,
    rpc: state.bridge?.rpc ?? unavailable,
    refreshKey: state.refreshKey,
  })));
  if (!target || root !== workspacePath) {
    return (
      <Stack align="center" justify="center" flex={1} p="lg">
        <Text size="xs" c="dimmed">Diff target unavailable.</Text>
      </Stack>
    );
  }
  return (
    <DiffEditorPanel
      root={root}
      api={rpc}
      target={target}
      refreshKey={refreshKey}
      onApplied={() => {
        store.setState((state) => ({ refreshKey: state.refreshKey + 1 }));
        void core.refreshWorkspaceMetadata(root);
      }}
    />
  );
}

function PromptsTool() {
  const { applyPrompt } = useWorkbench();
  const { root, rpc, refreshKey } = useWorkbenchState(useShallow((state) => ({
    root: state.workspace?.path ?? null,
    rpc: state.bridge?.rpc ?? unavailable,
    refreshKey: state.refreshKey,
  })));
  return <PromptLibrary root={root} api={rpc} onUse={applyPrompt} refreshKey={refreshKey} />;
}

function TerminalTool() {
  const { store } = useWorkbench();
  const { bridge, root, pendingCommand } = useWorkbenchState(useShallow((state) => ({
    bridge: state.bridge,
    root: state.workspace?.path ?? null,
    pendingCommand: state.pendingTerminalCommand,
  })));
  const onConsumedCommand = useCallback(() => {
    store.setState({ pendingTerminalCommand: null });
  }, [store]);
  return (
    <TerminalPanel
      key={root}
      bridge={bridge}
      cwd={root}
      title="Shell"
      autoStart
      pendingCommand={pendingCommand}
      onConsumedCommand={onConsumedCommand}
    />
  );
}

function HistoryTool({ id }: { id: string | undefined }) {
  const {
    core, dock, attachFile, openExternalUrl, previewDiffFromCode, forkConversationToSplit, runInTerminal,
  } = useWorkbench();
  const detail = useWorkbenchState((state) => id ? state.details[id] : undefined);
  const providers = useWorkbenchState((state) => state.providers);
  const root = useWorkbenchState((state) => state.workspace?.path ?? null);
  const rpc = useWorkbenchState((state) => state.bridge?.rpc);
  const missionsById = useWorkbenchState((state) => state.missionsById);
  const conversationWorkspace = useWorkbenchState((state) => {
    const convId = id ? state.details[id]?.run.conversationId : undefined;
    if (!convId) return undefined;
    const match = state.conversations.find((item) => item.id === convId && item.workspacePath === root)
      ?? state.conversations.find((item) => item.id === convId);
    return match?.workspacePath;
  });
  if (!detail) {
    return (
      <Stack align="center" justify="center" gap="xs" flex={1} p="lg">
        <Loader size="xs" color="iris" />
        <Text size="xs" c="dimmed">Loading run…</Text>
      </Stack>
    );
  }
  const canFork = Boolean(
    detail.run.conversationId && (conversationWorkspace === undefined || conversationWorkspace === root),
  );
  return (
    <div className="history-detail">
      <header>
        <strong>Saved run</strong>
        <RunStatus run={detail.run} />
      </header>
      <div className="transcript-scroll">
        <Transcript
          detail={detail}
          providers={providers}
          cwd={root}
          rpc={rpc}
          missionsById={missionsById}
          onFork={canFork ? (runId) => void forkConversationToSplit(detail.run.conversationId!, root, { upToRunId: runId }) : undefined}
          onOpenUrl={(url) => void openExternalUrl(url)}
          onOpenFile={(path, line) => dock.openFile(path, line)}
          onAttachFile={attachFile}
          onPreviewDiff={previewDiffFromCode}
          onRunCommand={runInTerminal}
          onApproveMission={core.approveMission}
          onCancelMission={core.cancelMission}
        />
      </div>
    </div>
  );
}

function ChatTool({ id }: { id: string }) {
  const {
    core, dock, pickProject, openProviders, sendToPane, forwardReplyToSplit, setPaneDraft, startNewConversation,
    attachFile, attachGitDiff, attachTerminal, forkConversationToSplit,
    openExternalUrl, previewDiffFromCode, runInTerminal,
  } = useWorkbench();
  const {
    bridge, root, recentWorkspaces, index, config, provider, providers, draft, promptHistory, busy,
    choosingProject, contextCount, hasSelection, missionsById, panes,
  } = useWorkbenchState(useShallow((state) => {
    const panes = state.dock.chatPanes;
    const paneIndex = panes.findIndex((pane) => pane.id === id);
    const pane = panes[paneIndex];
    const paneConfig = pane?.config ?? emptyConfig;
    return {
      bridge: state.bridge,
      root: state.workspace?.path ?? null,
      recentWorkspaces: state.recentWorkspaces,
      index: paneIndex,
      config: paneConfig,
      provider: providerForPane(state.providers, paneConfig, paneIndex),
      providers: state.providers,
      draft: state.paneDrafts[id] ?? "",
      promptHistory: state.panePromptHistory[id] ?? emptyHistory,
      busy: pane ? isPaneBusy(state, pane) : false,
      choosingProject: state.choosingProject,
      contextCount: state.contextPaths.length + state.attachments.length,
      hasSelection: Boolean(state.selection),
      missionsById: state.missionsById,
      panes,
    };
  }));

  const peerSplits = useMemo(() => panes.flatMap((other, otherIndex) => {
    if (other.id === id || other.config.mode === "terminal") return [];
    const otherProvider = providerForPane(providers, other.config, otherIndex);
    if (!otherProvider?.structured) return [];
    return [{
      id: other.id,
      title: paneDisplayTitle(otherProvider, other.config, otherIndex),
      providerId: otherProvider.id,
    }];
  }), [panes, providers, id]);

  const details = useWorkbenchState(useShallow((state) =>
    (state.paneRuns[conversationKey(root, config.conversationId)] ?? []).flatMap((runId) => {
      const detail = state.details[runId];
      return detail ? [detail] : [];
    })));

  const title = paneDisplayTitle(provider, config, Math.max(0, index));
  const sourceAlias = paneAlias(provider, config, Math.max(0, index));
  useEffect(() => {
    dock.setTitle(id, title);
  }, [dock, id, title]);

  return (
    <RunPane
      id={id}
      config={config}
      provider={provider}
      providers={providers}
      details={details}
      draft={draft}
      promptHistory={promptHistory}
      busy={busy}
      connected={Boolean(bridge)}
      choosingProject={choosingProject}
      contextCount={contextCount}
      hasSelection={hasSelection}
      bridge={bridge}
      rpc={bridge?.rpc}
      cwd={root}
      sourceAlias={sourceAlias}
      peerSplits={peerSplits}
      missionsById={missionsById}
      recentWorkspaces={recentWorkspaces}
      onPickProject={(recentPath) => void pickProject(false, recentPath)}
      onDraftChange={(value) => setPaneDraft(id, value)}
      onSend={(override) => void sendToPane(id, override)}
      onConfig={(patch) => dock.configure(id, patch)}
      onCancel={core.cancelRun}
      onRespondApproval={core.respondApproval}
      onRestoreCheckpoint={core.restoreCheckpoint}
      onApproveMission={core.approveMission}
      onCancelMission={core.cancelMission}
      onForwardReply={(targetPaneId, alias, sourceProviderId, replyText) => {
        void forwardReplyToSplit(targetPaneId, alias, sourceProviderId, replyText);
      }}
      onNewConversation={() => startNewConversation(id)}
      onOpenProviders={openProviders}
      onRefreshProviders={core.refreshProviders}
      onAttachFile={attachFile}
      onAttachGitDiff={(staged) => void attachGitDiff(staged)}
      onAttachTerminal={attachTerminal}
      onForkFromRun={config.conversationId
        ? (runId) => void forkConversationToSplit(config.conversationId!, root, { upToRunId: runId })
        : undefined}
      onOpenUrl={(url) => void openExternalUrl(url)}
      onOpenFile={(path, line) => dock.openFile(path, line)}
      onPreviewDiff={previewDiffFromCode}
      onRunCommand={runInTerminal}
    />
  );
}

function ToolPane({ api, params }: IDockviewPanelProps<PaneParams>) {
  switch (params?.tool) {
    case "editor": return <EditorTool id={api.id} path={params.filePath ?? null} revealLine={params.revealLine} revealNonce={params.revealNonce} workspacePath={params.workspacePath} />;
    case "diff": return <DiffTool target={params.diffTarget} workspacePath={params.workspacePath} />;
    case "prompts": return <PromptsTool />;
    case "terminal": return <TerminalTool />;
    case "history": return <HistoryTool id={params.runId} />;
    default: return <ChatTool id={api.id} />;
  }
}

const components = { pane: ToolPane };

export function WorkbenchDock() {
  const { dock } = useWorkbench();
  useEffect(() => dock.dispose, [dock]);
  return (
    <div className="dock-host">
      <DockviewReact onReady={dock.ready} components={components} className="dockview-theme-dark uya-dock" disableFloatingGroups />
    </div>
  );
}
