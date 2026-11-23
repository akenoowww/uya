import { useEffect } from "react";
import type { TextFile } from "@ide/protocol";
import type { editor } from "monaco-editor";

export interface Draft {
  baseline: TextFile;
  text: string;
  view: editor.ICodeEditorViewState | null;
  pendingSave?: Promise<void>;
  saveError?: string;
}

export type EditorDrafts = Map<string, Draft>;

export function hasUnsavedEditorDrafts(drafts: EditorDrafts): boolean {
  return Array.from(drafts.values()).some(({ baseline, text }) => baseline.text !== text);
}

export function hasPendingEditorSaves(drafts: EditorDrafts): boolean {
  return Array.from(drafts.values()).some(({ pendingSave }) => Boolean(pendingSave));
}

export function useProtectEditorDrafts(readDrafts: () => EditorDrafts) {
  useEffect(() => {
    function protectDrafts(event: BeforeUnloadEvent) {
      const drafts = readDrafts();
      if (hasUnsavedEditorDrafts(drafts) || hasPendingEditorSaves(drafts)) {
        event.preventDefault();
        event.returnValue = true;
      }
    }
    window.addEventListener("beforeunload", protectDrafts);
    return () => window.removeEventListener("beforeunload", protectDrafts);
  }, [readDrafts]);
}
