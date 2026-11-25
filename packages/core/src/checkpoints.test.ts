import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { CheckpointManager } from "./checkpoints";
import { History } from "./history";

let fixture: string;
let root: string;
let dataDir: string;
let history: History;
let manager: CheckpointManager;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "uya-checkpoint-")));
  root = join(fixture, "workspace");
  dataDir = join(fixture, "data");
  await mkdir(root);
  history = new History(dataDir);
  manager = new CheckpointManager(dataDir, history);
});

afterEach(async () => {
  history.close();
  await rm(fixture, { recursive: true, force: true });
});

function git(args: string[], input?: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8", input, timeout: 8000,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
}

function initGit() {
  git(["init", "-q", "--initial-branch=main", "--template="]);
}

function advanceHead(parent?: string) {
  git(["add", "--all"]);
  const tree = git(["write-tree"]).trim();
  const identity = "Uya Fixture <fixture@example.test> 1700000000 +0000";
  const body = [
    "tree " + tree, ...(parent ? ["parent " + parent] : []),
    "author " + identity, "committer " + identity, "", "Synthetic checkpoint fixture", "",
  ].join("\n");
  const head = git(["hash-object", "-t", "commit", "-w", "--stdin"], body).trim();
  git(["update-ref", "HEAD", head]);
  return head;
}

function write(path: string, contents: string | Buffer) {
  return writeFile(join(root, path), contents);
}

function read(path: string) {
  return readFile(join(root, path));
}

test("restores a plain workspace byte-for-byte and leaves protected and excluded paths alone", async () => {
  const original = Buffer.from([0, 1, 128, 255]);
  await mkdir(join(root, "deep/folder"), { recursive: true });
  await mkdir(join(root, "node_modules"));
  await write("edited.bin", original);
  await write("deep/folder/deleted.txt", "Restore this\r\n");
  await write(".env", "SYNTHETIC_FIXTURE=before\n");
  await write("node_modules/excluded.txt", "Before");
  if (process.platform !== "win32") await chmod(join(root, "edited.bin"), 0o751);
  const checkpoint = await manager.create(root + "/.", { label: "Before run", runId: "test-run" });
  expect(checkpoint).toMatchObject({ workspacePath: root, label: "Before run", runId: "test-run", filesCount: 2 });
  expect(await manager.list(root)).toEqual([checkpoint]);
  const storage = join(dataDir, "checkpoints", checkpoint.id);
  if (process.platform !== "win32") expect((await lstat(storage)).mode & 0o777).toBe(0o700);
  const hash = createHash("sha256").update(original).digest("hex");
  expect(await readFile(join(storage, "files", hash))).toEqual(original);

  await write("edited.bin", "Changed");
  if (process.platform !== "win32") await chmod(join(root, "edited.bin"), 0o600);
  await rm(join(root, "deep"), { recursive: true });
  await write("new.txt", "New");
  await write(".env", "SYNTHETIC_FIXTURE=after\n");
  await write(".env.local", "SYNTHETIC_FIXTURE=new\n");
  await write("node_modules/excluded.txt", "After");
  const result = await manager.restore(checkpoint.id, root);
  expect(result.id).toBe(checkpoint.id);
  expect(result.restoredFiles.sort()).toEqual(["deep/folder/deleted.txt", "edited.bin"]);
  expect(result.removedFiles).toEqual(["new.txt"]);
  expect(await read("edited.bin")).toEqual(original);
  if (process.platform !== "win32") expect((await lstat(join(root, "edited.bin"))).mode & 0o777).toBe(0o751);
  expect(await read("deep/folder/deleted.txt")).toEqual(Buffer.from("Restore this\r\n"));
  await expect(read("new.txt")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await read(".env")).toEqual(Buffer.from("SYNTHETIC_FIXTURE=after\n"));
  expect(await read(".env.local")).toEqual(Buffer.from("SYNTHETIC_FIXTURE=new\n"));
  expect(await read("node_modules/excluded.txt")).toEqual(Buffer.from("After"));
  expect((await manager.list(root))[0]?.restoredAt).toBeGreaterThanOrEqual(checkpoint.createdAt);
  expect(await manager.restore(checkpoint.id, root)).toEqual({ id: checkpoint.id, restoredFiles: [], removedFiles: [] });
});

test("restores clean, staged, and untracked Git working files while preserving protected and ignored files", async () => {
  initGit();
  const binary = Buffer.from([255, 0, 193, 10]);
  await write(".gitignore", "ignored.bin\n");
  await write(".env", "SYNTHETIC_FIXTURE=baseline\n");
  await write("clean.bin", binary);
  await write("clean-deleted.txt", "Original clean content\n");
  await write("dirty.bin", "HEAD");
  const headCommit = advanceHead();
  await write(".env", "SYNTHETIC_FIXTURE=before\n");
  await write("dirty.bin", "Staged bytes");
  git(["add", "--", "dirty.bin"]);
  await write("dirty.bin", binary);
  await write("untracked.txt", "Untracked before");
  const checkpoint = await manager.create(root, { label: "Before Git changes" });
  expect(checkpoint.filesCount).toBe(2);
  const metadata: unknown = JSON.parse(history.getCheckpoint(checkpoint.id)!.metadata);
  expect(metadata).toMatchObject({ headCommit, knownPaths: expect.arrayContaining(["clean.bin", "untracked.txt"]) });
  expect(metadata).not.toMatchObject({ knownPaths: expect.arrayContaining([".env"]) });

  await write(".env", "SYNTHETIC_FIXTURE=after\n");
  await write("clean.bin", "Changed");
  await rm(join(root, "clean-deleted.txt"));
  await write("dirty.bin", "Changed");
  await rm(join(root, "untracked.txt"));
  await write("ignored.bin", "Ignored after");
  await write("new.txt", "New");
  git(["add", "--", "new.txt"]);
  const index = git(["ls-files", "--stage"]);

  const result = await manager.restore(checkpoint.id, root);
  expect(result.restoredFiles.sort()).toEqual(["clean-deleted.txt", "clean.bin", "dirty.bin", "untracked.txt"]);
  expect(result.removedFiles).toEqual(["new.txt"]);
  expect(await read("clean.bin")).toEqual(binary);
  expect(await read("clean-deleted.txt")).toEqual(Buffer.from("Original clean content\n"));
  expect(await read("dirty.bin")).toEqual(binary);
  expect(await read("untracked.txt")).toEqual(Buffer.from("Untracked before"));
  await expect(read("new.txt")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await read(".env")).toEqual(Buffer.from("SYNTHETIC_FIXTURE=after\n"));
  expect(await read("ignored.bin")).toEqual(Buffer.from("Ignored after"));
  expect(git(["ls-files", "--stage"])).toBe(index);
});

test("preserves staged renames and the absence of previously deleted tracked files", async () => {
  initGit();
  await write("before.txt", "Renamed before checkpoint");
  await write("staged-deletion.txt", "Staged for deletion");
  await write("working-deletion.txt", "Deleted from disk");
  advanceHead();
  git(["mv", "--", "before.txt", "after [rename].txt"]);
  git(["rm", "-q", "--", "staged-deletion.txt"]);
  await rm(join(root, "working-deletion.txt"));
  const checkpoint = await manager.create(root, { label: "With staged changes" });

  await write("before.txt", "Recreated");
  await write("staged-deletion.txt", "Recreated");
  await write("working-deletion.txt", "Recreated");
  await rm(join(root, "after [rename].txt"));
  const result = await manager.restore(checkpoint.id, root);
  expect(result.restoredFiles).toEqual(["after [rename].txt"]);
  expect(result.removedFiles.sort()).toEqual(["before.txt", "staged-deletion.txt", "working-deletion.txt"]);
  expect(await read("after [rename].txt")).toEqual(Buffer.from("Renamed before checkpoint"));
});

test("restores original file casing without deleting a case alias of a known path", async () => {
  await write("Original.txt", "Before");
  const checkpoint = await manager.create(root, { label: "Before rename" });
  await rename(join(root, "Original.txt"), join(root, "original.txt"));
  await write("original.txt", "After");
  const result = await manager.restore(checkpoint.id, root);
  expect(result.restoredFiles).toEqual(["Original.txt"]);
  expect(await readdir(root)).toEqual(["Original.txt"]);
  expect(await read("Original.txt")).toEqual(Buffer.from("Before"));
});

test("preserves previously ignored files when the run changes ignore rules", async () => {
  initGit();
  await write(".gitignore", "local.log\nlogs/\n");
  advanceHead();
  await mkdir(join(root, "logs"));
  await write("local.log", "Local log");
  await write("logs/ignored.txt", "Existing ignored file");
  const checkpoint = await manager.create(root, { label: "Before ignore changes" });
  await write(".gitignore", "");
  await write("new.txt", "New");
  const result = await manager.restore(checkpoint.id, root);
  expect(result).toEqual({ id: checkpoint.id, restoredFiles: [".gitignore"], removedFiles: ["new.txt"] });
  expect(await read(".gitignore")).toEqual(Buffer.from("local.log\nlogs/\n"));
  expect(await read("local.log")).toEqual(Buffer.from("Local log"));
  expect(await read("logs/ignored.txt")).toEqual(Buffer.from("Existing ignored file"));
});

test("keeps both capture and cleanup away from staged renames of protected paths", async () => {
  initGit();
  await write(".env", "SYNTHETIC_FIXTURE=before\n");
  await write("note.txt", "Before");
  advanceHead();
  const first = await manager.create(root, { label: "Before staged rename" });
  git(["mv", "--", ".env", "renamed.txt"]);
  const second = await manager.create(root, { label: "After staged rename" });
  expect(second.filesCount).toBe(0);
  expect(history.getCheckpoint(second.id)?.metadata).not.toContain("renamed.txt");

  await write("renamed.txt", "SYNTHETIC_FIXTURE=after\n");
  await write("note.txt", "After");
  expect(await manager.restore(first.id, root))
    .toEqual({ id: first.id, restoredFiles: ["note.txt"], removedFiles: [] });
  expect(await read("renamed.txt")).toEqual(Buffer.from("SYNTHETIC_FIXTURE=after\n"));
});

test("pins clean files to the original HEAD and scopes a subdirectory checkpoint", async () => {
  initGit();
  await mkdir(join(root, "sub dir"));
  await write("sub dir/note [draft].txt", "Before");
  await write("outside.txt", "Outside before");
  const original = advanceHead();
  const workspace = join(root, "sub dir");
  const checkpoint = await manager.create(workspace, { label: "Before HEAD changes" });
  expect(checkpoint.filesCount).toBe(0);
  await write("sub dir/note [draft].txt", "After");
  await write("sub dir/new.txt", "New committed file");
  await write("outside.txt", "Outside after");
  const current = advanceHead(original);

  const result = await manager.restore(checkpoint.id, workspace);
  expect(result).toEqual({ id: checkpoint.id, restoredFiles: ["note [draft].txt"], removedFiles: ["new.txt"] });
  expect(await read("sub dir/note [draft].txt")).toEqual(Buffer.from("Before"));
  expect(await read("outside.txt")).toEqual(Buffer.from("Outside after"));
  expect(git(["rev-parse", "HEAD"]).trim()).toBe(current);
});

test("captures raw line endings and suppresses configured Git filters", async () => {
  initGit();
  await write(".gitattributes", "*.txt text eol=crlf filter=fixture\n");
  await write("windows.txt", "First\r\nSecond\r\n");
  advanceHead();
  expect(git(["status", "--porcelain=v1"])).toBe("");
  git(["config", "--local", "filter.fixture.clean", "uya-fixture-filter-does-not-exist"]);
  git(["config", "--local", "filter.fixture.process", "uya-fixture-filter-does-not-exist"]);
  git(["config", "--local", "filter.fixture.required", "true"]);
  const checkpoint = await manager.create(root, { label: "Raw working bytes" });
  expect(checkpoint.filesCount).toBe(1);
  await write("windows.txt", "Changed\n");
  expect((await manager.restore(checkpoint.id, root)).restoredFiles).toEqual(["windows.txt"]);
  expect(await read("windows.txt")).toEqual(Buffer.from("First\r\nSecond\r\n"));
});

test("supports Git workspaces with an unborn HEAD", async () => {
  initGit();
  await write("staged.bin", Buffer.from([0, 255]));
  git(["add", "--", "staged.bin"]);
  const checkpoint = await manager.create(root, { label: "Unborn branch" });
  await rm(join(root, "staged.bin"));
  await write("new", "New untracked");
  expect(await manager.restore(checkpoint.id, root))
    .toEqual({ id: checkpoint.id, restoredFiles: ["staged.bin"], removedFiles: ["new"] });
  expect(await read("staged.bin")).toEqual(Buffer.from([0, 255]));
});

test.skipIf(process.platform === "win32")("rejects a symlink ancestor before applying any writes", async () => {
  const outside = join(fixture, "outside");
  await mkdir(outside);
  await mkdir(join(root, "folder"));
  await write("editable.txt", "Before");
  await write("folder/note.txt", "Before");
  await writeFile(join(outside, "note.txt"), "Outside");
  const checkpoint = await manager.create(root, { label: "Before symlink" });
  await write("editable.txt", "After");
  await rm(join(root, "folder"), { recursive: true });
  await symlink(outside, join(root, "folder"), "dir");
  await expect(manager.restore(checkpoint.id, root)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await read("editable.txt")).toEqual(Buffer.from("After"));
  expect(await readFile(join(outside, "note.txt"))).toEqual(Buffer.from("Outside"));
  expect(history.getCheckpoint(checkpoint.id)?.summary.restoredAt).toBeUndefined();
});

test.skipIf(process.platform === "win32")("skips new symlinks and multiply linked files during cleanup", async () => {
  const outside = join(fixture, "outside.txt");
  await writeFile(outside, "Outside");
  await write("keep.txt", "Before");
  const checkpoint = await manager.create(root, { label: "Before links" });
  await write("keep.txt", "After");
  await link(outside, join(root, "alias.txt"));
  await symlink(outside, join(root, "pointer.txt"));
  await write("unlinked.txt", "New");
  const result = await manager.restore(checkpoint.id, root);
  expect(result).toEqual({ id: checkpoint.id, restoredFiles: ["keep.txt"], removedFiles: ["unlinked.txt"] });
  expect((await lstat(join(root, "alias.txt"))).nlink).toBe(2);
  expect((await lstat(join(root, "pointer.txt"))).isSymbolicLink()).toBe(true);
  expect(await readFile(outside)).toEqual(Buffer.from("Outside"));
});

test("releases partial snapshot directories when a capture exceeds the budget", async () => {
  initGit();
  await write("small.bin", Buffer.from([7]));
  await write("too-large.bin", Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(manager.create(root, { label: "Oversized" })).rejects.toMatchObject({ code: "LIMIT" });
  expect(await readdir(join(dataDir, "checkpoints"))).toEqual([]);
  expect(await manager.list(root)).toEqual([]);
});

test("checks every blob before writing and rejects missing or cross-workspace checkpoints", async () => {
  await write("first.txt", "Before");
  await write("second.txt", "Another before");
  const checkpoint = await manager.create(root, { label: "Before edits" });
  const other = join(fixture, "other");
  await mkdir(other);
  await expect(manager.restore("missing", root)).rejects.toMatchObject({ code: -32004, message: "Checkpoint not found." });
  await expect(manager.restore(checkpoint.id, other)).rejects.toMatchObject({ code: -32004, message: "Checkpoint not found." });
  const hash = createHash("sha256").update("Another before").digest("hex");
  const blob = join(dataDir, "checkpoints", checkpoint.id, "files", hash);
  await writeFile(blob, "Corrupt");
  await write("first.txt", "After");
  await write("second.txt", "Another after");
  await expect(manager.restore(checkpoint.id, root)).rejects.toMatchObject({ code: "IO" });
  expect(await read("first.txt")).toEqual(Buffer.from("After"));
  expect(await read("second.txt")).toEqual(Buffer.from("Another after"));
  expect((await manager.list(root))[0]?.restoredAt).toBeUndefined();
});

test("prunes the oldest snapshots and blobs per workspace across queued creates", async () => {
  await write("fixture.txt", "Sample");
  const other = join(fixture, "other");
  await mkdir(other);
  const separate = await manager.create(other, { label: "Separate workspace" });
  const checkpoints = await Promise.all(Array.from({ length: 32 }, (_, i) => manager.create(root, { label: String(i) })));
  expect(await manager.list(root)).toEqual(checkpoints.slice(-20).reverse());
  expect(await manager.list(root, 100)).toEqual(checkpoints.slice(-30).reverse());
  expect(await manager.list(other)).toEqual([separate]);
  const remaining = await readdir(join(dataDir, "checkpoints"));
  expect(remaining.sort()).toEqual([separate.id, ...checkpoints.slice(-30).map(({ id }) => id)].sort());
});
