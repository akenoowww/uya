import { useCallback, useEffect } from "react";
import { DockviewReact } from "dockview-react";
import type { IDockviewPanelProps } from "dockview-react";
import { useShallow } from "zustand/react/shallow";
import type { EditorSelection } from "@ide/protocol";
import { EditorPanel } from "./EditorPanel";
import { PromptLibrary } from "./PromptLibrary";
import { RunPane, RunStatus, Transcript } from "./RunPane";
import type { PaneConfig } from "./RunPane";
import { TerminalPanel } from "./TerminalPanel";
import type { PaneParams } from "./dockLayout";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";
import {
  conversationKey, isPaneBusy, paneDisplayTitle, providerForPane, unavailable,
} from "./workbenchStore";
import "dockview-react/dist/styles/dockview.css";

const emptyConfig: PaneConfig = {};
const emptyHistory: string[] = [];

function EditorTool({ id, path, workspacePath }: { id: string; path: string | null; workspacePath?: string }) {
  const { selectCode } = useWorkbench();
  const { root, rpc, active, readOnly, drafts } = useWorkbenchState(useShallow((state) => ({
    root: state.workspace?.path ?? null,
    rpc: state.bridge?.rpc ?? unavailable,
    active: state.dock.editorId === id,
    readOnly: state.choosingProject,
    drafts: state.editorDrafts,
  })));
  const onSelection = useCallback((selection: EditorSelection | null) => selectCode(id, selection), [id, selectCode]);
  return <EditorPanel root={root === workspacePath ? root : null} path={path} api={rpc} drafts={drafts} active={active}
    readOnly={readOnly} onSelectionChange={onSelection} />;
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
  const bridge = useWorkbenchState((state) => state.bridge);
  const root = useWorkbenchState((state) => state.workspace?.path ?? null);
  return <TerminalPanel key={root} bridge={bridge} cwd={root} title="Shell" />;
}

function HistoryTool({ id }: { id: string | undefined }) {
  const detail = useWorkbenchState((state) => id ? state.details[id] : undefined);
  const providers = useWorkbenchState((state) => state.providers);
  if (!detail) return <div className="pane-empty">Loading run…</div>;
  return (
    <div className="history-detail">
      <header>
        <strong>Saved run</strong>
        <RunStatus run={detail.run} />
      </header>
      <div className="transcript-scroll">
        <Transcript detail={detail} providers={providers} />
      </div>
    </div>
  );
}

function ChatTool({ id }: { id: string }) {
  const { core, dock, openProviders, sendToPane, setPaneDraft } = useWorkbench();
  const {
    bridge, root, index, config, provider, providers, draft, promptHistory, busy,
    choosingProject, contextCount, hasSelection,
  } = useWorkbenchState(useShallow((state) => {
    const panes = state.dock.chatPanes;
    const paneIndex = panes.findIndex((pane) => pane.id === id);
    const pane = panes[paneIndex];
    const paneConfig = pane?.config ?? emptyConfig;
    return {
      bridge: state.bridge,
      root: state.workspace?.path ?? null,
      index: paneIndex,
      config: paneConfig,
      provider: providerForPane(state.providers, paneConfig, paneIndex),
      providers: state.providers,
      draft: state.paneDrafts[id] ?? "",
      promptHistory: state.panePromptHistory[id] ?? emptyHistory,
      busy: pane ? isPaneBusy(state, pane) : false,
      choosingProject: state.choosingProject,
      contextCount: state.contextPaths.length,
      hasSelection: Boolean(state.selection),
    };
  }));

  const details = useWorkbenchState(useShallow((state) =>
    (state.paneRuns[conversationKey(root, config.conversationId)] ?? []).flatMap((runId) => {
      const detail = state.details[runId];
      return detail ? [detail] : [];
    })));

  const title = paneDisplayTitle(provider, config, Math.max(0, index));
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
      cwd={root}
      onDraftChange={(value) => setPaneDraft(id, value)}
      onSend={(override) => void sendToPane(id, override)}
      onConfig={(patch) => dock.configure(id, patch)}
      onCancel={core.cancelRun}
      onNewConversation={() => dock.newConversation(id)}
      onOpenProviders={openProviders}
    />
  );
}

function ToolPane({ api, params }: IDockviewPanelProps<PaneParams>) {
  switch (params?.tool) {
    case "editor": return <EditorTool id={api.id} path={params.filePath ?? null} workspacePath={params.workspacePath} />;
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
