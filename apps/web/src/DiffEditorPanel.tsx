import { ActionIcon, Alert, Badge, Button, Group } from "@mantine/core";
import { ArrowClockwise, Check, Columns, FloppyDisk, GitDiff, Rows } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import type { RpcCall } from "@ide/protocol";
import { applyUnifiedDiff, isUnifiedDiff } from "./patchApply";
import { themeTokens } from "./theme";
import "./editor.css";

export interface DiffTarget {
  mode: "git" | "apply";
  path: string;
  staged?: boolean;
  proposedCode?: string;
  language?: string;
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
  const [reloadTick, setReloadTick] = useState(0);

  const isApply = target.mode === "apply";
  const filename = target.path.split("/").at(-1) ?? target.path;

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

    const loadData = async (): Promise<{ original: string; modified: string; rev: string | null; note?: string }> => {
      if (target.mode === "git") {
        const res = await api("git.diff", { path: target.path, staged: target.staged, workspacePath: root });
        return {
          original: res.original ?? "",
          modified: res.modified ?? "",
          rev: null,
        };
      }
      const file = await api("workspace.read", { path: target.path, workspacePath: root });
      const proposed = target.proposedCode ?? file.text;
      if (isUnifiedDiff(target.language, proposed)) {
        const applied = applyUnifiedDiff(file.text, proposed);
        if (applied.ok) {
          return { original: file.text, modified: applied.text, rev: file.revision };
        }
        return {
          original: file.text,
          modified: file.text,
          rev: file.revision,
          note: `${applied.error} You can edit the right side manually before applying.`,
        };
      }
      return { original: file.text, modified: proposed, rev: file.revision };
    };

    void Promise.all([loadData(), import("./editorMonaco")]).then(([data, { monaco }]) => {
      if (!active) return;
      setRevision(data.rev);
      if (data.note) setWarning(data.note);

      const baseUri = monaco.Uri.file(`${root}/${target.path}`);
      originalModel = monaco.editor.createModel(data.original, undefined, baseUri.with({ query: `diff-orig=${modelId}-${reloadTick}` }));
      modifiedModel = monaco.editor.createModel(data.modified, undefined, baseUri.with({ query: `diff-mod=${modelId}-${reloadTick}` }));

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
  }, [api, isApply, modelId, reloadTick, refreshKey, root, target.language, target.mode, target.path, target.proposedCode, target.staged]);

  async function applyChanges() {
    if (!root || !isApply || !revision || saving) return;
    const modifiedText = diffEditorRef.current?.getModifiedEditor().getValue();
    if (modifiedText === undefined) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api("workspace.write", {
        path: target.path,
        workspacePath: root,
        text: modifiedText,
        revision,
      });
      setRevision(saved.revision);
      diffEditorRef.current?.getOriginalEditor().setValue(saved.text);
      setSavedBanner(true);
      onApplied?.(target.path);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not apply changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="tool-pane editor-pane" aria-label="Diff viewer">
      <header className="tool-heading">
        <div className="editor-filename" title={target.path}>
          <GitDiff size={14} weight="duotone" />
          <span>{filename}</span>
          <Badge size="xs" variant="light" color={isApply ? "iris" : target.staged ? "teal" : "gray"} radius="sm">
            {isApply ? "Apply Preview" : target.staged ? "Staged Diff" : "Working Diff"}
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
          {isApply && (
            <Button
              size="compact-xs"
              color={savedBanner ? "teal" : "iris"}
              variant="filled"
              loading={saving}
              disabled={!loaded || !revision}
              leftSection={savedBanner ? <Check size={12} weight="bold" /> : <FloppyDisk size={13} weight="duotone" />}
              onClick={() => void applyChanges()}
            >
              {savedBanner ? "Applied" : "Apply to file"}
            </Button>
          )}
        </Group>
      </header>
      {warning && <Alert color="yellow" variant="light" py={5} px={10} radius={0}>{warning}</Alert>}
      {error && <p className="editor-inline-error" role="alert">{error}</p>}
      {!loaded && !error && <p className="editor-note" role="status">Loading diff…</p>}
      <div ref={host} className={`editor-host${loaded ? " editor-host-ready" : ""}`} aria-hidden={!loaded} />
    </section>
  );
}
