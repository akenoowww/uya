import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { RpcCall } from "@ide/protocol";
import { extractMentionQuery } from "../components/MentionMenu";
import type { MentionItem } from "../components/MentionMenu";
import { hasTerminalOutput } from "../terminalBuffer";

interface UseMentionInputOptions {
  value: string;
  cursor: number;
  root: string | null;
  rpc: RpcCall | undefined;
  onChange: (next: string) => void;
  onAttachFile: (path: string) => void;
  onAttachGitDiff: (staged: boolean) => void;
  onAttachTerminal: () => void;
  onFocusInput: () => void;
}

const STATIC_MENTIONS: readonly MentionItem[] = [
  { kind: "git-diff", id: "git-diff", label: "@git-diff", description: "Unstaged diff", staged: false },
  { kind: "git-diff", id: "git-staged", label: "@git-staged", description: "Staged diff", staged: true },
  { kind: "terminal", id: "terminal", label: "@terminal", description: "Latest output" },
];

export function useMentionInput({
  value,
  cursor,
  root,
  rpc,
  onChange,
  onAttachFile,
  onAttachGitDiff,
  onAttachTerminal,
  onFocusInput,
}: UseMentionInputOptions) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  const match = useMemo(() => (dismissed ? null : extractMentionQuery(value, cursor)), [dismissed, value, cursor]);
  const matchOpen = Boolean(match);
  const query = match?.query ?? "";

  useEffect(() => {
    setDismissed(false);
    setSelectedIndex(0);
  }, [value]);

  useEffect(() => {
    if (!matchOpen || !root || !rpc) {
      setFiles([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void rpc("workspace.files", { query, limit: 10, workspacePath: root })
        .then((paths) => {
          if (active) setFiles(paths);
        })
        .catch(() => {
          if (active) setFiles([]);
        });
    }, 60);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [matchOpen, query, root, rpc]);

  const items = useMemo<MentionItem[]>(() => {
    if (!match) return [];
    const q = query.toLowerCase();
    const statics = STATIC_MENTIONS.filter((item) => {
      if (item.kind === "git-diff" && !root) return false;
      if (item.kind === "terminal" && !hasTerminalOutput()) return false;
      return !q || item.id.includes(q) || item.label.slice(1).includes(q);
    });
    const fileItems: MentionItem[] = files.map((path) => ({
      kind: "file",
      id: `file:${path}`,
      label: path.split("/").at(-1) ?? path,
      path,
    }));
    return [...statics, ...fileItems].slice(0, 12);
  }, [files, match, query, root]);

  const activeIndex = items.length ? Math.min(selectedIndex, items.length - 1) : 0;

  function applyMention(item: MentionItem) {
    if (!match) return;
    const before = value.slice(0, match.start);
    const after = value.slice(cursor);
    const cleaned = `${before}${after.startsWith(" ") ? after.slice(1) : after}`;
    onChange(cleaned);
    setDismissed(true);
    setSelectedIndex(0);
    if (item.kind === "file") onAttachFile(item.path);
    else if (item.kind === "git-diff") onAttachGitDiff(item.staged);
    else onAttachTerminal();
    requestAnimationFrame(onFocusInput);
  }

  function handleMentionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!items.length) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % items.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + items.length) % items.length);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
      event.preventDefault();
      applyMention(items[activeIndex]);
      return true;
    }
    return false;
  }

  return {
    mentionItems: items,
    activeMentionIndex: activeIndex,
    applyMention,
    handleMentionKeyDown,
  };
}
