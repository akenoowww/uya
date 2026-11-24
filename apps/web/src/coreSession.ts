import type { RunDetail, RunSummary } from "@ide/protocol";
import { connect, errorMessage } from "./bridge";
import type { Bridge } from "./bridge";
import { createRunStreams } from "./runStreams";
import { conversationKey } from "./workbenchStore";
import type { WorkbenchStore } from "./workbenchStore";

export function createCoreSession(store: WorkbenchStore) {
  function reportError(message: string) {
    store.setState({ error: message });
  }

  function recordDetail(detail: RunDetail) {
    const { run } = detail;
    store.setState((state) => {
      const saved = state.details[run.id];
      const savedSequence = saved?.events.at(-1)?.seq ?? 0;
      const sequence = detail.events.at(-1)?.seq ?? 0;
      if (savedSequence > sequence || (saved && savedSequence === sequence && saved.run.status === run.status)) return state;
      const previous = state.history.find((item) => item.id === run.id);
      const history = previous?.status === run.status && previous.providerId === run.providerId
        ? state.history
        : [run, ...state.history.filter((item) => item.id !== run.id)]
          .sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
      return { details: { ...state.details, [run.id]: detail }, history };
    });
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
      store.setState({ gitBranch: null, gitChangeCount: 0, projectRules: [] });
      return;
    }
    const [gitRes, rulesRes] = await Promise.allSettled([
      bridge.rpc("git.status", { workspacePath: root }),
      bridge.rpc("workspace.projectRules", { workspacePath: root }),
    ]);
    if (store.getState().workspace?.path !== root) return;
    store.setState({
      gitBranch: gitRes.status === "fulfilled" && gitRes.value.isRepo ? (gitRes.value.branch ?? "HEAD") : null,
      gitChangeCount: gitRes.status === "fulfilled" && gitRes.value.isRepo ? gitRes.value.changes.length : 0,
      projectRules: rulesRes.status === "fulfilled" ? rulesRes.value : [],
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
    hydrate, addRun, readRun, cancelRun, deleteRun, deleteConversation, reportError, recordDetail,
  };
}
