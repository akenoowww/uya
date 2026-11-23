import type { DockviewApi, DockviewReadyEvent, SerializedDockview } from "dockview-react";
import { shallow } from "zustand/vanilla/shallow";
import type { PaneConfig } from "./RunPane";
import { workspaceLabel } from "./workbenchStore";
import type { ChatPane, WorkbenchStore } from "./workbenchStore";

const layoutKey = "uya:dock-layout:v1";

export type PaneParams = PaneConfig & { tool?: string; runId?: string; filePath?: string; workspacePath?: string };

function newConversationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isEditor(id: string) {
  return id === "editor" || id.startsWith("editor:");
}

function isRun(id: string) {
  return id.startsWith("run-");
}

export function createDockLayout(store: WorkbenchStore) {
  let api: DockviewApi | undefined;
  let nextPane = 0;
  let lastEditorId: string | undefined;
  let lastChatPaneId: string | undefined;
  let layoutSubscription: { dispose(): void } | undefined;
  let activeSubscription: { dispose(): void } | undefined;
  let removeSubscription: { dispose(): void } | undefined;

  function sync() {
    if (!api) return;
    const state = store.getState();
    const current = state.dock;
    const nextPanes: ChatPane[] = api.panels.filter(({ id }) => isRun(id))
      .map((panel) => {
        const config = { ...panel.params } as PaneConfig;
        const previous = current.chatPanes.find(({ id }) => id === panel.id);
        return previous && shallow(previous.config, config) ? previous : { id: panel.id, config };
      });
    const chatPanes = shallow(current.chatPanes, nextPanes) ? current.chatPanes : nextPanes;
    const activePaneId = api.activePanel?.id;
    if (activePaneId && isRun(activePaneId)) lastChatPaneId = activePaneId;
    if (lastChatPaneId && !chatPanes.some((pane) => pane.id === lastChatPaneId)) {
      lastChatPaneId = chatPanes[0]?.id;
    }
    const editor = lastEditorId ? api.getPanel(lastEditorId) : undefined;
    const editorId = editor?.id;
    const filePath = (editor?.params as PaneParams | undefined)?.filePath;
    if (chatPanes === current.chatPanes
      && activePaneId === current.activePaneId
      && lastChatPaneId === current.lastChatPaneId
      && editorId === current.editorId
      && filePath === current.filePath) return;
    store.setState({
      dock: { chatPanes, activePaneId, lastChatPaneId, editorId, filePath },
      selection: editorId === current.editorId ? state.selection : null,
    });
  }

  function save() {
    if (!api) return;
    try {
      localStorage.setItem(layoutKey, JSON.stringify(api.toJSON()));
    } catch {
      // Layout remains usable when localStorage is disabled.
    }
  }

  function addRun(view: DockviewApi, reference?: string, direction: "right" | "below" = "right") {
    let id: string;
    do { id = `run-${++nextPane}`; } while (view.getPanel(id));
    return view.addPanel({
      id, component: "pane", title: `Split ${nextPane}`, renderer: "always",
      params: { conversationId: newConversationId() },
      minimumWidth: 260, minimumHeight: 190,
      position: reference ? { referencePanel: reference, direction } : undefined,
    });
  }

  function dispose() {
    layoutSubscription?.dispose();
    activeSubscription?.dispose();
    removeSubscription?.dispose();
    api = undefined;
    lastEditorId = undefined;
    lastChatPaneId = undefined;
  }

  function ready(event: DockviewReadyEvent) {
    dispose();
    const view = event.api;
    api = view;
    try {
      const stored = localStorage.getItem(layoutKey);
      if (stored) {
        view.fromJSON(JSON.parse(stored) as SerializedDockview);
        for (const panel of view.panels) {
          if (isEditor(panel.id) || panel.id.startsWith("history-")) {
            view.removePanel(panel);
          } else if (isRun(panel.id)) {
            const number = Number(panel.id.slice(4));
            if (Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER) nextPane = Math.max(nextPane, number);
            const config = (panel.params ?? {}) as PaneConfig;
            if (!config.conversationId) panel.api.updateParameters({ ...config, conversationId: newConversationId() });
          }
        }
      }
    } catch {
      view.clear();
    }
    if (!view.panels.length) {
      const first = addRun(view);
      addRun(view, first.id);
      first.api.setActive();
    }
    layoutSubscription = view.onDidLayoutChange(() => {
      sync();
      save();
    });
    activeSubscription = view.onDidActivePanelChange((panel) => {
      if (panel && isEditor(panel.id)) lastEditorId = panel.id;
      if (panel && isRun(panel.id)) lastChatPaneId = panel.id;
      sync();
    });
    removeSubscription = view.onDidRemovePanel((panel) => {
      if (lastEditorId === panel.id) lastEditorId = undefined;
      if (lastChatPaneId === panel.id) lastChatPaneId = undefined;
      sync();
    });
    sync();
    save();
  }

  function openFile(path: string) {
    const state = store.getState();
    if (!api || !state.workspace || state.choosingProject) return;
    const id = `editor:${path}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
    } else {
      const previous = lastEditorId ? api.getPanel(lastEditorId) : undefined;
      const reference = previous ?? api.activePanel ?? api.panels[0];
      api.addPanel({
        id, title: workspaceLabel(path), component: "pane",
        params: { tool: "editor", filePath: path, workspacePath: state.workspace.path },
        renderer: "always", minimumWidth: 210,
        position: reference ? { referencePanel: reference.id, direction: "within" } : undefined,
      });
    }
    lastEditorId = id;
    sync();
  }

  function openTool(tool: "prompts" | "terminal" | "history", title: string, runId?: string) {
    if (!api) return;
    const id = tool === "history" ? `history-${runId}` : tool;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setTitle(title);
      existing.api.setActive();
      return;
    }
    const reference = api.activePanel ?? api.panels[0];
    api.addPanel({
      id, title, component: "pane", params: { tool, runId }, minimumWidth: 210, renderer: "always",
      position: reference ? { referencePanel: reference.id, direction: tool === "terminal" ? "below" : "within" } : undefined,
    });
  }

  function configure(id: string, patch: PaneConfig) {
    const panel = api?.getPanel(id);
    if (!panel) return;
    panel.api.updateParameters({ ...panel.params, ...patch });
    sync();
    save();
  }

  function setTitle(id: string, title: string) {
    const panel = api?.getPanel(id);
    if (!panel || panel.title === title) return;
    panel.api.setTitle(title);
  }

  return {
    ready,
    dispose,
    openFile,
    openTool,
    configure,
    setTitle,
    activate: (id: string) => api?.getPanel(id)?.api.setActive(),
    newConversation: (id: string) => configure(id, { conversationId: newConversationId() }),
    newSplit(): string | undefined {
      if (!api) return undefined;
      const reference = api.activePanel?.id ?? api.panels[0]?.id;
      const direction = store.getState().dock.chatPanes.length > 1 ? "below" : "right";
      const created = addRun(api, reference, direction);
      created.api.setActive();
      sync();
      save();
      return created.id;
    },
    closeEditors() {
      for (const panel of api?.panels.filter(({ id }) => isEditor(id)) ?? []) api?.removePanel(panel);
      lastEditorId = undefined;
      sync();
    },
  };
}
