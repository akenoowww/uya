import type { EditorSelection, RenderedPrompt, RoutingRule, RunInput } from "@ide/protocol";
import type { SettingsControls } from "./SettingsDialog";
import { createCoreSession } from "./coreSession";
import { createDockLayout } from "./dockLayout";
import { hasPendingEditorSaves, hasUnsavedEditorDrafts } from "./editorDrafts";
import { errorMessage } from "./bridge";
import { parseSlashInvocation } from "./slashCommands";
import {
  activeChatPane, conversationKey, createWorkbenchStore, hasBusyDestination,
  isPaneBusy, providerForPane, resolveModel, routingTargets,
} from "./workbenchStore";
import type { ChatPane, WorkbenchState } from "./workbenchStore";

export function createWorkbench() {
  const store = createWorkbenchStore();
  const dock = createDockLayout(store);
  const core = createCoreSession(store);
  const settings: { current: SettingsControls | null } = { current: null };
  const projectConfirm: { current: (() => void) | null } = { current: null };

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
        if (target) dock.newConversation(target.id);
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
        dock.configure(target.id, { providerId: found.id, model: undefined, mode: found.structured ? "structured" : "terminal" });
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

  async function pickProject(discardConfirmed = false) {
    const state = store.getState();
    const bridge = state.bridge;
    if (!bridge || state.choosingProject || state.submitting || state.submittingPanes.length > 0) return;
    if (hasPendingEditorSaves(state.editorDrafts)) {
      core.reportError("Wait for the current save to finish before opening another project.");
      return;
    }
    if (!discardConfirmed && hasUnsavedEditorDrafts(state.editorDrafts)) {
      projectConfirm.current?.();
      return;
    }
    store.setState({ choosingProject: true, error: "" });
    try {
      const path = await bridge.chooseFolder();
      if (!path) return;
      const project = await bridge.rpc("workspace.open", { path });
      try {
        await bridge.activateFolder(path);
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
      store.setState((current) => ({
        workspace: project,
        sidebar: "explorer",
        refreshKey: current.refreshKey + 1,
        ...(changed ? { selection: null, contextPaths: [], editorDrafts: new Map() } : {}),
      }));
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

  function applyPrompt(prompt: RenderedPrompt) {
    const state = store.getState();
    const target = getActiveChatPane();
    if (prompt.providerId && target) {
      dock.configure(target.id, { providerId: prompt.providerId, model: undefined, mode: "structured" });
      dock.activate(target.id);
      if (!state.providers.some((provider) => provider.id === prompt.providerId && provider.available && provider.structured)) {
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

  async function sendToPane(paneId: string, promptOverride?: string) {
    const state = store.getState();
    const { bridge, choosingProject, contextPaths, selection, template } = state;
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
      const request: RunInput = {
        conversationId: pane.config.conversationId,
        workspacePath: root,
        providerId: provider.id,
        model: resolveModel(provider, pane.config.model),
        prompt,
        contextPaths,
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
      bridge, choosingProject, submitting, composer, contextPaths, selection, tags,
      fallbackIds, template, routing, broadcast, broadcastTargets,
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
    store.setState((current) => ({
      submitting: true,
      error: "",
      submittingPanes: [...new Set([...current.submittingPanes, ...destIds])],
    }));
    if (!useBroadcast) dock.activate(destinations[0].id);
    const root = state.workspace?.path ?? null;
    try {
      const outcomes = await Promise.allSettled(destinations.map(async ({ id, config, provider }) => {
        const request: RunInput = {
          conversationId: config.conversationId,
          workspacePath: root,
          providerId: provider.id,
          model: resolveModel(provider, config.model),
          prompt,
          contextPaths,
          selection: selection ?? undefined,
          mode: useBroadcast ? "manual" : routing,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          fallbackIds: fallbackIds.filter((entry) => entry !== provider.id),
          promptVersion: template?.text.trim() === prompt ? template.revision : undefined,
        };
        const run = await bridge.rpc("runs.start", request);
        core.addRun(bridge, root, config.conversationId, run);
        pushPromptHistory(id, prompt);
      }));
      const failures = outcomes.flatMap((result, index) => result.status === "rejected"
        ? [`${destinations[index].provider.name}: ${errorMessage(result.reason)}`] : []);
      if (failures.length < outcomes.length) {
        store.setState((current) => ({
          composer: current.composer.trim() === prompt ? "" : current.composer,
          template: current.template === template ? null : current.template,
        }));
      }
      if (failures.length) core.reportError(failures.join(" · "));
    } finally {
      store.setState((current) => ({
        submitting: false,
        submittingPanes: current.submittingPanes.filter((id) => !destIds.includes(id)),
      }));
    }
  }

  return {
    store, core, dock, settings, projectConfirm, pickProject, openHistory, applyPrompt,
    sendPrompt, sendToPane, setPaneDraft, executeSlashCommand, activeRunIdForPane,
    activeChatPane: getActiveChatPane,
    readEditorDrafts: () => store.getState().editorDrafts,
    openProviders: () => settings.current?.showProviders(),
    openRules: () => settings.current?.showRules(),
    openShortcuts: () => settings.current?.showShortcuts(),
    setRules: (rules: RoutingRule[]) => store.setState({ rules }),
    retryConnection: () => store.setState((state) => ({ connectionAttempt: state.connectionAttempt + 1 })),
    toggleBroadcast: () => store.setState((state) => {
      if (state.broadcastCollapsed) return { broadcastCollapsed: false, broadcast: true };
      return { broadcast: !state.broadcast };
    }),
    toggleBroadcastCollapsed: () => store.setState((state) => ({ broadcastCollapsed: !state.broadcastCollapsed })),
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
    toggleSidebar: (sidebar: Exclude<WorkbenchState["sidebar"], null>) => store.setState((state) => ({
      sidebar: state.sidebar === sidebar ? null : sidebar,
    })),
    toggleContext: (path: string) => store.setState((state) => ({
      contextPaths: state.contextPaths.includes(path) ? state.contextPaths.filter((item) => item !== path) : [...state.contextPaths, path],
    })),
    selectCode(editorId: string, selection: EditorSelection | null) {
      if (store.getState().dock.editorId === editorId) store.setState({ selection });
    },
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
