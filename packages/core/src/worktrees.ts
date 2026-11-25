import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  ArenaApplyResult, ArenaSlot, ArenaSlotFileStat, ArenaSlotInput, ArenaSummary, ArenaVerifySummary,
  GitDiffResult, GitFileStatus,
} from "@ide/protocol";
import { RpcError } from "./validation";
import {
  canonicalDirectory, isProtectedRelativePath, MAX_TEXT_BYTES, readText, relativePath, WorkspaceError,
} from "./workspace-files";

export interface ArenaStore {
  saveArena(arena: ArenaSummary): void;
  getArena(id: string): ArenaSummary | undefined;
  listArenas(workspacePath?: string, limit?: number): ArenaSummary[];
}

export interface ArenaCheckpointHook {
  createCheckpoint(workspacePath: string, label: string): Promise<{ id: string }>;
}

export interface ArenaVerifyExecutor {
  runSync(cwd: string, command: string, signal?: AbortSignal): Promise<{
    status: "passed" | "failed" | "cancelled";
    exitCode: number | null;
    durationMs: number;
    output: string;
  }>;
}

const GIT_TIMEOUT = 8000;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const DIFF_TRUNCATED = "\n[Diff truncated at 512 KiB]\n";
const gitFlags = [
  "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false",
  "-c", `core.hooksPath=${devNull}`, "-c", "submodule.recurse=false", "-c", "maintenance.auto=false",
];
const diffFlags = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=all"];
const renameFlags = ["--find-renames=100%"];
const patchFlags = ["--patch", "--src-prefix=a/", "--dst-prefix=b/"];
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class ArenaGitError extends WorkspaceError {
  constructor(readonly exitCode?: string | number | null) {
    super("IO", "Git could not complete the arena operation.");
  }
}

type GitOptions = { input?: string; index?: string; allowDiff?: boolean; allowTruncation?: boolean };
type GitOutput = { stdout: Buffer; truncated: boolean };
type GitRepository = { root: string; overrides: string[] };
type Project = { workspacePath: string; prefix: string; repo: GitRepository };

function gitEnv(index?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/iu.test(name)) delete env[name];
  return {
    ...env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C",
    ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
  };
}

function git(repo: GitRepository, args: string[], options: GitOptions = {}): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...gitFlags, ...repo.overrides, ...args], {
      cwd: repo.root, env: gitEnv(options.index), encoding: "buffer", timeout: GIT_TIMEOUT, maxBuffer: MAX_GIT_OUTPUT,
      killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (!error || (options.allowDiff && error.code === 1)) resolve({ stdout, truncated: false });
      else if (options.allowTruncation && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        resolve({ stdout, truncated: true });
      } else reject(new ArenaGitError(error.code));
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}

function gitWithFile(repo: GitRepository, args: string[], input: number | "ignore", output: number | "ignore") {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", [...gitFlags, ...repo.overrides, ...args], {
      cwd: repo.root, env: gitEnv(), stdio: [input, output, "ignore"], timeout: GIT_TIMEOUT, killSignal: "SIGKILL",
    });
    child.once("error", () => reject(new ArenaGitError()));
    child.once("close", (code) => code === 0 ? resolve() : reject(new ArenaGitError(code)));
  });
}

async function gitLine(repo: GitRepository, args: string[], options?: GitOptions): Promise<string> {
  return (await git(repo, args, options)).stdout.toString("utf8").replace(/\r?\n$/u, "");
}

function gitExit(error: unknown, code: number): boolean {
  return error instanceof ArenaGitError && error.exitCode === code;
}

function decode(bytes: Buffer): string | undefined {
  try { return decoder.decode(bytes); } catch { return undefined; }
}

function* splitRecords(bytes: Buffer): Generator<Buffer> {
  for (let offset = 0, end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, offset)) {
    yield bytes.subarray(offset, end);
    offset = end + 1;
  }
}

function* nulRecords(bytes: Buffer): Generator<string | undefined> {
  for (const record of splitRecords(bytes)) yield decode(record);
}

async function repository(root: string): Promise<GitRepository> {
  const repo: GitRepository = { root, overrides: [] };
  const names = await git(repo, [
    "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$",
  ]).catch((error: unknown) => {
    if (!gitExit(error, 1)) throw error;
    return undefined;
  });
  // Checkout, status, diff and add can all invoke configured filter programs.
  for (const name of new Set(nulRecords(names?.stdout ?? Buffer.alloc(0)))) {
    if (!name || /[=\u0000-\u001f\u007f]/u.test(name)) throw new ArenaGitError();
    repo.overrides.push("-c", `${name}=${name.endsWith(".required") ? "false" : ""}`);
  }
  return repo;
}

function safePath(path: string): string[] {
  const parts = relativePath(path);
  if (isProtectedRelativePath(path)) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
  return parts;
}

function allowedPath(path: string | undefined): path is string {
  try { return path !== undefined && !isProtectedRelativePath(path); } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return false;
  }
}

async function projectFor(input: string): Promise<Project> {
  const workspacePath = await canonicalDirectory(input);
  const topLevel = await gitLine({ root: workspacePath, overrides: [] }, ["rev-parse", "--show-toplevel"])
    .catch((error: unknown) => {
      if (!gitExit(error, 128)) throw error;
      throw new WorkspaceError("INVALID_INPUT", "Choose a Git working tree for the arena.");
    });
  const root = await canonicalDirectory(topLevel);
  const subdir = relative(root, workspacePath).split(sep).join("/");
  if (subdir) safePath(subdir);
  return { workspacePath, prefix: subdir ? `${subdir}/` : "", repo: await repository(root) };
}

async function requireCanonical(path: string): Promise<void> {
  if (await canonicalDirectory(path) !== path) throw new WorkspaceError("FORBIDDEN", "The arena folder has moved.");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function statIfPresent(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return undefined;
  });
}

async function directoryAt(parent: string, name: string, create = false): Promise<string | undefined> {
  const path = join(parent, name);
  const stats = await statIfPresent(path);
  if (stats?.isDirectory()) return path;
  if (stats) throw new WorkspaceError("FORBIDDEN", "An arena folder has been replaced.");
  if (!create) return undefined;
  await mkdir(path, { mode: 0o700 });
  return path;
}

type Location = { path: string; stats?: Stats };
type RegularFile = { path: string; stats: Stats };

function isRegular(stats: Stats | undefined): stats is Stats {
  return !!stats?.isFile() && (process.platform === "win32" ? stats.nlink <= 1 : stats.nlink === 1);
}

function unsafeFile(): WorkspaceError {
  return new WorkspaceError("FORBIDDEN", "Arena changes must use regular files without links.");
}

async function locate(root: string, path: string): Promise<Location> {
  const parts = safePath(path);
  let absolute = root;
  for (const [index, part] of parts.entries()) {
    absolute = join(absolute, part);
    const stats = await statIfPresent(absolute);
    if (stats?.isSymbolicLink()) throw unsafeFile();
    if (index === parts.length - 1) return { path: absolute, stats };
    if (!stats?.isDirectory()) return { path: join(root, ...parts) };
  }
  throw new WorkspaceError("INVALID_INPUT", "Enter a file path relative to the project.");
}

async function ensureParents(root: string, parts: string[], onCreate?: (path: string) => void): Promise<void> {
  let directory = root;
  for (const part of parts) {
    directory = join(directory, part);
    const stats = await statIfPresent(directory);
    if (stats?.isDirectory()) continue;
    if (stats) throw new WorkspaceError("CONFLICT", "An arena change conflicts with an existing file or link.");
    await mkdir(directory, { mode: 0o755 });
    onCreate?.(directory);
  }
}

function sameFile(a: Stats | undefined, b: Stats | undefined): boolean {
  if (!a || !b) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function changedOnDisk(): WorkspaceError {
  return new WorkspaceError("CONFLICT", "A file changed while applying the arena changes.");
}

async function copyBytes(input: FileHandle, output: FileHandle, size: number): Promise<void> {
  const chunk = Buffer.alloc(Math.min(size, 64 * 1024));
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (!bytesRead) throw changedOnDisk();
    for (let written = 0; written < bytesRead;) {
      const { bytesWritten } = await output.write(chunk, written, bytesRead - written, offset + written);
      if (!bytesWritten) throw new WorkspaceError("IO", "The arena file could not be written.");
      written += bytesWritten;
    }
    offset += bytesRead;
  }
}

async function temporaryCopy(source: RegularFile, directory: string): Promise<string> {
  const temporary = join(directory, `.uya-arena-${crypto.randomUUID()}.tmp`);
  const input = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await input.stat();
    if (!isRegular(before) || !sameFile(source.stats, before)) throw changedOnDisk();
    const output = await open(temporary, "wx", 0o600);
    try {
      try {
        await copyBytes(input, output, before.size);
        if (!sameFile(before, await input.stat())) throw changedOnDisk();
        if (process.platform !== "win32") await output.chmod(before.mode & 0o777);
        await output.sync();
      } finally {
        await output.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return temporary;
  } finally {
    await input.close();
  }
}

type Change = { path: string; status: GitFileStatus; previous?: string; regular: boolean };
type Changes = { tracked: Change[]; untracked: Change[]; blocked: Set<string> };
type Inspection = { repo: GitRepository; prefix: string; changes: Changes };

const statusByLetter: Partial<Record<string, GitFileStatus>> = {
  M: "modified", T: "modified", U: "modified", A: "added", D: "deleted", R: "renamed", C: "added",
};

function blockRename(blocked: Set<string>, first: string | undefined, second: string | undefined): void {
  if (allowedPath(first) && allowedPath(second)) return;
  if (first !== undefined) blocked.add(first);
  if (second !== undefined) blocked.add(second);
}

function parseStatus(bytes: Buffer) {
  const records = splitRecords(bytes);
  const untracked: string[] = [];
  const blocked = new Set<string>();
  for (const record of records) {
    const status = record.toString("ascii", 0, 2);
    const path = decode(record.subarray(3));
    if (status === "??" && allowedPath(path)) untracked.push(path);
    if (/[RC]/u.test(status)) {
      const previous = records.next().value;
      blockRename(blocked, path, previous && decode(previous));
    }
  }
  return { untracked, blocked };
}

function inScope(path: string, prefix: string): boolean {
  return path.length > prefix.length && path.startsWith(prefix);
}

function parseTracked(bytes: Buffer, prefix: string, blocked: Set<string>): Change[] {
  const records = nulRecords(bytes);
  const changes: Change[] = [];
  for (const header of records) {
    const entry = /^:([0-7]{6}) ([0-7]{6}) [^ ]+ [^ ]+ ([A-Z])\d*$/u.exec(header ?? "");
    if (!entry) throw new ArenaGitError();
    const first = records.next().value;
    const letter = entry[3]!;
    const paired = letter === "R" || letter === "C";
    const path = paired ? records.next().value : first;
    if (paired) blockRename(blocked, first, path);
    if (!allowedPath(first) || !allowedPath(path)) continue;
    const regular = entry.slice(1, 3).every((mode) => /^(?:000000|100[0-7]{3})$/u.test(mode));
    const fromInside = inScope(first, prefix);
    if (!inScope(path, prefix)) {
      if (letter === "R" && fromInside) changes.push({ path: first, status: "deleted", regular });
      continue;
    }
    const status = letter === "R" && !fromInside ? "added" : statusByLetter[letter];
    if (status) changes.push({ path, status, regular, previous: status === "renamed" ? first : undefined });
  }
  return changes.filter(({ path, previous }) => !blocked.has(path) && (!previous || !blocked.has(previous)));
}

async function inspectFile(root: string, path: string, missing = false): Promise<boolean> {
  try {
    const { stats } = await locate(root, path);
    return missing ? !stats || stats.isDirectory() || isRegular(stats) : isRegular(stats);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "FORBIDDEN") return false;
    throw error;
  }
}

async function scanChanges(repo: GitRepository, prefix: string, base: string): Promise<Changes> {
  const [status, raw] = await Promise.all([
    git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", ...renameFlags]),
    git(repo, [...diffFlags, "--raw", "-z", ...renameFlags, base, "--"]),
  ]);
  const { untracked, blocked } = parseStatus(status.stdout);
  const tracked = parseTracked(raw.stdout, prefix, blocked);
  for (const change of tracked) {
    change.regular = change.regular && await inspectFile(repo.root, change.path, change.status === "deleted") &&
      (!change.previous || await inspectFile(repo.root, change.previous, true));
  }
  const untrackedChanges: Change[] = [];
  for (const path of untracked) {
    if (!inScope(path, prefix) || blocked.has(path)) continue;
    untrackedChanges.push({ path, status: "untracked", regular: await inspectFile(repo.root, path) });
  }
  return { tracked, untracked: untrackedChanges, blocked };
}

function changePaths({ previous, path }: Change): string[] {
  return previous === undefined ? [path] : [previous, path];
}

function exactPathspec(path: string): string {
  // Use an escaped glob so this cannot also select the path's descendants.
  return ":(top,glob)" + path.replace(/^.|[\\*?[\]]/gu, "\\$&");
}

function* pathspecBatches(groups: string[][]): Generator<string[]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const group of groups) {
    const specs = group.map(exactPathspec);
    const size = specs.reduce((sum, spec) => sum + Buffer.byteLength(spec) + 1, 0);
    if (batch.length && bytes + size > 16 * 1024) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(...specs);
    bytes += size;
  }
  if (batch.length) yield batch;
}

type Counts = Pick<ArenaSlotFileStat, "additions" | "deletions">;
const zeroCounts: Counts = { additions: 0, deletions: 0 };

function numstats(bytes: Buffer): Map<string, Counts> {
  const stats = new Map<string, Counts>();
  const records = nulRecords(bytes);
  for (const record of records) {
    const fields = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(record ?? "");
    if (!fields) continue;
    let path = fields[3];
    if (path === "") {
      records.next();
      path = records.next().value;
    }
    if (path !== undefined) stats.set(path, { additions: Number(fields[1]) || 0, deletions: Number(fields[2]) || 0 });
  }
  return stats;
}

function untrackedDiff(repo: GitRepository, path: string, flags: string[], allowTruncation = false) {
  return git(repo, [...diffFlags, "--no-index", ...flags, "--", "/dev/null", path], { allowDiff: true, allowTruncation });
}

async function fileStats({ repo, prefix, changes }: Inspection, base: string): Promise<ArenaSlotFileStat[]> {
  const counts = new Map<string, Counts>();
  for (const specs of pathspecBatches(changes.tracked.filter((change) => change.regular).map(changePaths))) {
    const { stdout } = await git(repo, [...diffFlags, "--numstat", "-z", ...renameFlags, base, "--", ...specs]);
    for (const [path, count] of numstats(stdout)) counts.set(path, count);
  }
  const files = new Map<string, ArenaSlotFileStat>();
  for (const { path, status } of changes.tracked) {
    files.set(path, { path: path.slice(prefix.length), status, ...(counts.get(path) ?? zeroCounts) });
  }
  for (const { path, regular } of changes.untracked) {
    const previous = files.get(path);
    const count = regular ? numstats((await untrackedDiff(repo, path, ["--numstat", "-z"])).stdout).get(path) : undefined;
    files.set(path, {
      path: path.slice(prefix.length), status: previous ? "modified" : "untracked",
      additions: (previous?.additions ?? 0) + (count?.additions ?? 0), deletions: previous?.deletions ?? 0,
    });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function boundedDiff(diff: string, truncated: boolean): string {
  const bytes = Buffer.from(diff);
  if (!truncated && bytes.length <= MAX_DIFF_BYTES) return diff;
  let end = Math.min(bytes.length, MAX_DIFF_BYTES - Buffer.byteLength(DIFF_TRUNCATED));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + DIFF_TRUNCATED;
}

async function diffFor({ repo, changes }: Inspection, base: string, path?: string): Promise<string> {
  const groups = changes.tracked.filter((change) => change.regular).map(changePaths)
    .map((paths) => paths.filter((candidate) => path === undefined || candidate === path)).filter((paths) => paths.length);
  let diff = "";
  for (const specs of pathspecBatches(groups)) {
    const { stdout, truncated } = await git(repo, [
      ...diffFlags, ...patchFlags, ...renameFlags, base, "--", ...specs,
    ], { allowTruncation: true });
    diff += stdout.toString("utf8");
    if (truncated || Buffer.byteLength(diff) > MAX_DIFF_BYTES) return boundedDiff(diff, truncated);
  }
  for (const change of changes.untracked) {
    if (!change.regular || (path !== undefined && change.path !== path)) continue;
    const { stdout, truncated } = await untrackedDiff(repo, change.path, patchFlags, true);
    diff += stdout.toString("utf8");
    if (truncated || Buffer.byteLength(diff) > MAX_DIFF_BYTES) return boundedDiff(diff, truncated);
  }
  return diff;
}

async function originalText(repo: GitRepository, base: string, path: string): Promise<string | undefined> {
  const { stdout } = await git(repo, ["ls-tree", "--full-tree", "-z", base, "--", `:(top,literal)${path}`]);
  for (const entry of nulRecords(stdout)) {
    const tab = entry?.indexOf("\t") ?? -1;
    if (!entry || tab < 0 || entry.slice(tab + 1) !== path) continue;
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (type === "tree") return "";
    if (!mode || !/^100[0-7]{3}$/u.test(mode)) throw unsafeFile();
    if (!object || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(object)) throw new ArenaGitError();
    const blob = await git(repo, ["cat-file", "blob", object], { allowTruncation: true });
    if (blob.truncated || blob.stdout.length > MAX_TEXT_BYTES) return undefined;
    const text = decode(blob.stdout);
    return text?.includes("\0") ? undefined : text;
  }
  return "";
}

async function modifiedText(root: string, path: string): Promise<string | undefined> {
  const { stats } = await locate(root, path);
  if (!stats || stats.isDirectory()) return "";
  if (!isRegular(stats)) throw unsafeFile();
  try { return (await readText(root, path)).text; } catch (error) {
    if (error instanceof WorkspaceError && (error.code === "LIMIT" || error.code === "INVALID_INPUT")) return undefined;
    throw error;
  }
}

type Wip = { patch: string; files: { path: string; source: RegularFile }[] };

async function captureWip(project: Project, base: string, patch: string): Promise<Wip> {
  const { repo, prefix } = project;
  const { tracked, untracked } = await scanChanges(repo, prefix, base);
  const output = await open(patch, "wx", 0o600);
  try {
    for (const specs of pathspecBatches(tracked.filter((change) => change.regular).map(changePaths))) {
      await gitWithFile(repo, [...diffFlags, ...patchFlags, ...renameFlags, "--binary", base, "--", ...specs], "ignore", output.fd);
    }
  } finally {
    await output.close();
  }
  const files: Wip["files"] = [];
  for (const { path, regular } of untracked) {
    if (!regular) continue;
    const source = await locate(repo.root, path);
    if (isRegular(source.stats) && source.stats.size <= MAX_TEXT_BYTES) {
      files.push({ path, source: { path: source.path, stats: source.stats } });
    }
  }
  return { patch, files };
}

async function seedWorktree(repo: GitRepository, wip: Wip): Promise<void> {
  const input = await open(wip.patch, "r");
  try {
    await gitWithFile(repo, ["apply", "--allow-empty", "--binary", "-"], input.fd, "ignore");
  } finally {
    await input.close();
  }
  for (const { path, source } of wip.files) {
    await ensureParents(repo.root, safePath(path).slice(0, -1));
    const target = await locate(repo.root, path);
    if (target.stats) throw changedOnDisk();
    const temporary = await temporaryCopy(source, dirname(target.path));
    try { await rename(temporary, target.path); } finally { await unlink(temporary).catch(() => undefined); }
  }
}

function pathsToApply({ tracked, untracked }: Changes): Map<string, boolean> {
  const paths = new Map<string, boolean>();
  for (const change of [...tracked, ...untracked]) {
    if (!change.regular) throw unsafeFile();
    if (change.previous && !paths.has(change.previous)) paths.set(change.previous, false);
    paths.set(change.path, change.status !== "deleted");
  }
  return paths;
}

type WorkspaceEdit = { relative: string; target: Location; source?: RegularFile };
type EditJournal = { backups: string; undo: (() => Promise<void>)[] };

async function workspaceEdits(project: Project, slot: GitRepository, paths: Map<string, boolean>): Promise<WorkspaceEdit[]> {
  const edits: WorkspaceEdit[] = [];
  for (const [path, present] of paths) {
    const localPath = path.slice(project.prefix.length);
    const target = await locate(project.workspacePath, localPath);
    if (target.stats && !target.stats.isDirectory() && !isRegular(target.stats)) throw unsafeFile();
    const source = await locate(slot.root, path);
    if (present && !isRegular(source.stats)) throw changedOnDisk();
    edits.push({ relative: localPath, target, source: present ? { path: source.path, stats: source.stats! } : undefined });
  }
  return edits;
}

async function replaceFile(root: string, relative: string, source: RegularFile | undefined, target: Location) {
  const temporary = source && await temporaryCopy(source, dirname(target.path));
  try {
    if (!sameFile(target.stats, (await locate(root, relative)).stats)) throw changedOnDisk();
    if (temporary) await rename(temporary, target.path);
    else await unlink(target.path);
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}

async function removeEmptyDirectories(root: string, replacement: WorkspaceEdit, edits: WorkspaceEdit[], journal: EditJournal) {
  const directory = replacement.relative;
  const dirs = new Set([directory]);
  for (const edit of edits) {
    if (edit.source || !edit.relative.startsWith(`${directory}/`)) continue;
    for (let slash = edit.relative.lastIndexOf("/"); slash > directory.length; slash = edit.relative.lastIndexOf("/", slash - 1)) {
      dirs.add(edit.relative.slice(0, slash));
    }
  }
  for (const path of [...dirs].sort((a, b) => b.length - a.length)) {
    const current = await locate(root, path);
    if (!current.stats) continue;
    if (!current.stats.isDirectory() || path === directory && (current.stats.ino !== replacement.target.stats?.ino ||
      current.stats.dev !== replacement.target.stats?.dev)) throw changedOnDisk();
    try { await rmdir(current.path); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOTEMPTY") throw error;
      throw new WorkspaceError("CONFLICT", "An arena change would replace a folder containing other files.");
    }
    const mode = current.stats.mode & 0o777;
    journal.undo.push(async () => {
      if ((await locate(root, path)).stats) throw changedOnDisk();
      await mkdir(current.path, { mode });
    });
  }
}

async function applyWorkspaceEdit(root: string, edit: WorkspaceEdit, edits: WorkspaceEdit[], journal: EditJournal) {
  await requireCanonical(root);
  const { relative, source } = edit;
  let { target } = edit;
  if (!source && (!target.stats || target.stats.isDirectory())) return;
  if (target.stats?.isDirectory()) {
    await removeEmptyDirectories(root, edit, edits, journal);
    target = { path: target.path };
  }
  if (source) await ensureParents(root, safePath(relative).slice(0, -1), (path) => journal.undo.push(() => rmdir(path)));
  const backup = isRegular(target.stats) &&
    await temporaryCopy({ path: target.path, stats: target.stats }, journal.backups);
  await replaceFile(root, relative, source, target);
  journal.undo.push(async () => {
    const current = await locate(root, relative);
    if (current.stats && !isRegular(current.stats)) throw unsafeFile();
    if (backup) await replaceFile(root, relative, { path: backup, stats: await lstat(backup) }, current);
    else if (current.stats) await unlink(current.path);
  });
}

async function applyWorkspaceEdits(root: string, edits: WorkspaceEdit[], save: () => void): Promise<void> {
  const journal: EditJournal = { backups: await mkdtemp(join(tmpdir(), "uya-arena-backup-")), undo: [] };
  try {
    // Deletions can make room for an added file or an added directory at the same path.
    const ordered = [...edits.filter(({ source }) => !source), ...edits.filter(({ source }) => source)];
    for (const edit of ordered) await applyWorkspaceEdit(root, edit, edits, journal);
    save();
  } catch (error) {
    let rollbackFailed = false;
    for (const undo of journal.undo.reverse()) {
      try { await requireCanonical(root); await undo(); } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new WorkspaceError("IO", "The arena changes could not be fully rolled back.");
    throw error;
  } finally {
    await rm(journal.backups, { force: true, recursive: true });
  }
}

async function winnerBranch(repo: GitRepository, name: string): Promise<string> {
  if (typeof name !== "string" || name.length > 256 || !name || name === "HEAD" || name.startsWith("-") ||
      /[\s\u0000-\u001f\u007f]/u.test(name) || /^uya-arena(?:\/|$)/iu.test(name)) {
    throw new WorkspaceError("INVALID_INPUT", "Invalid Git branch name for an arena winner.");
  }
  const ref = `refs/heads/${name}`;
  await git(repo, ["check-ref-format", ref]).catch((error: unknown) => {
    if (!gitExit(error, 1)) throw error;
    throw new WorkspaceError("INVALID_INPUT", "Invalid Git branch name for an arena winner.");
  });
  const exists = await git(repo, ["show-ref", "--verify", "--quiet", ref]).then(() => true, (error: unknown) => {
    if (!gitExit(error, 1)) throw error;
    return false;
  });
  if (exists) throw new WorkspaceError("CONFLICT", "The arena winner branch already exists.");
  return ref;
}

async function commitIdentity(repo: GitRepository): Promise<string[]> {
  const flags: string[] = [];
  for (const [key, fallback] of [["user.name", "Uya Arena"], ["user.email", "uya@local"]] as const) {
    const name = await gitLine(repo, ["config", "--get", key]).catch((error: unknown) => {
      if (!gitExit(error, 1)) throw error;
      return "";
    });
    if (!name.trim()) flags.push("-c", `${key}=${fallback}`);
  }
  return flags;
}

async function commitWinner(repo: GitRepository, base: string, paths: Map<string, boolean>): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "uya-arena-index-"));
  const options = { index: join(temporary, "index") };
  try {
    // Build from the arena base so unrelated staged files and slot commits cannot carry protected changes into the winner.
    await git(repo, ["read-tree", base], options);
    const input = [...paths.keys()].map(exactPathspec).join("\0") + "\0";
    await git(repo, ["add", "--all", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], { ...options, input });
    await checkWinnerIndex(repo, base, paths, options);
    const tree = await gitLine(repo, ["write-tree"], options);
    const identity = await commitIdentity(repo);
    return await gitLine(repo, [...identity, "commit-tree", tree, "-p", base, "-m", "Apply arena winner"], options);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function checkWinnerIndex(repo: GitRepository, base: string, paths: Map<string, boolean>, options: GitOptions) {
  const { stdout } = await git(repo, [
    ...diffFlags, "--ignore-submodules=none", "--cached", "--raw", "-z", "--no-renames", base, "--",
  ], options);
  const records = nulRecords(stdout);
  for (const header of records) {
    const changedPath = records.next().value;
    const entry = /^:([0-7]{6}) ([0-7]{6}) /u.exec(header ?? "");
    const regular = entry?.slice(1).every((mode) => /^(?:000000|100[0-7]{3})$/u.test(mode));
    // Staging a file can implicitly remove conflicting entries under the same path.
    if (!regular || changedPath === undefined || paths.get(changedPath) !== (entry?.[2] !== "000000")) {
      throw new WorkspaceError("CONFLICT", "The winner would also change files outside the arena selection.");
    }
  }
}

async function applyBranch(repo: GitRepository, arena: ArenaSummary, slot: ArenaSlot, paths: Map<string, boolean>,
  branchName: string, save: () => void): Promise<void> {
  const ref = await winnerBranch(repo, branchName);
  const slotRef = `refs/heads/${slot.branch}`;
  const oldCommit = await gitLine(repo, ["rev-parse", "--verify", slotRef]);
  const commit = await commitWinner(repo, arena.baseCommit, paths);
  await git(repo, ["update-ref", "--stdin"], { input: `update ${slotRef} ${commit} ${oldCommit}\ncreate ${ref} ${commit}\n` });
  try { save(); } catch (error) {
    await git(repo, ["update-ref", "--stdin"], { input: `update ${slotRef} ${oldCommit} ${commit}\ndelete ${ref} ${commit}\n` });
    throw error;
  }
}

function arenaSlot(arena: ArenaSummary, id: string): ArenaSlot {
  const slot = arena.slots.find((item) => item.id === id);
  if (!slot) throw new RpcError(-32004, "Arena slot not found.");
  return slot;
}

function repoHash(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

function slotBranch(arenaId: string, slotId: string): string {
  return `uya-arena/${arenaId}/${slotId}`;
}

async function arenaBranches(repo: GitRepository, id: string): Promise<string[]> {
  const names = await gitLine(repo, ["for-each-ref", "--format=%(refname:lstrip=2)", `refs/heads/uya-arena/${id}/`]);
  return names.split("\n").filter(Boolean);
}

async function baseOf(repo: GitRepository): Promise<string> {
  return gitLine(repo, ["rev-parse", "--verify", "HEAD"]).catch((error: unknown) => {
    if (!gitExit(error, 128)) throw error;
    throw new WorkspaceError("CONFLICT", "Create an initial Git commit before starting a Worktree Arena.");
  });
}

export class WorktreeArenaManager {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly store: ArenaStore,
    private readonly checkpoints?: ArenaCheckpointHook) {}

  cleanupOrphans(): Promise<void> {
    return this.serialize(async () => {
      const worktrees = await this.worktreesRoot().catch(() => undefined);
      if (!worktrees) return;
      for (const repo of await readdir(worktrees, { withFileTypes: true }).catch(() => [])) {
        if (!repo.isDirectory()) continue;
        const parent = join(worktrees, repo.name);
        for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory()) continue;
          try {
            const arena = this.store.getArena(entry.name);
            if (arena?.status === "active") continue;
            const root = join(parent, entry.name);
            if (arena && repoHash(arena.workspacePath) === repo.name) await this.removeArena(arena);
            else await rm(root, { recursive: true, force: true });
          } catch { /* A stale or inaccessible directory must not prevent startup. */ }
        }
        await rmdir(parent).catch(() => undefined);
      }
    });
  }

  create(workspacePath: string, options: { prompt: string; slots: ArenaSlotInput[]; includeDirty?: boolean }): Promise<ArenaSummary> {
    return this.serialize(async () => {
      if (options.slots.length < 2 || options.slots.length > 6) {
        throw new WorkspaceError("INVALID_INPUT", "Use between 2 and 6 arena slots.");
      }
      const project = await projectFor(workspacePath);
      const { repo, prefix } = project;
      const baseCommit = await baseOf(repo);
      const baseBranch = await gitLine(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      if ((await arenaBranches(repo, id)).length) throw new WorkspaceError("CONFLICT", "The arena branch namespace already exists.");
      const parent = (await this.repoDirectory(project.workspacePath, true))!;
      const root = join(parent, id);
      await mkdir(root, { mode: 0o700 });
      const slots: ArenaSlot[] = options.slots.map((input, index) => {
        const slotId = `slot-${index + 1}`;
        return {
          ...input, id: slotId, arenaId: id, branch: slotBranch(id, slotId), worktreePath: join(root, slotId, prefix),
          status: "ready", filesChanged: 0, additions: 0, deletions: 0, files: [],
        };
      });
      const arena: ArenaSummary = {
        id, workspacePath: project.workspacePath, baseBranch, baseCommit, prompt: options.prompt,
        createdAt: Date.now(), status: "active", slots,
      };
      try {
        await this.createSlots(project, arena, root, options.includeDirty !== false);
        this.store.saveArena(arena);
        return arena;
      } catch (error) {
        await this.removeArena(arena, repo).catch(() => undefined);
        throw error;
      }
    });
  }

  attachRun(arenaId: string, slotId: string, runId: string): ArenaSummary | undefined {
    const arena = this.store.getArena(arenaId);
    if (arena?.status !== "active") return undefined;
    const slot = arena.slots.find(({ id }) => id === slotId);
    if (!slot || slot.status === "discarded" || slot.status === "applied") return undefined;
    return this.saveSlot(arena, { ...slot, runId, status: "running" });
  }

  refreshSlot(arenaId: string, slotId: string, nextStatus?: ArenaSlot["status"]): Promise<ArenaSummary> {
    return this.serialize(async () => (await this.refresh(arenaId, slotId, nextStatus)).arena);
  }

  get(arenaId: string, refresh = true): Promise<ArenaSummary> {
    return this.serialize(async () => {
      const arena = this.requireArena(arenaId);
      if (!refresh || arena.status !== "active") return arena;
      for (const slot of arena.slots) {
        if (slot.status === "discarded" || slot.status === "applied") continue;
        try { await this.refresh(arenaId, slot.id); } catch (error) {
          if (!(error instanceof WorkspaceError && error.code === "NOT_FOUND")) throw error;
        }
      }
      return this.requireArena(arenaId);
    });
  }

  list(workspacePath?: string, limit = 20): ArenaSummary[] {
    return this.store.listArenas(workspacePath, limit);
  }

  slotDiff(arenaId: string, slotId: string, path?: string): Promise<GitDiffResult> {
    return this.serialize(async () => {
      if (path !== undefined) safePath(path);
      const arena = this.requireArena(arenaId);
      const inspection = await this.inspect(arena, arenaSlot(arena, slotId));
      const { repo, prefix, changes } = inspection;
      if (path === undefined) return { staged: false, diff: await diffFor(inspection, arena.baseCommit) };
      const gitPath = prefix + path;
      safePath(gitPath);
      if (changes.blocked.has(gitPath)) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
      const [original, modified, diff] = await Promise.all([
        originalText(repo, arena.baseCommit, gitPath), modifiedText(repo.root, gitPath),
        diffFor(inspection, arena.baseCommit, gitPath),
      ]);
      return { path, staged: false, diff, original, modified };
    });
  }

  recordVerify(arenaId: string, slotId: string, verify: ArenaVerifySummary): ArenaSlot {
    const arena = this.requireArena(arenaId);
    const slot = { ...arenaSlot(arena, slotId), verify };
    this.saveSlot(arena, slot);
    return slot;
  }

  apply(arenaId: string, slotId: string,
    options: { mode: "workspace" | "branch"; branchName?: string; cleanup?: boolean }): Promise<ArenaApplyResult> {
    return this.serialize(async () => {
      if (options.mode !== "branch" && options.mode !== "workspace") {
        throw new WorkspaceError("INVALID_INPUT", "Unknown arena apply mode.");
      }
      if (this.requireArena(arenaId).status !== "active") throw new WorkspaceError("CONFLICT", "This arena is no longer active.");
      const { arena, inspection } = await this.refresh(arenaId, slotId);
      const slot = arenaSlot(arena, slotId);
      if (!slot.files.length) throw new WorkspaceError("CONFLICT", "This arena slot has no file changes to apply.");
      await requireCanonical(arena.workspacePath);
      const project = await projectFor(arena.workspacePath);
      const paths = pathsToApply(inspection.changes);
      const result: ArenaApplyResult = {
        arenaId, slotId, mode: options.mode, appliedFiles: [...paths.keys()].map((path) => path.slice(project.prefix.length)),
      };
      const save = () => {
        const latest = this.requireArena(arenaId);
        this.saveSlot({ ...latest, status: "applied", appliedSlotId: slotId }, { ...arenaSlot(latest, slotId), status: "applied" });
      };
      if (options.mode === "branch") {
        result.branchName = options.branchName ?? `uya-arena-winner-${arenaId.slice(0, 6)}`;
        await applyBranch(inspection.repo, arena, slot, paths, result.branchName, save);
      } else {
        const edits = await workspaceEdits(project, inspection.repo, paths);
        const checkpoint = await this.checkpoints?.createCheckpoint(project.workspacePath,
          `Before applying arena winner (${slot.providerName})`);
        if (checkpoint) result.checkpointId = checkpoint.id;
        await applyWorkspaceEdits(project.workspacePath, edits, save);
      }
      if (options.cleanup !== false) await this.removeArena(arena, project.repo).catch(() => undefined);
      return result;
    });
  }

  discard(arenaId: string): Promise<void> {
    return this.serialize(async () => {
      await this.removeArena(this.requireArena(arenaId));
      const arena = this.requireArena(arenaId);
      this.store.saveArena({
        ...arena, status: "discarded", slots: arena.slots.map((slot) => slot.status === "applied"
          ? slot : { ...slot, status: "discarded" }),
      });
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireArena(id: string): ArenaSummary {
    const arena = this.store.getArena(id);
    if (!arena) throw new RpcError(-32004, "Arena not found.");
    return arena;
  }

  private saveSlot(arena: ArenaSummary, slot: ArenaSlot): ArenaSummary {
    const updated = { ...arena, slots: arena.slots.map((previous) => previous.id === slot.id ? slot : previous) };
    this.store.saveArena(updated);
    return updated;
  }

  private async worktreesRoot(create = false): Promise<string | undefined> {
    const data = resolve(this.dataDir);
    if (create) await mkdir(data, { recursive: true, mode: 0o700 });
    try { return await directoryAt(await canonicalDirectory(data), "worktrees", create); } catch (error) {
      if (!create && error instanceof WorkspaceError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }

  private async repoDirectory(workspacePath: string, create = false): Promise<string | undefined> {
    const root = await this.worktreesRoot(create);
    return root && directoryAt(root, repoHash(workspacePath), create);
  }

  private async arenaDirectory(arena: ArenaSummary): Promise<string | undefined> {
    if (!/^[0-9a-f]{16}$/u.test(arena.id)) throw new WorkspaceError("INVALID_INPUT", "Invalid arena ID.");
    const parent = await this.repoDirectory(arena.workspacePath);
    return parent && directoryAt(parent, arena.id);
  }

  private async createSlots(project: Project, arena: ArenaSummary, root: string, includeDirty: boolean): Promise<void> {
    const patch = join(root, "initial.patch");
    try {
      const wip = includeDirty ? await captureWip(project, arena.baseCommit, patch) : undefined;
      for (const [index, slot] of arena.slots.entries()) {
        const checkout = join(root, slot.id);
        await git(project.repo, ["worktree", "add", "-b", slot.branch, "--", checkout, arena.baseCommit]);
        if (wip) await seedWorktree({ root: checkout, overrides: project.repo.overrides }, wip);
        if (project.prefix) await ensureParents(checkout, safePath(project.prefix.slice(0, -1)));
        if (wip && index === 0) {
          const inspection = await this.inspect(arena, slot);
          const stats = await fileStats(inspection, arena.baseCommit);
          for (const item of arena.slots) Object.assign(item, slotStats(stats.map((file) => ({ ...file }))));
        }
      }
    } finally {
      if (includeDirty) await unlink(patch).catch(() => undefined);
    }
  }

  private async inspect(arena: ArenaSummary, slot: ArenaSlot): Promise<Inspection> {
    const root = await this.arenaDirectory(arena);
    if (!root) throw new WorkspaceError("NOT_FOUND", "The arena worktree no longer exists.");
    if (!/^slot-[1-6]$/u.test(slot.id) || slot.branch !== slotBranch(arena.id, slot.id) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(arena.baseCommit)) {
      throw new WorkspaceError("INVALID_INPUT", "Invalid arena slot.");
    }
    const checkout = join(root, slot.id);
    await requireCanonical(checkout);
    const project = await projectFor(arena.workspacePath);
    if (slot.worktreePath !== join(checkout, project.prefix) || project.workspacePath !== arena.workspacePath) {
      throw new WorkspaceError("FORBIDDEN", "The arena worktree has moved.");
    }
    const repo = await repository(checkout);
    const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const [topLevel, common, expected] = await Promise.all([
      gitLine(repo, ["rev-parse", "--show-toplevel"]), gitLine(repo, commonArgs), gitLine(project.repo, commonArgs),
    ]);
    if (resolve(topLevel) !== checkout || resolve(common) !== resolve(expected)) {
      throw new WorkspaceError("FORBIDDEN", "The arena worktree has moved.");
    }
    return { repo, prefix: project.prefix, changes: await scanChanges(repo, project.prefix, arena.baseCommit) };
  }

  private async refresh(arenaId: string, slotId: string, nextStatus?: ArenaSlot["status"]) {
    const arena = this.requireArena(arenaId);
    const inspection = await this.inspect(arena, arenaSlot(arena, slotId));
    const files = await fileStats(inspection, arena.baseCommit);
    const latest = this.requireArena(arenaId);
    const slot = arenaSlot(latest, slotId);
    return { arena: this.saveSlot(latest, { ...slot, ...slotStats(files), status: nextStatus ?? slot.status }), inspection };
  }

  private async removeArena(arena: ArenaSummary, repo?: GitRepository): Promise<void> {
    const root = await this.arenaDirectory(arena);
    if (!repo) {
      repo = await requireCanonical(arena.workspacePath).then(() => projectFor(arena.workspacePath))
        .then((project) => project.repo).catch(() => undefined);
    }
    if (root) {
      for (const slot of arena.slots) {
        if (!/^slot-[1-6]$/u.test(slot.id)) continue;
        const path = join(root, slot.id);
        const stats = await statIfPresent(path);
        if (repo && (!stats || stats.isDirectory())) {
          await git(repo, ["worktree", "remove", "--force", "--force", "--", path]).catch(() => undefined);
        }
      }
      await rm(root, { recursive: true, force: true });
      await rmdir(dirname(root)).catch(() => undefined);
    }
    if (repo) {
      await git(repo, ["worktree", "prune", "--expire", "now"]);
      const branches = await arenaBranches(repo, arena.id);
      if (branches.length) await git(repo, ["branch", "-D", "--", ...branches]);
    }
  }
}

function slotStats(files: ArenaSlotFileStat[]) {
  return {
    files, filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}
