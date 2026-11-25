import { basename } from "node:path";
import type { DirectoryEntry, TextContext } from "@ide/protocol";
import {
  canonicalDirectory,
  isProtectedRelativePath,
  listIndexedDirectory,
  workspaceEntryKind,
  WorkspaceError,
} from "./workspace-files";

const MAX_ENTRIES = 120;
const MAX_BYTES = 6 * 1024;
const TREE_FENCE = "```";

type TreeEntry = { entry: DirectoryEntry; depth: number };

async function collectTree(root: string): Promise<{ entries: TreeEntry[]; total: number }> {
  const entries: TreeEntry[] = [];
  let total = 0;
  const add = (entry: DirectoryEntry, depth: number) => {
    if (total++ < MAX_ENTRIES) entries.push({ entry, depth });
  };
  for (const entry of await listIndexedDirectory(root, "")) {
    add(entry, 0);
    if (entry.kind !== "directory") continue;
    for (const child of await listIndexedDirectory(root, entry.path)) add(child, 1);
  }
  return { entries, total };
}

async function activeEditorPath(root: string, path?: string): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    if (isProtectedRelativePath(path)) return undefined;
    // Reject aliases and protected ancestors. A new editor buffer can be absent on disk.
    return (await workspaceEntryKind(root, path)) === "directory" ? undefined : path;
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
  }
}

function label(value: string): string {
  const chars = [...value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, " ")];
  return chars.length > 512 ? chars.slice(0, 511).join("") + "…" : chars.join("");
}

function inlineCode(value: string): string {
  const text = label(value);
  const longestRun = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const padding = /^[ `]|[ `]$/u.test(text) ? " " : "";
  return fence + padding + text + padding + fence;
}

function omission(count: number): string {
  return count ? "... (" + count + " more)\n" : "";
}

function formatMap(project: string, active: string | undefined, entries: TreeEntry[], total: number): string {
  const name = label(project).replace(/[\\`*_[\]<>&#]/gu, "\\$&");
  const header = "# " + name + "\n\n" + (active ? "Active file " + inlineCode(active) + "\n\n" : "") + TREE_FENCE + "text\n";
  const rows: string[] = [];
  let bytes = Buffer.byteLength(header + TREE_FENCE);
  for (const { entry, depth } of entries) {
    const row = "  ".repeat(depth) + "- " + entry.name + (entry.kind === "directory" ? "/" : "") + "\n";
    const size = Buffer.byteLength(row);
    const remaining = total - rows.length - 1;
    if (bytes + size + Buffer.byteLength(omission(remaining)) > MAX_BYTES) break;
    bytes += size;
    rows.push(row);
  }
  return header + rows.join("") + omission(total - rows.length) + TREE_FENCE;
}

export async function buildWorkspaceMap(root: string, activeFilePath?: string): Promise<TextContext> {
  const directory = await canonicalDirectory(root);
  const [{ entries, total }, active] = await Promise.all([
    collectTree(directory),
    activeEditorPath(directory, activeFilePath),
  ]);
  return { path: "@workspace-map", text: formatMap(basename(directory) || directory, active, entries, total) };
}
