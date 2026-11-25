import { useMemo } from "react";
import { Badge, Group, Kbd } from "@mantine/core";
import { Spotlight, spotlight } from "@mantine/spotlight";
import type { SpotlightActionData, SpotlightActionGroupData } from "@mantine/spotlight";
import {
  ArrowClockwise, ArrowCounterClockwise, BookOpen, Brain, Broadcast, ChartBar, ClockCounterClockwise,
  Columns, ColumnsPlusRight, Eye, FileMagnifyingGlass, FolderOpen, GitBranch, Keyboard, Lock,
  MagnifyingGlass, NotePencil, Play, PlugsConnected, Scales, SlidersHorizontal, Sparkle,
  TerminalWindow, Wrench,
} from "@phosphor-icons/react";
import type { ExecutionMode } from "@ide/protocol";
import { useShallow } from "zustand/react/shallow";
import { focusPaneInput, formatShortcut, isMac } from "../shortcuts";
import { useWorkbench, useWorkbenchState } from "../workbenchContext";
import {
  activeChatPane, paneDisplayTitle, providerForPane, resolveAccessMode, resolveModel,
} from "../workbenchStore";
import { ACCESS_MODE_META } from "./AccessModePicker";
import { EFFORT_META, resolveSupportedEfforts } from "./EffortPicker";
import { ProviderIcon } from "./ProviderIcon";

export function toggleCommandPalette() {
  spotlight.toggle();
}

export function openCommandPalette() {
  spotlight.open();
}

export function CommandPalette({
  onOpenQuickOpen,
  onCheckForUpdates,
}: {
  onOpenQuickOpen?: () => void;
  onCheckForUpdates?: () => Promise<void>;
}) {
  const workbench = useWorkbench();
  const {
    dock, providers, workspace, gitBranch, verifyPresets, checkpoints, chatPanes, activePane, activeProvider,
  } = useWorkbenchState(useShallow((state) => {
    const active = activeChatPane(state.dock);
    const activeIndex = active ? state.dock.chatPanes.findIndex((entry) => entry.id === active.id) : -1;
    return {
      dock: state.dock,
      providers: state.providers,
      workspace: state.workspace,
      gitBranch: state.gitBranch,
      verifyPresets: state.verifyPresets,
      checkpoints: state.checkpoints,
      chatPanes: state.dock.chatPanes,
      activePane: active,
      activeProvider: active ? providerForPane(state.providers, active.config, activeIndex) : undefined,
    };
  }));

  const actions = useMemo<SpotlightActionGroupData[]>(() => {
    const groups: SpotlightActionGroupData[] = [];

    if (chatPanes.length > 0) {
      const splitActions: SpotlightActionData[] = chatPanes.map((pane, index) => {
        const provider = providerForPane(providers, pane.config, index);
        const title = paneDisplayTitle(provider, pane.config, index);
        const shortcut = index < 9 ? `${isMac ? "⌘" : "Ctrl+"}${index + 1}` : undefined;
        return {
          id: `split-${pane.id}`,
          label: title,
          description: `Focus split ${index + 1}`,
          keywords: ["split", `${index + 1}`, title, provider?.id ?? ""],
          leftSection: <ProviderIcon providerId={provider?.id} size={14} framed={false} />,
          rightSection: (
            <Group gap={6}>
              {dock.activePaneId === pane.id && <Badge size="xs" variant="light" color="iris">Active</Badge>}
              {shortcut && <Kbd>{shortcut}</Kbd>}
            </Group>
          ),
          onClick: () => {
            workbench.dock.activate(pane.id);
            requestAnimationFrame(() => focusPaneInput(pane.id));
          },
        };
      });
      groups.push({ group: "Focus Split", actions: splitActions });
    }

    const activeModels = activeProvider?.models ?? [];
    const currentModel = resolveModel(activeProvider, activePane?.config.model);
    if (activePane && activeProvider && activeModels.length > 0) {
      const modelActions: SpotlightActionData[] = [];
      if (activeProvider.kind === "cli") {
        modelActions.push({
          id: "model-default",
          label: "CLI default model",
          description: activeProvider.defaultModel ? `Uses ${activeProvider.defaultModel}` : `Uses ${activeProvider.name} default`,
          keywords: ["model", "default", "auto", activeProvider.name],
          leftSection: <Sparkle size={15} weight="duotone" color="var(--accent)" />,
          rightSection: !currentModel ? <Badge size="xs" variant="light" color="iris">Current</Badge> : undefined,
          onClick: () => workbench.dock.configure(activePane.id, { model: undefined }),
        });
      }
      for (const model of activeModels) {
        modelActions.push({
          id: `model-${model}`,
          label: model,
          description: `${activeProvider.name} model version`,
          keywords: ["model", model, activeProvider.name],
          leftSection: <Sparkle size={15} weight="duotone" color="var(--accent)" />,
          rightSection: currentModel === model ? <Badge size="xs" variant="light" color="iris">Current</Badge> : undefined,
          onClick: () => workbench.dock.configure(activePane.id, { model }),
        });
      }
      groups.push({ group: `Switch ${activeProvider.name} Model`, actions: modelActions });
    }

    const supportedEfforts = resolveSupportedEfforts(activeProvider, currentModel);
    if (activePane && activeProvider && supportedEfforts.length > 0) {
      const currentEffort = activePane.config.effort;
      groups.push({
        group: `Set ${activeProvider.name} Reasoning Effort`,
        actions: [
          {
            id: "effort-auto",
            label: "Effort: Auto",
            description: "Use provider default reasoning effort",
            keywords: ["effort", "reasoning", "thinking", "auto", "default"],
            leftSection: <Brain size={15} weight="duotone" color="var(--accent)" />,
            rightSection: !currentEffort ? <Badge size="xs" variant="light" color="iris">Current</Badge> : undefined,
            onClick: () => workbench.dock.configure(activePane.id, { effort: undefined }),
          },
          ...supportedEfforts.map((level) => ({
            id: `effort-${level}`,
            label: `Effort: ${EFFORT_META[level].label}`,
            description: EFFORT_META[level].hint,
            keywords: ["effort", "reasoning", "thinking", level, EFFORT_META[level].label],
            leftSection: <Brain size={15} weight="duotone" color="var(--accent)" />,
            rightSection: currentEffort === level ? <Badge size="xs" variant="light" color="iris">Current</Badge> : undefined,
            onClick: () => workbench.dock.configure(activePane.id, { effort: level }),
          })),
        ],
      });
    }

    if (activePane && activeProvider?.structured) {
      const supportedModes = activeProvider.supportedModes ?? ["isolated"];
      const currentMode = resolveAccessMode(activeProvider, activePane.config.accessMode, Boolean(workspace));
      const modeActions: SpotlightActionData[] = (["isolated", "read-only", "agent"] as ExecutionMode[])
        .filter((mode) => mode === "isolated" || (Boolean(workspace) && supportedModes.includes(mode)))
        .map((mode) => ({
          id: `access-mode-${mode}`,
          label: `Access Mode: ${ACCESS_MODE_META[mode].label}`,
          description: ACCESS_MODE_META[mode].hint,
          keywords: ["mode", "access", mode, ACCESS_MODE_META[mode].label, "explore", "agent", "isolated"],
          leftSection: mode === "agent"
            ? <Wrench size={15} weight="duotone" color="var(--accent)" />
            : mode === "read-only"
              ? <Eye size={15} weight="duotone" color="var(--positive)" />
              : <Lock size={15} weight="duotone" color="var(--muted)" />,
          rightSection: currentMode === mode ? <Badge size="xs" variant="light" color="iris">Current</Badge> : undefined,
          onClick: () => workbench.dock.configure(activePane.id, { accessMode: mode }),
        }));
      if (modeActions.length > 1) {
        groups.push({ group: "Workspace Access Mode", actions: modeActions });
      }
    }

    const availableProviders = providers.filter((entry) => entry.available);
    if (activePane && availableProviders.length > 1) {
      groups.push({
        group: "Switch Active Split Provider",
        actions: availableProviders.map((provider) => ({
          id: `provider-${provider.id}`,
          label: `Use ${provider.name}`,
          description: provider.structured ? "Structured chat & terminal" : "Interactive terminal",
          keywords: ["provider", provider.name, provider.id],
          leftSection: <ProviderIcon providerId={provider.id} size={14} framed={false} />,
          onClick: () => workbench.dock.configure(activePane.id, {
            providerId: provider.id,
            model: undefined,
            effort: undefined,
            mode: provider.structured ? "structured" : "terminal",
          }),
        })),
      });
    }

    const actionItems: SpotlightActionData[] = [
      ...(onOpenQuickOpen ? [{
        id: "quick-open",
        label: "Quick Open file",
        description: "Jump to any file in the open workspace",
        leftSection: <FileMagnifyingGlass size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("quick-open")}</Kbd>,
        onClick: onOpenQuickOpen,
      }] : []),
      {
        id: "new-split",
        label: "New model split",
        description: "Open another model comparison split",
        leftSection: <ColumnsPlusRight size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("new-split")}</Kbd>,
        onClick: () => {
          const created = workbench.dock.newSplit();
          if (created) requestAnimationFrame(() => focusPaneInput(created));
        },
      },
      ...(activePane ? [{
        id: "new-conversation",
        label: "New conversation in active split",
        description: "Start a fresh thread in the focused split",
        leftSection: <NotePencil size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("new-conversation")}</Kbd>,
        onClick: () => {
          workbench.startNewConversation(activePane.id);
          requestAnimationFrame(() => focusPaneInput(activePane.id));
        },
      }] : []),
      {
        id: "toggle-search",
        label: "Search across workspace",
        description: "Full-text code search powered by ripgrep",
        leftSection: <MagnifyingGlass size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("toggle-search")}</Kbd>,
        onClick: () => workbench.openSearch(),
      },
      {
        id: "toggle-broadcast",
        label: "Toggle Broadcast multi-model composer",
        description: "Send one prompt to multiple splits simultaneously",
        leftSection: <Broadcast size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("toggle-broadcast")}</Kbd>,
        onClick: () => workbench.toggleBroadcast(),
      },
      ...(workspace && gitBranch ? [{
        id: "toggle-arena",
        label: "Toggle Worktree Arena",
        description: "Run broadcast models in isolated parallel git worktrees",
        leftSection: <GitBranch size={15} weight="duotone" color="var(--positive)" />,
        onClick: () => workbench.toggleArena(),
      }] : []),
      ...verifyPresets.slice(0, 3).map((preset) => ({
        id: `verify-${preset.id}`,
        label: `Verify: ${preset.label}`,
        description: preset.command,
        keywords: ["verify", "test", "build", "lint", preset.label, preset.command],
        leftSection: <Play size={15} weight="fill" color="var(--positive)" />,
        onClick: () => void workbench.core.startVerify(preset.command),
      })),
      ...(checkpoints.length > 0 ? [{
        id: "restore-checkpoint",
        label: "Undo last agent turn (restore checkpoint)",
        description: `Restore "${checkpoints[0].label}"`,
        keywords: ["undo", "checkpoint", "rollback", "restore"],
        leftSection: <ArrowCounterClockwise size={15} weight="bold" />,
        onClick: () => void workbench.core.restoreCheckpoint(checkpoints[0].id),
      }] : []),
      {
        id: "judge-broadcast",
        label: "Cross-review / Synthesize broadcast responses",
        description: "Send latest broadcast responses to an arbiter model",
        leftSection: <Scales size={15} weight="duotone" />,
        onClick: () => workbench.judgeDialog.current?.(),
      },
      ...(activePane ? [{
        id: "toggle-terminal",
        label: "Toggle split interactive terminal",
        description: "Switch active split between Structured and TUI mode",
        leftSection: <TerminalWindow size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("toggle-terminal")}</Kbd>,
        onClick: () => workbench.dock.configure(activePane.id, {
          mode: activePane.config.mode === "terminal" ? "structured" : "terminal",
        }),
      }] : []),
      {
        id: "open-project",
        label: "Open project folder",
        description: "Switch active workspace directory",
        leftSection: <FolderOpen size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("open-project")}</Kbd>,
        onClick: () => void workbench.pickProject(),
      },
      {
        id: "toggle-explorer",
        label: "Toggle Explorer sidebar",
        description: "Show or hide workspace files",
        leftSection: <Columns size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("toggle-explorer")}</Kbd>,
        onClick: () => workbench.toggleSidebar("explorer"),
      },
      {
        id: "toggle-git",
        label: "Toggle Git sidebar",
        description: "Inspect repository status, diffs, and attach git diff",
        leftSection: <GitBranch size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("toggle-git")}</Kbd>,
        onClick: () => workbench.toggleSidebar("git"),
      },
      {
        id: "toggle-history",
        label: "Toggle History & Threads",
        description: "Browse, resume, or fork saved conversations",
        leftSection: <ClockCounterClockwise size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("toggle-history")}</Kbd>,
        onClick: () => workbench.toggleSidebar("history"),
      },
      {
        id: "open-prompts",
        label: "Open Prompt Library",
        description: "Browse or create reusable templates",
        leftSection: <BookOpen size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("open-prompts")}</Kbd>,
        onClick: () => workbench.dock.openTool("prompts", "Prompt Library"),
      },
      {
        id: "open-terminal",
        label: "Open Shell Terminal",
        description: "Launch an interactive shell tab",
        leftSection: <TerminalWindow size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("open-terminal")}</Kbd>,
        onClick: () => workbench.dock.openTool("terminal", "Terminal"),
      },
      {
        id: "open-providers",
        label: "Manage Providers & Local Runtimes",
        description: "Discover CLIs, local servers, and custom commands",
        leftSection: <PlugsConnected size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("open-providers")}</Kbd>,
        onClick: () => workbench.openProviders(),
      },
      {
        id: "open-rules",
        label: "Configure Routing Rules",
        description: "Route prompts by tag, extension, or context size",
        leftSection: <SlidersHorizontal size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("open-rules")}</Kbd>,
        onClick: () => workbench.openRules(),
      },
      {
        id: "open-usage",
        label: "View Usage & Speed Insights",
        description: "Inspect TTFT, tokens, and effort breakdown by provider",
        leftSection: <ChartBar size={15} weight="duotone" />,
        onClick: () => workbench.openUsage(),
      },
      {
        id: "open-shortcuts",
        label: "Keyboard Shortcuts Reference",
        description: "View all hotkeys and inline slash commands",
        leftSection: <Keyboard size={15} weight="duotone" />,
        rightSection: <Kbd>{formatShortcut("shortcuts")}</Kbd>,
        onClick: () => workbench.openShortcuts(),
      },
      ...(onCheckForUpdates ? [{
        id: "check-for-updates",
        label: "Check for Updates",
        description: "Check for a new version of Uya",
        leftSection: <ArrowClockwise size={15} weight="duotone" />,
        onClick: () => void onCheckForUpdates(),
      }] : []),
    ];
    groups.push({ group: "Actions", actions: actionItems });
    return groups;
  }, [
    activePane, activeProvider, chatPanes, checkpoints, dock.activePaneId, gitBranch,
    onCheckForUpdates, onOpenQuickOpen, providers, verifyPresets, workbench, workspace,
  ]);

  return (
    <Spotlight
      actions={actions}
      shortcut={null}
      nothingFound="No matching commands."
      highlightQuery
      scrollable
      maxHeight={380}
      searchProps={{
        leftSection: <MagnifyingGlass size={15} />,
        placeholder: "Type a command, switch split, pick a model or effort…",
      }}
    />
  );
}
