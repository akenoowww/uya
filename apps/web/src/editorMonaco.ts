import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker.js?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
import { themeTokens } from "./theme";

const workerTypes = new Map([
  ["json", JsonWorker],
  ["css", CssWorker],
  ["scss", CssWorker],
  ["less", CssWorker],
  ["html", HtmlWorker],
  ["handlebars", HtmlWorker],
  ["razor", HtmlWorker],
  ["typescript", TypeScriptWorker],
  ["javascript", TypeScriptWorker],
]);

self.MonacoEnvironment = {
  getWorker(_id, label) {
    const WorkerType = workerTypes.get(label) ?? EditorWorker;
    return new WorkerType();
  },
};

const color = themeTokens();
monaco.editor.defineTheme("workbench-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": color("background"),
    "editor.foreground": color("text"),
    "editor.lineHighlightBackground": color("surface"),
    "editorLineNumber.foreground": color("code-line-number"),
    "editorLineNumber.activeForeground": color("accent"),
    "editor.selectionBackground": color("code-selection"),
    "editor.inactiveSelectionBackground": color("code-selection-inactive"),
    "editorWidget.background": color("panel"),
    "editorWidget.border": color("border"),
    "editorCursor.foreground": color("accent"),
  },
});

export { monaco };
