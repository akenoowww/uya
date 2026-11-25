import type { ApprovalDecision, RunDetail, RunSummary } from "@ide/protocol";
import { connect, errorMessage } from "./bridge";
import type { Bridge } from "./bridge";
import { createRunStreams } from "./runStreams";
import { conversationKey } from "./workbenchStore";
import type { WorkbenchStore } from "./workbenchStore";

export function createCoreSession(store: WorkbenchStore) {
  function reportError(message: string) {
    store.setState({ error: message });
  }

  let verifyPollTimer: ReturnType<typeof setTimeout> | undefined;

  function stopVerifyPoll() {
    clearTimeout(verifyPollTimer);
    verifyPollTimer = undefined;
  }

  async function refreshActiveArena(arenaId?: string) {
    const state = store.getState();
    const id = arenaId ?? state.activeArena?.id;
    if (!state.bridge || !id) return;
    try {
      const updated = await state.bridge.rpc("arena.get", { id });
      if (store.getState().workspace?.path === updated.workspacePath) {
        store.setState({ activeArena: updated.status === "discarded" ? null : updated });
      }
    } catch {
      // Arena may have been cleaned up or workspace changed.
    }
  }

  function recordDetail(detail: RunDetail) {
    const { run } = detail;
    let shouldRefreshArena = false;
    let shouldRefreshCheckpoints = false;
    store.setState((state) => {
      const saved = state.details[run.id];
      const savedSequence = saved?.events.at(-1)?.seq ?? 0;
      const sequence = detail.events.at(-1)?.seq ?? 0;
      if (savedSequence > sequence || (saved && savedSequence === sequence && saved.run.status === run.status)) return state;
      if (saved?.run.status === "running" && run.status !== "running") {
        if (run.arenaId) shouldRefreshArena = true;
        if (run.checkpointId) shouldRefreshCheckpoints = true;
      }
      const previous = state.history.find((item) => item.id === run.id);
      const history = previous?.status === run.status && previous.providerId === run.providerId
        ? state.history
        : [run, ...state.history.filter((item) => item.id !== run.id)]
          .sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
      return { details: { ...state.details, [run.id]: detail }, history };
    });
    if (shouldRefreshArena && run.arenaId) void refreshActiveArena(run.arenaId);
    if (shouldRefreshCheckpoints) {
      const root = store.getState().workspace?.path ?? null;
      if (root) void refreshWorkspaceMetadata(root);
    }
  }

  const streams = createRunStreams(recordDetail, reportError);
  let activeHistoryFilter: { query?: string; workspacePath?: string | null } = {};

  async function refreshHistory(options?: { query?: string; workspacePath?: string | null }) {
    const { bridge } = store.getState();
    if (!bridge) return;
    const effective = options ?? activeHistoryFilter;
    const [runsResult, convsResult] = await Promise.allSettled([
      bridge.rpc("runs.list", { limit: 100, ...effective }),
      bridge.rpc("runs.conversations", { limit: 60, ...effective }),
    ]);
    if (store.getState().bridge !== bridge) return;
    store.setState((state) => ({
      history: runsResult.status === "fulfilled" ? runsResult.value : state.history,
      conversations: convsResult.status === "fulfilled" ? convsResult.value : state.conversations,
    }));
  }

  function setHistoryFilter(filter: { query?: string; workspacePath?: string | null }) {
    activeHistoryFilter = filter;
    return refreshHistory(filter);
  }

  async function refreshWorkspaceMetadata(root: string | null) {
    const { bridge } = store.getState();
    if (!bridge || !root) {
      store.setState({
        gitBranch: null,
        gitChangeCount: 0,
        projectRules: [],
        checkpoints: [],
        verifyPresets: [],
        activeArena: null,
      });
      return;
    }
    const [gitRes, rulesRes, presetsRes, checkpointsRes, arenasRes] = await Promise.allSettled([
      bridge.rpc("git.status", { workspacePath: root }),
      bridge.rpc("workspace.projectRules", { workspacePath: root }),
      bridge.rpc("verify.presets", { workspacePath: root }),
      bridge.rpc("checkpoints.list", { workspacePath: root, limit: 20 }),
      bridge.rpc("arena.list", { workspacePath: root, limit: 5 }),
    ]);
    if (store.getState().workspace?.path !== root) return;
    const activeArena = arenasRes.status === "fulfilled"
      ? arenasRes.value.find((arena) => arena.status === "active") ?? null
      : store.getState().activeArena;
    store.setState({
      gitBranch: gitRes.status === "fulfilled" && gitRes.value.isRepo ? (gitRes.value.branch ?? "HEAD") : null,
      gitChangeCount: gitRes.status === "fulfilled" && gitRes.value.isRepo ? gitRes.value.changes.length : 0,
      projectRules: rulesRes.status === "fulfilled" ? rulesRes.value : [],
      verifyPresets: presetsRes.status === "fulfilled" ? presetsRes.value : [],
      checkpoints: checkpointsRes.status === "fulfilled" ? checkpointsRes.value : [],
      activeArena,
    });
  }

  function start() {
    let current = true;
    let unlisten: (() => void) | undefined;
    let watcherDebounce: ReturnType<typeof setTimeout> | undefined;
    store.setState({ bridge: null, connectionError: "" });
    void connect().then(async (bridge) => {
      const [history, conversations, recentWorkspaces] = await Promise.all([
        bridge.rpc("runs.list", { limit: 100 }),
        bridge.rpc("runs.conversations", { limit: 60 }).catch(() => []),
        bridge.listRecentFolders(),
      ]);
      if (!current) return;
      store.setState({ bridge, history, conversations, recentWorkspaces });

      void bridge.watchFolder((path) => {
        if (!current || path !== store.getState().workspace?.path) return;
        clearTimeout(watcherDebounce);
        watcherDebounce = setTimeout(() => {
          if (path === store.getState().workspace?.path) {
            store.setState((state) => ({ refreshKey: state.refreshKey + 1 }));
            void refreshWorkspaceMetadata(path);
          }
        }, 180);
      }).then((dispose) => {
        if (current) unlisten = dispose;
        else dispose();
      }).catch(() => {});

      const [sources, rules] = await Promise.allSettled([bridge.rpc("providers.list", {}), bridge.rpc("runs.getRules", {})]);
      if (!current) return;
      if (sources.status === "fulfilled") store.setState({ providers: sources.value });
      else reportError(errorMessage(sources.reason));
      if (rules.status === "fulfilled") store.setState({ rules: rules.value });
    }).catch((reason) => {
      if (current) store.setState({ connectionError: errorMessage(reason) });
    });

    return () => {
      current = false;
      clearTimeout(watcherDebounce);
      stopVerifyPoll();
      unlisten?.();
      streams.stop();
    };
  }

  async function refreshProviders() {
    const { bridge } = store.getState();
    if (!bridge) return;
    const [providers, rules] = await Promise.all([bridge.rpc("providers.list", { refresh: true }), bridge.rpc("runs.getRules", {})]);
    if (store.getState().bridge === bridge) store.setState({ providers, rules });
  }

  function hydrate(bridge: Bridge, root: string | null, conversationIds: string[]) {
    let current = true;
    for (const id of conversationIds) {
      void bridge.rpc("runs.conversation", { id, workspacePath: root }).then((rows) => {
        const state = store.getState();
        if (!current || state.bridge !== bridge || (state.workspace?.path ?? null) !== root) return;
        for (const detail of rows) {
          recordDetail(detail);
          streams.follow(bridge, store.getState().details[detail.run.id].run);
        }
        const key = conversationKey(root, id);
        store.setState((state) => {
          const ids = [...new Set([...rows.map(({ run }) => run.id), ...(state.paneRuns[key] ?? [])])].slice(-12);
          if (ids.length === (state.paneRuns[key] ?? []).length && ids.every((item, index) => item === state.paneRuns[key][index])) return state;
          return { paneRuns: { ...state.paneRuns, [key]: ids } };
        });
      }).catch((reason) => {
        if (current) reportError(errorMessage(reason));
      });
    }
    return () => { current = false; };
  }

  function addRun(bridge: Bridge, root: string | null, conversationId: string | undefined, run: RunSummary) {
    if (store.getState().bridge !== bridge) return;
    recordDetail({ run, events: [] });
    const key = conversationKey(root, conversationId);
    store.setState((state) => ({ paneRuns: { ...state.paneRuns, [key]: [...(state.paneRuns[key] ?? []), run.id].slice(-12) } }));
    if (run.status === "running") {
      streams.follow(bridge, run);
    } else {
      void bridge.rpc("runs.get", { id: run.id }).then(recordDetail).catch(() => {});
    }
    void refreshHistory();
  }

  async function readRun(id: string) {
    const { bridge } = store.getState();
    if (!bridge) return;
    const detail = await bridge.rpc("runs.get", { id });
    if (store.getState().bridge !== bridge) return;
    recordDetail(detail);
    streams.follow(bridge, detail.run);
  }

  async function cancelRun(id: string) {
    try {
      await store.getState().bridge?.rpc("runs.cancel", { id });
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function respondApproval(runId: string, requestId: string, decision: ApprovalDecision) {
    try {
      await store.getState().bridge?.rpc("runs.respondApproval", { runId, requestId, decision });
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function closeConversationSession(conversationId: string | undefined) {
    const { bridge, workspace } = store.getState();
    if (!bridge || !conversationId) return;
    try {
      await bridge.rpc("runs.closeSession", { conversationId, workspacePath: workspace?.path ?? null });
    } catch {
      // Best-effort cleanup of idle session.
    }
  }

  async function restoreCheckpoint(id: string) {
    const { bridge, workspace } = store.getState();
    if (!bridge || !workspace) return;
    reportError("");
    try {
      await bridge.rpc("checkpoints.restore", { id, workspacePath: workspace.path });
      store.setState((state) => ({ refreshKey: state.refreshKey + 1 }));
      await refreshWorkspaceMetadata(workspace.path);
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function startVerify(command: string, arenaTarget?: { arenaId: string; arenaSlotId: string }) {
    const { bridge, workspace } = store.getState();
    if (!bridge || !workspace) {
      reportError("Open a project folder before running verification checks.");
      return;
    }
    const trimmed = command.trim();
    if (!trimmed) return;
    reportError("");
    stopVerifyPoll();
    try {
      const started = await bridge.rpc("verify.start", {
        command: trimmed,
        workspacePath: workspace.path,
        arenaId: arenaTarget?.arenaId,
        arenaSlotId: arenaTarget?.arenaSlotId,
      });
      if (!arenaTarget) store.setState({ activeVerify: started });
      else void refreshActiveArena(arenaTarget.arenaId);

      const poll = async () => {
        const activeBridge = store.getState().bridge;
        if (activeBridge !== bridge) return;
        try {
          const latest = await bridge.rpc("verify.get", { id: started.id });
          if (!arenaTarget) store.setState({ activeVerify: latest });
          if (latest.status === "running") {
            verifyPollTimer = setTimeout(() => void poll(), 350);
          } else if (arenaTarget) {
            void refreshActiveArena(arenaTarget.arenaId);
          }
        } catch {
          stopVerifyPoll();
        }
      };
      if (started.status === "running") {
        verifyPollTimer = setTimeout(() => void poll(), 300);
      }
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function cancelVerify() {
    const { bridge, activeVerify } = store.getState();
    if (!bridge || !activeVerify || activeVerify.status !== "running") return;
    try {
      await bridge.rpc("verify.cancel", { id: activeVerify.id });
      const latest = await bridge.rpc("verify.get", { id: activeVerify.id });
      store.setState({ activeVerify: latest });
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function applyArenaSlot(arenaId: string, slotId: string, mode: "workspace" | "branch", branchName?: string) {
    const { bridge, workspace } = store.getState();
    if (!bridge || !workspace) return;
    reportError("");
    try {
      await bridge.rpc("arena.apply", { arenaId, slotId, mode, branchName, cleanup: true });
      store.setState((state) => ({ activeArena: null, refreshKey: state.refreshKey + 1 }));
      await refreshWorkspaceMetadata(workspace.path);
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function discardArena(arenaId: string) {
    const { bridge } = store.getState();
    if (!bridge) return;
    reportError("");
    try {
      await bridge.rpc("arena.discard", { arenaId });
      store.setState({ activeArena: null });
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function deleteRun(id: string) {
    const { bridge } = store.getState();
    if (!bridge) return;
    try {
      await bridge.rpc("runs.delete", { id });
      store.setState((state) => {
        const nextDetails = { ...state.details };
        delete nextDetails[id];
        return {
          details: nextDetails,
          history: state.history.filter((run) => run.id !== id),
        };
      });
      await refreshHistory();
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  async function deleteConversation(id: string, workspacePath: string | null) {
    const { bridge } = store.getState();
    if (!bridge) return;
    try {
      await bridge.rpc("runs.deleteConversation", { id, workspacePath });
      const key = conversationKey(workspacePath, id);
      store.setState((state) => {
        const nextPaneRuns = { ...state.paneRuns };
        delete nextPaneRuns[key];
        return {
          paneRuns: nextPaneRuns,
          conversations: state.conversations.filter((conv) => !(conv.id === id && conv.workspacePath === workspacePath)),
        };
      });
      await refreshHistory();
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }

  return {
    start, refreshProviders, refreshHistory, setHistoryFilter, refreshWorkspaceMetadata,
    hydrate, addRun, readRun, cancelRun, respondApproval, closeConversationSession,
    restoreCheckpoint, startVerify, cancelVerify, refreshActiveArena, applyArenaSlot, discardArena,
    deleteRun, deleteConversation, reportError, recordDetail,
  };
}
