import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type {
  DirectoryEntry,
  ProjectRuleFile,
  PromptDocument,
  PromptRef,
  PromptSummary,
  PromptVariable,
  RenderedPrompt,
  TextContext,
  TextFile,
  WorkspaceInfo,
} from "@ide/protocol";
import {
  canonicalDirectory,
  createEntry,
  listDirectory,
  listWorkspaceFiles,
  MAX_TEXT_BYTES,
  promptDirectory,
  readText,
  relativePath,
  removeEntry,
  renameEntry,
  validateText,
  WorkspaceError,
  writeText,
} from "./workspace-files";

export { WorkspaceError } from "./workspace-files";

const PROMPT_SUFFIX = ".prompt.md";
const MAX_FRONT_MATTER = 64 * 1024;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_SELECTION_BYTES = 128 * 1024;
const MAX_PROJECT_RULE_BYTES = 64 * 1024;
const PROJECT_RULE_PATHS = ["AGENTS.md", "CLAUDE.md", ".uya/rules.md", ".cursorrules", ".github/copilot-instructions.md"];
const VARIABLE_NAME = /^[A-Za-z_][\w-]*$/u;
const PLACEHOLDER = /\{\{[ \t]*([A-Za-z_][\w-]*)[ \t]*\}\}/gu;

function checkPromptRef(ref: PromptRef): string[] {
  if (ref?.scope !== "global" && ref?.scope !== "project") {
    throw new WorkspaceError("INVALID_INPUT", "Choose the project or global prompt library.");
  }
  const parts = relativePath(ref.path);
  if (!(parts.at(-1)?.endsWith(PROMPT_SUFFIX)) || parts.at(-1) === PROMPT_SUFFIX) {
    throw new WorkspaceError("INVALID_INPUT", "Prompt files must end in .prompt.md.");
  }
  return parts;
}

function promptTitle(ref: PromptRef) {
  return basename(ref.path, PROMPT_SUFFIX);
}

function invalidPrompt(message: string) {
  return new WorkspaceError("INVALID_PROMPT", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitPrompt(source: string): { metadata: Record<string, unknown>; body: string } {
  const text = source.replace(/^\uFEFF/u, "");
  const start = /^---[ \t]*\r?\n/u.exec(text);
  if (!start) return { metadata: {}, body: text };

  const remainder = text.slice(start[0].length);
  const end = /^---[ \t]*\r?$/mu.exec(remainder);
  if (!end) throw invalidPrompt("Close the YAML front matter with ---.");
  const frontMatter = remainder.slice(0, end.index);
  if (Buffer.byteLength(frontMatter) > MAX_FRONT_MATTER) throw invalidPrompt("YAML front matter is limited to 64 KiB.");
  let metadata: unknown;
  try {
    metadata = Bun.YAML.parse(frontMatter) ?? {};
  } catch {
    throw invalidPrompt("The prompt has invalid YAML front matter.");
  }
  if (!isRecord(metadata)) throw invalidPrompt("Use a YAML mapping for the front matter.");
  const body = remainder.slice(end.index + end[0].length).replace(/^\n/u, "");
  return { metadata, body };
}

function readVariables(declared: unknown, body: string): PromptVariable[] {
  const variables = new Map<string, PromptVariable>();
  function add(name: unknown, defaultValue?: unknown) {
    if (typeof name !== "string" || !VARIABLE_NAME.test(name)) {
      throw invalidPrompt("Variable names must start with a letter or underscore and use letters, numbers, underscores or hyphens.");
    }
    if (defaultValue != null && typeof defaultValue !== "string") {
      throw invalidPrompt("Variable defaults must be strings. Quote numeric and boolean defaults.");
    }
    variables.set(name, typeof defaultValue === "string" ? { name, defaultValue } : { name });
    if (variables.size > 128) throw invalidPrompt("A prompt can use at most 128 variables.");
  }

  if (Array.isArray(declared)) {
    for (const item of declared) {
      if (isRecord(item)) add(item.name, item.defaultValue);
      else add(item);
    }
  } else if (isRecord(declared)) {
    for (const [name, value] of Object.entries(declared)) add(name, value);
  } else if (declared != null) {
    throw invalidPrompt("Use a list or a mapping for variables.");
  }

  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!variables.has(name)) add(name);
  }
  return [...variables.values()];
}

function parsePrompt(ref: PromptRef, file: TextFile): PromptDocument {
  const { metadata, body } = splitPrompt(file.text);
  const { title, providerId, effort, mode, variables } = metadata;
  if (title !== undefined && (typeof title !== "string" || !title.trim())) {
    throw invalidPrompt("The prompt title must be nonempty text.");
  }
  if (providerId !== undefined && (typeof providerId !== "string" || !providerId.trim())) {
    throw invalidPrompt("providerId must be nonempty text.");
  }
  if (mode !== undefined && mode !== "manual" && mode !== "rule" && mode !== "fallback") {
    throw invalidPrompt("Use manual, rule or fallback for mode.");
  }
  if (effort !== undefined && effort !== "minimal" && effort !== "low" && effort !== "medium" &&
    effort !== "high" && effort !== "xhigh" && effort !== "max") {
    throw invalidPrompt("Use minimal, low, medium, high, xhigh or max for effort.");
  }
  return {
    ref,
    title: typeof title === "string" ? title : promptTitle(ref),
    source: file.text,
    revision: file.revision,
    body,
    variables: readVariables(variables, body),
    ...(typeof providerId === "string" ? { providerId } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(mode ? { mode } : {}),
  };
}

function fillPrompt(document: PromptDocument, values: Record<string, string>): string {
  if (!isRecord(values)) throw invalidPrompt("Provide prompt variables as a mapping.");
  const substitutions = new Map<string, string>();
  for (const { name, defaultValue } of document.variables) {
    const value = Object.hasOwn(values, name) ? values[name] : defaultValue;
    if (value !== undefined && (typeof value !== "string" || value.includes("\0"))) {
      throw invalidPrompt("Variable values must be text.");
    }
    if (value !== undefined) substitutions.set(name, value);
  }

  const fragments: string[] = [];
  let currentSize = 0;
  let offset = 0;
  for (const match of document.body.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    const value = substitutions.get(name);
    if (value === undefined) throw invalidPrompt(`Enter a value for ${name}.`);
    const literal = document.body.slice(offset, match.index);
    currentSize += Buffer.byteLength(literal) + Buffer.byteLength(value);
    if (currentSize > MAX_TEXT_BYTES) throw invalidPrompt("Rendered prompts are limited to 1 MiB.");
    fragments.push(literal, value);
    offset = match.index + match[0].length;
  }
  const trailingText = document.body.slice(offset);
  if (currentSize + Buffer.byteLength(trailingText) > MAX_TEXT_BYTES) throw invalidPrompt("Rendered prompts are limited to 1 MiB.");
  fragments.push(trailingText);
  return fragments.join("");
}

export class Workspace {
  private root?: string;
  private selectionVersion = 0;
  private readonly globalBase: string;
  private readonly globalParts: string[];

  constructor(options: { globalPromptsDir?: string } = {}) {
    this.globalBase = options.globalPromptsDir ? dirname(options.globalPromptsDir) : homedir();
    this.globalParts = options.globalPromptsDir ? [basename(options.globalPromptsDir)] : [".uya", "prompts"];
  }

  get path(): string | undefined {
    return this.root;
  }

  async open({ path }: { path: string }): Promise<WorkspaceInfo> {
    const selection = ++this.selectionVersion;
    const root = await canonicalDirectory(path);
    if (selection !== this.selectionVersion) throw new WorkspaceError("CONFLICT", "A different folder was selected.");
    this.root = root;
    return { path: root, name: basename(root) || root };
  }

  close() {
    this.root = undefined;
  }

  private requireRoot(): string {
    if (this.root === undefined) throw new WorkspaceError("NO_WORKSPACE", "Open a project folder first.");
    return this.root;
  }

  async list({ path = "" }: { path?: string } = {}): Promise<DirectoryEntry[]> {
    return listDirectory(this.requireRoot(), path);
  }

  async files({ query, limit }: { query?: string; limit?: number } = {}): Promise<string[]> {
    return listWorkspaceFiles(this.requireRoot(), query, limit);
  }

  async create({ path, kind, text }: { path: string; kind: "file" | "directory"; text?: string }): Promise<DirectoryEntry> {
    return createEntry(this.requireRoot(), path, kind, text);
  }

  async rename({ from, to }: { from: string; to: string }): Promise<DirectoryEntry> {
    return renameEntry(this.requireRoot(), from, to);
  }

  async remove({ path }: { path: string }): Promise<void> {
    return removeEntry(this.requireRoot(), path);
  }

  async read({ path }: { path: string }): Promise<TextFile> {
    return readText(this.requireRoot(), path);
  }

  async write({ path, text, revision }: { path: string; text: string; revision: string }): Promise<TextFile> {
    if (typeof revision !== "string" || !revision) {
      throw new WorkspaceError("INVALID_INPUT", "Open the file before saving.");
    }
    return writeText(this.requireRoot(), path, text, revision);
  }

  async projectRules(): Promise<ProjectRuleFile[]> {
    return (await this.readProjectRulesContext()).map(({ path, text }) => ({ path, bytes: Buffer.byteLength(text) }));
  }

  async readProjectRulesContext(): Promise<TextContext[]> {
    const root = this.root;
    if (root === undefined) return [];
    const context: TextContext[] = [];
    let remaining = MAX_PROJECT_RULE_BYTES;
    for (const path of PROJECT_RULE_PATHS) {
      try {
        const { text } = await readText(root, path, remaining);
        remaining -= Buffer.byteLength(text);
        context.push({ path, text });
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
      }
    }
    return context;
  }

  async context(paths: string[]): Promise<TextContext[]> {
    if (!Array.isArray(paths) || paths.length > 20) {
      throw new WorkspaceError("LIMIT", "Select at most 20 context files.");
    }
    if (paths.length === 0) return [];
    const root = this.requireRoot();
    const context: TextContext[] = [];
    let size = 0;
    for (const path of new Set(paths)) {
      const { text } = await readText(root, path);
      size += Buffer.byteLength(text);
      if (size > MAX_CONTEXT_BYTES) throw new WorkspaceError("LIMIT", "Selected context files are limited to 256 KiB total.");
      context.push({ path, text });
    }
    return context;
  }

  async validateSelection({ path, text, revision }: { path: string; text: string; revision: string }): Promise<TextContext> {
    if (typeof text !== "string" || !text || Buffer.byteLength(text) > MAX_SELECTION_BYTES) {
      throw new WorkspaceError("INVALID_INPUT", "Select up to 128 KiB of saved text.");
    }
    const file = await this.read({ path });
    if (file.revision !== revision || !file.text.includes(text)) {
      throw new WorkspaceError("CONFLICT", "The selected text changed. Reselect it in the saved file.");
    }
    return { path, text };
  }

  private async library(scope: PromptRef["scope"], create: boolean): Promise<string | undefined> {
    if (scope === "project") return promptDirectory(this.requireRoot(), [".ai", "prompts"], create);
    return promptDirectory(await canonicalDirectory(this.globalBase), this.globalParts, create);
  }

  async listPrompts(): Promise<PromptSummary[]> {
    const scopes: PromptRef["scope"][] = this.root ? ["project", "global"] : ["global"];
    const results: PromptSummary[] = [];
    for (const scope of scopes) {
      const root = await this.library(scope, false);
      if (root === undefined) continue;
      const folders = [""];
      for (let index = 0; index < folders.length; index++) {
        for (const entry of await listDirectory(root, folders[index]!)) {
          if (entry.kind === "directory") {
            folders.push(entry.path);
            if (folders.length > 128) throw new WorkspaceError("LIMIT", "The prompt library has too many folders.");
          } else if (entry.name !== PROMPT_SUFFIX && entry.name.endsWith(PROMPT_SUFFIX)) {
            const ref = { scope, path: entry.path };
            let title = promptTitle(ref);
            try {
              title = parsePrompt(ref, await readText(root, entry.path)).title;
            } catch (error) {
              if (!(error instanceof WorkspaceError)) throw error;
            }
            results.push({ ref, title });
            if (results.length > 250) throw new WorkspaceError("LIMIT", "The prompt library has too many prompts.");
          }
        }
      }
    }
    return results;
  }

  private async loadPrompt(ref: PromptRef): Promise<TextFile> {
    checkPromptRef(ref);
    const root = await this.library(ref.scope, false);
    if (root === undefined) throw new WorkspaceError("NOT_FOUND", "The prompt library does not exist yet.");
    return readText(root, ref.path);
  }

  async readPrompt({ ref }: { ref: PromptRef }): Promise<PromptDocument> {
    const file = await this.loadPrompt(ref);
    try {
      return parsePrompt(ref, file);
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== "INVALID_PROMPT") throw error;
      return {
        ref,
        title: promptTitle(ref),
        source: file.text,
        revision: file.revision,
        body: "",
        variables: [],
        parseError: error.message,
      };
    }
  }

  async renderPrompt({ ref, values }: { ref: PromptRef; values: Record<string, string> }): Promise<RenderedPrompt> {
    const document = parsePrompt(ref, await this.loadPrompt(ref));
    return {
      text: fillPrompt(document, values),
      revision: document.revision,
      ...(document.providerId ? { providerId: document.providerId } : {}),
      ...(document.effort !== undefined ? { effort: document.effort } : {}),
      ...(document.mode ? { mode: document.mode } : {}),
    };
  }

  async writePrompt({ ref, source, revision }: { ref: PromptRef; source: string; revision?: string }): Promise<PromptDocument> {
    const parts = checkPromptRef(ref);
    validateText(source);
    parsePrompt(ref, { path: ref.path, text: source, revision: "" });
    if (revision !== undefined && (typeof revision !== "string" || !revision)) {
      throw new WorkspaceError("INVALID_INPUT", "Open the prompt before saving.");
    }
    const root = await this.library(ref.scope, revision === undefined);
    if (root === undefined) throw new WorkspaceError("NOT_FOUND", "The prompt library does not exist yet.");
    if (revision === undefined) await promptDirectory(root, parts.slice(0, -1), true);
    return parsePrompt(ref, await writeText(root, ref.path, source, revision));
  }
}
