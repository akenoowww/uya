import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ArenaSlotInput, ArenaSummary } from "@ide/protocol";
import { WorktreeArenaManager, type ArenaStore } from "./worktrees";

class MemoryStore implements ArenaStore {
  readonly arenas = new Map<string, ArenaSummary>();
  failOn?: ArenaSummary["status"];

  saveArena(arena: ArenaSummary): void {
    if (this.failOn === arena.status) throw new Error("Fixture persistence failure");
    this.arenas.set(arena.id, structuredClone(arena));
  }

  getArena(id: string): ArenaSummary | undefined {
    return structuredClone(this.arenas.get(id));
  }

  listArenas = mock((workspacePath?: string, limit?: number): ArenaSummary[] => [...this.arenas.values()]
    .filter((arena) => workspacePath === undefined || arena.workspacePath === workspacePath)
    .slice(0, limit).map((arena) => structuredClone(arena)));
}

const slots: ArenaSlotInput[] = [
  { paneId: "left", providerId: "fixture-a", providerName: "Fixture A", model: "fixture-model", effort: "medium" },
  { paneId: "right", providerId: "fixture-b", providerName: "Fixture B" },
];
const prompt = "Make a change in an isolated checkout";
let fixture: string;
let workspace: string;
let dataDir: string;
let store: MemoryStore;
let manager: WorktreeArenaManager;

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)));
  return execFileSync("git", [
    "--no-optional-locks", "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", ...args,
  ], {
    cwd, encoding: "utf8", timeout: 8000,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
}

async function file(root: string, path: string, content: string | Buffer) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function read(root: string, path: string) {
  return readFile(join(root, path), "utf8");
}

function commitFixture(cwd: string, parent?: string): string {
  git(cwd, "add", "--all");
  const tree = git(cwd, "write-tree").trim();
  const identity = ["-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.test"];
  const commit = git(cwd, ...identity, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Fixture snapshot").trim();
  git(cwd, "update-ref", "HEAD", commit);
  return commit;
}

async function baseline(files: Record<string, string | Buffer>): Promise<string> {
  for (const [path, content] of Object.entries(files)) await file(workspace, path, content);
  return commitFixture(workspace);
}

async function expectCleaned(arena: ArenaSummary) {
  for (const slot of arena.slots) {
    await expect(lstat(slot.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(workspace, "worktree", "list", "--porcelain")).not.toContain(slot.worktreePath);
  }
  expect(git(workspace, "branch", "--list", `uya-arena/${arena.id}/*`)).toBe("");
}

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "uya-arena-test-")));
  workspace = join(fixture, "workspace");
  dataDir = join(fixture, "data");
  await mkdir(workspace);
  git(workspace, "init", "-q", "--initial-branch=main", "--template=");
  git(workspace, "config", "--local", "user.name", "Configured Author");
  git(workspace, "config", "--local", "user.email", "configured@example.test");
  store = new MemoryStore();
  manager = new WorktreeArenaManager(dataDir, store);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

test("creates two isolated slots and persists run, verify and refreshed stats", async () => {
  const baseCommit = await baseline({ "note.md": "base\n" });
  const arena = await manager.create(workspace, { prompt, slots });
  const [left, right] = arena.slots;
  expect(arena).toMatchObject({ workspacePath: workspace, baseBranch: "main", baseCommit, prompt, status: "active" });
  expect(arena.id).toMatch(/^[0-9a-f]{16}$/u);
  expect(left).toMatchObject({ ...slots[0], id: "slot-1", branch: `uya-arena/${arena.id}/slot-1`, status: "ready" });
  expect(right).toMatchObject({ ...slots[1], id: "slot-2", branch: `uya-arena/${arena.id}/slot-2`, status: "ready" });
  if (process.platform !== "win32") expect((await lstat(dirname(left.worktreePath))).mode & 0o777).toBe(0o700);

  await file(left.worktreePath, "note.md", "left\nnew\n");
  await file(right.worktreePath, "note.md", "right\n");
  await file(right.worktreePath, "right-only.txt", "isolated\n");
  expect(await read(workspace, "note.md")).toBe("base\n");
  expect(await read(left.worktreePath, "note.md")).toBe("left\nnew\n");
  expect(await read(right.worktreePath, "note.md")).toBe("right\n");
  await expect(lstat(join(left.worktreePath, "right-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(git(workspace, "status", "--porcelain")).toBe("");

  expect(manager.attachRun(arena.id, left.id, "run-1")?.slots[0]).toMatchObject({ status: "running", runId: "run-1" });
  expect(manager.attachRun(arena.id, "unknown", "run-2")).toBeUndefined();
  const verify = { command: "check", status: "passed", exitCode: 0, durationMs: 12, output: "ok" } as const;
  const refreshing = manager.refreshSlot(arena.id, left.id, "succeeded");
  expect(manager.recordVerify(arena.id, left.id, verify).verify).toEqual(verify);
  expect((await refreshing).slots[0]).toMatchObject({ status: "succeeded", runId: "run-1", verify, filesChanged: 1 });
  const refreshed = await manager.get(arena.id);
  expect(refreshed.slots[0]).toMatchObject({ additions: 2, deletions: 1 });
  expect(refreshed.slots[1]).toMatchObject({ additions: 2, deletions: 1, filesChanged: 2 });
  expect(manager.list(workspace)).toEqual([refreshed]);
  expect(store.listArenas).toHaveBeenCalledWith(workspace, 20);
});

test("seeds both slots with public staged, unstaged, binary and eligible untracked work", async () => {
  const originalBinary = Buffer.alloc(2 * 1024 * 1024 + 4096);
  const editedBinary = randomBytes(originalBinary.length);
  editedBinary[0] = 0;
  await baseline({ "note.md": "base\n", "delete.md": "remove\n", "blob.bin": originalBinary, ".env.test": "" });
  await file(workspace, "note.md", "staged\n");
  await file(workspace, "staged.md", "new staged file\n");
  git(workspace, "add", "--", "note.md", "staged.md");
  await file(workspace, "note.md", "working\n");
  await file(workspace, "blob.bin", editedBinary);
  await rm(join(workspace, "delete.md"));
  await file(workspace, "nested/scratch.md", "public scratch\n");
  await file(workspace, ".env.example", "PUBLIC_SAMPLE=true\n");
  await file(workspace, ".env", "");
  git(workspace, "rm", "-q", "--", ".env.test");
  await file(workspace, "large.bin", Buffer.alloc(1024 * 1024 + 1));
  await file(fixture, "outside.txt", "linked fixture\n");
  await link(join(fixture, "outside.txt"), join(workspace, "hardlink.txt"));
  await symlink(join(fixture, "outside.txt"), join(workspace, "symlink.txt"));

  const arena = await manager.create(workspace, { prompt, slots, includeDirty: true });
  for (const slot of arena.slots) {
    expect(await read(slot.worktreePath, "note.md")).toBe("working\n");
    expect(await read(slot.worktreePath, "staged.md")).toBe("new staged file\n");
    expect(await read(slot.worktreePath, "nested/scratch.md")).toBe("public scratch\n");
    expect(await read(slot.worktreePath, ".env.example")).toBe("PUBLIC_SAMPLE=true\n");
    expect((await lstat(join(slot.worktreePath, ".env.test"))).isFile()).toBe(true);
    expect((await readFile(join(slot.worktreePath, "blob.bin"))).compare(editedBinary)).toBe(0);
    for (const path of ["delete.md", ".env", "large.bin", "hardlink.txt", "symlink.txt"]) {
      await expect(lstat(join(slot.worktreePath, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(slot.filesChanged).toBe(6);
  }
  expect(git(workspace, "show", ":note.md")).toBe("staged\n");
  expect(await read(workspace, "note.md")).toBe("working\n");

  const cleanArena = await manager.create(workspace, { prompt, slots, includeDirty: false });
  expect(await read(cleanArena.slots[0].worktreePath, "note.md")).toBe("base\n");
  await expect(lstat(join(cleanArena.slots[0].worktreePath, "nested/scratch.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("returns tracked, renamed, deleted and untracked diffs relative to the arena base", async () => {
  const path = "note [draft].md";
  await baseline({ [path]: "base\n", "delete.md": "old\n", "old name.md": "rename content\n", ".env": "" });
  const arena = await manager.create(workspace, { prompt, slots, includeDirty: false });
  const { id, worktreePath } = arena.slots[0];
  await file(worktreePath, path, "commit\n");
  commitFixture(worktreePath, arena.baseCommit);
  await file(worktreePath, path, "working\n");
  await file(worktreePath, "-scratch note.md", "first\nsecond");
  await rm(join(worktreePath, "delete.md"));
  git(worktreePath, "mv", "--", "old name.md", "new name.md");
  git(worktreePath, "mv", "--", ".env", "renamed-env.txt");

  const full = await manager.slotDiff(arena.id, id);
  expect(full).toMatchObject({ staged: false });
  expect(full.diff).toContain("-base\n+working\n");
  expect(full.diff).toContain("rename from old name.md\nrename to new name.md");
  expect(full.diff).toContain("+first\n+second\n\\ No newline at end of file\n");
  expect(full.diff).not.toMatch(/renamed-env|\.env/u);
  expect(await manager.slotDiff(arena.id, id, path)).toMatchObject({
    path, original: "base\n", modified: "working\n", diff: expect.stringContaining("-base\n+working\n"),
  });
  expect(await manager.slotDiff(arena.id, id, "delete.md")).toMatchObject({ original: "old\n", modified: "" });
  expect(await manager.slotDiff(arena.id, id, "-scratch note.md")).toMatchObject({
    original: "", modified: "first\nsecond", diff: expect.stringContaining("--- /dev/null\n"),
  });
  await expect(manager.slotDiff(arena.id, id, "../note.md")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  for (const blocked of [".env", "renamed-env.txt", "var/ai/note.md"]) {
    await expect(manager.slotDiff(arena.id, id, blocked)).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
  expect((await manager.get(arena.id)).slots[0].files).toEqual([
    { path: "-scratch note.md", status: "untracked", additions: 2, deletions: 0 },
    { path: "delete.md", status: "deleted", additions: 0, deletions: 1 },
    { path: "new name.md", status: "renamed", additions: 0, deletions: 0 },
    { path, status: "modified", additions: 1, deletions: 1 },
  ]);
});

test("applies a workspace winner after checkpointing, with deletions and renames", async () => {
  const base = await baseline({ "note.md": "base\n", "delete.md": "remove\n", "old.md": "name\n", "untouched.md": "base\n" });
  const createCheckpoint = mock(async () => {
    expect(await read(workspace, "note.md")).toBe("base\n");
    expect(await read(workspace, "delete.md")).toBe("remove\n");
    return { id: "pre-apply-checkpoint" };
  });
  manager = new WorktreeArenaManager(dataDir, store, { createCheckpoint });
  const arena = await manager.create(workspace, { prompt, slots });
  const winner = arena.slots[1];
  await file(winner.worktreePath, "note.md", "winner\n");
  await file(winner.worktreePath, "nested/added.bin", Buffer.from([0, 1, 255]));
  await file(winner.worktreePath, ".env", "");
  await rm(join(winner.worktreePath, "delete.md"));
  git(winner.worktreePath, "mv", "--", "old.md", "renamed.md");
  await file(workspace, "untouched.md", "user still editing\n");
  git(workspace, "add", "--", "untouched.md");

  const result = await manager.apply(arena.id, winner.id, { mode: "workspace" });
  expect(result).toMatchObject({ arenaId: arena.id, slotId: winner.id, mode: "workspace", checkpointId: "pre-apply-checkpoint" });
  expect(result.appliedFiles.sort()).toEqual(["delete.md", "nested/added.bin", "note.md", "old.md", "renamed.md"]);
  expect(createCheckpoint).toHaveBeenCalledWith(workspace, "Before applying arena winner (Fixture B)");
  expect(await read(workspace, "note.md")).toBe("winner\n");
  expect(await read(workspace, "renamed.md")).toBe("name\n");
  expect([...(await readFile(join(workspace, "nested/added.bin")))]).toEqual([0, 1, 255]);
  for (const path of ["delete.md", "old.md", ".env"]) await expect(lstat(join(workspace, path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(base);
  expect(git(workspace, "diff", "--cached", "--name-only").trim()).toBe("untouched.md");
  expect(await manager.get(arena.id)).toMatchObject({ status: "applied", appliedSlotId: winner.id });
  expect((await manager.get(arena.id)).slots[1].status).toBe("applied");
  await expectCleaned(arena);
});

test("publishes a branch winner with the configured identity and only eligible changes", async () => {
  const base = await baseline({ "note.md": "base\n", "delete.md": "remove\n" });
  const arena = await manager.create(workspace, { prompt, slots, includeDirty: false });
  const { id, worktreePath } = arena.slots[0];
  await file(worktreePath, "note.md", "committed slot edit\n");
  await file(worktreePath, ".env", "");
  commitFixture(worktreePath, base);
  await file(worktreePath, ".env.local", "");
  git(worktreePath, "add", "--", ".env.local");
  await file(worktreePath, "new.md", "untracked slot edit\n");
  await rm(join(worktreePath, "delete.md"));

  await expect(manager.apply(arena.id, id, { mode: "branch", branchName: "-bad" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(manager.apply(arena.id, id, { mode: "branch", branchName: "main" })).rejects.toMatchObject({ code: "CONFLICT" });
  const result = await manager.apply(arena.id, id, { mode: "branch", branchName: "review/winner" });
  expect(result).toMatchObject({ arenaId: arena.id, slotId: id, mode: "branch", branchName: "review/winner" });
  expect(result.appliedFiles.sort()).toEqual(["delete.md", "new.md", "note.md"]);
  expect(git(workspace, "log", "-1", "--format=%an <%ae>%n%P", "review/winner").trim()).toBe(`Configured Author <configured@example.test>\n${base}`);
  expect(git(workspace, "diff", "--name-only", base, "review/winner").trim().split("\n")).toEqual(["delete.md", "new.md", "note.md"]);
  expect(git(workspace, "show", "review/winner:note.md")).toBe("committed slot edit\n");
  expect(git(workspace, "show", "review/winner:new.md")).toBe("untracked slot edit\n");
  expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(base);
  expect(await read(workspace, "note.md")).toBe("base\n");
  expect(git(workspace, "status", "--porcelain")).toBe("");
  await expectCleaned(arena);
});

test("honors cleanup false and retains the default winner branch after discard", async () => {
  await baseline({ "note.md": "base\n" });
  git(workspace, "config", "--local", "user.name", "");
  git(workspace, "config", "--local", "user.email", "");
  const arena = await manager.create(workspace, { prompt, slots });
  const slot = arena.slots[0];
  await file(slot.worktreePath, "note.md", "winner\n");
  const winner = `uya-arena-winner-${arena.id.slice(0, 6)}`;
  expect((await manager.apply(arena.id, slot.id, { mode: "branch", cleanup: false })).branchName).toBe(winner);
  expect(await read(slot.worktreePath, "note.md")).toBe("winner\n");
  expect(git(workspace, "log", "-1", "--format=%an <%ae>", winner).trim()).toBe("Uya Arena <uya@local>");
  expect(git(workspace, "rev-parse", slot.branch)).toBe(git(workspace, "rev-parse", winner));
  await manager.discard(arena.id);
  expect((await manager.get(arena.id)).slots.map(({ status }) => status)).toEqual(["applied", "discarded"]);
  expect(git(workspace, "show", `${winner}:note.md`)).toBe("winner\n");
  await expectCleaned(arena);
});

test("cleans orphan directories, preserves active arenas and discards missing worktrees", async () => {
  await manager.cleanupOrphans();
  await baseline({ "note.md": "base\n" });
  const arena = await manager.create(workspace, { prompt, slots });
  const root = dirname(arena.slots[0].worktreePath);
  const orphan = join(dirname(root), "orphan");
  const outside = join(fixture, "outside");
  await file(orphan, "slot-1/stale.md", "stale\n");
  await file(outside, "keep.md", "outside\n");
  await symlink(outside, join(dirname(root), "outside-link"), "dir");
  await manager.cleanupOrphans();
  await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await read(outside, "keep.md")).toBe("outside\n");
  expect(await read(arena.slots[0].worktreePath, "note.md")).toBe("base\n");

  await rm(arena.slots[0].worktreePath, { recursive: true });
  await file(arena.slots[1].worktreePath, "note.md", "alive\n");
  expect((await manager.get(arena.id)).slots.map(({ filesChanged }) => filesChanged)).toEqual([0, 1]);
  await manager.discard(arena.id);
  expect(await manager.get(arena.id)).toMatchObject({ status: "discarded", slots: [{ status: "discarded" }, { status: "discarded" }] });
  await expectCleaned(arena);
});

test("rejects unborn repositories and reports missing arenas", async () => {
  await expect(manager.create(workspace, { prompt, slots })).rejects.toMatchObject({
    code: "CONFLICT", message: "Create an initial Git commit before starting a Worktree Arena.",
  });
  await expect(manager.create(workspace, { prompt, slots: slots.slice(0, 1) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(manager.get("missing")).rejects.toMatchObject({ code: -32004, message: "Arena not found." });
  expect(manager.attachRun("missing", "slot-1", "run-1")).toBeUndefined();
  expect(manager.list()).toEqual([]);
});

test("rolls back created worktrees and branches when initial persistence fails", async () => {
  await baseline({ "note.md": "base\n" });
  store.failOn = "active";
  await expect(manager.create(workspace, { prompt, slots })).rejects.toThrow("Fixture persistence failure");
  expect(git(workspace, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  expect(git(workspace, "branch", "--list", "uya-arena/*")).toBe("");
  expect(manager.list()).toEqual([]);
});

test.skipIf(process.platform === "win32")("rolls back when Git fails during the second worktree add", async () => {
  await baseline({ "note.md": "base\n" });
  const bin = join(fixture, "bin");
  const wrapper = join(bin, "git");
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("Git is required for the fixture");
  await file(bin, "git", `#!/bin/sh
add=
second=
for arg do
  case "$arg" in
    add) add=yes ;;
    uya-arena/*/slot-2) second=yes ;;
  esac
done
if [ "$add" ] && [ "$second" ]; then
  "$UYA_FIXTURE_GIT" "$@" || exit "$?"
  exit 21
fi
exec "$UYA_FIXTURE_GIT" "$@"
`);
  await chmod(wrapper, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  process.env.UYA_FIXTURE_GIT = realGit;
  try {
    await expect(manager.create(workspace, { prompt, slots })).rejects.toMatchObject({ code: "IO", exitCode: 21 });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.UYA_FIXTURE_GIT;
  }
  expect(git(workspace, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  expect(git(workspace, "branch", "--list", "uya-arena/*")).toBe("");
  expect(manager.list()).toEqual([]);
});

test("rejects linked destinations during preflight and restores files after a failed save", async () => {
  await baseline({ "first.md": "base\n", "nested/last.md": "original\n" });
  const checkpoint = mock(async () => ({ id: "pre-apply" }));
  manager = new WorktreeArenaManager(dataDir, store, { createCheckpoint: checkpoint });
  const arena = await manager.create(workspace, { prompt, slots });
  const slot = arena.slots[0];
  await expect(manager.apply(arena.id, slot.id, { mode: "workspace" })).rejects.toMatchObject({
    code: "CONFLICT", message: "This arena slot has no file changes to apply.",
  });
  await file(slot.worktreePath, "first.md", "winner\n");
  await file(slot.worktreePath, "nested/last.md", "winner\n");
  await file(slot.worktreePath, "new/deeper/new.md", "new\n");
  await file(fixture, "outside/last.md", "outside\n");
  await rm(join(workspace, "nested"), { recursive: true });
  await symlink(join(fixture, "outside"), join(workspace, "nested"), "dir");
  await expect(manager.apply(arena.id, slot.id, { mode: "workspace" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(checkpoint).not.toHaveBeenCalled();
  expect(await read(workspace, "first.md")).toBe("base\n");
  expect(await read(fixture, "outside/last.md")).toBe("outside\n");

  await rm(join(workspace, "nested"));
  await file(workspace, "nested/last.md", "original\n");
  store.failOn = "applied";
  await expect(manager.apply(arena.id, slot.id, { mode: "workspace" })).rejects.toThrow("Fixture persistence failure");
  expect(await read(workspace, "first.md")).toBe("base\n");
  expect(await read(workspace, "nested/last.md")).toBe("original\n");
  await expect(lstat(join(workspace, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(git(workspace, "status", "--porcelain")).toBe("");
  expect((await manager.get(arena.id)).status).toBe("active");
});

test("applies file and directory replacements and rolls them back if saving fails", async () => {
  await baseline({ "becomes-file/nested/delete.md": "original child\n", "becomes-dir": "original file\n" });
  const arena = await manager.create(workspace, { prompt, slots });
  const { id, worktreePath } = arena.slots[0];
  await rm(join(worktreePath, "becomes-file"), { recursive: true });
  await rm(join(worktreePath, "becomes-dir"));
  await file(worktreePath, "becomes-file", "replacement file\n");
  await file(worktreePath, "becomes-dir/nested/added.md", "replacement child\n");

  store.failOn = "applied";
  await expect(manager.apply(arena.id, id, { mode: "workspace" })).rejects.toThrow("Fixture persistence failure");
  expect(await read(workspace, "becomes-dir")).toBe("original file\n");
  expect(await read(workspace, "becomes-file/nested/delete.md")).toBe("original child\n");
  expect(git(workspace, "status", "--porcelain")).toBe("");

  store.failOn = undefined;
  const result = await manager.apply(arena.id, id, { mode: "workspace" });
  expect(result.appliedFiles.sort()).toEqual(["becomes-dir", "becomes-dir/nested/added.md", "becomes-file", "becomes-file/nested/delete.md"]);
  expect(await read(workspace, "becomes-file")).toBe("replacement file\n");
  expect(await read(workspace, "becomes-dir/nested/added.md")).toBe("replacement child\n");
  await expectCleaned(arena);
});

test("a file replacement cannot remove a protected descendant in either apply mode", async () => {
  const base = await baseline({ "folder/.env": "", "folder/public.txt": "original\n" });
  const arena = await manager.create(workspace, { prompt, slots });
  const { id, worktreePath } = arena.slots[0];
  await rm(join(worktreePath, "folder"), { recursive: true });
  await file(worktreePath, "folder", "replacement\n");

  await expect(manager.apply(arena.id, id, { mode: "branch", branchName: "rejected-winner" })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(git(workspace, "branch", "--list", "rejected-winner")).toBe("");
  expect(git(workspace, "rev-parse", arena.slots[0].branch).trim()).toBe(base);
  await expect(manager.apply(arena.id, id, { mode: "workspace" })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await read(workspace, "folder/public.txt")).toBe("original\n");
  expect((await lstat(join(workspace, "folder/.env"))).isFile()).toBe(true);
  expect(git(workspace, "status", "--porcelain")).toBe("");
  expect((await manager.get(arena.id)).status).toBe("active");
});

test("scopes dirty seeding, diff and apply to a workspace under the repository root", async () => {
  await baseline({ "project dir/note.md": "inside base\n", "outside.md": "outside base\n" });
  await file(workspace, "project dir/note.md", "inside dirty\n");
  await file(workspace, "outside.md", "outside dirty\n");
  const selected = join(workspace, "project dir");
  const arena = await manager.create(selected, { prompt, slots });
  const { id, worktreePath } = arena.slots[0];
  expect(arena.workspacePath).toBe(selected);
  expect(await read(worktreePath, "note.md")).toBe("inside dirty\n");
  expect(await read(dirname(worktreePath), "outside.md")).toBe("outside base\n");
  await file(worktreePath, "note.md", "inside winner\n");
  await file(dirname(worktreePath), "outside.md", "ignored checkout edit\n");
  expect(await manager.slotDiff(arena.id, id, "note.md")).toMatchObject({ original: "inside base\n", modified: "inside winner\n" });
  expect((await manager.slotDiff(arena.id, id)).diff).not.toContain("outside.md");
  expect((await manager.apply(arena.id, id, { mode: "workspace" })).appliedFiles).toEqual(["note.md"]);
  expect(await read(selected, "note.md")).toBe("inside winner\n");
  expect(await read(workspace, "outside.md")).toBe("outside dirty\n");
  await expectCleaned(arena);
});

test("ignores inherited Git overrides and disables checkout hooks and file filters", async () => {
  await baseline({ ".gitattributes": "*.md filter=fixture\n", "note.md": "base\n" });
  const hooks = join(fixture, "hooks");
  await file(hooks, "post-checkout", "#!/bin/sh\nexit 97\n");
  await chmod(join(hooks, "post-checkout"), 0o700);
  git(workspace, "config", "--local", "core.hooksPath", hooks);
  for (const key of ["clean", "smudge", "process"]) {
    git(workspace, "config", "--local", `filter.fixture.${key}`, "uya-arena-fixture-nonexistent-program");
  }
  git(workspace, "config", "--local", "filter.fixture.required", "true");
  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(fixture, "missing.git");
  try {
    await file(workspace, "note.md", "public edit\n");
    const arena = await manager.create(workspace, { prompt, slots });
    const [slot] = arena.slots;
    expect(await manager.slotDiff(arena.id, slot.id, "note.md")).toMatchObject({
      original: "base\n", modified: "public edit\n", diff: expect.stringContaining("+public edit\n"),
    });
    await manager.discard(arena.id);
    await expectCleaned(arena);
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
});
