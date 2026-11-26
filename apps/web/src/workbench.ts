import type {
  ConversationSummary, EditorSelection, EffortLevel, OriginActor, RenderedPrompt, RoutingRule, RunInput,
} from "@ide/protocol";
import type { SettingsControls } from "./SettingsDialog";
import { errorMessage } from "./bridge";
import { parseAccessModeArg } from "./components/AccessModePicker";
import { parseEffortArg, resolveSupportedEfforts } from "./components/EffortPicker";
import { buildJudgePrompt, extractRunReplyText } from "./components/JudgeModal";
import type { JudgePreset } from "./components/JudgeModal";
import type { ApplyPreviewRequest } from "./components/MarkdownView";
import { createCoreSession } from "./coreSession";
import { createDockLayout } from "./dockLayout";
import { hasPendingEditorSaves, hasUnsavedEditorDrafts } from "./editorDrafts";
import { parseSlashInvocation } from "./slashCommands";
import { readLatestTerminalOutput } from "./terminalBuffer";
import {
  activeChatPane, buildWorkbenchSnapshot, conversationKey, createWorkbenchStore, hasBusyDestination,
  isPaneBusy, paneAlias, providerForPane, resolveAccessMode, resolveModel, routingTargets, utf8Bytes,
} from "./workbenchStore";
import type { ChatPane, SidebarView } from "./workbenchStore";

export type SynapseModalTab = "matrix" | "capabilities" | "missions";

export function createWorkbench() {
  const store = createWorkbenchStore();
  const dock = createDockLayout(store);
  const core = createCoreSession(store);
  const settings: { current: SettingsControls | null } = { current: null };
  const projectConfirm: { current: ((pendingRecentPath?: string) => void) | null } = { current: null };
  const judgeDialog: { current: (() => void) | null } = { current: null };
  const synapseDialog: { current: ((tab?: SynapseModalTab) => void) | null } = { current: null };

  core.setUiCommandHandler((command) => {
    switch (command.action) {
      case "open_file":
        if (command.path) dock.openFile(command.path, command.line);
        break;
      case "open_diff":
        if (command.path) dock.openDiff({ mode: "git", path: command.path, staged: false });
        break;
      case "focus_split": {
        if (!command.paneId) break;
        const state = store.getState();
        const found = state.dock.chatPanes.find((pane, index) => {
          const provider = providerForPane(state.providers, pane.config, index);
          return pane.id === command.paneId
            || paneAlias(provider, pane.config, index) === command.paneId
            || provider?.id === command.paneId;
        });
        if (found) dock.activate(found.id);
        break;
      }
    }
  });

  function pushPromptHistory(paneId: string, prompt: string) {
    store.setState((state) => {
      const prev = state.panePromptHistory[paneId] ?? [];
      const next = prev.at(-1) === prompt ? prev : [...prev, prompt].slice(-25);
      return { panePromptHistory: { ...state.panePromptHistory, [paneId]: next } };
    });
  }

  function setPaneDraft(paneId: string, text: string) {
    store.setState((state) => ({
      paneDrafts: { ...state.paneDrafts, [paneId]: text },
    }));
  }

  function getActiveChatPane(): ChatPane | undefined {
    return activeChatPane(store.getState().dock);
  }

  function activeRunIdForPane(paneId: string): string | undefined {
    const state = store.getState();
    const pane = state.dock.chatPanes.find((entry) => entry.id === paneId);
    if (!pane) return undefined;
    const key = conversationKey(state.workspace?.path ?? null, pane.config.conversationId);
    const runIds = state.paneRuns[key] ?? [];
    for (let i = runIds.length - 1; i >= 0; i -= 1) {
      const detail = state.details[runIds[i]];
      if (detail?.run.status === "running") return detail.run.id;
    }
    return undefined;
  }

  async function measureContextFile(path: string) {
    const { bridge, workspace } = store.getState();
    if (!bridge || !workspace) return;
    try {
      const file = await bridge.rpc("workspace.read", { path, workspacePath: workspace.path });
      store.setState((state) => ({
        contextSizes: { ...state.contextSizes, [path]: utf8Bytes(file.text) },
      }));
    } catch {
      // Size estimation is best-effort; backend enforces the authoritative limit.
    }
  }

  function toggleContext(path: string) {
    const adding = !store.getState().contextPaths.includes(path);
    store.setState((state) => ({
      contextPaths: adding ? [...state.contextPaths, path] : state.contextPaths.filter((item) => item !== path),
    }));
    if (adding) void measureContextFile(path);
  }

  function attachFile(path: string) {
    if (!store.getState().contextPaths.includes(path)) {
      toggleContext(path);
    }
  }

  async function attachGitDiff(staged = false) {
    const { bridge, workspace } = store.getState();
    if (!bridge || !workspace) {
      core.reportError("Open a Git project folder first.");
      return;
    }
    core.reportError("");
    try {
      const result = await bridge.rpc("git.diff", { staged, workspacePath: workspace.path });
      if (!result.diff.trim()) {
        core.reportError(staged ? "No staged Git diff to attach." : "Working tree has no unstaged diff to attach.");
        return;
      }
      const label = staged ? "@git-staged" : "@git-diff";
      store.setState((state) => ({
        attachments: [
          ...state.attachments.filter((item) => item.path !== label),
          { path: label, text: result.diff },
        ],
      }));
    } catch (reason) {
      core.reportError(errorMessage(reason));
    }
  }

  function attachTerminal() {
    const snapshot = readLatestTerminalOutput();
    if (!snapshot) {
      core.reportError("No terminal output captured yet.");
      return;
    }
    core.reportError("");
    const label = `@terminal (${snapshot.title})`;
    store.setState((state) => ({
      attachments: [
        ...state.attachments.filter((item) => !item.path.startsWith("@terminal")),
        { path: label, text: snapshot.text },
      ],
    }));
  }

  function removeAttachment(path: string) {
    store.setState((state) => ({
      attachments: state.attachments.filter((item) => item.path !== path),
    }));
  }

  async function openExternalUrl(url: string) {
    const { bridge } = store.getState();
    if (!bridge) return;
    try {
      await bridge.openExternalUrl(url);
    } catch (reason) {
      core.reportError(errorMessage(reason));
    }
  }

  function previewDiffFromCode(request: ApplyPreviewRequest) {
    const state = store.getState();
    if (!state.workspace) {
      core.reportError("Open a project folder before previewing or applying code diffs.");
      return;
    }
    if (request.multiFiles && request.multiFiles.length > 1) {
      dock.openDiff({
        mode: "apply",
        path: request.multiFiles[0].path,
        proposedCode: request.code,
        language: request.language,
        multiFiles: request.multiFiles,
      });
      return;
    }
    const targetPath = request.suggestedPath ?? state.dock.filePath;
    if (!targetPath) {
      core.reportError("Open a target file in the editor (or include its path) to preview this diff.");
      return;
    }
    dock.openDiff({
      mode: "apply",
      path: targetPath,
      proposedCode: request.code,
      language: request.language,
    });
  }

  function startNewConversation(paneId: string) {
    const pane = store.getState().dock.chatPanes.find((entry) => entry.id === paneId);
    if (pane?.config.conversationId) {
      void core.closeConversationSession(pane.config.conversationId);
    }
    dock.newConversation(paneId);
  }

  function openSearch(query?: string) {
    const trimmed = query?.trim();
    store.setState((state) => ({
      sidebar: "search",
      searchQuerySeed: trimmed ? { query: trimmed, nonce: Date.now() } : state.searchQuerySeed,
    }));
  }

  function runInTerminal(command: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    store.setState({ pendingTerminalCommand: { command: trimmed, nonce: Date.now() } });
    dock.openTool("terminal", "Terminal");
  }

  function sendVerifyFailureToAgent() {
    const state = store.getState();
    const verify = state.activeVerify;
    if (!verify) return;
    const label = `@verify (${verify.command})`;
    const header = `Command: ${verify.command}\nStatus: ${verify.status} (exit ${verify.exitCode ?? "?"})\n\n`;
    store.setState((current) => ({
      attachments: [
        ...current.attachments.filter((item) => !item.path.startsWith("@verify")),
        { path: label, text: header + verify.output },
      ],
    }));
    const target = getActiveChatPane();
    if (target) {
      dock.activate(target.id);
      if (!(state.paneDrafts[target.id] ?? "").trim()) {
        setPaneDraft(target.id, `Fix the failing check in ${label}.`);
      }
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(`textarea[data-pane-input="${CSS.escape(target.id)}"]`)?.focus();
      });
    }
  }

  async function generateCommitMessage(staged: boolean): Promise<string | null> {
    const state = store.getState();
    const { bridge, workspace, providers } = state;
    if (!bridge || !workspace) {
      core.reportError("Open a Git project folder first.");
      return null;
    }
    const provider = providers.find((item) => item.available && item.structured);
    if (!provider) {
      core.reportError("No structured provider available to generate a commit message.");
      return null;
    }
    core.reportError("");
    try {
      const diffResult = await bridge.rpc("git.diff", { staged, workspacePath: workspace.path });
      if (!diffResult.diff.trim()) {
        core.reportError(staged ? "No staged changes to summarize." : "No working tree changes to summarize.");
        return null;
      }
      const started = await bridge.rpc("runs.start", {
        workspacePath: workspace.path,
        providerId: provider.id,
        accessMode: "isolated",
        mode: "manual",
        prompt: [
          "Write a concise Conventional Commit message summarizing the attached Git diff.",
          "Return ONLY the commit message (single subject line <= 72 chars; optional brief bullet body only if multiple distinct changes).",
          "No markdown fences, quotes, or commentary.",
        ].join(" "),
        attachments: [{ path: staged ? "@git-staged" : "@git-diff", text: diffResult.diff.slice(0, 60_000) }],
      });
      const deadline = Date.now() + 20_000;
      let detail = await bridge.rpc("runs.get", { id: started.id });
      while (detail.run.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        detail = await bridge.rpc("runs.get", { id: started.id });
      }
      if (detail.run.status === "running") {
        void bridge.rpc("runs.cancel", { id: started.id }).catch(() => {});
        core.reportError("Timed out generating commit message.");
        return null;
      }
      if (detail.run.status !== "succeeded") {
        core.reportError(detail.run.error || "Commit message generation failed.");
        return null;
      }
      const cleaned = extractRunReplyText(detail)
        .replace(/^```[^\n]*\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
      return cleaned || null;
    } catch (reason) {
      core.reportError(errorMessage(reason));
      return null;
    }
  }

  function executeSlashCommand(input: string, paneId?: string): boolean {
    const parsed = parseSlashInvocation(input);
    if (!parsed) return false;
    const { command, arg } = parsed;
    const state = store.getState();
    const target = (paneId ? state.dock.chatPanes.find((pane) => pane.id === paneId) : undefined)
      ?? getActiveChatPane();

    core.reportError("");
    switch (command.name) {
      case "new":
        if (target) startNewConversation(target.id);
        return true;
      case "model": {
        if (!target) return true;
        const index = state.dock.chatPanes.findIndex((pane) => pane.id === target.id);
        const provider = providerForPane(state.providers, target.config, index);
        if (!arg) {
          const trigger = document.querySelector<HTMLButtonElement>(`[data-model-trigger="${CSS.escape(target.id)}"]`);
          trigger?.click();
          return true;
        }
        if (arg.toLowerCase() === "default" || arg.toLowerCase() === "auto") {
          if (provider?.kind === "cli") dock.configure(target.id, { model: undefined });
          return true;
        }
        if (provider?.kind === "runtime" && provider.models?.length && !provider.models.includes(arg)) {
          const matched = provider.models.find((item) => item.toLowerCase().includes(arg.toLowerCase()));
          if (!matched) {
            core.reportError(`Local model "${arg}" not found in ${provider.name}.`);
            return true;
          }
          dock.configure(target.id, { model: matched });
          return true;
        }
        const matched = provider?.models?.find((item) => item.toLowerCase() === arg.toLowerCase()) ?? arg;
        dock.configure(target.id, { model: matched });
        return true;
      }
      case "effort": {
        if (!target) return true;
        const index = state.dock.chatPanes.findIndex((pane) => pane.id === target.id);
        const provider = providerForPane(state.providers, target.config, index);
        const model = resolveModel(provider, target.config.model);
        const supported = resolveSupportedEfforts(provider, model);
        if (!arg) {
          const trigger = document.querySelector<HTMLButtonElement>(`[data-effort-trigger="${CSS.escape(target.id)}"]`);
          trigger?.click();
          return true;
        }
        const parsedEffort = parseEffortArg(arg);
        if (!parsedEffort) {
          core.reportError(`Unknown effort level "${arg}". Use auto, minimal, low, medium, high, xhigh, or max.`);
          return true;
        }
        if (parsedEffort === "auto") {
          dock.configure(target.id, { effort: undefined });
          return true;
        }
        if (!supported.length) {
          core.reportError(`${provider?.name ?? "This provider"} does not support reasoning effort.`);
          return true;
        }
        if (!supported.includes(parsedEffort)) {
          core.reportError(`${provider?.name ?? "This provider"} supports: ${supported.join(", ")}.`);
          return true;
        }
        dock.configure(target.id, { effort: parsedEffort });
        return true;
      }
      case "provider": {
        if (!target) return true;
        if (!arg) {
          settings.current?.showProviders();
          return true;
        }
        const query = arg.toLowerCase();
        const found = state.providers.find((provider) =>
          provider.available && (provider.id.toLowerCase() === query || provider.name.toLowerCase().includes(query)));
        if (!found) {
          core.reportError(`No available provider matching "${arg}".`);
          return true;
        }
        dock.configure(target.id, { providerId: found.id, model: undefined, effort: undefined, mode: found.structured ? "structured" : "terminal" });
        return true;
      }
      case "mode": {
        if (!target) return true;
        const index = state.dock.chatPanes.findIndex((pane) => pane.id === target.id);
        const provider = providerForPane(state.providers, target.config, index);
        if (!arg) {
          const trigger = document.querySelector<HTMLButtonElement>(`[data-mode-trigger="${CSS.escape(target.id)}"]`);
          trigger?.click();
          return true;
        }
        const parsedMode = parseAccessModeArg(arg);
        if (!parsedMode) {
          core.reportError(`Unknown mode "${arg}". Use isolated, explore (read-only), or agent.`);
          return true;
        }
        if (parsedMode !== "isolated" && !state.workspace) {
          core.reportError("Open a project folder before switching to Explore or Agent mode.");
          return true;
        }
        const supported = provider?.supportedModes ?? ["isolated"];
        if (!supported.includes(parsedMode)) {
          core.reportError(`${provider?.name ?? "This provider"} only supports: ${supported.join(", ")}.`);
          return true;
        }
        dock.configure(target.id, { accessMode: parsedMode });
        return true;
      }
      case "arena": {
        const lower = arg.trim().toLowerCase();
        if (lower === "discard") {
          if (state.activeArena) void core.discardArena(state.activeArena.id);
          else core.reportError("No active Worktree Arena to discard.");
          return true;
        }
        if (!state.workspace || !state.gitBranch) {
          core.reportError("Open a Git repository folder to use Worktree Arena.");
          return true;
        }
        const nextEnabled = lower === "on" ? true : lower === "off" ? false : !state.arenaEnabled;
        store.setState({ arenaEnabled: nextEnabled, ...(nextEnabled ? { broadcast: true, broadcastCollapsed: false } : {}) });
        return true;
      }
      case "search":
        openSearch(arg);
        return true;
      case "verify": {
        const cmd = arg.trim() || state.verifyPresets[0]?.command;
        if (!cmd) {
          core.reportError("No verify presets detected. Try /verify <command>.");
          return true;
        }
        void core.startVerify(cmd);
        return true;
      }
      case "undo": {
        const candidate = state.checkpoints.find((cp) => !cp.restoredAt) ?? state.checkpoints[0];
        if (!candidate) {
          core.reportError("No saved checkpoints available to restore.");
          return true;
        }
        void core.restoreCheckpoint(candidate.id);
        return true;
      }
      case "terminal":
        if (target) {
          dock.configure(target.id, { mode: target.config.mode === "terminal" ? "structured" : "terminal" });
        }
        return true;
      case "split":
        dock.newSplit();
        return true;
      case "broadcast":
        store.setState((current) => ({ broadcast: !current.broadcast, broadcastCollapsed: false }));
        return true;
      case "judge":
        judgeDialog.current?.();
        return true;
      case "synapse":
      case "matrix":
        synapseDialog.current?.("matrix");
        return true;
      case "capabilities":
        synapseDialog.current?.("capabilities");
        return true;
      case "mission":
        synapseDialog.current?.("missions");
        return true;
      case "git":
        store.setState((current) => ({ sidebar: current.sidebar === "git" ? null : "git" }));
        return true;
      case "prompts":
        dock.openTool("prompts", "Prompt Library");
        return true;
      case "providers":
        settings.current?.showProviders();
        return true;
      case "rules":
        settings.current?.showRules();
        return true;
      case "shortcuts":
        settings.current?.showShortcuts();
        return true;
      default:
        return false;
    }
  }

  async function openFolderPath(path: string, isRecent: boolean) {
    const state = store.getState();
    const bridge = state.bridge;
    if (!bridge) return;
    const preparedPath = isRecent ? await bridge.prepareRecentFolder(path) : path;
    const project = await bridge.rpc("workspace.open", { path: preparedPath });
    try {
      await bridge.activateFolder(preparedPath);
    } catch (reason) {
      try {
        if (state.workspace) await bridge.rpc("workspace.open", { path: state.workspace.path });
        else await bridge.rpc("workspace.close", { path: project.path });
      } catch {
        throw new Error("Could not restore the previous project. Reopen a folder to continue.");
      }
      throw reason;
    }
    const changed = project.path !== state.workspace?.path;
    if (changed) dock.closeEditors();
    const recentWorkspaces = await bridge.listRecentFolders();
    store.setState((current) => ({
      workspace: project,
      recentWorkspaces,
      sidebar: "explorer",
      refreshKey: current.refreshKey + 1,
      ...(changed
        ? {
            selection: null,
            contextPaths: [],
            contextSizes: {},
            attachments: [],
            editorDrafts: new Map(),
            activeVerify: null,
            activeArena: null,
            arenaEnabled: false,
            searchQuerySeed: null,
          }
        : {}),
    }));
    void core.refreshWorkspaceMetadata(project.path);
  }

  async function pickProject(discardConfirmed = false, recentPath?: string) {
    const state = store.getState();
    const bridge = state.bridge;
    if (!bridge || state.choosingProject || state.submitting || state.submittingPanes.length > 0) return;
    if (hasPendingEditorSaves(state.editorDrafts)) {
      core.reportError("Wait for the current save to finish before opening another project.");
      return;
    }
    if (!discardConfirmed && hasUnsavedEditorDrafts(state.editorDrafts)) {
      projectConfirm.current?.(recentPath);
      return;
    }
    store.setState({ choosingProject: true, error: "" });
    try {
      if (recentPath) {
        await openFolderPath(recentPath, true);
      } else {
        const path = await bridge.chooseFolder();
        if (!path) return;
        await openFolderPath(path, false);
      }
    } catch (reason) {
      core.reportError(errorMessage(reason));
    } finally {
      store.setState({ choosingProject: false });
    }
  }

  async function openHistory(id: string) {
    if (!store.getState().bridge) return;
    core.reportError("");
    try {
      await core.readRun(id);
      dock.openTool("history", "Run history", id);
    } catch (reason) {
      core.reportError(errorMessage(reason));
    }
  }

  async function resumeConversation(summary: ConversationSummary) {
    const state = store.getState();
    if (!state.bridge) return;
    const activeRoot = state.workspace?.path ?? null;
    if ((summary.workspacePath ?? null) !== activeRoot) {
      core.reportError(summary.workspacePath
        ? "Switch to that thread’s project folder to resume it."
        : "Close the current project folder to resume this workspace-less thread.");
      return;
    }
    dock.openConversationSplit(summary.id, {
      providerId: summary.providerId,
      model: summary.model,
      effort: summary.effort,
      mode: "structured",
    });
  }

  async function forkConversationToSplit(
    conversationId: string,
    workspacePath: string | null,
    options?: { upToRunId?: string; providerId?: string; model?: string; effort?: EffortLevel },
  ) {
    const { bridge, workspace } = store.getState();
    if (!bridge) return;
    const activeRoot = workspace?.path ?? null;
    if ((workspacePath ?? null) !== activeRoot) {
      core.reportError(workspacePath
        ? "Open that conversation’s project folder before forking it."
        : "Close the current project folder before forking this workspace-less thread.");
      return;
    }
    core.reportError("");
    try {
      const forked = await bridge.rpc("runs.fork", {
        conversationId,
        upToRunId: options?.upToRunId,
        workspacePath: activeRoot,
      });
      for (const detail of forked.runs) {
        core.recordDetail(detail);
      }
      const key = conversationKey(activeRoot, forked.conversationId);
      store.setState((state) => ({
        paneRuns: { ...state.paneRuns, [key]: forked.runs.map(({ run }) => run.id) },
      }));
      dock.openConversationSplit(forked.conversationId, {
        providerId: options?.providerId ?? forked.runs.at(-1)?.run.providerId,
        model: options?.model ?? forked.runs.at(-1)?.run.model,
        effort: options?.effort ?? forked.runs.at(-1)?.run.effort,
        mode: "structured",
      });
      void core.refreshHistory();
    } catch (reason) {
      core.reportError(errorMessage(reason));
    }
  }

  function applyPrompt(prompt: RenderedPrompt) {
    const state = store.getState();
    const target = getActiveChatPane();
    if (target && (prompt.providerId || prompt.effort)) {
      dock.configure(target.id, {
        ...(prompt.providerId ? { providerId: prompt.providerId, model: undefined, mode: "structured" } : {}),
        ...(prompt.effort ? { effort: prompt.effort } : {}),
      });
      dock.activate(target.id);
      if (prompt.providerId && !state.providers.some((provider) => provider.id === prompt.providerId && provider.available && provider.structured)) {
        core.reportError("The template’s provider is unavailable. Choose a provider before sending.");
      }
    }
    if (prompt.mode && prompt.mode !== "manual") {
      store.setState({
        composer: prompt.text,
        template: prompt,
        routing: prompt.mode,
        broadcast: false,
        broadcastCollapsed: false,
      });
      document.getElementById("prompt-input")?.focus();
      return;
    }
    if (target) {
      store.setState((current) => ({
        template: prompt,
        paneDrafts: { ...current.paneDrafts, [target.id]: prompt.text },
      }));
      dock.activate(target.id);
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(`textarea[data-pane-input="${CSS.escape(target.id)}"]`)?.focus();
      });
    } else {
      store.setState({ composer: prompt.text, template: prompt, broadcastCollapsed: false });
      document.getElementById("prompt-input")?.focus();
    }
  }

  async function sendToPane(paneId: string, promptOverride?: string, originActor?: OriginActor) {
    const state = store.getState();
    const {
      bridge, choosingProject, contextPaths, attachments, selection, template,
      includeProjectRules, projectRules, synapseEnabled,
    } = state;
    const rawDraft = promptOverride ?? state.paneDrafts[paneId] ?? "";
    const prompt = rawDraft.trim();
    if (!prompt) return;

    if (executeSlashCommand(prompt, paneId)) {
      if (promptOverride === undefined) setPaneDraft(paneId, "");
      return;
    }

    const index = state.dock.chatPanes.findIndex((entry) => entry.id === paneId);
    const pane = state.dock.chatPanes[index];
    const provider = pane ? providerForPane(state.providers, pane.config, index) : undefined;
    if (!bridge || choosingProject || !pane || !provider?.structured || pane.config.mode === "terminal" || isPaneBusy(state, pane)) {
      return;
    }

    store.setState((current) => ({
      error: "",
      submittingPanes: current.submittingPanes.includes(paneId)
        ? current.submittingPanes
        : [...current.submittingPanes, paneId],
    }));
    const root = state.workspace?.path ?? null;
    try {
      const model = resolveModel(provider, pane.config.model);
      const supported = resolveSupportedEfforts(provider, model);
      const effort = pane.config.effort && supported.includes(pane.config.effort) ? pane.config.effort : undefined;
      const accessMode = resolveAccessMode(provider, pane.config.accessMode, Boolean(root));
      const request: RunInput = {
        conversationId: pane.config.conversationId,
        workspacePath: root,
        providerId: provider.id,
        model,
        effort,
        accessMode,
        synapseEnabled,
        workbenchSnapshot: buildWorkbenchSnapshot(state),
        ...(originActor ? { originActor } : {}),
        includeWorkspaceMap: root && state.includeWorkspaceMap ? true : undefined,
        activeFilePath: root ? state.dock.filePath : undefined,
        createCheckpoint: root && accessMode === "agent" ? true : undefined,
        includeProjectRules: includeProjectRules && projectRules.length > 0 ? true : undefined,
        prompt,
        contextPaths,
        attachments: attachments.length ? attachments : undefined,
        selection: selection ?? undefined,
        mode: "manual",
        promptVersion: template?.text.trim() === prompt ? template.revision : undefined,
      };
      const run = await bridge.rpc("runs.start", request);
      core.addRun(bridge, root, pane.config.conversationId, run);
      pushPromptHistory(paneId, prompt);
      if (promptOverride === undefined) {
        store.setState((current) => ({
          paneDrafts: (current.paneDrafts[paneId] ?? "").trim() === prompt
            ? { ...current.paneDrafts, [paneId]: "" }
            : current.paneDrafts,
          template: current.template === template ? null : current.template,
        }));
      }
    } catch (reason) {
      core.reportError(`${provider.name}: ${errorMessage(reason)}`);
    } finally {
      store.setState((current) => ({
        submittingPanes: current.submittingPanes.filter((id) => id !== paneId),
      }));
    }
  }

  async function sendPrompt() {
    const state = store.getState();
    const {
      bridge, choosingProject, submitting, composer, contextPaths, attachments, selection, tags,
      fallbackIds, template, routing, broadcast, broadcastTargets, includeProjectRules, projectRules,
      includeWorkspaceMap, arenaEnabled, gitBranch,
    } = state;
    const prompt = composer.trim();
    if (!prompt) return;

    if (executeSlashCommand(prompt)) {
      store.setState({ composer: "" });
      return;
    }

    const { useBroadcast, destinations } = routingTargets(state.providers, state.dock, broadcast, broadcastTargets);
    if (!bridge || choosingProject || submitting || !destinations.length || hasBusyDestination(state, destinations)) return;
    const destIds = destinations.map((pane) => pane.id);
    const broadcastGroupId = useBroadcast && destinations.length > 1 ? crypto.randomUUID() : undefined;
    const root = state.workspace?.path ?? null;
    const useArena = Boolean(useBroadcast && arenaEnabled && root && gitBranch && destinations.length >= 2);
    store.setState((current) => ({
      submitting: true,
      error: "",
      submittingPanes: [...new Set([...current.submittingPanes, ...destIds])],
    }));
    if (!useBroadcast) dock.activate(destinations[0].id);
    const startedRunIds: string[] = [];
    try {
      let activeArenaId: string | undefined;
      let slotByPane = new Map<string, string>();
      if (useArena && root) {
        try {
          const arena = await bridge.rpc("arena.create", {
            workspacePath: root,
            prompt,
            includeDirty: true,
            slots: destinations.map(({ id, config, provider }) => {
              const model = resolveModel(provider, config.model);
              const supported = resolveSupportedEfforts(provider, model);
              const effort = config.effort && supported.includes(config.effort) ? config.effort : undefined;
              return { paneId: id, providerId: provider.id, providerName: provider.name, model, effort };
            }),
          });
          activeArenaId = arena.id;
          slotByPane = new Map(arena.slots.map((slot) => [slot.paneId, slot.id]));
          store.setState({ activeArena: arena });
        } catch (reason) {
          core.reportError(`Worktree Arena: ${errorMessage(reason)}`);
          return;
        }
      }

      const outcomes = await Promise.allSettled(destinations.map(async ({ id, config, provider }) => {
        const model = resolveModel(provider, config.model);
        const supported = resolveSupportedEfforts(provider, model);
        const effort = config.effort && supported.includes(config.effort) ? config.effort : undefined;
        const arenaSlotId = slotByPane.get(id);
        const accessMode = activeArenaId && arenaSlotId
          ? ((provider.supportedModes ?? ["isolated"]).includes("agent") ? "agent" : resolveAccessMode(provider, config.accessMode, Boolean(root)))
          : resolveAccessMode(provider, config.accessMode, Boolean(root));
        const request: RunInput = {
          conversationId: config.conversationId,
          workspacePath: root,
          providerId: provider.id,
          model,
          effort,
          accessMode,
          synapseEnabled: state.synapseEnabled,
          workbenchSnapshot: buildWorkbenchSnapshot(state),
          includeWorkspaceMap: root && includeWorkspaceMap ? true : undefined,
          activeFilePath: root ? state.dock.filePath : undefined,
          createCheckpoint: !activeArenaId && root && accessMode === "agent" ? true : undefined,
          arenaId: activeArenaId,
          arenaSlotId,
          broadcastGroupId,
          includeProjectRules: includeProjectRules && projectRules.length > 0 ? true : undefined,
          prompt,
          contextPaths,
          attachments: attachments.length ? attachments : undefined,
          selection: selection ?? undefined,
          mode: useBroadcast ? "manual" : routing,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          fallbackIds: fallbackIds.filter((entry) => entry !== provider.id),
          promptVersion: template?.text.trim() === prompt ? template.revision : undefined,
        };
        const run = await bridge.rpc("runs.start", request);
        startedRunIds.push(run.id);
        core.addRun(bridge, root, config.conversationId, run);
        pushPromptHistory(id, prompt);
      }));
      const failures = outcomes.flatMap((result, index) => result.status === "rejected"
        ? [`${destinations[index].provider.name}: ${errorMessage(result.reason)}`] : []);
      if (failures.length < outcomes.length) {
        store.setState((current) => ({
          composer: current.composer.trim() === prompt ? "" : current.composer,
          template: current.template === template ? null : current.template,
          ...(broadcastGroupId && startedRunIds.length >= 2
            ? { lastBroadcastGroupId: broadcastGroupId, lastBroadcastRunIds: startedRunIds }
            : {}),
        }));
      }
      if (activeArenaId) void core.refreshActiveArena(activeArenaId);
      if (failures.length) core.reportError(failures.join(" · "));
    } finally {
      store.setState((current) => ({
        submitting: false,
        submittingPanes: current.submittingPanes.filter((id) => !destIds.includes(id)),
      }));
    }
  }

  async function runJudge(options: {
    providerId: string;
    model?: string;
    effort?: EffortLevel;
    preset: JudgePreset;
    useArenaPatches?: boolean;
  }) {
    const state = store.getState();
    const { bridge } = state;
    if (!bridge) return;
    let judgePrompt = "";
    if (options.useArenaPatches && state.activeArena) {
      const arena = state.activeArena;
      const changedSlots = arena.slots.filter((slot) => slot.filesChanged > 0);
      if (changedSlots.length < 2) {
        core.reportError("Need at least 2 Worktree Arena slots with code changes to cross-review patches.");
        return;
      }
      const entries = await Promise.all(changedSlots.map(async (slot) => {
        let diff = "";
        try {
          const res = await bridge.rpc("arena.slotDiff", { arenaId: arena.id, slotId: slot.id });
          diff = res.diff;
        } catch {
          diff = "";
        }
        const detail = slot.runId ? state.details[slot.runId] : undefined;
        const verifySummary = slot.verify && slot.verify.status !== "idle"
          ? `\`${slot.verify.command}\` → ${slot.verify.status}${slot.verify.exitCode !== undefined && slot.verify.exitCode !== null ? ` (exit ${slot.verify.exitCode})` : ""}`
          : undefined;
        return {
          label: `${slot.providerName}${slot.model ? ` (${slot.model})` : ""} · ${slot.filesChanged} files (+${slot.additions}/-${slot.deletions})`,
          text: detail ? extractRunReplyText(detail) : "",
          diff,
          verifySummary,
        };
      }));
      judgePrompt = buildJudgePrompt(options.preset, arena.prompt, entries);
    } else {
      const candidates = state.lastBroadcastRunIds
        .map((id) => state.details[id])
        .filter((detail): detail is NonNullable<typeof detail> => Boolean(detail && detail.run.status === "succeeded"));
      if (candidates.length < 2) {
        core.reportError("Need at least 2 completed broadcast responses to run cross-model review.");
        return;
      }
      judgePrompt = buildJudgePrompt(
        options.preset,
        candidates[0].run.prompt,
        candidates.map((detail) => ({
          label: `${detail.run.providerName ?? detail.run.providerId}${detail.run.model ? ` (${detail.run.model})` : ""}`,
          text: extractRunReplyText(detail),
        })),
      );
    }

    const judgeProvider = state.providers.find((provider) => provider.id === options.providerId);
    const preferredMode = resolveAccessMode(judgeProvider, "read-only", Boolean(state.workspace));
    const newPaneId = dock.newSplit({
      providerId: options.providerId,
      model: options.model,
      effort: options.effort,
      accessMode: preferredMode,
      mode: "structured",
    });
    if (!newPaneId) return;
    await sendToPane(newPaneId, judgePrompt);
  }

  async function forwardReplyToSplit(
    targetPaneId: string | "new",
    sourceAlias: string,
    sourceProviderId: string,
    replyText: string,
  ) {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    let destinationId = targetPaneId;
    if (targetPaneId === "new") {
      const state = store.getState();
      const alternate = state.providers.find((entry) => entry.available && entry.structured && entry.id !== sourceProviderId)
        ?? state.providers.find((entry) => entry.available && entry.structured);
      const created = dock.newSplit(alternate ? { providerId: alternate.id, mode: "structured" } : undefined);
      if (!created) return;
      destinationId = created;
    } else {
      dock.activate(destinationId);
    }
    const forwardedPrompt = [
      `Review or build upon this output from @${sourceAlias}:`,
      "---",
      trimmed.slice(0, 64_000),
    ].join("\n\n");
    await sendToPane(destinationId, forwardedPrompt, {
      alias: sourceAlias,
      providerId: sourceProviderId,
      kind: "forward",
    });
  }

  return {
    store, core, dock, settings, projectConfirm, judgeDialog, synapseDialog,
    pickProject, openHistory, resumeConversation, forkConversationToSplit,
    applyPrompt, sendPrompt, sendToPane, forwardReplyToSplit, runJudge, setPaneDraft, executeSlashCommand,
    startNewConversation, openSearch, runInTerminal, sendVerifyFailureToAgent, generateCommitMessage,
    activeRunIdForPane, activeChatPane: getActiveChatPane,
    toggleContext, attachFile, attachGitDiff, attachTerminal, removeAttachment,
    openExternalUrl, previewDiffFromCode,
    readEditorDrafts: () => store.getState().editorDrafts,
    openProviders: () => settings.current?.showProviders(),
    openRules: () => settings.current?.showRules(),
    openShortcuts: () => settings.current?.showShortcuts(),
    openUsage: () => settings.current?.showUsage(),
    openSynapse: (tab?: SynapseModalTab) => synapseDialog.current?.(tab),
    setRules: (rules: RoutingRule[]) => store.setState({ rules }),
    retryConnection: () => store.setState((state) => ({ connectionAttempt: state.connectionAttempt + 1 })),
    toggleBroadcast: () => store.setState((state) => {
      if (state.broadcastCollapsed) return { broadcastCollapsed: false, broadcast: true };
      return { broadcast: !state.broadcast };
    }),
    toggleBroadcastCollapsed: () => store.setState((state) => ({ broadcastCollapsed: !state.broadcastCollapsed })),
    toggleProjectRules: () => store.setState((state) => ({ includeProjectRules: !state.includeProjectRules })),
    toggleWorkspaceMap: () => store.setState((state) => ({ includeWorkspaceMap: !state.includeWorkspaceMap })),
    toggleArena: () => store.setState((state) => ({
      arenaEnabled: !state.arenaEnabled,
      ...(!state.arenaEnabled ? { broadcast: true, broadcastCollapsed: false } : {}),
    })),
    toggleBroadcastTarget: (paneId: string) => store.setState((state) => {
      const current = state.broadcastTargets;
      if (!current.length) {
        return { broadcastTargets: [paneId], broadcast: true };
      }
      const next = current.includes(paneId)
        ? current.filter((id) => id !== paneId)
        : [...current, paneId];
      return { broadcastTargets: next, broadcast: true };
    }),
    selectAllBroadcastTargets: () => store.setState({ broadcastTargets: [], broadcast: true }),
    toggleSidebar: (sidebar: Exclude<SidebarView, null>) => store.setState((state) => ({
      sidebar: state.sidebar === sidebar ? null : sidebar,
    })),
    selectCode(editorId: string, selection: EditorSelection | null) {
      if (store.getState().dock.editorId === editorId) store.setState({ selection });
    },
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
