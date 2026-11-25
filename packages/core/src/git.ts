import { execFile } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import type { GitBranch, GitCommit, GitCommitResult, GitDiffResult, GitFileStatus, GitStatus } from "@ide/protocol";
import {
  canonicalDirectory,
  isProtectedRelativePath,
  MAX_TEXT_BYTES,
  readText,
  relativePath,
  WorkspaceError,
  workspaceFileExists,
} from "./workspace-files";

const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_PATHSPEC_BYTES = 16 * 1024;
const DIFF_TRUNCATED = "\n[Diff truncated at 512 KiB]\n";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const gitFlags = [
  "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false",
  "-c", `core.hooksPath=${devNull}`, "-c", "maintenance.auto=false",
];
const diffFlags = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=all"];
const rawDiffFlags = [...diffFlags, "--raw", "-z"];
const gitLocalEnv = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
  "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
]);

class GitError extends WorkspaceError {
  constructor(readonly exitCode?: string | number | null) {
    super("IO", "Git could not read this workspace.");
  }
}

type GitOutput = { stdout: Buffer; truncated: boolean };
type Repository = {
  root: string;
  prefix: string;
  run: (args: string[], allowTruncation?: boolean, input?: string) => Promise<GitOutput>;
};

function runGit(root: string, args: string[], allowTruncation = false, input?: string): Promise<GitOutput> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  for (const name of Object.keys(env)) {
    if (gitLocalEnv.has(name.toUpperCase())) delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...gitFlags, ...args], {
      cwd: root, timeout: 8000, maxBuffer: MAX_GIT_OUTPUT, encoding: "buffer", env,
    }, (error, stdout) => {
      if (!error) resolve({ stdout, truncated: false });
      else if (allowTruncation && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ stdout, truncated: true });
      else reject(new GitError(error.code));
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  });
}

function decode(bytes: Buffer | undefined): string | undefined {
  if (!bytes) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function* nulRecords(bytes: Buffer): Generator<Buffer> {
  let offset = 0;
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, offset)) {
    yield bytes.subarray(offset, end);
    offset = end + 1;
  }
}

async function filterOverrides(root: string): Promise<string[]> {
  let stdout: Buffer;
  try {
    ({ stdout } = await runGit(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]));
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return [];
    throw error;
  }
  const overrides = new Set<string>();
  for (const record of nulRecords(stdout)) {
    const name = decode(record);
    if (!name || /[=\u0000-\u001f\u007f]/u.test(name)) throw new GitError();
    overrides.add(`${name}=${name.endsWith(".required") ? "false" : ""}`);
  }
  // Even read-only status and diff commands can run a configured clean filter.
  return [...overrides].flatMap((option) => ["-c", option]);
}

async function repositoryFor(input: string): Promise<Repository | undefined> {
  let root: string;
  let probe: string | undefined;
  try {
    root = await canonicalDirectory(input);
    probe = decode((await runGit(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"])).stdout);
  } catch (error) {
    if (error instanceof GitError || (error instanceof WorkspaceError && error.code === "NOT_FOUND")) return undefined;
    throw error;
  }
  const workTree = /^true\r?\n/u.exec(probe ?? "");
  if (!workTree) return undefined;
  const prefix = probe!.slice(workTree[0].length).replace(/\r?\n$/u, "");
  const overrides = await filterOverrides(root);
  return { root, prefix, run: (args, allowTruncation, input) => runGit(root, [...overrides, ...args], allowTruncation, input) };
}

function workspacePath(repository: Repository, gitPath: string | undefined): string | undefined {
  if (!gitPath?.startsWith(repository.prefix)) return undefined;
  const path = gitPath.slice(repository.prefix.length);
  try {
    if (!isProtectedRelativePath(gitPath) && !isProtectedRelativePath(path)) return path;
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
  }
  return undefined;
}

async function canShowPath(root: string, path: string): Promise<boolean> {
  try {
    await workspaceFileExists(root, path);
    return true;
  } catch (error) {
    if (error instanceof WorkspaceError) return false;
    throw error;
  }
}

function regularMode(mode: string): boolean {
  return /^100[0-7]{3}$/u.test(mode);
}

function regularOrMissingMode(mode: string): boolean {
  return mode === "000000" || regularMode(mode);
}

const changeTypes: Partial<Record<string, GitFileStatus>> = {
  M: "modified", T: "modified", A: "added", D: "deleted", R: "renamed", C: "added",
};

export async function gitStatus(root: string): Promise<GitStatus> {
  const result: GitStatus = { isRepo: false, changes: [] };
  const repository = await repositoryFor(root);
  if (!repository) return result;
  result.isRepo = true;
  const { stdout } = await repository.run([
    "status", "--porcelain=v2", "--branch", "-z", "--ahead-behind", "--untracked-files=all",
    "--find-renames=100%", "--ignore-submodules=all",
  ]);
  const records = nulRecords(stdout);
  for (const bytes of records) {
    const renamed = bytes[0] === 0x32 && bytes[1] === 0x20;
    const oldPath = renamed ? workspacePath(repository, decode(records.next().value)) : undefined;
    const record = decode(bytes);
    if (record === undefined) continue;
    if (record.startsWith("# branch.head ")) {
      const branch = record.slice("# branch.head ".length);
      if (branch && branch !== "(detached)") result.branch = branch;
    } else if (record.startsWith("# branch.ab ")) {
      const divergence = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
      if (divergence) {
        result.ahead = Number(divergence[1]);
        result.behind = Number(divergence[2]);
      }
    } else if (record.startsWith("? ")) {
      const path = workspacePath(repository, record.slice(2));
      if (path && await canShowPath(repository.root, path)) result.changes.push({ path, status: "untracked", staged: false });
    } else {
      const entry = /^[12] ([A-Z.]{2}) [^ ]+ ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) [^ ]+ [^ ]+ /u.exec(record);
      if (!entry || !entry.slice(2).every(regularOrMissingMode) || (renamed && !oldPath)) continue;
      const remainder = record.slice(entry[0].length);
      const path = workspacePath(repository, renamed ? remainder.replace(/^[RC]\d+ /u, "") : remainder);
      if (!path || !(await canShowPath(repository.root, path))) continue;
      if (oldPath && !(await canShowPath(repository.root, oldPath))) continue;
      const staged = changeTypes[entry[1]![0]!];
      const unstaged = changeTypes[entry[1]![1]!];
      if (staged) result.changes.push({ path, status: staged, staged: true });
      if (unstaged) result.changes.push({ path, status: unstaged, staged: false });
    }
  }
  return result;
}

function exactPathspec(path: string, ignoreCase = false): string {
  // Force a wildcard match so Git does not also match the path as a directory prefix.
  // Escaping the first character and any glob syntax makes that match exact.
  return (ignoreCase ? ":(top,glob,icase)" : ":(top,glob)") + path.replace(/^.|[\\*?[\]]/gu, "\\$&");
}

function* pathspecBatches(pathspecs: Iterable<string>): Generator<string[]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const pathspec of pathspecs) {
    const size = Buffer.byteLength(pathspec) + 1;
    if (batch.length && bytes + size > MAX_PATHSPEC_BYTES) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(pathspec);
    bytes += size;
  }
  if (batch.length) yield batch;
}

function* rawChanges(stdout: Buffer) {
  const records = nulRecords(stdout);
  for (const header of records) {
    const entry = /^:([0-7]{6}) ([0-7]{6}) [^ ]+ [^ ]+ ([A-Z])\d*$/u.exec(header.toString("ascii"));
    if (!entry) throw new GitError();
    const paths = [decode(records.next().value)];
    if (entry[3] === "R" || entry[3] === "C") paths.push(decode(records.next().value));
    yield { paths, regular: entry.slice(1, 3).every(regularOrMissingMode) };
  }
}

async function changedPaths(repository: Repository, staged: boolean, path?: string) {
  const args = [...rawDiffFlags, staged ? "--find-renames=100%" : "--no-renames"];
  if (staged) args.push("--cached");
  else args.push("--", path === undefined ? "." : exactPathspec(repository.prefix + path));
  const paths = new Set<string>();
  const blocked = new Set<string>();
  for (const change of rawChanges((await repository.run(args)).stdout)) {
    const [first, second] = change.paths.map((name) => workspacePath(repository, name));
    if (change.paths.length === 2) {
      if (!change.regular || !first || !second) {
        if (first) blocked.add(first);
        if (second) blocked.add(second);
        continue;
      }
      paths.add(second);
    }
    if (first && change.regular) paths.add(first);
  }
  return { paths, blocked };
}

function boundedDiff(diff: string, truncated = false): string {
  const bytes = Buffer.from(diff, "utf8");
  if (!truncated && bytes.length <= MAX_DIFF_BYTES) return diff;
  let end = Math.min(bytes.length, MAX_DIFF_BYTES - Buffer.byteLength(DIFF_TRUNCATED));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + DIFF_TRUNCATED;
}

async function patchFor(repository: Repository, paths: string[], staged: boolean): Promise<string> {
  const args = [...diffFlags, "--patch", "--src-prefix=a/", "--dst-prefix=b/"];
  args.push(staged ? "--find-renames=100%" : "--no-renames");
  if (staged) args.push("--cached");
  const pathspecs = paths.map((path) => exactPathspec(repository.prefix + path));
  let diff = "";
  for (const batch of pathspecBatches(pathspecs)) {
    const { stdout, truncated } = await repository.run([...args, "--", ...batch], true);
    diff += stdout.toString("utf8");
    if (truncated || Buffer.byteLength(diff) > MAX_DIFF_BYTES) return boundedDiff(diff, true);
  }
  return diff;
}

type TextSnapshot = { exists: boolean; text?: string };
const missingText: TextSnapshot = { exists: false, text: "" };

async function objectText(repository: Repository, path: string, side: "HEAD" | ":0"): Promise<TextSnapshot> {
  const gitPath = repository.prefix + path;
  let listing: GitOutput;
  try {
    listing = side === "HEAD"
      ? await repository.run(["ls-tree", "--full-tree", "-z", "HEAD", "--", ":(top,literal)" + gitPath])
      : await repository.run(["ls-files", "--full-name", "--stage", "-z", "--", exactPathspec(gitPath)]);
  } catch (error) {
    if (side === "HEAD" && error instanceof GitError && error.exitCode === 128) return missingText;
    throw error;
  }
  for (const bytes of nulRecords(listing.stdout)) {
    const record = decode(bytes);
    const tab = record?.indexOf("\t") ?? -1;
    if (record === undefined || tab < 0 || record.slice(tab + 1) !== gitPath) continue;
    const [mode, objectOrType, stageOrObject] = record.slice(0, tab).split(" ");
    if (side === ":0" && stageOrObject !== "0") continue;
    if (mode === "040000") return missingText;
    if (!mode || !regularMode(mode)) return { exists: true };
    const object = side === "HEAD" ? stageOrObject : objectOrType;
    if (!object || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(object)) throw new GitError();
    // Read the checked HEAD or stage-0 blob even if the ref or index changes.
    const { stdout, truncated } = await repository.run(["show", "--no-textconv", object, "--"], true);
    if (truncated || stdout.length > MAX_TEXT_BYTES) return { exists: true };
    const text = decode(stdout);
    return text === undefined || text.includes("\0") ? { exists: true } : { exists: true, text };
  }
  return missingText;
}

async function workingText(root: string, path: string): Promise<TextSnapshot> {
  if (!(await workspaceFileExists(root, path))) return missingText;
  try {
    return { exists: true, text: (await readText(root, path)).text };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      if (error.code === "NOT_FOUND") return missingText;
      if (error.code === "LIMIT" || error.code === "INVALID_INPUT") return { exists: true };
    }
    throw error;
  }
}

function untrackedPatch(path: string, text: string): string {
  const label = (prefix: string) => /\s|"/u.test(path) ? JSON.stringify(prefix + path) : prefix + path;
  const from = label("a/");
  const to = label("b/");
  const header = `diff --git ${from} ${to}\nnew file mode 100644\n`;
  if (!text.length) return header;
  const hasNewline = text.endsWith("\n");
  const body = hasNewline ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const hunk = `--- /dev/null\n+++ ${to}\n@@ -0,0 +1,${lines.length} @@\n`;
  return header + hunk + lines.map((line) => "+" + line + "\n").join("") + (hasNewline ? "" : "\\ No newline at end of file\n");
}

export async function gitDiff(root: string, { path, staged = false }: { path?: string; staged?: boolean } = {}): Promise<GitDiffResult> {
  if (path !== undefined && isProtectedRelativePath(path)) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
  const result: GitDiffResult = { ...(path !== undefined ? { path } : {}), staged, diff: "" };
  const repository = await repositoryFor(root);
  if (!repository) return result;
  if (path !== undefined) {
    if (workspacePath(repository, repository.prefix + path) === undefined) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
    await workspaceFileExists(repository.root, path);
  }
  const index = await changedPaths(repository, true);
  if (path !== undefined && index.blocked.has(path)) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
  const changes = staged ? index : await changedPaths(repository, false, path);
  const selected: string[] = [];
  for (const candidate of changes.paths) {
    if ((path !== undefined && candidate !== path) || index.blocked.has(candidate)) continue;
    if (await canShowPath(repository.root, candidate)) selected.push(candidate);
  }
  result.diff = await patchFor(repository, selected, staged);
  if (path === undefined) return result;

  const [original, modified] = await Promise.all([
    objectText(repository, path, staged ? "HEAD" : ":0"),
    staged ? objectText(repository, path, ":0") : workingText(repository.root, path),
  ]);
  if (original.text !== undefined) result.original = original.text;
  if (modified.text !== undefined) result.modified = modified.text;
  if (!staged && !result.diff && !original.exists && modified.exists && modified.text !== undefined) {
    result.diff = boundedDiff(untrackedPatch(repository.prefix + path, modified.text));
  }
  return result;
}

type FileSelection = { paths?: string[]; all?: boolean };

async function requireRepository(root: string): Promise<Repository> {
  const repository = await repositoryFor(root);
  if (!repository) throw new WorkspaceError("INVALID_INPUT", "This folder is not a Git repository.");
  return repository;
}

let pendingMutation: Promise<void> = Promise.resolve();

function mutateGit<T>(root: string, operation: (repository: Repository) => Promise<T>): Promise<T> {
  // Keep index and worktree preflight and the resulting status together across Uya calls.
  const result = pendingMutation.then(async () => operation(await requireRepository(root)));
  pendingMutation = result.then(() => undefined, () => undefined);
  return result;
}

async function checkWorktreePath(repository: Repository, path: string): Promise<boolean> {
  relativePath(path);
  if (workspacePath(repository, repository.prefix + path) === undefined) {
    throw new WorkspaceError("FORBIDDEN", "This path is protected.");
  }
  return workspaceFileExists(repository.root, path);
}

async function checkedSelection(repository: Repository, { paths, all }: FileSelection, message: string): Promise<Set<string>> {
  const selected = new Set(paths);
  if (!all && !selected.size) throw new WorkspaceError("INVALID_INPUT", message);
  for (const path of selected) await checkWorktreePath(repository, path);
  return selected;
}

async function runPathCommand(repository: Repository, args: string[], paths: string[]): Promise<void> {
  if (!paths.length) return;
  const pathspecs = paths.map((path) => exactPathspec(repository.prefix + path));
  const input = pathspecs.join("\0") + "\0";
  if (Buffer.byteLength(input) <= MAX_PATHSPEC_BYTES) {
    await repository.run([...args, "--", ...pathspecs]);
  } else {
    // Keep large selections in one index transaction without exceeding argv limits.
    await repository.run([...args, "--pathspec-from-file=-", "--pathspec-file-nul", "--"], false, input);
  }
}

function pathParents(path: string): string[] {
  const parents: string[] = [];
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    parents.push(path.slice(0, slash));
  }
  return parents;
}

async function safeIndexPaths(repository: Repository, paths: string[]): Promise<Set<string>> {
  const pathspecs = new Set<string>();
  for (const path of paths) {
    const name = repository.prefix + path;
    pathspecs.add(":(top,literal,icase)" + name);
    for (const parent of pathParents(name)) pathspecs.add(exactPathspec(parent, true));
  }
  const unsafe = new Set<string>();
  const unsafeParents = new Set<string>();
  for (const batch of pathspecBatches(pathspecs)) {
    const { stdout } = await repository.run(["ls-files", "--full-name", "--stage", "-z", "--", ...batch]);
    for (const record of nulRecords(stdout)) {
      const tab = record.indexOf(0x09);
      if (tab < 0) throw new GitError();
      const bytes = record.subarray(tab + 1);
      const name = decode(bytes);
      if (regularMode(record.toString("ascii", 0, 6)) && workspacePath(repository, name) !== undefined) continue;
      const key = (name ?? bytes.toString("utf8")).toLowerCase();
      unsafe.add(key);
      for (const parent of pathParents(key)) unsafeParents.add(parent);
    }
  }
  // Git can remove a conflicting index entry even when the pathspec itself is exact.
  return new Set(paths.filter((path) => {
    const key = (repository.prefix + path).toLowerCase();
    return !unsafe.has(key) && !unsafeParents.has(key) && !pathParents(key).some((parent) => unsafe.has(parent));
  }));
}

async function checkRenameSelection(repository: Repository, selected: Set<string>): Promise<Set<string>> {
  const { blocked } = await changedPaths(repository, true);
  for (const path of selected) {
    if (blocked.has(path)) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
  }
  return blocked;
}

export function gitStage(root: string, options: FileSelection): Promise<GitStatus> {
  return mutateGit(root, async (repository) => {
    const selected = await checkedSelection(repository, options, "Choose files to stage.");
    const blocked = await checkRenameSelection(repository, selected);
    const paths = options.all
      ? (await gitStatus(repository.root)).changes.filter((change) => !change.staged).map((change) => change.path)
      : [...selected];
    const candidates = paths.filter((path) => !blocked.has(path));
    const safe = await safeIndexPaths(repository, candidates);
    if (candidates.some((path) => selected.has(path) && !safe.has(path))) {
      throw new WorkspaceError("FORBIDDEN", "This path is protected.");
    }
    await runPathCommand(repository, ["add", "--no-ignore-errors"], [...safe]);
    return gitStatus(repository.root);
  });
}

async function cachedChanges(repository: Repository, ...flags: string[]) {
  const { stdout } = await repository.run([...rawDiffFlags, "--cached", "--ignore-submodules=none", ...flags, "--"]);
  return rawChanges(stdout);
}

async function unstagePaths(repository: Repository, selected: Set<string>, all: boolean): Promise<string[]> {
  const groups: { paths: string[]; explicit: boolean }[] = [];
  const changes = await cachedChanges(repository, "--find-renames=100%");
  for (const change of changes) {
    const paths = change.paths.map((path) => workspacePath(repository, path)).filter((path) => path !== undefined);
    const explicit = paths.some((path) => selected.has(path));
    if (!all && !explicit) continue;
    const safe = change.regular && paths.length === change.paths.length &&
      (await Promise.all(paths.map((path) => canShowPath(repository.root, path)))).every(Boolean);
    if (!safe && explicit) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
    if (safe) groups.push({ paths, explicit });
  }
  const safe = await safeIndexPaths(repository, groups.flatMap(({ paths }) => paths));
  const result = new Set<string>();
  for (const group of groups) {
    if (group.paths.every((path) => safe.has(path))) {
      for (const path of group.paths) result.add(path);
    } else if (group.explicit) {
      throw new WorkspaceError("FORBIDDEN", "This path is protected.");
    }
  }
  return [...result];
}

async function gitSucceeds(repository: Repository, args: string[]): Promise<boolean> {
  try {
    await repository.run(args);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

function hasHead(repository: Repository): Promise<boolean> {
  return gitSucceeds(repository, ["rev-parse", "--verify", "--quiet", "HEAD"]);
}

export function gitUnstage(root: string, options: FileSelection): Promise<GitStatus> {
  return mutateGit(root, async (repository) => {
    const selected = await checkedSelection(repository, options, "Choose files to unstage.");
    const paths = await unstagePaths(repository, selected, options.all === true);
    if (paths.length) {
      const args = await hasHead(repository)
        ? ["restore", "--staged"]
        : ["rm", "--cached", "--quiet", "--force"];
      await runPathCommand(repository, args, paths);
    }
    return gitStatus(repository.root);
  });
}

async function checkRestoreTarget(repository: Repository, path: string): Promise<void> {
  if (await checkWorktreePath(repository, path)) return;
  try {
    await lstat(join(repository.root, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code !== "ENOTDIR") throw new WorkspaceError("IO", "Git could not inspect the file to discard.");
  }
  // Git restore can remove an obstructing directory or parent file.
  throw new WorkspaceError("CONFLICT", "Another file or folder is in the way of restoring this path.");
}

async function discardUntracked(repository: Repository, path: string): Promise<void> {
  if (!(await checkWorktreePath(repository, path))) {
    throw new WorkspaceError("CONFLICT", "The file changed before it could be discarded.");
  }
  try {
    await unlink(join(repository.root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WorkspaceError("IO", "Git could not remove the untracked file.");
    }
  }
}

export function gitDiscard(root: string, paths: string[]): Promise<GitStatus> {
  return mutateGit(root, async (repository) => {
    const selected = await checkedSelection(repository, { paths }, "Choose files to discard.");
    await checkRenameSelection(repository, selected);
    const changes = (await gitStatus(repository.root)).changes.filter((change) => !change.staged && selected.has(change.path));
    const tracked = changes.filter((change) => change.status !== "untracked").map((change) => change.path);
    for (const path of tracked) await checkRestoreTarget(repository, path);
    await runPathCommand(repository, ["restore", "--worktree", "--no-recurse-submodules"], tracked);
    for (const change of changes) {
      if (change.status === "untracked") await discardUntracked(repository, change.path);
    }
    return gitStatus(repository.root);
  });
}

async function checkTreeChanges(repository: Repository, changes: ReturnType<typeof rawChanges>): Promise<boolean> {
  let changed = false;
  for (const change of changes) {
    changed = true;
    for (const name of change.paths) {
      const path = workspacePath(repository, name);
      if (path === undefined || !change.regular) throw new WorkspaceError("FORBIDDEN", "This path is protected.");
      await workspaceFileExists(repository.root, path);
    }
  }
  return changed;
}

const localBranchPrefix = "refs/heads/";

async function currentBranch(repository: Repository): Promise<string> {
  try {
    const { stdout } = await repository.run(["symbolic-ref", "--quiet", "--no-recurse", "HEAD"]);
    return stdout.toString("utf8").trimEnd().slice(localBranchPrefix.length);
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return "HEAD";
    throw error;
  }
}

async function readLog(repository: Repository, limit: number): Promise<GitCommit[]> {
  const { stdout } = await repository.run([
    "log", "-z", "-n", String(limit), "--no-show-signature", "--no-notes", "--encoding=UTF-8",
    "--format=%H%x00%h%x00%s%x00%an%x00%aI%x1e", "HEAD", "--",
  ]);
  const fields = stdout.toString("utf8").split("\0");
  const commits: GitCommit[] = [];
  for (let start = 0; start + 4 < fields.length; start += 5) {
    const [hash, shortHash, subject, author, date] = fields.slice(start, start + 5);
    if (!hash || !shortHash || !date.endsWith("\x1e")) throw new GitError();
    commits.push({ hash, shortHash, subject, author, date: date.slice(0, -1) });
  }
  return commits;
}

export function gitCommit(root: string, message: string): Promise<GitCommitResult> {
  return mutateGit(root, async (repository) => {
    const text = message.trim();
    if (!text || text.includes("\0")) throw new WorkspaceError("INVALID_INPUT", "Enter a valid commit message.");
    const staged = await cachedChanges(repository, "--no-renames", "--ita-invisible-in-index");
    if (!(await checkTreeChanges(repository, staged))) {
      throw new WorkspaceError("CONFLICT", "There are no staged changes to commit.");
    }
    await repository.run(["commit", "--quiet", "--no-gpg-sign", "--cleanup=verbatim", "-m", text]);
    const [commit] = await readLog(repository, 1);
    if (!commit) throw new GitError();
    return { hash: commit.hash, shortHash: commit.shortHash, branch: await currentBranch(repository), subject: commit.subject };
  });
}

export async function gitBranches(root: string): Promise<GitBranch[]> {
  const repository = await requireRepository(root);
  const { stdout } = await repository.run([
    "for-each-ref", "--format=%(HEAD)%00%(refname:lstrip=2)%00%(upstream:short)%00%(objectname:short)", localBranchPrefix,
  ]);
  const output = decode(stdout);
  if (output === undefined) throw new GitError();
  const branches = output.split("\n").filter(Boolean).map((line) => {
    const [head, name, upstream, commit] = line.split("\0");
    return { name, current: head === "*", ...(upstream ? { upstream } : {}), ...(commit ? { commit } : {}) };
  });
  return branches.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}

async function checkedBranchRef(repository: Repository, name: string): Promise<string> {
  const ref = localBranchPrefix + name;
  if (!name || name.startsWith("-") || name === "HEAD" || name === "@" || name.includes("\0") ||
      !(await gitSucceeds(repository, ["check-ref-format", ref]))) {
    throw new WorkspaceError("INVALID_INPUT", "Invalid Git branch name.");
  }
  return ref;
}

function branchExists(repository: Repository, ref: string): Promise<boolean> {
  return gitSucceeds(repository, ["show-ref", "--verify", "--quiet", "--", ref]);
}

const switchFlags = ["switch", "--no-guess", "--no-recurse-submodules", "--no-overwrite-ignore"];

export function gitCheckout(root: string, branch: string): Promise<GitStatus> {
  return mutateGit(root, async (repository) => {
    const ref = await checkedBranchRef(repository, branch);
    if (!(await branchExists(repository, ref))) {
      throw new WorkspaceError("NOT_FOUND", "That local branch does not exist.");
    }
    const base = await hasHead(repository) ? "HEAD" :
      (await repository.run(["hash-object", "-t", "tree", "--stdin"], false, "")).stdout.toString("ascii").trim();
    const { stdout } = await repository.run([...rawDiffFlags, "--ignore-submodules=none", "--no-renames", base, ref, "--"]);
    await checkTreeChanges(repository, rawChanges(stdout));
    if (!(await gitSucceeds(repository, [...switchFlags, "--", branch]))) {
      throw new WorkspaceError("CONFLICT", "Local changes prevent switching to that branch.");
    }
    return gitStatus(repository.root);
  });
}

export function gitCreateBranch(root: string, name: string, checkout = true): Promise<GitStatus> {
  return mutateGit(root, async (repository) => {
    const ref = await checkedBranchRef(repository, name);
    if (await branchExists(repository, ref)) {
      throw new WorkspaceError("CONFLICT", "That branch already exists.");
    }
    try {
      await repository.run(checkout !== false ? [...switchFlags, "-c", name] : ["branch", "--", name]);
    } catch (error) {
      if (error instanceof GitError && await branchExists(repository, ref)) {
        throw new WorkspaceError("CONFLICT", "That branch already exists.");
      }
      throw error;
    }
    return gitStatus(repository.root);
  });
}

export async function gitLog(root: string, limit = 25): Promise<GitCommit[]> {
  const repository = await requireRepository(root);
  if (!(await hasHead(repository))) return [];
  const count = Math.max(1, Math.min(100, Math.trunc(Number.isNaN(limit) ? 25 : limit)));
  return readLog(repository, count);
}
