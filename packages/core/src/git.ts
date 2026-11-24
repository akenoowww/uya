import { execFile } from "node:child_process";
import type { GitDiffResult, GitFileStatus, GitStatus } from "@ide/protocol";
import {
  canonicalDirectory,
  isProtectedRelativePath,
  MAX_TEXT_BYTES,
  readText,
  WorkspaceError,
  workspaceFileExists,
} from "./workspace-files";

const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const DIFF_TRUNCATED = "\n[Diff truncated at 512 KiB]\n";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const gitFlags = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const diffFlags = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=all"];
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
  run: (args: string[], allowTruncation?: boolean) => Promise<GitOutput>;
};

function runGit(root: string, args: string[], allowTruncation = false): Promise<GitOutput> {
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
    execFile("git", [...gitFlags, ...args], {
      cwd: root, timeout: 8000, maxBuffer: MAX_GIT_OUTPUT, encoding: "buffer", env,
    }, (error, stdout) => {
      if (!error) resolve({ stdout, truncated: false });
      else if (allowTruncation && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ stdout, truncated: true });
      else reject(new GitError(error.code));
    });
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
    ({ stdout } = await runGit(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"]));
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
  return { root, prefix, run: (args, allowTruncation) => runGit(root, [...overrides, ...args], allowTruncation) };
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

function exactPathspec(path: string): string {
  // Force a wildcard match so Git does not also match the path as a directory prefix.
  // Escaping the first character and any glob syntax makes that match exact.
  return ":(top,glob)" + path.replace(/^.|[\\*?[\]]/gu, "\\$&");
}

async function changedPaths(repository: Repository, staged: boolean, path?: string) {
  const args = [...diffFlags, "--raw", "-z", staged ? "--find-renames=100%" : "--no-renames"];
  if (staged) args.push("--cached");
  else args.push("--", path === undefined ? "." : exactPathspec(repository.prefix + path));
  const records = nulRecords((await repository.run(args)).stdout);
  const paths = new Set<string>();
  const blocked = new Set<string>();
  for (const header of records) {
    const entry = /^:([0-7]{6}) ([0-7]{6}) [^ ]+ [^ ]+ ([A-Z])\d*$/u.exec(header.toString("ascii"));
    const first = workspacePath(repository, decode(records.next().value));
    if (!entry) throw new GitError();
    const regular = entry.slice(1, 3).every(regularOrMissingMode);
    if (entry[3] === "R" || entry[3] === "C") {
      const second = workspacePath(repository, decode(records.next().value));
      if (!regular || !first || !second) {
        if (first) blocked.add(first);
        if (second) blocked.add(second);
        continue;
      }
      paths.add(second);
    }
    if (first && regular) paths.add(first);
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
  for (let index = 0; index < pathspecs.length;) {
    const batch: string[] = [];
    let bytes = 0;
    do {
      const pathspec = pathspecs[index++]!;
      batch.push(pathspec);
      bytes += Buffer.byteLength(pathspec) + 1;
    } while (index < pathspecs.length && bytes + Buffer.byteLength(pathspecs[index]!) < 16 * 1024);
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
