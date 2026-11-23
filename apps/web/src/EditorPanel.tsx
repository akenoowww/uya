import { ActionIcon, Button } from "@mantine/core";
import { ArrowClockwise, Code, FileCode, FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import type { EditorSelection, RpcCall } from "@ide/protocol";
import type { Draft, EditorDrafts } from "./editorDrafts";
import "./editor.css";
import { themeTokens } from "./theme";

interface EditorProps {
  root: string | null;
  path: string | null;
  api: RpcCall;
  drafts: EditorDrafts;
  active?: boolean;
  readOnly?: boolean;
  onSelectionChange(selection: EditorSelection | null): void;
}

interface OpenEditorProps extends Omit<EditorProps, "root" | "path"> {
  root: string;
  path: string;
}

function OpenFileEditor({ root, path, api, drafts, active = true, readOnly = false, onSelectionChange }: OpenEditorProps) {
  const modelId = useId();
  const host = useRef<HTMLDivElement>(null);
  const notifySelection = useRef(onSelectionChange);
  const isActive = useRef(active);
  const isReadOnly = useRef(readOnly);
  const editorInstance = useRef<editor.IStandaloneCodeEditor | null>(null);
  const publishSelection = useRef<(() => void) | null>(null);
  const save = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const draftKey = `${root}\0${path}`;
  const filename = path.split("/").at(-1) ?? path;

  useLayoutEffect(() => { notifySelection.current = onSelectionChange; }, [onSelectionChange]);
  useLayoutEffect(() => {
    isActive.current = active;
    if (active) publishSelection.current?.();
  }, [active]);
  useLayoutEffect(() => {
    isReadOnly.current = readOnly;
    editorInstance.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    let current = true;
    let instance: editor.IStandaloneCodeEditor | undefined;
    let model: editor.ITextModel | undefined;
    let draft: Draft | undefined;
    const remembered = drafts.get(draftKey);
    const keepDraft = remembered && (remembered.pendingSave || remembered.baseline.text !== remembered.text);
    const file = keepDraft ? Promise.resolve(remembered.baseline) : api("workspace.read", { path, workspacePath: root });
    setLoaded(false);
    setError("");

    void Promise.all([file, import("./editorMonaco")]).then(([file, { monaco }]) => {
      if (!current) return;
      const opened: Draft = keepDraft ? remembered : { baseline: file, text: file.text, view: remembered?.view ?? null };
      draft = opened;
      drafts.set(draftKey, opened);
      const resource = monaco.Uri.file(`${root}/${path}`);
      const resourceId = monaco.editor.getModel(resource) ? resource.with({ query: `editor=${modelId}` }) : resource;
      const textModel = monaco.editor.createModel(opened.text, undefined, resourceId);
      model = textModel;
      const codeEditor = monaco.editor.create(container, {
        model: textModel,
        theme: "workbench-dark",
        ariaLabel: `Edit ${path}`,
        readOnly: isReadOnly.current,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: themeTokens()("mono"),
        fontSize: 13,
        lineHeight: 21,
        padding: { top: 12, bottom: 10 },
        folding: true,
        // Monaco can reject an in-flight occurrence highlight when a docked editor closes.
        occurrencesHighlight: "off",
        scrollBeyondLastLine: false,
        links: false,
      });
      instance = codeEditor;
      editorInstance.current = codeEditor;
      if (opened.view) codeEditor.restoreViewState(opened.view);

      const reportSelection = () => {
        if (!isActive.current) return;
        const selection = codeEditor.getSelection();
        if (!selection || selection.isEmpty() || opened.baseline.text !== opened.text) {
          notifySelection.current(null);
          return;
        }
        notifySelection.current({ path, text: textModel.getValueInRange(selection), revision: opened.baseline.revision });
      };
      publishSelection.current = reportSelection;

      codeEditor.onDidChangeModelContent(() => {
        opened.text = textModel.getValue(undefined, true);
        setDirty(opened.text !== opened.baseline.text);
        reportSelection();
      });
      codeEditor.onDidChangeCursorSelection(reportSelection);

      const reflectChanges = () => {
        if (!current) return;
        setSaving(Boolean(opened.pendingSave));
        setDirty(opened.baseline.text !== opened.text);
        setError(opened.saveError ?? "");
        reportSelection();
      };

      const saveFile = () => {
        if (isReadOnly.current || opened.pendingSave || opened.text === opened.baseline.text) return;
        opened.saveError = undefined;
        opened.pendingSave = api("workspace.write", { path, workspacePath: root, text: opened.text, revision: opened.baseline.revision }).then((saved) => {
          opened.baseline = saved;
        }).catch((reason: unknown) => {
          opened.saveError = reason instanceof Error ? reason.message : "Could not save this file.";
        }).finally(() => {
          opened.pendingSave = undefined;
          reflectChanges();
        });
        reflectChanges();
      };

      save.current = saveFile;
      codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);
      setLoaded(true);
      reflectChanges();
      if (opened.pendingSave) void opened.pendingSave.then(reflectChanges);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Could not open this file.");
    });

    return () => {
      current = false;
      save.current = null;
      editorInstance.current = null;
      publishSelection.current = null;
      if (draft && instance) draft.view = instance.saveViewState();
      instance?.dispose();
      model?.dispose();
    };
  }, [api, draftKey, drafts, generation, modelId, path, root]);

  function reload() {
    setReloading(false);
    if (isReadOnly.current) return;
    if (isActive.current) notifySelection.current(null);
    drafts.delete(draftKey);
    setGeneration((value) => value + 1);
  }

  return (
    <section className="tool-pane editor-pane" aria-label="Code editor">
      <header className="tool-heading">
        <div className="editor-filename" title={path}><FileCode size={14} weight="duotone" /><span>{filename}</span>{dirty && <span className="editor-dirty" aria-label="Unsaved changes" />}</div>
        <div className="tool-actions">
          <ActionIcon size="sm" onClick={() => dirty ? setReloading(true) : reload()} disabled={readOnly || saving} aria-label="Reload file from disk" title="Reload file from disk">
            <ArrowClockwise size={13} />
          </ActionIcon>
          <ActionIcon size="sm" color={dirty ? "iris" : "gray"} variant={dirty ? "light" : "subtle"} onClick={() => save.current?.()} disabled={readOnly || !loaded || !dirty || saving} aria-label="Save file" title="Save file (⌘S / Ctrl+S)">
            <FloppyDisk size={14} weight="duotone" />
          </ActionIcon>
        </div>
      </header>
      {reloading && (
        <div className="editor-notice" role="status">
          <span>Discard local changes and reload this file?</span>
          <Button size="compact-xs" variant="subtle" color="red" onClick={reload} disabled={readOnly || saving}>Discard and reload</Button>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setReloading(false)}>Keep editing</Button>
        </div>
      )}
      {error && <p className="editor-inline-error" role="alert">{error}</p>}
      {!loaded && !error && <p className="editor-note" role="status">Opening file…</p>}
      <div ref={host} className={`editor-host${loaded ? " editor-host-ready" : ""}`} aria-hidden={!loaded} />
    </section>
  );
}

export function EditorPanel({ root, path, ...props }: EditorProps) {
  if (!root || !path) {
    return <section className="tool-pane editor-pane" aria-label="Code editor">
      <header className="tool-heading"><h2>Editor</h2></header>
      <div className="editor-empty"><Code size={25} weight="duotone" aria-hidden="true" /><p>Select a file in Explorer</p></div>
    </section>;
  }

  return <OpenFileEditor key={`${root}\0${path}`} root={root} path={path} {...props} />;
}
