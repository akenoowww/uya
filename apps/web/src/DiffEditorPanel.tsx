import { ActionIcon, Alert, Badge, Button, Group } from "@mantine/core";
import { ArrowClockwise, Check, Columns, FloppyDisk, GitDiff, Rows } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import type { RpcCall } from "@ide/protocol";
import { applyUnifiedDiff, isUnifiedDiff } from "./patchApply";
import type { MultiFilePatchEntry } from "./patchApply";
import { themeTokens } from "./theme";
import "./editor.css";

export interface DiffTarget {
  mode: "git" | "apply" | "arena";
  path: string;
  staged?: boolean;
  proposedCode?: string;
  language?: string;
  multiFiles?: MultiFilePatchEntry[];
  arenaId?: string;
  arenaSlotId?: string;
  arenaLabel?: string;
}

interface Props {
  root: string | null;
  api: RpcCall;
  target: DiffTarget;
  refreshKey?: number;
  onApplied?: (path: string) => void;
}

export function DiffEditorPanel({ root, api, target, refreshKey = 0, onApplied }: Props) {
  const modelId = useId();
  const host = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [inlineMode, setInlineMode] = useState(false);
  const inlineModeRef = useRef(inlineMode);
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [isNewFile, setIsNewFile] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [activeFileIndex, setActiveFileIndex] = useState(0);

  const multiFiles = target.mode === "apply" && target.multiFiles && target.multiFiles.length > 1
    ? target.multiFiles
    : null;
  const activeEntry = multiFiles ? multiFiles[Math.min(activeFileIndex, multiFiles.length - 1)] : null;
  const activePath = activeEntry?.path ?? target.path;
  const activeCode = activeEntry?.diff ?? target.proposedCode;
  const activeLanguage = activeEntry ? "diff" : target.language;

  const isApply = target.mode === "apply";
  const filename = activePath.split("/").at(-1) ?? activePath;

  useEffect(() => {
    setActiveFileIndex(0);
  }, [target.path, target.proposedCode]);

  useEffect(() => {
    inlineModeRef.current = inlineMode;
    diffEditorRef.current?.updateOptions({ renderSideBySide: !inlineMode });
  }, [inlineMode]);

  useEffect(() => {
    const container = host.current;
    if (!container || !root) return;
    let active = true;
    let diffEditor: editor.IStandaloneDiffEditor | undefined;
    let originalModel: editor.ITextModel | undefined;
    let modifiedModel: editor.ITextModel | undefined;

    setLoaded(false);
    setError("");
    setWarning("");
    setSavedBanner(false);
    setIsNewFile(false);

    const loadData = async (): Promise<{
      original: string;
      modified: string;
      rev: string | null;
      createNew?: boolean;
      note?: string;
    }> => {
      if (target.mode === "arena" && target.arenaId && target.arenaSlotId) {
        const res = await api("arena.slotDiff", {
          arenaId: target.arenaId,
          slotId: target.arenaSlotId,
          path: activePath,
        });
        return {
          original: res.original ?? "",
          modified: res.modified ?? "",
          rev: null,
        };
      }
      if (target.mode === "git") {
        const res = await api("git.diff", { path: activePath, staged: target.staged, workspacePath: root });
        return {
          original: res.original ?? "",
          modified: res.modified ?? "",
          rev: null,
        };
      }

      let fileText = "";
      let fileRevision: string | null = null;
      let createNew = false;
      try {
        const file = await api("workspace.read", { path: activePath, workspacePath: root });
        fileText = file.text;
        fileRevision = file.revision;
      } catch {
        if (activeEntry?.isNewFile) {
          createNew = true;
        } else {
          throw new Error(`Could not read "${activePath}" in this workspace.`);
        }
      }

      const proposed = activeCode ?? fileText;
      if (isUnifiedDiff(activeLanguage, proposed)) {
        const applied = applyUnifiedDiff(fileText, proposed);
        if (applied.ok) {
          return { original: fileText, modified: applied.text, rev: fileRevision, createNew };
        }
        return {
          original: fileText,
          modified: fileText,
          rev: fileRevision,
          createNew,
          note: `${applied.error} You can edit the right side manually before applying.`,
        };
      }
      return { original: fileText, modified: proposed, rev: fileRevision, createNew };
    };

    void Promise.all([loadData(), import("./editorMonaco")]).then(([data, { monaco }]) => {
      if (!active) return;
      setRevision(data.rev);
      setIsNewFile(Boolean(data.createNew));
      if (data.note) setWarning(data.note);

      const baseUri = monaco.Uri.file(`${root}/${activePath}`);
      originalModel = monaco.editor.createModel(data.original, undefined, baseUri.with({ query: `diff-orig=${modelId}-${activeFileIndex}-${reloadTick}` }));
      modifiedModel = monaco.editor.createModel(data.modified, undefined, baseUri.with({ query: `diff-mod=${modelId}-${activeFileIndex}-${reloadTick}` }));

      diffEditor = monaco.editor.createDiffEditor(container, {
        theme: "workbench-dark",
        automaticLayout: true,
        renderSideBySide: !inlineModeRef.current,
        originalEditable: false,
        readOnly: !isApply,
        minimap: { enabled: false },
        fontFamily: themeTokens()("mono"),
        fontSize: 12.5,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        ignoreTrimWhitespace: false,
      });
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
      if (isApply) {
        modifiedModel.onDidChangeContent(() => setSavedBanner(false));
      }
      diffEditorRef.current = diffEditor;
      setLoaded(true);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not open diff view.");
    });

    return () => {
      active = false;
      diffEditorRef.current = null;
      diffEditor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [
    activeCode, activeEntry?.isNewFile, activeFileIndex, activeLanguage, activePath, api, isApply,
    modelId, reloadTick, refreshKey, root, target.arenaId, target.arenaSlotId, target.mode, target.staged,
  ]);

  async function applyChanges() {
    if (!root || !isApply || saving) return;
    if (!isNewFile && !revision) return;
    const modifiedText = diffEditorRef.current?.getModifiedEditor().getValue();
    if (modifiedText === undefined) return;
    setSaving(true);
    setError("");
    try {
      if (isNewFile) {
        await api("workspace.create", { path: activePath, kind: "file", text: modifiedText, workspacePath: root });
        const created = await api("workspace.read", { path: activePath, workspacePath: root });
        setIsNewFile(false);
        setRevision(created.revision);
        diffEditorRef.current?.getOriginalEditor().setValue(created.text);
      } else {
        const saved = await api("workspace.write", {
          path: activePath,
          workspacePath: root,
          text: modifiedText,
          revision: revision!,
        });
        setRevision(saved.revision);
        diffEditorRef.current?.getOriginalEditor().setValue(saved.text);
      }
      setSavedBanner(true);
      onApplied?.(activePath);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not apply changes.");
    } finally {
      setSaving(false);
    }
  }

  async function applyAllFiles() {
    if (!root || !multiFiles || saving) return;
    setSaving(true);
    setError("");
    try {
      const planned: Array<{ path: string; createNew: boolean; text: string; revision?: string }> = [];
      for (const entry of multiFiles) {
        let original = "";
        let rev: string | undefined;
        let createNew = false;
        try {
          const file = await api("workspace.read", { path: entry.path, workspacePath: root });
          original = file.text;
          rev = file.revision;
        } catch {
          if (entry.isNewFile) createNew = true;
          else throw new Error(`Cannot read ${entry.path} to apply multi-file patch.`);
        }
        const applied = applyUnifiedDiff(original, entry.diff);
        if (!applied.ok) throw new Error(`${entry.path}: ${applied.error}`);
        planned.push({ path: entry.path, createNew, text: applied.text, revision: rev });
      }
      for (const item of planned) {
        if (item.createNew) {
          await api("workspace.create", { path: item.path, kind: "file", text: item.text, workspacePath: root });
        } else {
          await api("workspace.write", { path: item.path, text: item.text, revision: item.revision!, workspacePath: root });
        }
      }
      setSavedBanner(true);
      setReloadTick((value) => value + 1);
      onApplied?.(activePath);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not apply multi-file patch.");
    } finally {
      setSaving(false);
    }
  }

  const badgeLabel = target.mode === "arena"
    ? `Arena · ${target.arenaLabel ?? target.arenaSlotId}`
    : isApply
      ? "Apply Preview"
      : target.staged
        ? "Staged Diff"
        : "Working Diff";

  return (
    <section className="tool-pane editor-pane" aria-label="Diff viewer">
      <header className="tool-heading">
        <div className="editor-filename" title={activePath}>
          <GitDiff size={14} weight="duotone" />
          <span>{filename}</span>
          <Badge size="xs" variant="light" color={target.mode === "arena" ? "teal" : isApply ? "iris" : target.staged ? "teal" : "gray"} radius="sm">
            {badgeLabel}
          </Badge>
        </div>
        <Group gap={4} wrap="nowrap" className="tool-actions">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={inlineMode ? "Side-by-side diff" : "Inline diff"}
            title={inlineMode ? "Side-by-side diff" : "Inline diff"}
            onClick={() => setInlineMode((current) => !current)}
          >
            {inlineMode ? <Columns size={14} /> : <Rows size={14} />}
          </ActionIcon>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Reload diff"
            title="Reload diff"
            disabled={saving}
            onClick={() => setReloadTick((value) => value + 1)}
          >
            <ArrowClockwise size={13} />
          </ActionIcon>
          {multiFiles && (
            <Button
              size="compact-xs"
              color="teal"
              variant="light"
              loading={saving}
              disabled={!loaded}
              leftSection={<FloppyDisk size={13} weight="duotone" />}
              onClick={() => void applyAllFiles()}
            >
              Apply all ({multiFiles.length})
            </Button>
          )}
          {isApply && (
            <Button
              size="compact-xs"
              color={savedBanner ? "teal" : "iris"}
              variant="filled"
              loading={saving}
              disabled={!loaded || (!revision && !isNewFile)}
              leftSection={savedBanner ? <Check size={12} weight="bold" /> : <FloppyDisk size={13} weight="duotone" />}
              onClick={() => void applyChanges()}
            >
              {savedBanner ? "Applied" : isNewFile ? "Create file" : "Apply to file"}
            </Button>
          )}
        </Group>
      </header>
      {multiFiles && (
        <Group gap={4} px={8} py={5} style={{ borderBottom: "1px solid var(--line)", background: "#1b1c23" }} wrap="wrap">
          {multiFiles.map((entry, idx) => (
            <Button
              key={entry.path}
              size="compact-xs"
              variant={idx === activeFileIndex ? "light" : "subtle"}
              color={idx === activeFileIndex ? "iris" : "gray"}
              onClick={() => setActiveFileIndex(idx)}
            >
              {entry.path}
            </Button>
          ))}
        </Group>
      )}
      {warning && <Alert color="yellow" variant="light" py={5} px={10} radius={0}>{warning}</Alert>}
      {error && <p className="editor-inline-error" role="alert">{error}</p>}
      {!loaded && !error && <p className="editor-note" role="status">Loading diff…</p>}
      <div ref={host} className={`editor-host${loaded ? " editor-host-ready" : ""}`} aria-hidden={!loaded} />
    </section>
  );
}
