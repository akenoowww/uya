import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat, mkdir, open, opendir, realpath, rename, rm, unlink, writeFile, type FileHandle,
} from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CheckpointRestoreResult, CheckpointSummary } from "@ide/protocol";
import * as z from "zod";
import type { History } from "./history";
import { RpcError } from "./validation";
import { canonicalDirectory, isProtectedRelativePath, relativePath, WorkspaceError } from "./workspace-files";

const MIB = 1024 * 1024;
const MAX_GIT_FILE_BYTES = 2 * MIB;
const KEEP_CHECKPOINTS = 30;
const checkpointId = /^[A-Za-z0-9_-]{1,100}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const excludedDirectories = new Set(["node_modules", ".next", ".venv", "__pycache__", "target", "dist", "build"]);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function allowedPath(path: string): boolean {
  try {
    return !isProtectedRelativePath(path) && !path.split("/").some((part) => part.startsWith(".ide-save-"));
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "INVALID_INPUT") return false;
    throw error;
  }
}

const fileSchema = z.object({ path: z.string().refine(allowedPath), mode: z.int().min(0).max(0o777) });
const manifestSchema = z.object({
  git: z.boolean(),
  headCommit: z.string().regex(objectId).optional(),
  knownPaths: z.array(fileSchema.shape.path),
  ignoredPaths: z.array(z.string().refine((path) => !path || allowedPath(path.endsWith("/") ? path + "entry" : path))),
  files: z.array(fileSchema.extend({ hash: z.string().regex(sha256) })).max(300),
  cleanFiles: z.array(fileSchema),
});
type Manifest = z.infer<typeof manifestSchema>;
type Workspace = { root: string; dataDir: string };
type Repository = { root: string; prefix: string; headCommit?: string };
type Entry = { path: string; stats?: Stats; actualPath?: string };
type RegularFile = Entry & { stats: Stats };
type RestoreFile = { file: { path: string; mode: number }; target: Entry; source: Buffer | string };

function invalidCheckpoint() {
  return new WorkspaceError("IO", "Checkpoint data is missing or invalid.");
}

function changedWorkspace() {
  return new WorkspaceError("CONFLICT", "A workspace file or folder changed during the checkpoint operation.");
}

function unsafeFile() {
  return new WorkspaceError("FORBIDDEN", "Checkpoint targets must be regular files without links.");
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code;
}

function withinWorkspace(workspace: Workspace, path: string, directory = false): boolean {
  if (!allowedPath(directory ? path + "/entry" : path)) return false;
  const absolute = join(workspace.root, path);
  const snapshots = join(workspace.dataDir, "checkpoints");
  const sqlite = join(workspace.dataDir, "history.sqlite");
  return absolute !== snapshots && !absolute.startsWith(snapshots + sep) &&
    absolute !== sqlite && !absolute.startsWith(sqlite + "-");
}

function actualRelative(root: string, entry: Entry): string {
  return relative(root, entry.actualPath ?? entry.path).split(sep).join("/");
}

async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function directoryAt(path: string) {
  if (!(await statIfPresent(path))?.isDirectory() || await realpath(path) !== path) throw unsafeFile();
}

async function entryAt(root: string, path: string, createParents = false): Promise<Entry> {
  if (!allowedPath(path)) throw unsafeFile();
  const parts = relativePath(path);
  const absolute = join(root, ...parts);
  let parent = root;
  await directoryAt(parent);
  for (const part of parts.slice(0, -1)) {
    const next = join(parent, part);
    const stats = await statIfPresent(next);
    if (stats && !stats.isDirectory()) throw unsafeFile();
    if (!stats) {
      if (!createParents) return { path: absolute };
      await directoryAt(parent);
      await mkdir(next, { mode: 0o755 });
    }
    parent = next;
  }
  await directoryAt(parent);
  const stats = await statIfPresent(absolute);
  if (!stats?.isFile()) return { path: absolute, stats };
  const actualPath = await realpath(absolute);
  if (dirname(actualPath) !== parent || !allowedPath([...parts.slice(0, -1), basename(actualPath)].join("/"))) {
    throw unsafeFile();
  }
  return { path: absolute, stats, actualPath };
}

async function observedEntry(root: string, path: string): Promise<Entry | undefined> {
  try {
    return await entryAt(root, path);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "FORBIDDEN") return undefined;
    throw error;
  }
}

function isRegular(entry: Entry | undefined): entry is RegularFile {
  return !!entry?.stats?.isFile() && entry.stats.nlink === 1;
}

function sameVersion(before: Stats | undefined, after: Stats | undefined): boolean {
  if (!before || !after) return before === after;
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.nlink === after.nlink &&
    before.mode === after.mode && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readFileVersion<T>(entry: RegularFile, read: (handle: FileHandle) => Promise<T>): Promise<T> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  await directoryAt(dirname(entry.path));
  const handle = await open(entry.path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameVersion(entry.stats, before)) throw changedWorkspace();
    const result = await read(handle);
    if (!sameVersion(before, await handle.stat())) throw changedWorkspace();
    return result;
  } finally {
    await handle.close();
  }
}

function readBytes(entry: RegularFile): Promise<Buffer> {
  return readFileVersion(entry, async (handle) => {
    const bytes = Buffer.alloc(entry.stats.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changedWorkspace();
      offset += bytesRead;
    }
    return bytes;
  });
}

function fileDigest(entry: RegularFile, gitObject?: string): Promise<string> {
  return readFileVersion(entry, async (handle) => {
    const hash = createHash(gitObject?.length === 40 ? "sha1" : "sha256");
    if (gitObject) hash.update("blob " + entry.stats.size + "\0");
    const chunk = Buffer.alloc(Math.min(entry.stats.size, 64 * 1024));
    for (let offset = 0; offset < entry.stats.size;) {
      const length = Math.min(chunk.length, entry.stats.size - offset);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (!bytesRead) throw changedWorkspace();
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest("hex");
  });
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const gitFlags = [
  "--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false",
  "-c", "core.hooksPath=" + devNull, "-c", "maintenance.auto=false",
];

class CheckpointGitError extends WorkspaceError {
  constructor(readonly exitCode?: number | string | null, readonly notRepository = false) {
    super("IO", "Git could not read the workspace for this checkpoint.");
  }
}

function gitOptions(root: string) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", LC_ALL: "C" });
  return { cwd: root, env, timeout: 8000 };
}

function gitRead(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", [...gitFlags, ...args], {
      ...gitOptions(root), encoding: "buffer", maxBuffer: 8 * MIB,
    }, (error, stdout, stderr) => {
      if (error) reject(new CheckpointGitError(error.code, /^fatal: not a git repository\b/u.test(stderr.toString())));
      else resolve(stdout);
    });
  });
}

function gitWriteBlob(root: string, object: string, output: FileHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...gitFlags, "cat-file", "blob", object], {
      ...gitOptions(root), stdio: ["ignore", output.fd, "ignore"],
    });
    child.once("error", () => reject(new CheckpointGitError()));
    child.once("close", (code) => code === 0 ? resolve() : reject(new CheckpointGitError(code)));
  });
}

function* gitRecords(output: Buffer): Generator<string | undefined, void, unknown> {
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    try {
      yield decoder.decode(output.subarray(start, end));
    } catch (error) {
      // Paths that cannot round-trip through the workspace API are out of scope.
      if (!(error instanceof TypeError)) throw error;
      yield undefined;
    }
    start = end + 1;
  }
}

async function gitHead(root: string): Promise<string | undefined> {
  try {
    const head = (await gitRead(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).toString("ascii").trim();
    if (!objectId.test(head)) throw new CheckpointGitError();
    return head;
  } catch (error) {
    if (error instanceof CheckpointGitError && error.exitCode === 1) return undefined;
    throw error;
  }
}

async function repositoryAt(root: string): Promise<Repository | undefined> {
  let output: Buffer;
  try {
    output = await gitRead(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  } catch (error) {
    if (error instanceof CheckpointGitError && error.notRepository) return undefined;
    if (!(error instanceof CheckpointGitError) || error.exitCode !== "ENOENT") throw error;
    // A plain directory can still use checkpoints on a machine without Git.
    for (let path = root; ; path = dirname(path)) {
      if (await statIfPresent(join(path, ".git"))) throw error;
      if (path === dirname(path)) return undefined;
    }
  }
  const [inside, prefix] = decoder.decode(output).split(/\r?\n/u, 2);
  if (inside === "false") throw new WorkspaceError("INVALID_INPUT", "Choose a Git working directory.");
  if (inside !== "true" || prefix === undefined || (prefix && !allowedPath(prefix + "entry"))) {
    throw new CheckpointGitError();
  }
  return { root, prefix, headCommit: await gitHead(root) };
}

function gitWorkspacePath(workspace: Workspace, repo: Repository, gitPath: string): string | undefined {
  if (!gitPath.startsWith(repo.prefix) || !allowedPath(gitPath)) return undefined;
  const path = gitPath.slice(repo.prefix.length);
  return withinWorkspace(workspace, path) ? path : undefined;
}

async function gitTree(repo: Repository, head: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  for (const record of gitRecords(await gitRead(repo.root, ["ls-tree", "-r", "-z", "--full-name", head, "--", "."]))) {
    if (record === undefined) continue;
    const row = /^100[0-7]{3} blob ([a-f0-9]+)\t/u.exec(record);
    if (row && objectId.test(row[1])) tree.set(record.slice(row[0].length), row[1]);
  }
  return tree;
}

async function gitPaths(repo: Repository, ignored = false): Promise<string[]> {
  const output = await gitRead(repo.root, [
    "ls-files", "-z", "--full-name", "--others", "--exclude-standard",
    ...(ignored ? ["--ignored", "--directory"] : ["--cached"]), "--", ".",
  ]);
  return [...new Set(gitRecords(output))].filter((path) => path !== undefined);
}

async function ignoredGitPaths(workspace: Workspace, repo: Repository): Promise<string[]> {
  // Record ignored names without copying their contents. Git can collapse whole ignored directories.
  const paths: string[] = [];
  for (const candidate of await gitPaths(repo, true)) {
    const directory = candidate.endsWith("/");
    const path = gitWorkspacePath(workspace, repo, directory ? candidate + "entry" : candidate);
    if (path) paths.push(directory ? path.slice(0, -"entry".length) : path);
  }
  return paths;
}

async function filterOverrides(root: string): Promise<string[]> {
  let output: Buffer;
  try {
    output = await gitRead(root, [
      "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$",
    ]);
  } catch (error) {
    if (error instanceof CheckpointGitError && error.exitCode === 1) return [];
    throw error;
  }
  return [...new Set(gitRecords(output))].flatMap((name) => {
    if (!name || /[=\u0000-\u001f\u007f]/u.test(name)) throw new CheckpointGitError();
    return ["-c", name + (name.endsWith(".required") ? "=false" : "=")];
  });
}

async function protectedRenameTargets(repo: Repository, head = repo.headCommit): Promise<Set<string>> {
  // Compare index entries using exact rename detection. This does not read working-tree contents.
  const output = await gitRead(repo.root, [
    "diff", "--cached", "--name-status", "-z", "--find-renames=100%", "--no-relative",
    "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...(head ? [head] : []), "--",
  ]);
  const blocked = new Set<string>();
  const records = gitRecords(output);
  for (const status of records) {
    const source = records.next().value;
    if (!status || !/^[RC]/u.test(status)) continue;
    const destination = records.next().value;
    if (destination && (!source || !allowedPath(source))) blocked.add(destination);
  }
  return blocked;
}

async function gitChanges(
  workspace: Workspace, repo: Repository, paths: Iterable<string>, blocked: Set<string>,
): Promise<Set<string>> {
  // Filter overrides suppress external clean commands, including required filters.
  const overrides = await filterOverrides(repo.root);
  const exclusions: string[] = [];
  for (const path of new Set(paths)) {
    if (blocked.has(path) || !gitWorkspacePath(workspace, repo, path)) exclusions.push(":(top,literal,exclude)" + path);
  }
  const output = await gitRead(repo.root, [
    ...overrides, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames",
    "--ignore-submodules=all", "--", ".", ...exclusions,
  ]);
  // With rename detection disabled, a move is a delete and an addition.
  return new Set([...gitRecords(output)].filter((record) => record !== undefined).map((record) => record.slice(3)));
}

async function gitCapture(workspace: Workspace, repo: Repository) {
  const tree = repo.headCommit ? await gitTree(repo, repo.headCommit) : new Map<string, string>();
  const tracked = await gitPaths(repo);
  const blocked = await protectedRenameTargets(repo);
  const changes = await gitChanges(workspace, repo, [...tracked, ...tree.keys()], blocked);
  return { tree, blocked, changes, paths: new Set([...tracked, ...tree.keys(), ...changes]) };
}

async function* directoryPaths(workspace: Workspace): AsyncGenerator<string> {
  const folders = [""];
  while (folders.length > 0) {
    const folder = folders.pop()!;
    const absolute = join(workspace.root, folder);
    await directoryAt(absolute);
    for await (const entry of await opendir(absolute)) {
      const path = folder ? folder + "/" + entry.name : entry.name;
      if (excludedDirectories.has(entry.name.toLowerCase()) ||
        !withinWorkspace(workspace, path, entry.isDirectory())) continue;
      if (entry.isDirectory()) folders.push(path);
      else yield path;
    }
  }
}

async function captureManifest(workspace: Workspace, blobs: string): Promise<Manifest> {
  const repo = await repositoryAt(workspace.root);
  const git = repo ? await gitCapture(workspace, repo) : undefined;
  const paths = git?.paths ?? directoryPaths(workspace);
  const manifest: Manifest = {
    git: !!repo, headCommit: repo?.headCommit, knownPaths: [], files: [], cleanFiles: [],
    ignoredPaths: repo ? await ignoredGitPaths(workspace, repo) : [],
  };
  const known = new Set<string>();
  const hashes = new Set<string>();
  const maxFiles = repo ? 200 : 300;
  const maxTotal = (repo ? 32 : 16) * MIB;
  let total = 0;
  for await (const candidate of paths) {
    if (git?.blocked.has(candidate)) continue;
    const path = repo ? gitWorkspacePath(workspace, repo, candidate) : candidate;
    if (!path) continue;
    const entry = await observedEntry(workspace.root, path);
    if (!entry?.stats || entry.stats.isDirectory()) continue;
    const existingPath = actualRelative(workspace.root, entry);
    if (known.has(existingPath) || !withinWorkspace(workspace, existingPath)) continue;
    if (repo && git?.blocked.has(repo.prefix + existingPath)) continue;
    known.add(existingPath);
    if (!isRegular(entry)) continue;
    const file = { path: existingPath, mode: entry.stats.mode & 0o777 };
    const object = git?.tree.get(candidate);
    // Clean Git entries can still have different raw bytes, e.g. a CRLF checkout.
    if (object && path === existingPath && !git?.changes.has(candidate) && await fileDigest(entry, object) === object) {
      manifest.cleanFiles.push(file);
      continue;
    }
    total += entry.stats.size;
    if (manifest.files.length >= maxFiles || total > maxTotal || (repo && entry.stats.size > MAX_GIT_FILE_BYTES)) {
      throw new WorkspaceError("LIMIT", "This workspace exceeds the checkpoint snapshot limits.");
    }
    const bytes = await readBytes(entry);
    const hash = digest(bytes);
    if (!hashes.has(hash)) await writeFile(join(blobs, hash), bytes, { mode: 0o600, flag: "wx" });
    hashes.add(hash);
    manifest.files.push({ ...file, hash });
  }
  if (repo && await gitHead(repo.root) !== repo.headCommit) throw changedWorkspace();
  manifest.knownPaths = [...known];
  return manifest;
}

function readManifest(workspace: Workspace, metadata: string): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(metadata);
  } catch {
    throw invalidCheckpoint();
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw invalidCheckpoint();
  const manifest = parsed.data;
  const known = new Set(manifest.knownPaths);
  const saved = [...manifest.files, ...manifest.cleanFiles];
  if (known.size !== manifest.knownPaths.length || known.size < saved.length ||
    (manifest.headCommit && !manifest.git) || (manifest.cleanFiles.length > 0 && !manifest.headCommit) ||
    new Set(saved.map(({ path }) => path)).size !== saved.length ||
    saved.some(({ path }) => !known.has(path)) ||
    manifest.knownPaths.some((path) => !withinWorkspace(workspace, path))) throw invalidCheckpoint();
  return manifest;
}

async function snapshotBytes(blobs: string, hash: string, maxSize: number): Promise<Buffer> {
  const entry = await entryAt(blobs, hash);
  if (!isRegular(entry) || entry.stats.size > maxSize) throw invalidCheckpoint();
  const bytes = await readBytes(entry);
  if (digest(bytes) !== hash) throw invalidCheckpoint();
  return bytes;
}

async function planRestore(
  workspace: Workspace, manifest: Manifest, blobs: string, repo: Repository | undefined,
  blocked: Set<string>,
): Promise<RestoreFile[]> {
  const base = repo && manifest.headCommit ? await gitTree(repo, manifest.headCommit) : new Map<string, string>();
  const writes: RestoreFile[] = [];
  let total = 0;
  for (const file of [...manifest.cleanFiles, ...manifest.files]) {
    const target = await entryAt(workspace.root, file.path);
    if (target.stats && !isRegular(target)) throw unsafeFile();
    if (repo && blocked.has(repo.prefix + actualRelative(workspace.root, target))) throw unsafeFile();
    let source: Buffer | string;
    let expected: string;
    if ("hash" in file && typeof file.hash === "string") {
      expected = file.hash;
      const limits = manifest.git ? Math.min(MAX_GIT_FILE_BYTES, 32 * MIB - total) : 16 * MIB - total;
      source = await snapshotBytes(blobs, file.hash, limits);
      total += source.length;
    } else {
      const blob = base.get((repo?.prefix ?? "") + file.path);
      if (!blob) throw invalidCheckpoint();
      source = expected = blob;
    }
    if (!isRegular(target) || target.actualPath !== target.path || (target.stats.mode & 0o777) !== file.mode ||
      await fileDigest(target, typeof source === "string" ? source : undefined) !== expected) {
      writes.push({ file, target, source });
    }
  }
  return writes;
}

function wasIgnored(ignored: Set<string>, path: string): boolean {
  if (ignored.has("") || ignored.has(path)) return true;
  for (let offset = path.indexOf("/"); offset !== -1; offset = path.indexOf("/", offset + 1)) {
    if (ignored.has(path.slice(0, offset + 1))) return true;
  }
  return false;
}

async function planRemovals(
  workspace: Workspace, manifest: Manifest, repo: Repository | undefined, writes: RestoreFile[], blocked: Set<string>,
) {
  const known = new Set(manifest.knownPaths);
  const ignored = new Set(manifest.ignoredPaths);
  const aliases = new Set(writes.map(({ target }) => target.actualPath));
  const removals = new Map<string, RegularFile>();
  const paths = repo ? await gitPaths(repo) : directoryPaths(workspace);
  for await (const candidate of paths) {
    if (blocked.has(candidate)) continue;
    const path = repo ? gitWorkspacePath(workspace, repo, candidate) : candidate;
    if (!path || known.has(path)) continue;
    const entry = await observedEntry(workspace.root, path);
    if (!isRegular(entry) || aliases.has(entry.actualPath)) continue;
    const existingPath = actualRelative(workspace.root, entry);
    if (repo && blocked.has(repo.prefix + existingPath)) continue;
    if (withinWorkspace(workspace, existingPath) && !known.has(existingPath) && !wasIgnored(ignored, existingPath)) {
      removals.set(existingPath, entry);
    }
  }
  return removals;
}

async function restoreFile(root: string, { file, target, source }: RestoreFile) {
  const current = await entryAt(root, file.path, true);
  if (!sameVersion(current.stats, target.stats)) throw changedWorkspace();
  const temporary = join(dirname(current.path), ".ide-save-" + randomUUID());
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      if (typeof source === "string") await gitWriteBlob(root, source, handle);
      else await handle.writeFile(source);
      if (process.platform !== "win32") await handle.chmod(file.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const checked = await entryAt(root, file.path);
    if (!sameVersion(checked.stats, current.stats)) throw changedWorkspace();
    await rename(temporary, checked.actualPath ?? checked.path);
    if (checked.actualPath && checked.actualPath !== checked.path) await rename(checked.actualPath, checked.path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

export class CheckpointManager {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly history: History) {}

  create(workspacePath: string, options: { runId?: string; label: string }): Promise<CheckpointSummary> {
    return this.serialize(async () => {
      const workspace = await this.workspace(workspacePath);
      const root = join(workspace.dataDir, "checkpoints");
      await mkdir(root, { recursive: true, mode: 0o700 });
      await directoryAt(root);
      const id = randomUUID();
      const checkpoint = join(root, id);
      const blobs = join(checkpoint, "files");
      await mkdir(checkpoint, { mode: 0o700 });
      let saved = false;
      let summary: CheckpointSummary;
      try {
        await mkdir(blobs, { mode: 0o700 });
        const manifest = await captureManifest(workspace, blobs);
        summary = {
          id, workspacePath: workspace.root, createdAt: Date.now(), label: options.label,
          filesCount: manifest.files.length, ...(options.runId === undefined ? {} : { runId: options.runId }),
        };
        this.history.saveCheckpoint({ summary, metadata: JSON.stringify(manifest) });
        saved = true;
      } finally {
        if (!saved) await rm(checkpoint, { recursive: true, force: true });
      }
      for (const { summary: pruned } of this.history.deleteOldCheckpoints(workspace.root, KEEP_CHECKPOINTS)) {
        if (checkpointId.test(pruned.id)) await rm(join(root, pruned.id), { recursive: true, force: true });
      }
      return summary;
    });
  }

  async list(workspacePath: string, limit = 20): Promise<CheckpointSummary[]> {
    return this.history.listCheckpoints(await canonicalDirectory(workspacePath), limit);
  }

  restore(id: string, workspacePath: string): Promise<CheckpointRestoreResult> {
    return this.serialize(async () => {
      const workspace = await this.workspace(workspacePath);
      const checkpoint = checkpointId.test(id) ? this.history.getCheckpoint(id) : undefined;
      if (!checkpoint || checkpoint.summary.workspacePath !== workspace.root) {
        throw new RpcError(-32004, "Checkpoint not found.");
      }
      const manifest = readManifest(workspace, checkpoint.metadata);
      const blobs = join(workspace.dataDir, "checkpoints", id, "files");
      await directoryAt(blobs);
      const repo = manifest.git ? await repositoryAt(workspace.root) : undefined;
      if (manifest.git && !repo) throw new WorkspaceError("CONFLICT", "The checkpoint's Git workspace is unavailable.");
      const blocked = repo ? await protectedRenameTargets(repo, manifest.headCommit) : new Set<string>();
      const writes = await planRestore(workspace, manifest, blobs, repo, blocked);
      const removals = await planRemovals(workspace, manifest, repo, writes, blocked);
      const restoredFiles: string[] = [];
      const removedFiles: string[] = [];
      for (const write of writes) {
        await restoreFile(workspace.root, write);
        restoredFiles.push(write.file.path);
      }
      for (const [path, entry] of removals) {
        const current = await entryAt(workspace.root, path);
        if (!isRegular(current) || !sameVersion(current.stats, entry.stats)) throw changedWorkspace();
        await unlink(current.path);
        removedFiles.push(path);
      }
      this.history.markCheckpointRestored(id, Date.now());
      return { id, restoredFiles, removedFiles };
    });
  }

  private async workspace(input: string): Promise<Workspace> {
    return { root: await canonicalDirectory(input), dataDir: await realpath(this.dataDir) };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}
