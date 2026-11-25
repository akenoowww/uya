import { useEffect, useRef, useState } from "react";
import {
  ActionIcon, Badge, Box, Button, Group, Indicator, Kbd, Loader, Menu, Modal, Popover, ScrollArea,
  Stack, Text, TextInput, UnstyledButton,
} from "@mantine/core";
import {
  BookOpen, Bug, CaretDown, ChartBar, Check, CheckCircle, ClockCounterClockwise, ColumnsPlusRight,
  Files, FolderOpen, GitBranch, Keyboard, MagnifyingGlass, Play, PlugsConnected, Stop,
  TerminalWindow, XCircle,
} from "@phosphor-icons/react";
import { isTauri } from "@tauri-apps/api/core";
import type { GitBranch as GitBranchInfo } from "@ide/protocol";
import { useShallow } from "zustand/react/shallow";
import { errorMessage } from "./bridge";
import { JudgeModal } from "./components/JudgeModal";
import { UyaBrandMark } from "./components/ProviderIcon";
import { HintTooltip } from "./components/Tooltip";
import { GitPanel } from "./GitPanel";
import { HistoryPanel } from "./HistoryPanel";
import { ProjectExplorer } from "./ProjectExplorer";
import { SearchPanel } from "./SearchPanel";
import { SettingsDialog } from "./SettingsDialog";
import { formatShortcut, isMac } from "./shortcuts";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";
import { formatDurationCompact, unavailable, workspaceLabel } from "./workbenchStore";

const SIDEBAR_WIDTH_KEY = "uya:sidebar-width:v1";

function loadSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= 170 && raw <= 460) return raw;
  } catch {
    // Ignore storage failures.
  }
  return 236;
}

function VerifyPopoverButton() {
  const { core, sendVerifyFailureToAgent } = useWorkbench();
  const { workspace, verifyPresets, activeVerify } = useWorkbenchState(useShallow((state) => ({
    workspace: state.workspace,
    verifyPresets: state.verifyPresets,
    activeVerify: state.activeVerify,
  })));
  const [opened, setOpened] = useState(false);
  const [command, setCommand] = useState("");

  useEffect(() => {
    if (!command && verifyPresets.length > 0) {
      setCommand(verifyPresets[0].command);
    }
  }, [command, verifyPresets]);

  if (!workspace) return null;

  const status = activeVerify?.status;
  const color = status === "passed" ? "teal" : status === "failed" ? "red" : status === "running" ? "iris" : "gray";
  const icon = status === "running"
    ? <Loader size={11} color="iris" />
    : status === "passed"
      ? <CheckCircle size={13} weight="fill" color="var(--positive)" />
      : status === "failed"
        ? <XCircle size={13} weight="fill" color="var(--danger)" />
        : <Play size={12} weight="fill" />;
  const elapsed = activeVerify?.finishedAt ? activeVerify.finishedAt - activeVerify.startedAt : undefined;

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={400} shadow="md" withinPortal>
      <Popover.Target>
        <Button
          variant={status && status !== "cancelled" ? "light" : "default"}
          color={color}
          size="compact-xs"
          leftSection={icon}
          onClick={() => setOpened((v) => !v)}
          aria-label="Verification runner"
        >
          {status === "running" ? "Verifying…" : status === "passed" ? "Passed" : status === "failed" ? "Failed" : "Verify"}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={8}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="xs" fw={650}>Verify workspace</Text>
            {activeVerify && (
              <Badge size="xs" variant="light" color={color}>
                {activeVerify.status}{elapsed ? ` · ${formatDurationCompact(elapsed)}` : ""}
              </Badge>
            )}
          </Group>

          {verifyPresets.length > 0 && (
            <Group gap={4} wrap="wrap">
              {verifyPresets.slice(0, 6).map((preset) => (
                <Button
                  key={preset.id}
                  size="compact-xs"
                  variant={command === preset.command ? "light" : "default"}
                  color={command === preset.command ? "iris" : "gray"}
                  onClick={() => {
                    setCommand(preset.command);
                    void core.startVerify(preset.command);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </Group>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (command.trim()) void core.startVerify(command.trim());
            }}
          >
            <Group gap={6} wrap="nowrap">
              <TextInput
                size="xs"
                style={{ flex: 1 }}
                aria-label="Verification command"
                placeholder="e.g. bun test, npm run build, cargo check"
                value={command}
                onChange={(event) => setCommand(event.currentTarget.value)}
              />
              {status === "running" ? (
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  leftSection={<Stop size={12} weight="fill" />}
                  onClick={() => void core.cancelVerify()}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="xs"
                  color="iris"
                  disabled={!command.trim()}
                  leftSection={<Play size={12} weight="fill" />}
                >
                  Run
                </Button>
              )}
            </Group>
          </form>

          {activeVerify && (
            <>
              <ScrollArea.Autosize mah={200} type="auto">
                <pre className="verify-output">
                  {activeVerify.output || (activeVerify.status === "running" ? "Running…" : "(no output)")}
                </pre>
              </ScrollArea.Autosize>
              {activeVerify.status === "failed" && (
                <Group justify="flex-end">
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="iris"
                    leftSection={<Bug size={12} weight="duotone" />}
                    onClick={() => {
                      sendVerifyFailureToAgent();
                      setOpened(false);
                    }}
                  >
                    Send failure to agent
                  </Button>
                </Group>
              )}
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function WorkbenchTitlebar({ onOpenPalette, onRestartToUpdate }: {
  onOpenPalette: () => void;
  onRestartToUpdate?: () => void;
}) {
  const { dock, pickProject, openProviders } = useWorkbench();
  const { workspace, recentWorkspaces, blocked, providerCount } = useWorkbenchState(useShallow((state) => ({
    workspace: state.workspace,
    recentWorkspaces: state.recentWorkspaces,
    blocked: !state.bridge || state.choosingProject || state.submitting,
    providerCount: state.providers.filter((provider) => provider.available).length,
  })));

  const otherRecents = recentWorkspaces.filter((path) => path !== workspace?.path);

  return (
    <Box component="header" className={`titlebar${isMac && isTauri() ? " titlebar-mac-overlay" : ""}`} data-tauri-drag-region>
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <span className="brand-mark" data-tauri-drag-region><UyaBrandMark size={20} /></span>
        <Menu position="bottom-start" width={290}>
          <Menu.Target>
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              className="project-button"
              leftSection={<FolderOpen size={14} weight="duotone" />}
              rightSection={<CaretDown size={10} weight="bold" />}
              disabled={blocked}
            >
              <span className="project-button-text">{workspace?.name ?? "Open project"}</span>
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<FolderOpen size={13} weight="duotone" />}
              rightSection={<Kbd>{formatShortcut("open-project")}</Kbd>}
              onClick={() => void pickProject()}
            >
              Open folder…
            </Menu.Item>
            {otherRecents.length > 0 && (
              <>
                <Menu.Divider />
                <Menu.Label>Recent projects</Menu.Label>
                {otherRecents.map((path) => (
                  <Menu.Item
                    key={path}
                    leftSection={<FolderOpen size={12} />}
                    onClick={() => void pickProject(false, path)}
                    title={path}
                  >
                    <Text size="xs" truncate="end">{workspaceLabel(path)}</Text>
                  </Menu.Item>
                ))}
              </>
            )}
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Group justify="center" wrap="nowrap" data-tauri-drag-region>
        <HintTooltip label="Command palette" shortcut={formatShortcut("palette")}>
          <Button
            variant="default"
            size="compact-xs"
            className="palette-trigger"
            leftSection={<MagnifyingGlass size={12} />}
            rightSection={<Kbd>{formatShortcut("palette")}</Kbd>}
            onClick={onOpenPalette}
          >
            <span className="palette-trigger-text">Commands</span>
          </Button>
        </HintTooltip>
      </Group>

      <Group justify="flex-end" gap={6} wrap="nowrap">
        {onRestartToUpdate && (
          <Button color="iris" size="compact-xs" onClick={onRestartToUpdate}>Restart to Update</Button>
        )}
        <VerifyPopoverButton />
        <HintTooltip label="New model split" shortcut={formatShortcut("new-split")}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="New model split"
            onClick={() => dock.newSplit()}
          >
            <ColumnsPlusRight size={15} weight="duotone" />
          </ActionIcon>
        </HintTooltip>
        <HintTooltip label="Providers, rules & usage" shortcut={formatShortcut("open-providers")}>
          <Button
            variant="default"
            size="compact-xs"
            leftSection={<PlugsConnected size={13} weight="duotone" />}
            rightSection={providerCount > 0 ? <Badge size="xs" variant="light" color="iris" px={5}>{providerCount}</Badge> : undefined}
            onClick={openProviders}
          >
            Providers
          </Button>
        </HintTooltip>
      </Group>
    </Box>
  );
}

export function ActivityRail() {
  const { dock, toggleSidebar, openShortcuts, openUsage } = useWorkbench();
  const { sidebar, contextCount, gitChangeCount } = useWorkbenchState(useShallow((state) => ({
    sidebar: state.sidebar,
    contextCount: state.contextPaths.length + state.attachments.length,
    gitChangeCount: state.gitChangeCount,
  })));
  return (
    <Stack component="nav" className="activity-rail" align="center" gap={4} aria-label="Workspace tools">
      <HintTooltip label="Explorer" shortcut={formatShortcut("toggle-explorer")} side="right">
        <Indicator disabled={contextCount === 0} label={contextCount} size={14} offset={3} color="iris" fw={700}>
          <ActionIcon
            size="lg"
            variant={sidebar === "explorer" ? "light" : "subtle"}
            color={sidebar === "explorer" ? "iris" : "gray"}
            className="rail-action"
            aria-label="Explorer"
            aria-pressed={sidebar === "explorer"}
            onClick={() => toggleSidebar("explorer")}
          >
            <Files size={18} weight={sidebar === "explorer" ? "duotone" : "regular"} />
          </ActionIcon>
        </Indicator>
      </HintTooltip>
      <HintTooltip label="Search workspace" shortcut={formatShortcut("toggle-search")} side="right">
        <ActionIcon
          size="lg"
          variant={sidebar === "search" ? "light" : "subtle"}
          color={sidebar === "search" ? "iris" : "gray"}
          className="rail-action"
          aria-label="Search workspace"
          aria-pressed={sidebar === "search"}
          onClick={() => toggleSidebar("search")}
        >
          <MagnifyingGlass size={18} weight={sidebar === "search" ? "duotone" : "regular"} />
        </ActionIcon>
      </HintTooltip>
      <HintTooltip label="Git changes" shortcut={formatShortcut("toggle-git")} side="right">
        <Indicator disabled={gitChangeCount === 0} label={gitChangeCount > 99 ? "99" : gitChangeCount} size={14} offset={3} color="iris" fw={700}>
          <ActionIcon
            size="lg"
            variant={sidebar === "git" ? "light" : "subtle"}
            color={sidebar === "git" ? "iris" : "gray"}
            className="rail-action"
            aria-label="Git changes"
            aria-pressed={sidebar === "git"}
            onClick={() => toggleSidebar("git")}
          >
            <GitBranch size={18} weight={sidebar === "git" ? "duotone" : "regular"} />
          </ActionIcon>
        </Indicator>
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
          <BookOpen size={18} weight="regular" />
        </ActionIcon>
      </HintTooltip>
      <HintTooltip label="History & Threads" shortcut={formatShortcut("toggle-history")} side="right">
        <ActionIcon
          size="lg"
          variant={sidebar === "history" ? "light" : "subtle"}
          color={sidebar === "history" ? "iris" : "gray"}
          className="rail-action"
          aria-label="History & Threads"
          aria-pressed={sidebar === "history"}
          onClick={() => toggleSidebar("history")}
        >
          <ClockCounterClockwise size={18} weight={sidebar === "history" ? "duotone" : "regular"} />
        </ActionIcon>
      </HintTooltip>
      <Box style={{ flex: 1 }} />
      <HintTooltip label="Shell Terminal" shortcut={formatShortcut("open-terminal")} side="right">
        <ActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          className="rail-action"
          aria-label="Terminal"
          onClick={() => dock.openTool("terminal", "Terminal")}
        >
          <TerminalWindow size={18} weight="regular" />
        </ActionIcon>
      </HintTooltip>
      <HintTooltip label="Usage & Speed Insights" side="right">
        <ActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          className="rail-action"
          aria-label="Usage Insights"
          onClick={openUsage}
        >
          <ChartBar size={18} weight="regular" />
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
          <Keyboard size={18} weight="regular" />
        </ActionIcon>
      </HintTooltip>
    </Stack>
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
  return <ProjectExplorer root={root} api={rpc} onOpen={(path) => dock.openFile(path)} activePath={activePath}
    selectedContext={contextPaths} onToggleContext={toggleContext} onChooseProject={() => void pickProject()} refreshKey={refreshKey} />;
}

function WorkspaceSearch() {
  const { dock, pickProject, attachFile } = useWorkbench();
  const { root, rpc, seedQuery } = useWorkbenchState(useShallow((state) => ({
    root: state.workspace?.path ?? null,
    rpc: state.bridge?.rpc ?? unavailable,
    seedQuery: state.searchQuerySeed,
  })));
  return (
    <SearchPanel
      root={root}
      api={rpc}
      seedQuery={seedQuery}
      onOpenMatch={(path, line) => dock.openFile(path, line)}
      onAttachFiles={(paths) => {
        for (const path of paths) attachFile(path);
      }}
      onChooseProject={() => void pickProject()}
    />
  );
}

function WorkspaceGit() {
  const { store, core, dock, pickProject, attachGitDiff, generateCommitMessage } = useWorkbench();
  const { root, rpc, refreshKey } = useWorkbenchState(useShallow((state) => ({
    root: state.workspace?.path ?? null,
    rpc: state.bridge?.rpc ?? unavailable,
    refreshKey: state.refreshKey,
  })));
  return (
    <GitPanel
      root={root}
      api={rpc}
      refreshKey={refreshKey}
      onOpenDiff={(path, staged) => dock.openDiff({ mode: "git", path, staged })}
      onAttachDiff={(staged) => void attachGitDiff(staged)}
      onChooseProject={() => void pickProject()}
      onGenerateCommitMessage={generateCommitMessage}
      onGitChanged={() => {
        store.setState((state) => ({ refreshKey: state.refreshKey + 1 }));
        void core.refreshWorkspaceMetadata(root);
      }}
    />
  );
}

export function WorkbenchSidebar() {
  const sidebar = useWorkbenchState((state) => state.sidebar);
  const [width, setWidth] = useState(loadSidebarWidth);
  const widthRef = useRef(width);
  const dragging = useRef(false);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (!dragging.current) return;
      const next = Math.max(170, Math.min(460, event.clientX - 46));
      widthRef.current = next;
      setWidth(next);
    }
    function onPointerUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRef.current));
      } catch {
        // Ignore storage errors.
      }
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  if (!sidebar) return null;
  const ariaLabel = sidebar === "explorer"
    ? "Project explorer"
    : sidebar === "search"
      ? "Workspace search"
      : sidebar === "git"
        ? "Git changes"
        : "Run history";
  return (
    <aside
      className="sidebar"
      style={{ flexBasis: `${width}px` }}
      aria-label={ariaLabel}
    >
      <div className="sidebar-inner">
        {sidebar === "explorer"
          ? <WorkspaceExplorer />
          : sidebar === "search"
            ? <WorkspaceSearch />
            : sidebar === "git"
              ? <WorkspaceGit />
              : <HistoryPanel />}
      </div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(event) => {
          event.preventDefault();
          dragging.current = true;
          document.body.style.cursor = "col-resize";
        }}
      />
    </aside>
  );
}

export function WorkbenchStatus({ version }: { version?: string }) {
  const { store, core, toggleSidebar } = useWorkbench();
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [switching, setSwitching] = useState(false);
  const { bridge, root, connected, offline, gitBranch, gitChangeCount, busyRuns } = useWorkbenchState(useShallow((state) => ({
    bridge: state.bridge,
    root: state.workspace?.path ?? null,
    connected: Boolean(state.bridge),
    offline: Boolean(state.connectionError),
    gitBranch: state.gitBranch,
    gitChangeCount: state.gitChangeCount,
    busyRuns: state.history.filter((run) => run.status === "running").length,
  })));

  async function loadBranches() {
    if (!bridge || !root) return;
    try {
      const list = await bridge.rpc("git.branches", { workspacePath: root });
      setBranches(list);
    } catch {
      setBranches([]);
    }
  }

  async function checkoutBranch(branch: string) {
    if (!bridge || !root || switching) return;
    setSwitching(true);
    try {
      await bridge.rpc("git.checkout", { branch, workspacePath: root });
      store.setState((state) => ({ refreshKey: state.refreshKey + 1 }));
      await core.refreshWorkspaceMetadata(root);
    } catch (reason) {
      core.reportError(errorMessage(reason));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Group component="footer" className="statusbar" justify="space-between" gap="xs" wrap="nowrap">
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <span className={`state-dot ${connected ? "connected" : ""}`} />
          <Text size="11px" c="dimmed" lh={1}>
            {connected ? "Core connected" : offline ? "Core offline" : "Connecting…"}
          </Text>
        </Group>
        {gitBranch && (
          <Menu position="top-start" width={240} onOpen={() => void loadBranches()}>
            <Menu.Target>
              <UnstyledButton className="status-branch-btn" title="Switch branch or open Git">
                <Group gap={5} wrap="nowrap">
                  <GitBranch size={12} weight="duotone" />
                  <Text size="11px" lh={1}>{gitBranch}</Text>
                  {gitChangeCount > 0 && <Badge size="xs" variant="light" color="iris" px={5}>{gitChangeCount}</Badge>}
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Switch branch</Menu.Label>
              {branches.slice(0, 12).map((branch) => (
                <Menu.Item
                  key={branch.name}
                  disabled={branch.current || switching}
                  rightSection={branch.current ? <Check size={12} color="var(--accent)" /> : undefined}
                  onClick={() => void checkoutBranch(branch.name)}
                >
                  <Text size="xs" truncate="end">{branch.name}</Text>
                </Menu.Item>
              ))}
              {branches.length > 0 && <Menu.Divider />}
              <Menu.Item leftSection={<GitBranch size={12} />} onClick={() => toggleSidebar("git")}>
                Open Git sidebar
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>

      <Group gap="sm" wrap="nowrap">
        {busyRuns > 0 && (
          <Badge size="xs" variant="light" color="iris" leftSection={<Loader size={9} color="iris" />}>
            {busyRuns} {busyRuns === 1 ? "run" : "runs"} active
          </Badge>
        )}
        {version && <Text size="11px" c="dimmed" ff="monospace">v{version}</Text>}
      </Group>
    </Group>
  );
}

export function WorkbenchDialogs() {
  const { core, settings, projectConfirm, judgeDialog, pickProject, setRules, runJudge } = useWorkbench();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingRecent, setPendingRecent] = useState<string | undefined>(undefined);
  const [judgeOpen, setJudgeOpen] = useState(false);
  const { providers, rules, rpc, lastBroadcastRunIds, details, activeArena } = useWorkbenchState(useShallow((state) => ({
    providers: state.providers,
    rules: state.rules,
    rpc: state.bridge?.rpc,
    lastBroadcastRunIds: state.lastBroadcastRunIds,
    details: state.details,
    activeArena: state.activeArena,
  })));

  const judgeCandidates = lastBroadcastRunIds
    .map((id) => details[id])
    .filter((detail): detail is NonNullable<typeof detail> => Boolean(detail && detail.run.status === "succeeded"));

  useEffect(() => {
    projectConfirm.current = (recentPath?: string) => {
      setPendingRecent(recentPath);
      setConfirmOpen(true);
    };
    return () => { projectConfirm.current = null; };
  }, [projectConfirm]);

  useEffect(() => {
    judgeDialog.current = () => setJudgeOpen(true);
    return () => { judgeDialog.current = null; };
  }, [judgeDialog]);

  return (
    <>
      <SettingsDialog controls={settings} providers={providers} rules={rules} rpc={rpc} onRefresh={core.refreshProviders} onRules={setRules} />
      <JudgeModal
        opened={judgeOpen}
        onClose={() => setJudgeOpen(false)}
        providers={providers}
        candidates={judgeCandidates}
        arena={activeArena}
        onRunJudge={(options) => void runJudge(options)}
      />
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
              const target = pendingRecent;
              setConfirmOpen(false);
              setPendingRecent(undefined);
              void pickProject(true, target);
            }}
          >
            {pendingRecent ? "Open project" : "Choose folder"}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
