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

  function start() {
    let current = true;
    let unlisten: (() => void) | undefined;
    let watcherDebounce: ReturnType<typeof setTimeout> | undefined;
    store.setState({ bridge: null, connectionError: "" });
    void connect().then(async (bridge) => {
      const history = await bridge.rpc("runs.list", { limit: 100 });
      if (!current) return;
      store.setState({ bridge, history });

      void bridge.watchFolder((path) => {
        if (!current || path !== store.getState().workspace?.path) return;
        clearTimeout(watcherDebounce);
        watcherDebounce = setTimeout(() => {
          if (path === store.getState().workspace?.path) {
            store.setState((state) => ({ refreshKey: state.refreshKey + 1 }));
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
    if (run.status === "running") streams.follow(bridge, run);
    else void bridge.rpc("runs.get", { id: run.id }).then(recordDetail).catch(() => {});
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

  return { start, refreshProviders, hydrate, addRun, readRun, cancelRun, reportError };
}
