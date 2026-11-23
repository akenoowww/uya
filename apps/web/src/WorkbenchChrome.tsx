import { useEffect, useState } from "react";
import { ActionIcon, Badge, Button, Group, Kbd, Modal, Text, TextInput } from "@mantine/core";
import {
  BookOpen, CaretDown, ClockCounterClockwise, ColumnsPlusRight, Files, FolderOpen,
  Keyboard, MagnifyingGlass, PlugsConnected, SidebarSimple, SlidersHorizontal, TerminalWindow,
} from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { ProviderIcon, UyaBrandMark } from "./components/ProviderIcon";
import { HintTooltip } from "./components/Tooltip";
import { ProjectExplorer } from "./ProjectExplorer";
import { RunStatus } from "./RunPane";
import { SettingsDialog } from "./SettingsDialog";
import { formatShortcut } from "./shortcuts";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";
import { shortModelName, unavailable } from "./workbenchStore";

export function WorkbenchTitlebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { pickProject, openProviders } = useWorkbench();
  const { project, blocked, providerCount } = useWorkbenchState(useShallow((state) => ({
    project: state.workspace?.name ?? "Open project",
    blocked: !state.bridge || state.choosingProject || state.submitting,
    providerCount: state.providers.filter((provider) => provider.available).length,
  })));
  return (
    <header className="titlebar">
      <div className="product-name">
        <span className="brand-mark"><UyaBrandMark size={28} /></span>
        <h1>Uya</h1>
      </div>
      <div className="project-switch">
        <HintTooltip label="Open project folder" shortcut={formatShortcut("open-project")}>
          <Button
            variant="default"
            size="xs"
            className="project-button"
            leftSection={<FolderOpen size={15} weight="duotone" />}
            rightSection={<CaretDown size={11} weight="bold" />}
            onClick={() => void pickProject()}
            disabled={blocked}
          >
            <span className="project-button-text">{project}</span>
          </Button>
        </HintTooltip>
        <HintTooltip label="Command palette" shortcut={formatShortcut("palette")}>
          <Button
            variant="default"
            size="xs"
            className="palette-trigger"
            leftSection={<MagnifyingGlass size={13} />}
            rightSection={<Kbd>{formatShortcut("palette")}</Kbd>}
            onClick={onOpenPalette}
          >
            <span className="palette-trigger-text">Commands</span>
          </Button>
        </HintTooltip>
      </div>
      <div className="titlebar-right">
        <HintTooltip label="Manage providers & models" shortcut={formatShortcut("open-providers")}>
          <Button
            variant="default"
            size="xs"
            leftSection={<PlugsConnected size={15} weight="duotone" />}
            rightSection={providerCount > 0 ? <Badge size="xs" variant="light" color="iris" px={5}>{providerCount}</Badge> : undefined}
            onClick={openProviders}
          >
            Providers
          </Button>
        </HintTooltip>
      </div>
    </header>
  );
}

export function ActivityRail() {
  const { dock, toggleSidebar, openShortcuts } = useWorkbench();
  const { sidebar, contextCount } = useWorkbenchState(useShallow((state) => ({
    sidebar: state.sidebar,
    contextCount: state.contextPaths.length,
  })));
  return (
    <nav className="activity-rail" aria-label="Workspace tools">
      <HintTooltip label="Explorer" shortcut={formatShortcut("toggle-explorer")} side="right">
        <ActionIcon
          size="lg"
          variant={sidebar === "explorer" ? "light" : "subtle"}
          color={sidebar === "explorer" ? "iris" : "gray"}
          className="rail-action"
          aria-label="Explorer"
          aria-pressed={sidebar === "explorer"}
          onClick={() => toggleSidebar("explorer")}
        >
          <Files size={19} weight={sidebar === "explorer" ? "duotone" : "regular"} />
          {contextCount > 0 && <span className="rail-badge">{contextCount}</span>}
        </ActionIcon>
      </HintTooltip>
      <HintTooltip label="Prompt Library" shortcut={formatShortcut("open-prompts")} side="right">
        <ActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          className="rail-action"
          aria-label="Prompt Library"
          onClick={() => dock.openTool("prompts", "Prompt Library")}
        >
          <BookOpen size={19} weight="regular" />
        </ActionIcon>
      </HintTooltip>
      <HintTooltip label="Run History" shortcut={formatShortcut("toggle-history")} side="right">
        <ActionIcon
          size="lg"
          variant={sidebar === "history" ? "light" : "subtle"}
          color={sidebar === "history" ? "iris" : "gray"}
          className="rail-action"
          aria-label="Run History"
          aria-pressed={sidebar === "history"}
          onClick={() => toggleSidebar("history")}
        >
          <ClockCounterClockwise size={19} weight={sidebar === "history" ? "duotone" : "regular"} />
        </ActionIcon>
      </HintTooltip>
      <div className="rail-spacer" />
      <HintTooltip label="Shell Terminal" shortcut={formatShortcut("open-terminal")} side="right">
        <ActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          className="rail-action"
          aria-label="Terminal"
          onClick={() => dock.openTool("terminal", "Terminal")}
        >
          <TerminalWindow size={19} weight="regular" />
        </ActionIcon>
      </HintTooltip>
      <HintTooltip label="Keyboard Shortcuts" shortcut={formatShortcut("shortcuts")} side="right">
        <ActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          className="rail-action"
          aria-label="Keyboard Shortcuts"
          onClick={openShortcuts}
        >
          <Keyboard size={19} weight="regular" />
        </ActionIcon>
      </HintTooltip>
    </nav>
  );
}

function WorkspaceExplorer() {
  const { dock, pickProject, toggleContext } = useWorkbench();
  const { root, rpc, activePath, contextPaths, refreshKey } = useWorkbenchState(useShallow((state) => ({
    root: state.workspace?.path ?? null,
    rpc: state.bridge?.rpc ?? unavailable,
    activePath: state.dock.filePath,
    contextPaths: state.contextPaths,
    refreshKey: state.refreshKey,
  })));
  return <ProjectExplorer root={root} api={rpc} onOpen={dock.openFile} activePath={activePath}
    selectedContext={contextPaths} onToggleContext={toggleContext} onChooseProject={() => void pickProject()} refreshKey={refreshKey} />;
}

function WorkspaceHistory() {
  const { openHistory } = useWorkbench();
  const [filter, setFilter] = useState("");
  const history = useWorkbenchState((state) => state.history);
  const providers = useWorkbenchState((state) => state.providers);
  const query = filter.trim().toLowerCase();
  const filtered = query
    ? history.filter((run) =>
      run.prompt.toLowerCase().includes(query)
      || (run.providerName ?? run.providerId).toLowerCase().includes(query)
      || (run.model ?? "").toLowerCase().includes(query))
    : history;

  return (
    <>
      <h2 className="sidebar-heading">Run history</h2>
      {history.length > 0 && (
        <div className="sidebar-search-pad">
          <TextInput
            size="xs"
            placeholder="Filter runs…"
            leftSection={<MagnifyingGlass size={13} />}
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            aria-label="Filter run history"
          />
        </div>
      )}
      <div className="history-list">
        {filtered.length ? filtered.map((run) => {
          const provider = run.providerName ?? providers.find((entry) => entry.id === run.providerId)?.name ?? run.providerId;
          return (
            <button key={run.id} type="button" className="history-item" onClick={() => void openHistory(run.id)}>
              <span className="history-prompt">{run.prompt}</span>
              <span className="history-provider">
                <ProviderIcon providerId={run.providerId} size={11} framed={false} />
                <span>{provider}{run.model ? ` · ${shortModelName(run.model)}` : ""}</span>
              </span>
              <span>
                <RunStatus run={run} />
                <small>{new Date(run.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
              </span>
            </button>
          );
        }) : <p className="sidebar-empty">{query ? "No runs match that filter." : "Completed and active runs appear here."}</p>}
      </div>
    </>
  );
}

export function WorkbenchSidebar() {
  const sidebar = useWorkbenchState((state) => state.sidebar);
  if (!sidebar) return null;
  return (
    <aside className="sidebar" aria-label={sidebar === "explorer" ? "Project explorer" : "Run history"}>
      {sidebar === "explorer" ? <WorkspaceExplorer /> : <WorkspaceHistory />}
    </aside>
  );
}

export function WorkbenchToolbar() {
  const { dock, openRules, store } = useWorkbench();
  const { sidebarOpen, splits } = useWorkbenchState(useShallow((state) => ({
    sidebarOpen: Boolean(state.sidebar),
    splits: state.dock.chatPanes.length,
  })));
  const toggleLabel = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  return (
    <div className="workbench-toolbar">
      <HintTooltip label={toggleLabel} shortcut={formatShortcut("toggle-explorer")}>
        <ActionIcon
          aria-label={toggleLabel}
          onClick={() => store.setState({ sidebar: sidebarOpen ? null : "explorer" })}
        >
          <SidebarSimple size={16} weight={sidebarOpen ? "duotone" : "regular"} />
        </ActionIcon>
      </HintTooltip>
      <div className="workbench-name">
        <h2>Workbench</h2>
        <span>{splits} {splits === 1 ? "split" : "splits"}</span>
      </div>
      <div className="toolbar-spacer" />
      <HintTooltip label="Routing rules" shortcut={formatShortcut("open-rules")}>
        <Button
          variant="default"
          size="compact-xs"
          leftSection={<SlidersHorizontal size={14} weight="duotone" />}
          onClick={openRules}
        >
          Rules
        </Button>
      </HintTooltip>
      <HintTooltip label="Open new model split" shortcut={formatShortcut("new-split")}>
        <Button
          variant="default"
          size="compact-xs"
          leftSection={<ColumnsPlusRight size={15} weight="duotone" />}
          onClick={() => dock.newSplit()}
        >
          New split
        </Button>
      </HintTooltip>
    </div>
  );
}

export function WorkbenchStatus({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { openShortcuts } = useWorkbench();
  const { connected, offline, project, busyRuns } = useWorkbenchState(useShallow((state) => ({
    connected: Boolean(state.bridge),
    offline: Boolean(state.connectionError),
    project: state.workspace?.name,
    busyRuns: state.history.filter((run) => run.status === "running").length,
  })));
  return (
    <footer className="statusbar">
      <span className="runtime-status">
        <span className={`state-dot ${connected ? "connected" : ""}`} />
        {connected ? "Local core connected" : offline ? "Core offline" : "Connecting to local core"}
      </span>
      {project && <span className="footer-project"><FolderOpen size={12} weight="duotone" />{project}</span>}
      <span className="toolbar-spacer" />
      {!!busyRuns && <span className="status-active">{busyRuns} {busyRuns === 1 ? "run" : "runs"} active</span>}
      <Button size="compact-xs" variant="subtle" color="gray" className="status-action" onClick={onOpenPalette}>
        <Group gap={5} wrap="nowrap">
          <span>Palette</span>
          <Kbd>{formatShortcut("palette")}</Kbd>
        </Group>
      </Button>
      <Button size="compact-xs" variant="subtle" color="gray" className="status-action" onClick={openShortcuts}>
        <Group gap={5} wrap="nowrap">
          <span>Shortcuts</span>
          <Kbd>{formatShortcut("shortcuts")}</Kbd>
        </Group>
      </Button>
      <span>v0.1.0</span>
    </footer>
  );
}

export function WorkbenchDialogs() {
  const { core, settings, projectConfirm, pickProject, setRules } = useWorkbench();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { providers, rules, rpc } = useWorkbenchState(useShallow((state) => ({
    providers: state.providers,
    rules: state.rules,
    rpc: state.bridge?.rpc,
  })));

  useEffect(() => {
    projectConfirm.current = () => setConfirmOpen(true);
    return () => { projectConfirm.current = null; };
  }, [projectConfirm]);

  return (
    <>
      <SettingsDialog controls={settings} providers={providers} rules={rules} rpc={rpc} onRefresh={core.refreshProviders} onRules={setRules} />
      <Modal
        opened={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Open another project?"
        size="sm"
      >
        <Text size="xs" c="dimmed" mb="md">
          Opening a different project discards unsaved file drafts in this workspace.
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={() => setConfirmOpen(false)} autoFocus>Keep editing</Button>
          <Button
            color="iris"
            onClick={() => {
              setConfirmOpen(false);
              void pickProject(true);
            }}
          >
            Choose folder
          </Button>
        </Group>
      </Modal>
    </>
  );
}
