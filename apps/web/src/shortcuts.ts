import { useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Workbench } from "./workbench";
import { routingTargets } from "./workbenchStore";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export interface ShortcutEntry {
  id: string;
  label: string;
  category: "Navigation" | "Splits & Chat" | "Workspace";
  mac: string[];
  other: string[];
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: "palette", label: "Command palette", category: "Navigation", mac: ["⌘", "K"], other: ["Ctrl", "K"] },
  { id: "quick-open", label: "Quick open file", category: "Navigation", mac: ["⌘", "P"], other: ["Ctrl", "P"] },
  { id: "shortcuts", label: "Keyboard shortcuts", category: "Navigation", mac: ["⌘", "/"], other: ["Ctrl", "/"] },
  { id: "focus-input", label: "Focus active split input", category: "Navigation", mac: ["⌘", "L"], other: ["Ctrl", "L"] },
  { id: "focus-split", label: "Focus split 1–9", category: "Navigation", mac: ["⌘", "1–9"], other: ["Ctrl", "1–9"] },
  { id: "send", label: "Send prompt", category: "Splits & Chat", mac: ["↵"], other: ["Enter"] },
  { id: "newline", label: "Insert newline", category: "Splits & Chat", mac: ["⇧", "↵"], other: ["Shift", "Enter"] },
  { id: "new-split", label: "New split", category: "Splits & Chat", mac: ["⌘", "\\"], other: ["Ctrl", "\\"] },
  { id: "new-conversation", label: "New conversation in split", category: "Splits & Chat", mac: ["⌘", "N"], other: ["Ctrl", "N"] },
  { id: "toggle-broadcast", label: "Toggle Broadcast composer", category: "Splits & Chat", mac: ["⌘", "⇧", "B"], other: ["Ctrl", "Shift", "B"] },
  { id: "toggle-terminal", label: "Toggle split interactive terminal", category: "Splits & Chat", mac: ["⌘", "⇧", "T"], other: ["Ctrl", "Shift", "T"] },
  { id: "cancel-run", label: "Cancel active run", category: "Splits & Chat", mac: ["⌘", "."], other: ["Ctrl", "."] },
  { id: "recall-prompt", label: "Recall previous prompt (empty input)", category: "Splits & Chat", mac: ["↑"], other: ["↑"] },
  { id: "open-project", label: "Open project folder", category: "Workspace", mac: ["⌘", "O"], other: ["Ctrl", "O"] },
  { id: "toggle-explorer", label: "Toggle Explorer sidebar", category: "Workspace", mac: ["⌘", "B"], other: ["Ctrl", "B"] },
  { id: "toggle-git", label: "Toggle Git sidebar", category: "Workspace", mac: ["⌘", "⇧", "G"], other: ["Ctrl", "Shift", "G"] },
  { id: "toggle-history", label: "Toggle Run History", category: "Workspace", mac: ["⌘", "⇧", "H"], other: ["Ctrl", "Shift", "H"] },
  { id: "open-prompts", label: "Open Prompt Library", category: "Workspace", mac: ["⌘", "⇧", "L"], other: ["Ctrl", "Shift", "L"] },
  { id: "open-terminal", label: "Open Shell Terminal", category: "Workspace", mac: ["⌘", "J"], other: ["Ctrl", "J"] },
  { id: "open-providers", label: "Open Providers & Settings", category: "Workspace", mac: ["⌘", ","], other: ["Ctrl", ","] },
  { id: "open-rules", label: "Open Routing Rules", category: "Workspace", mac: ["⌘", "⇧", "R"], other: ["Ctrl", "Shift", "R"] },
];

export function formatShortcut(id: string): string {
  const entry = SHORTCUTS.find((item) => item.id === id);
  if (!entry) return "";
  return (isMac ? entry.mac : entry.other).join(isMac ? "" : "+");
}

/**
 * IME-safe Enter-to-submit check for chat textareas.
 * Plain Enter (without Shift/Alt) or Cmd/Ctrl+Enter submits; Shift+Enter inserts a newline.
 * Checks both `isComposing` and `keyCode === 229` to guard WebKit/Safari IME confirmation ordering.
 */
export function isEnterSubmit(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter") return false;
  if (event.metaKey || event.ctrlKey) return true;
  if (event.shiftKey || event.altKey) return false;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
  return true;
}

export function focusPaneInput(paneId: string | undefined) {
  const selector = paneId
    ? `textarea[data-pane-input="${CSS.escape(paneId)}"]`
    : "#prompt-input";
  const target = document.querySelector<HTMLTextAreaElement>(selector) ?? document.getElementById("prompt-input");
  target?.focus();
}

function isInsideTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".xterm, .terminal-viewport"));
}

function hasOpenModal(): boolean {
  return Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'));
}

export function useWorkbenchShortcuts(
  workbench: Workbench,
  controls: {
    togglePalette: () => void;
    openQuickOpen: () => void;
    openShortcuts: () => void;
  },
) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod) return;
      if (isInsideTerminal(event.target) && !isMac) return;

      const key = event.key.toLowerCase();
      if (key === "k" || (event.shiftKey && key === "p")) {
        event.preventDefault();
        controls.togglePalette();
        return;
      }
      if (hasOpenModal()) return;

      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        controls.openQuickOpen();
        return;
      }
      if (key === "/") {
        event.preventDefault();
        controls.openShortcuts();
        return;
      }
      if (key === "," && !event.shiftKey) {
        event.preventDefault();
        workbench.openProviders();
        return;
      }
      if (key === "o" && !event.shiftKey) {
        event.preventDefault();
        void workbench.pickProject();
        return;
      }
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        workbench.toggleSidebar("explorer");
        return;
      }
      if (key === "b" && event.shiftKey) {
        event.preventDefault();
        workbench.toggleBroadcast();
        return;
      }
      if (key === "g" && event.shiftKey) {
        event.preventDefault();
        workbench.toggleSidebar("git");
        return;
      }
      if (key === "h" && event.shiftKey) {
        event.preventDefault();
        workbench.toggleSidebar("history");
        return;
      }
      if (key === "l" && event.shiftKey) {
        event.preventDefault();
        workbench.dock.openTool("prompts", "Prompt Library");
        return;
      }
      if (key === "r" && event.shiftKey) {
        event.preventDefault();
        workbench.openRules();
        return;
      }
      if (key === "\\" && !event.shiftKey) {
        event.preventDefault();
        const created = workbench.dock.newSplit();
        if (created) requestAnimationFrame(() => focusPaneInput(created));
        return;
      }
      if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        workbench.dock.openTool("terminal", "Terminal");
        return;
      }
      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        const pane = workbench.activeChatPane();
        if (pane) {
          workbench.dock.newConversation(pane.id);
          requestAnimationFrame(() => focusPaneInput(pane.id));
        }
        return;
      }
      if (key === "t" && event.shiftKey) {
        event.preventDefault();
        const pane = workbench.activeChatPane();
        if (pane) {
          const nextMode = pane.config.mode === "terminal" ? "structured" : "terminal";
          workbench.dock.configure(pane.id, { mode: nextMode });
        }
        return;
      }
      if (key === "l" && !event.shiftKey) {
        event.preventDefault();
        const pane = workbench.activeChatPane();
        if (pane) {
          workbench.dock.activate(pane.id);
          focusPaneInput(pane.id);
        } else {
          focusPaneInput(undefined);
        }
        return;
      }
      if (key === "." && !event.shiftKey) {
        event.preventDefault();
        const state = workbench.store.getState();
        const { selected } = routingTargets(state.providers, state.dock, false);
        const runningId = selected ? workbench.activeRunIdForPane(selected.id) : undefined;
        if (runningId) void workbench.core.cancelRun(runningId);
        return;
      }
      if (!event.shiftKey && !event.altKey && /^[1-9]$/.test(key)) {
        const index = Number(key) - 1;
        const pane = workbench.store.getState().dock.chatPanes[index];
        if (pane) {
          event.preventDefault();
          workbench.dock.activate(pane.id);
          requestAnimationFrame(() => focusPaneInput(pane.id));
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workbench, controls]);
}
