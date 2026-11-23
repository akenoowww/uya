import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
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
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const protectedNames = new Set([
  ".aws", ".azure", ".claude", ".codex", ".config", ".continue", ".docker", ".gemini",
  ".git", ".gnupg", ".kube", ".netrc", ".npmrc", ".ollama", ".opencode", ".pypirc",
  ".qwen", ".ssh", "secrets", "credentials", "keychains", "private-keys", ".secrets",
  ".credentials",
]);
const excludedNames = new Set(["node_modules", ".next", ".venv", "__pycache__"]);
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
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new WorkspaceError("INVALID_INPUT", "Enter a path relative to the project.");
  }
  return parts;
}

function filesystemError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new WorkspaceError("NOT_FOUND", "The file or folder no longer exists.");
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

export async function promptDirectory(root: string, parts: string[], create: boolean): Promise<string | undefined> {
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

export async function listDirectory(root: string, relative: string): Promise<DirectoryEntry[]> {
  const parts = relativePath(relative, true);
  const { path, stats } = await walk(root, parts, "directory");
  if (!stats?.isDirectory()) throw new WorkspaceError("INVALID_INPUT", "Choose a folder.");
  const entries = await fs(() => readdir(path, { withFileTypes: true }));
  const result: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const kind = entry.isDirectory() ? "directory" : "file";
    if (excludedNames.has(entry.name) || protectedPath([...path.split(sep), entry.name], kind) ||
      /[\\\u0000-\u001f\u007f]/u.test(entry.name) || entry.name.startsWith(".ide-save-")) continue;
    result.push({
      name: entry.name,
      path: [...parts, entry.name].join("/"),
      kind,
    });
  }
  if (result.length > MAX_ENTRIES) throw new WorkspaceError("LIMIT", "This folder has too many entries to display.");
  return result.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
}

function validFile(stats: Stats | undefined) {
  const hasMultipleLinks = process.platform === "win32" ? (stats?.nlink ?? 0) > 1 : stats?.nlink !== 1;
  if (!stats?.isFile() || hasMultipleLinks) {
    throw new WorkspaceError("FORBIDDEN", "Choose a regular text file without links.");
  }
  if (stats.size > MAX_TEXT_BYTES) throw new WorkspaceError("LIMIT", "Text files are limited to 1 MiB.");
}

function sameVersion(first: Stats, second: Stats) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size &&
    first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

export async function readText(root: string, relative: string): Promise<TextFile> {
  const { path, stats } = await walk(root, relativePath(relative), "file");
  validFile(stats);
  const openFlags = (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await fs(() => open(path, openFlags));
  try {
    const before = await fs(() => handle.stat());
    validFile(before);
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

export async function writeText(root: string, relative: string, text: string, revision?: string): Promise<TextFile> {
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
