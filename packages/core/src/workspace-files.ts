import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative as relativeTo, resolve, sep } from "node:path";
import type { DirectoryEntry, TextFile } from "@ide/protocol";

type WorkspaceErrorCode = "INVALID_INPUT" | "NO_WORKSPACE" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "LIMIT" |
  "INVALID_PROMPT" | "IO";

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_INDEX_DEPTH = 12;
const MAX_INDEX_ENTRIES = 50_000;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const protectedNames = new Set([
  ".aws", ".azure", ".claude", ".codex", ".config", ".continue", ".docker", ".gemini",
  ".git", ".gnupg", ".kube", ".netrc", ".npmrc", ".ollama", ".opencode", ".pypirc",
  ".qwen", ".ssh", "secrets", "credentials", "keychains", "private-keys", ".secrets",
  ".credentials",
]);
const excludedNames: ReadonlySet<string> = new Set([
  "node_modules", ".next", ".venv", "__pycache__", ".DS_Store", "Thumbs.db", "desktop.ini",
]);
const indexExcludedNames: ReadonlySet<string> = new Set(["target", "dist", "build"]);
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".cts", ".dart", ".ex", ".exs", ".go", ".h", ".hpp",
  ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".mjs", ".cjs", ".mts", ".php",
  ".py", ".pyi", ".rb", ".rs", ".scala", ".sql", ".swift", ".ts", ".tsx", ".vue", ".svelte",
]);
const dotenv = /^\.env(?:rc)?(?:\.|$)|\.env(?:rc)?(?:\.example)?$/u;
const dotenvExample = /^\.env(?:rc)?(?:\.[a-z0-9_-]+)*\.example$|\.(?:example\.env(?:rc)?|env(?:rc)?\.example)$/u;
const configExample = /\.(?:example\.(?:jsonc?|ya?ml|toml|ini|conf|cfg)|(?:jsonc?|ya?ml|toml|ini|conf|cfg)\.example)$/u;
type PathKind = "file" | "directory";

function protectedPath(parts: string[], kind: PathKind): boolean {
  return parts.some((part, index) => {
    const name = part.toLowerCase();
    if (name === "ai" && parts[index - 1]?.toLowerCase() === "var") return true;
    if (protectedNames.has(name)) return true;
    if (/\.(key|pem|p12|pfx|jks|keystore)$/u.test(name) ||
      /^(id_(rsa|dsa|ecdsa|ed25519)(?:_sk)?)(\.|$)/u.test(name)) return true;
    const isFile = kind === "file" && index === parts.length - 1;
    if (dotenv.test(name)) return !isFile || !dotenvExample.test(name);
    if (isFile && configExample.test(name)) return false;
    if (name.startsWith(".aider.conf.")) return true;
    if (isFile && sourceExtensions.has(extname(name))) return false;
    return /(?:credentials?|secrets?|api[_-]?keys?|access[_-]?tokens?|private[_-]?keys?|private[_-]?api|service[_-]?accounts?)/u.test(name)
      || /^(auth|providers?|models?)(?:[._-].+)?\.(jsonc?|ya?ml|toml)$/u.test(name);
  });
}

function checkPath(path: string, kind: PathKind) {
  if (protectedPath(path.split(sep).filter(Boolean), kind)) {
    throw new WorkspaceError("FORBIDDEN", "This path is protected.");
  }
}

export function relativePath(path: string, allowEmpty = false): string[] {
  if (typeof path !== "string" || path.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(path) || isAbsolute(path)) {
    throw new WorkspaceError("INVALID_INPUT", "Enter a path relative to the project.");
  }
  if (allowEmpty && path === "") return [];
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." ||
    (process.platform === "win32" && /[<>:"|?*]|[. ]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)))) {
    throw new WorkspaceError("INVALID_INPUT", "Enter a path relative to the project.");
  }
  return parts;
}

export function isProtectedRelativePath(path: string): boolean {
  return protectedPath(relativePath(path), "file");
}

function isTreeExcludedName(name: string): boolean {
  return excludedNames.has(name) || name.startsWith(".ide-save-");
}

export function isIgnoredWorkspaceName(name: string): boolean {
  return isTreeExcludedName(name) || indexExcludedNames.has(name.toLowerCase());
}

export function isIndexedWorkspacePath(path: string): boolean {
  try {
    return !isProtectedRelativePath(path) && !path.split("/").some(isIgnoredWorkspaceName);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "INVALID_INPUT") return false;
    throw error;
  }
}

function filesystemError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new WorkspaceError("NOT_FOUND", "The file or folder no longer exists.");
  if (code === "EEXIST" || code === "ENOTEMPTY") return new WorkspaceError("CONFLICT", "The file or folder already exists or has changed.");
  if (code === "ELOOP" || code === "EACCES" || code === "EPERM") {
    return new WorkspaceError("FORBIDDEN", "The file or folder cannot be accessed.");
  }
  return new WorkspaceError("IO", "The file operation failed.");
}

async function fs<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw filesystemError(error);
  }
}

export async function canonicalDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0") || input.length > 4096) {
    throw new WorkspaceError("INVALID_INPUT", "Choose a folder by its absolute path.");
  }
  const path = resolve(input);
  checkPath(path, "directory");
  const canonical = await fs(() => realpath(path));
  checkPath(canonical, "directory");
  const stats = await fs(() => lstat(canonical));
  if (!stats.isDirectory()) throw new WorkspaceError("INVALID_INPUT", "Choose an existing folder.");
  return canonical;
}

async function walk(root: string, parts: string[], kind: PathKind, allowMissing = false): Promise<{ path: string; stats?: Stats }> {
  const fullPath = join(root, ...parts);
  checkPath(fullPath, kind);

  if (await canonicalDirectory(root) !== root) {
    throw new WorkspaceError("FORBIDDEN", "The selected folder has moved.");
  }

  let path = root;
  let stats = await fs(() => lstat(path));
  for (const [index, part] of parts.entries()) {
    if (!stats.isDirectory()) throw new WorkspaceError("NOT_FOUND", "The folder no longer exists.");
    path = join(path, part);
    try {
      stats = await lstat(path);
    } catch (error) {
      if (allowMissing && index === parts.length - 1 && (error as NodeJS.ErrnoException)?.code === "ENOENT") {
        if (await fs(() => realpath(dirname(path))) !== dirname(path)) {
          throw new WorkspaceError("FORBIDDEN", "Use the folder path shown in the project tree.");
        }
        return { path };
      }
      throw filesystemError(error);
    }
    if (stats.isSymbolicLink()) throw new WorkspaceError("FORBIDDEN", "Symbolic links are unavailable in the editor.");
  }

  if (await fs(() => realpath(path)) !== path) {
    throw new WorkspaceError("FORBIDDEN", "Use the file path shown in the project tree.");
  }
  return { path, stats };
}

let pendingMutation: Promise<void> = Promise.resolve();

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingMutation.then(operation);
  pendingMutation = result.then(() => undefined, () => undefined);
  return result;
}

export async function promptDirectory(root: string, parts: string[], create: boolean): Promise<string | undefined> {
  return create ? mutate(() => ensurePromptDirectory(root, parts, true)) : ensurePromptDirectory(root, parts, false);
}

async function ensurePromptDirectory(root: string, parts: string[], create: boolean): Promise<string | undefined> {
  let path = root;
  for (let index = 0; index < parts.length; index++) {
    const next = await walk(root, parts.slice(0, index + 1), "directory", true);
    if (!next.stats) {
      if (!create) return undefined;
      try {
        await mkdir(next.path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw filesystemError(error);
      }
    }
    path = next.path;
  }
  const checked = await walk(root, parts, "directory");
  if (!checked.stats?.isDirectory()) throw new WorkspaceError("INVALID_INPUT", "The prompt library path must be a folder.");
  return path;
}

async function directoryEntries(root: string, relative: string, indexed: boolean): Promise<DirectoryEntry[]> {
  const parts = relativePath(relative, true);
  const { path, stats } = await walk(root, parts, "directory");
  if (!stats?.isDirectory()) throw new WorkspaceError("INVALID_INPUT", "Choose a folder.");
  const entries = await fs(() => readdir(path, { withFileTypes: true }));
  if (indexed) {
    const current = await fs(() => lstat(path));
    if (!current.isDirectory() || current.dev !== stats.dev || current.ino !== stats.ino) {
      throw new WorkspaceError("CONFLICT", "The folder changed.");
    }
  }
  const ancestors = path.split(sep);
  const result: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const kind = entry.isDirectory() ? "directory" : "file";
    const { name } = entry;
    const child = [...parts, name].join("/");
    const omitted = indexed ? !isIndexedWorkspacePath(child) : isTreeExcludedName(name) || /[\\\u0000-\u001f\u007f]/u.test(name);
    if (omitted || protectedPath([...ancestors, name], kind)) continue;
    result.push({ name, path: child, kind });
  }
  return result;
}

export async function listDirectory(root: string, relative: string): Promise<DirectoryEntry[]> {
  const result = await directoryEntries(root, relative, false);
  if (result.length > MAX_ENTRIES) throw new WorkspaceError("LIMIT", "This folder has too many entries to display.");
  return result.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
}

export async function listIndexedDirectory(root: string, relative: string): Promise<DirectoryEntry[]> {
  try {
    const entries = await directoryEntries(root, relative, true);
    return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch (error) {
    if (relative && error instanceof WorkspaceError &&
      (error.code === "NOT_FOUND" || error.code === "FORBIDDEN" || error.code === "CONFLICT" || error.code === "INVALID_INPUT")) return [];
    throw error;
  }
}

export function isSingleLinkFile(stats: Stats | undefined): stats is Stats {
  return !!stats?.isFile() && (process.platform === "win32" ? stats.nlink <= 1 : stats.nlink === 1);
}

function requireRegularFile(stats: Stats | undefined): asserts stats is Stats {
  if (!isSingleLinkFile(stats)) {
    throw new WorkspaceError("FORBIDDEN", "Choose a regular file without links.");
  }
}

function validFile(stats: Stats | undefined, maxBytes: number) {
  requireRegularFile(stats);
  if (stats.size > MAX_TEXT_BYTES) throw new WorkspaceError("LIMIT", "Text files are limited to 1 MiB.");
  if (stats.size > maxBytes) throw new WorkspaceError("LIMIT", "The file exceeds the available context size.");
}

function sameVersion(first: Stats, second: Stats) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size &&
    first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

export async function readText(root: string, relative: string, maxBytes = MAX_TEXT_BYTES): Promise<TextFile> {
  const { path, stats } = await walk(root, relativePath(relative), "file");
  validFile(stats, maxBytes);
  const openFlags = (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await fs(() => open(path, openFlags));
  try {
    const before = await fs(() => handle.stat());
    validFile(before, maxBytes);
    if (!stats || !sameVersion(stats, before)) throw new WorkspaceError("CONFLICT", "The file changed. Open it again.");
    const data = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await fs(() => handle.read(data, offset, data.length - offset, offset));
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== before.size || !sameVersion(before, await fs(() => handle.stat()))) {
      throw new WorkspaceError("CONFLICT", "The file changed. Open it again.");
    }
    let text: string;
    try {
      text = decoder.decode(data.subarray(0, offset));
      if (text.includes("\0")) throw new Error();
    } catch {
      throw new WorkspaceError("INVALID_INPUT", "The editor supports UTF-8 text files.");
    }
    const stamp = `${before.dev}:${before.ino}:${before.mtimeMs}:${before.ctimeMs}:`;
    const revision = createHash("sha256").update(stamp).update(data.subarray(0, offset)).digest("hex");
    return { path: relative, text, revision };
  } finally {
    await handle.close();
  }
}

export function validateText(text: string) {
  if (typeof text !== "string" || text.includes("\0")) {
    throw new WorkspaceError("INVALID_INPUT", "Enter valid UTF-8 text.");
  }
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new WorkspaceError("LIMIT", "Text files are limited to 1 MiB.");
}

export function writeText(root: string, relative: string, text: string, revision?: string): Promise<TextFile> {
  return mutate(() => saveText(root, relative, text, revision));
}

async function saveText(root: string, relative: string, text: string, revision?: string): Promise<TextFile> {
  validateText(text);
  const parts = relativePath(relative);
  const { path, stats } = await walk(root, parts, "file", revision === undefined);
  const conflict = () => new WorkspaceError("CONFLICT", "The file changed. Reopen it before saving.");
  if (revision === undefined && stats) throw conflict();
  if (revision !== undefined && (await readText(root, relative)).revision !== revision) throw conflict();

  const temporary = join(dirname(path), `.ide-save-${randomUUID()}`);
  const handle = await fs(() => open(temporary, "wx", stats ? stats.mode & 0o777 : 0o600));
  try {
    try {
      if (stats && process.platform !== "win32") await fs(() => handle.chmod(stats.mode & 0o777));
      await fs(() => handle.writeFile(text, "utf8"));
      await fs(() => handle.sync());
    } finally {
      await handle.close();
    }

    if (revision === undefined) {
      await walk(root, parts.slice(0, -1), "directory");
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw conflict();
        throw filesystemError(error);
      }
    } else {
      if ((await readText(root, relative)).revision !== revision) throw conflict();
      await fs(() => rename(temporary, path));
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return readText(root, relative);
}

async function unoccupiedPath(root: string, parts: string[], kind: PathKind): Promise<string> {
  const { path, stats } = await walk(root, parts, kind, true);
  if (stats) throw new WorkspaceError("CONFLICT", "The file or folder already exists.");
  return path;
}

export async function createEntry(root: string, relative: string, kind: PathKind, text?: string): Promise<DirectoryEntry> {
  const parts = relativePath(relative);
  if (kind === "file") {
    await writeText(root, relative, text ?? "");
  } else if (kind === "directory") {
    await mutate(async () => {
      const path = await unoccupiedPath(root, parts, "directory");
      await fs(() => mkdir(path, { mode: 0o755 }));
    });
  } else {
    throw new WorkspaceError("INVALID_INPUT", "Choose a file or folder.");
  }
  return { name: parts.at(-1)!, path: relative, kind };
}

type ExistingEntry = { path: string; stats: Stats };

function checkedKind({ path, stats }: ExistingEntry): PathKind {
  const kind = stats.isDirectory() ? "directory" : "file";
  checkPath(path, kind);
  if (kind === "file") requireRegularFile(stats);
  return kind;
}

async function existingEntry(root: string, parts: string[]): Promise<ExistingEntry> {
  const { path, stats } = await walk(root, parts, "file");
  if (!stats) throw new WorkspaceError("NOT_FOUND", "The file or folder no longer exists.");
  return { path, stats };
}

function pathInWorkspace(root: string, path: string): string {
  return relativeTo(root, path).split(sep).join("/");
}

async function checkTree(root: string, source: ExistingEntry, destination?: string): Promise<ExistingEntry[]> {
  const entries = [source];
  for (const entry of entries) {
    const kind = checkedKind(entry);
    if (destination !== undefined) checkPath(destination + entry.path.slice(source.path.length), kind);
    if (kind !== "directory") continue;
    for (const name of await fs(() => readdir(entry.path))) {
      const path = join(entry.path, name);
      relativePath(pathInWorkspace(root, path));
      entries.push({ path, stats: await fs(() => lstat(path)) });
    }
  }
  return entries;
}

export async function renameEntry(root: string, from: string, to: string): Promise<DirectoryEntry> {
  const fromParts = relativePath(from);
  const toParts = relativePath(to);
  return mutate(async () => {
    const source = await existingEntry(root, fromParts);
    const kind = checkedKind(source);
    const destination = await unoccupiedPath(root, toParts, kind);
    if (destination.startsWith(source.path + sep)) {
      throw new WorkspaceError("INVALID_INPUT", "Choose a destination outside the folder being moved.");
    }
    await checkTree(root, source, destination);
    const current = await existingEntry(root, fromParts);
    checkedKind(current);
    if (!sameVersion(source.stats, current.stats)) throw new WorkspaceError("CONFLICT", "The file or folder changed.");
    await unoccupiedPath(root, toParts, kind);
    await fs(() => rename(source.path, destination));
    return { name: toParts.at(-1)!, path: to, kind };
  });
}

export async function removeEntry(root: string, relative: string): Promise<void> {
  const parts = relativePath(relative);
  await mutate(async () => {
    const source = await existingEntry(root, parts);
    const entries = await checkTree(root, source);
    // Remove only entries that passed preflight. A new child makes rmdir fail.
    for (const entry of entries.reverse()) {
      const current = await existingEntry(root, relativePath(pathInWorkspace(root, entry.path)));
      const kind = checkedKind(current);
      if (entry.stats.dev !== current.stats.dev || entry.stats.ino !== current.stats.ino) {
        throw new WorkspaceError("CONFLICT", "The file or folder changed.");
      }
      await fs(() => kind === "directory" ? rmdir(current.path) : unlink(current.path));
    }
  });
}

export async function workspaceEntryKind(root: string, relative: string): Promise<PathKind | undefined> {
  try {
    const { path, stats } = await walk(root, relativePath(relative), "file", true);
    return stats ? checkedKind({ path, stats }) : undefined;
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
}

export async function workspaceFileExists(root: string, relative: string): Promise<boolean> {
  return (await workspaceEntryKind(root, relative)) === "file";
}

function matchRank(name: string, path: string, query: string): number | undefined {
  const basename = name.toLowerCase();
  if (basename.startsWith(query)) return 0;
  if (basename.includes(query)) return 1;
  const candidate = path.toLowerCase();
  if (candidate.includes(query)) return 2;
  let offset = 0;
  for (const char of query) {
    const index = candidate.indexOf(char, offset);
    if (index === -1) return undefined;
    offset = index + char.length;
  }
  return 3;
}

export async function listWorkspaceFiles(root: string, query?: string, limit = 100): Promise<string[]> {
  if ((query !== undefined && typeof query !== "string") || !Number.isFinite(limit)) {
    throw new WorkspaceError("INVALID_INPUT", "Enter a file search and a finite result limit.");
  }
  const count = Math.min(500, Math.floor(limit));
  if (count <= 0) return [];
  const search = query?.trim().toLowerCase() ?? "";
  const folders: string[][] = [[]];
  const matches: { path: string; rank: number; depth: number }[] = [];
  let files = 0;
  let visited = 0;
  for (const parts of folders) {
    if (files >= MAX_ENTRIES || visited >= MAX_INDEX_ENTRIES) break;
    try {
      const { path } = await walk(root, parts, "directory");
      const directory = await fs(() => opendir(path));
      for await (const entry of directory) {
        if (++visited > MAX_INDEX_ENTRIES) break;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const { name } = entry;
        if (isIgnoredWorkspaceName(name)) continue;
        const child = [...parts, name];
        const relative = child.join("/");
        if (relative.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(name)) continue;
        const absolute = join(path, name);
        const kind = entry.isDirectory() ? "directory" : "file";
        if (protectedPath(absolute.split(sep), kind)) continue;
        if (kind === "directory") {
          if (parts.length < MAX_INDEX_DEPTH) folders.push(child);
          continue;
        }
        const rank = matchRank(name, relative, search);
        if (rank !== undefined && isSingleLinkFile(await lstat(absolute).catch(() => undefined))) {
          matches.push({ path: relative, rank, depth: parts.length });
        }
        if (++files >= MAX_ENTRIES) break;
      }
    } catch (error) {
      const issue = filesystemError(error);
      if (!parts.length || (issue.code !== "NOT_FOUND" && issue.code !== "FORBIDDEN")) throw issue;
    }
  }
  return matches.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.path.localeCompare(b.path))
    .slice(0, count).map(({ path }) => path);
}
