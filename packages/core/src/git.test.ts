import { execFileSync } from "node:child_process";
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gitBranches, gitCheckout, gitCommit, gitCreateBranch, gitDiff, gitDiscard, gitLog, gitStage, gitStatus, gitUnstage } from "./git";

let root: string;

function git(...args: string[]) {
  return execFileSync("git", [
    "-c", "user.name=Uya Fixture",
    "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgSign=false",
    ...args,
  ], {
    cwd: root,
    timeout: 8000,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
}

async function commitFiles(files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  git("add", "--all");
  git("commit", "-qm", "Fixture baseline");
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "uya-git-")));
  git("init", "-q", "--initial-branch=main", "--template=");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("git status", () => {
  test("detects an unborn branch and a non-repository folder", async () => {
    expect(await gitStatus(root)).toEqual({ isRepo: true, branch: "main", changes: [] });
    const plain = await realpath(await mkdtemp(join(tmpdir(), "uya-plain-")));
    try {
      expect(await gitStatus(plain)).toEqual({ isRepo: false, changes: [] });
      expect(await gitDiff(plain)).toEqual({ diff: "", staged: false });
      expect(await gitDiff(plain, { path: "missing.md", staged: true })).toEqual({ path: "missing.md", diff: "", staged: true });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("parses staged, unstaged, renamed and nested untracked paths", async () => {
    await commitFiles({
      "both.txt": "original\n",
      "delete.txt": "remove\n",
      "before name.txt": "rename fixture\n",
    });
    await writeFile(join(root, "both.txt"), "index\n");
    await writeFile(join(root, "add.txt"), "added\n");
    git("add", "--", "both.txt", "add.txt");
    await writeFile(join(root, "both.txt"), "working copy\n");
    git("mv", "--", "before name.txt", "after name.txt");
    await rm(join(root, "delete.txt"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/ untracked.txt"), "local only\n");

    expect(await gitStatus(root)).toEqual({
      isRepo: true,
      branch: "main",
      changes: [
        { path: "add.txt", status: "added", staged: true },
        { path: "after name.txt", status: "renamed", staged: true },
        { path: "both.txt", status: "modified", staged: true },
        { path: "both.txt", status: "modified", staged: false },
        { path: "delete.txt", status: "deleted", staged: false },
        { path: "nested/ untracked.txt", status: "untracked", staged: false },
      ],
    });
  });

  test("reports upstream divergence and handles a detached head", async () => {
    await commitFiles({ "readme.md": "fixture\n" });
    git("branch", "upstream");
    git("commit", "-qm", "Main", "--allow-empty");
    git("switch", "-q", "upstream");
    git("commit", "-qm", "Upstream", "--allow-empty");
    git("switch", "-q", "main");
    git("branch", "--set-upstream-to=upstream", "main");
    expect(await gitStatus(root)).toEqual({ isRepo: true, branch: "main", ahead: 1, behind: 1, changes: [] });
    git("switch", "-q", "--detach");
    expect(await gitStatus(root)).toEqual({ isRepo: true, changes: [] });
  });
});

describe("git diff", () => {
  test("uses HEAD to index for staged diffs and index to disk for unstaged diffs", async () => {
    const path = "note [draft].md";
    await commitFiles({ [path]: "HEAD version\n" });
    await writeFile(join(root, path), "index version\n");
    git("--literal-pathspecs", "add", "--", path);
    await writeFile(join(root, path), "working version\n");

    const staged = await gitDiff(root, { path, staged: true });
    expect(staged).toMatchObject({ path, staged: true, original: "HEAD version\n", modified: "index version\n" });
    expect(staged.diff).toContain("-HEAD version\n+index version\n");
    expect(staged.diff).not.toContain("working version");
    const unstaged = await gitDiff(root, { path });
    expect(unstaged).toMatchObject({ path, staged: false, original: "index version\n", modified: "working version\n" });
    expect(unstaged.diff).toContain("-index version\n+working version\n");
    expect(unstaged.diff).not.toContain("HEAD version");
    expect(await gitDiff(root, { staged: true })).toEqual({ staged: true, diff: staged.diff });
    expect(await gitDiff(root)).toEqual({ staged: false, diff: unstaged.diff });
  });

  test("provides empty text for absent sides of additions and deletions", async () => {
    const added = "added.md";
    await writeFile(join(root, added), "new in an unborn branch\n");
    git("add", "--", added);
    expect(await gitDiff(root, { path: added, staged: true })).toMatchObject({
      path: added, staged: true, original: "", modified: "new in an unborn branch\n",
      diff: expect.stringContaining("+new in an unborn branch\n"),
    });
    git("commit", "-qm", "Fixture baseline");
    await rm(join(root, added));
    expect(await gitDiff(root, { path: added })).toMatchObject({
      path: added, original: "new in an unborn branch\n", modified: "",
      diff: expect.stringContaining("-new in an unborn branch\n"),
    });
    git("add", "--", added);
    expect(await gitDiff(root, { path: added, staged: true })).toMatchObject({
      path: added, original: "new in an unborn branch\n", modified: "",
      diff: expect.stringContaining("-new in an unborn branch\n"),
    });
  });

  test("provides a unified addition and editor text for an untracked file", async () => {
    const path = "-notes [draft].md";
    await writeFile(join(root, path), "First line\nSecond line");
    const result = await gitDiff(root, { path });
    expect(result).toMatchObject({ path, staged: false, original: "", modified: "First line\nSecond line" });
    expect(result.diff).toContain(
      '--- /dev/null\n+++ "b/-notes [draft].md"\n@@ -0,0 +1,2 @@\n+First line\n+Second line\n\\ No newline at end of file\n',
    );
    expect(await gitDiff(root)).toEqual({ staged: false, diff: "" });
    expect(await gitDiff(root, { path, staged: true })).toEqual({ path, staged: true, diff: "", original: "", modified: "" });
  });

  test("does not synthesize an addition for an unchanged tracked empty file", async () => {
    const path = "empty.txt";
    await commitFiles({ [path]: "" });
    expect(await gitDiff(root, { path })).toEqual({ path, staged: false, diff: "", original: "", modified: "" });
  });

  test("scopes status, patches and snapshots to a workspace selected inside the repository", async () => {
    await mkdir(join(root, "sub project"));
    await commitFiles({ "sub project/in.md": "inside baseline\n", "out.md": "outside baseline\n" });
    await writeFile(join(root, "sub project/in.md"), "inside edit\n");
    await writeFile(join(root, "out.md"), "outside edit\n");
    const workspace = join(root, "sub project");
    expect((await gitStatus(workspace)).changes).toEqual([{ path: "in.md", status: "modified", staged: false }]);
    expect(await gitDiff(workspace, { path: "in.md" })).toMatchObject({
      original: "inside baseline\n", modified: "inside edit\n", diff: expect.stringContaining("+inside edit\n"),
    });
    expect((await gitDiff(workspace)).diff).not.toContain("outside edit");
    await expect(gitDiff(workspace, { path: "../out.md" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(gitDiff(workspace, { path: join(root, "out.md") })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("truncates large Git output inside the byte budget at a UTF-8 boundary", async () => {
    const path = "large.txt";
    await commitFiles({ [path]: "small baseline\n" });
    await writeFile(join(root, path), "🌏".repeat(600_000) + "\n");
    const result = await gitDiff(root, { path });
    expect(result.original).toBe("small baseline\n");
    expect(result.modified).toBeUndefined();
    expect(result.diff).toContain("+🌏🌏");
    expect(result.diff.endsWith("\n[Diff truncated at 512 KiB]\n")).toBe(true);
    expect(result.diff).not.toContain("\ufffd");
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(512 * 1024);
  });

  test("does not invoke configured diff drivers or clean filters", async () => {
    await commitFiles({ ".gitattributes": "*.txt diff=fixture filter=fixture\n", "note.txt": "baseline\n" });
    git("config", "--local", "diff.fixture.command", "uya-fixture-diff-driver-does-not-exist");
    git("config", "--local", "diff.fixture.textconv", "uya-fixture-textconv-does-not-exist");
    git("config", "--local", "filter.fixture.clean", "uya-fixture-clean-filter-does-not-exist");
    git("config", "--local", "filter.fixture.process", "uya-fixture-process-filter-does-not-exist");
    git("config", "--local", "filter.fixture.required", "true");
    await writeFile(join(root, "note.txt"), "changed\n");
    expect((await gitStatus(root)).changes).toEqual([{ path: "note.txt", status: "modified", staged: false }]);
    expect((await gitDiff(root, { path: "note.txt" })).diff).toContain("-baseline\n+changed\n");
  });
});

describe("Git path protection", () => {
  test("excludes protected tracked and untracked files from status and both aggregate patches", async () => {
    await mkdir(join(root, "var/ai"), { recursive: true });
    await commitFiles({
      ".env": "SYNTHETIC_FIXTURE=before\n",
      "var/ai/note.md": "restricted fixture baseline\n",
      "readme.md": "public baseline\n",
    });
    await writeFile(join(root, ".env"), "SYNTHETIC_FIXTURE=staged\n");
    await writeFile(join(root, "var/ai/note.md"), "restricted fixture staged\n");
    await writeFile(join(root, "readme.md"), "public index\n");
    git("add", "--all");
    await writeFile(join(root, ".env"), "SYNTHETIC_FIXTURE=working\n");
    await writeFile(join(root, "var/ai/note.md"), "restricted fixture working\n");
    await writeFile(join(root, "readme.md"), "public working\n");
    await writeFile(join(root, ".env.local"), "SYNTHETIC_FIXTURE=new\n");
    await writeFile(join(root, ".env.example"), "PUBLIC_SAMPLE=true\n");
    expect((await gitStatus(root)).changes).toEqual([
      { path: "readme.md", status: "modified", staged: true },
      { path: "readme.md", status: "modified", staged: false },
      { path: ".env.example", status: "untracked", staged: false },
    ]);
    for (const staged of [false, true]) {
      const { diff } = await gitDiff(root, { staged });
      expect(diff).toContain(staged ? "+public index" : "+public working");
      expect(diff).not.toMatch(/\.env|SYNTHETIC_FIXTURE|var\/ai|restricted fixture/u);
      for (const path of [".env", ".env.local", "var/ai/note.md"]) {
        await expect(gitDiff(root, { path, staged })).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
  });

  test("checks both sides of a staged rename", async () => {
    await commitFiles({ ".env": "SYNTHETIC_FIXTURE=rename\n", "before.txt": "public rename\n" });
    git("mv", "--", ".env", "renamed.txt");
    git("mv", "--", "before.txt", "after.txt");
    expect((await gitStatus(root)).changes).toEqual([{ path: "after.txt", status: "renamed", staged: true }]);
    const { diff } = await gitDiff(root, { staged: true });
    expect(diff).toContain("rename from before.txt");
    expect(diff).toContain("rename to after.txt");
    expect(diff).not.toMatch(/\.env|renamed\.txt|SYNTHETIC_FIXTURE/u);
    await expect(gitDiff(root, { path: "renamed.txt", staged: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(gitDiff(root, { path: "renamed.txt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("selects exact file paths when staging a directory replaced with a regular file", async () => {
    await mkdir(join(root, "folder"));
    await commitFiles({ "folder/.env": "SYNTHETIC_FIXTURE=former-child\n", "folder/public.md": "public child\n" });
    await rm(join(root, "folder"), { recursive: true });
    await writeFile(join(root, "folder"), "new regular file\n");
    git("add", "--all");
    const { diff } = await gitDiff(root, { staged: true });
    expect(diff).toContain("-public child\n");
    expect(diff).toContain("+new regular file\n");
    expect(diff).not.toMatch(/\.env|SYNTHETIC_FIXTURE/u);
    const file = await gitDiff(root, { path: "folder", staged: true });
    expect(file).toMatchObject({ original: "", modified: "new regular file\n" });
    expect(file.diff).toContain("+new regular file\n");
    expect(file.diff).not.toMatch(/public child|\.env|SYNTHETIC_FIXTURE/u);
  });

  test("does not display symbolic links or linked working files", async () => {
    await commitFiles({ "file.txt": "baseline\n" });
    const outside = await realpath(await mkdtemp(join(tmpdir(), "uya-outside-")));
    try {
      const external = join(outside, "external.md");
      await writeFile(external, "external fixture\n");
      await symlink(external, join(root, "alias.md"), "file");
      await rm(join(root, "file.txt"));
      await link(external, join(root, "file.txt"));
      expect((await gitStatus(root)).changes).toEqual([]);
      expect((await gitDiff(root)).diff).toBe("");
      await expect(gitDiff(root, { path: "alias.md" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(gitDiff(root, { path: "file.txt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("git stage and unstage", () => {
  test("stages exact paths and unstages index changes with working edits intact", async () => {
    const name = "-note [x].md";
    await commitFiles({ [name]: "baseline\n", "removed.md": "baseline\n", "-note x.md": "baseline\n" });
    await writeFile(join(root, name), "index\n");
    await writeFile(join(root, "-note x.md"), "different file\n");
    await rm(join(root, "removed.md"));
    expect((await gitStage(root, { paths: [name, "removed.md"] })).changes).toEqual([
      { path: name, status: "modified", staged: true },
      { path: "-note x.md", status: "modified", staged: false },
      { path: "removed.md", status: "deleted", staged: true },
    ]);
    await writeFile(join(root, name), "working edit\n");
    expect((await gitUnstage(root, { paths: [name] })).changes).toContainEqual({ path: name, status: "modified", staged: false });
    expect(git("diff", "--cached", "--name-only").trim()).toBe("removed.md");
    await gitUnstage(root, { all: true });
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(join(root, name), "utf8")).toBe("working edit\n");
  });

  test("stages all eligible files in a nested workspace and excludes protected files", async () => {
    await mkdir(join(root, "project"));
    await commitFiles({ "project/note.md": "baseline\n", "outside.md": "baseline\n" });
    const workspace = join(root, "project");
    await writeFile(join(workspace, "note.md"), "updated\n");
    await writeFile(join(workspace, ".env"), "SYNTHETIC_FIXTURE=local\n");
    await writeFile(join(workspace, ".env.example"), "PUBLIC_SAMPLE=true\n");
    await writeFile(join(root, "outside.md"), "outside edit\n");
    expect((await gitStage(workspace, { all: true })).changes).toEqual([
      { path: ".env.example", status: "added", staged: true },
      { path: "note.md", status: "modified", staged: true },
    ]);
    expect(git("diff", "--cached", "--name-only").trim().split("\n")).toEqual(["project/.env.example", "project/note.md"]);
    await gitUnstage(workspace, { all: true });
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  test("leaves protected index entries in place during file and directory replacements", async () => {
    await mkdir(join(root, "folder"));
    await commitFiles({ "folder/.env": "SYNTHETIC_FIXTURE=local\n", "safe.md": "baseline\n" });
    await rm(join(root, "folder"), { recursive: true });
    await writeFile(join(root, "folder"), "replacement\n");
    await writeFile(join(root, "safe.md"), "edited\n");
    await expect(gitStage(root, { paths: ["safe.md", "folder"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(git("diff", "--cached", "--name-only")).toBe("");
    await gitStage(root, { all: true });
    expect(git("diff", "--cached", "--name-only").trim()).toBe("safe.md");
    expect(git("ls-files", "folder/.env").trim()).toBe("folder/.env");
  });

  test("unstages an unborn branch even when the working file differs from its staged contents", async () => {
    await writeFile(join(root, ".env"), "SYNTHETIC_FIXTURE=local\n");
    await writeFile(join(root, "a.md"), "staged\n");
    await writeFile(join(root, "b.md"), "staged\n");
    await gitStage(root, { all: true });
    expect(git("ls-files").trim().split("\n")).toEqual(["a.md", "b.md"]);
    git("add", "--", ".env");
    await writeFile(join(root, "a.md"), "working edit\n");
    await gitUnstage(root, { paths: ["a.md"] });
    expect(git("ls-files").trim().split("\n")).toEqual([".env", "b.md"]);
    await gitUnstage(root, { all: true });
    expect(git("ls-files").trim()).toBe(".env");
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("working edit\n");
  });

  test("unstages both endpoints of a rename and protects renames with a restricted endpoint", async () => {
    await commitFiles({ "before.md": "public\n", ".env": "SYNTHETIC_FIXTURE=local\n" });
    git("mv", "--", "before.md", "after.md");
    git("mv", "--", ".env", "restricted-rename.md");
    await expect(gitUnstage(root, { paths: ["restricted-rename.md"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const status = await gitUnstage(root, { paths: ["after.md"] });
    expect(status.changes).toContainEqual({ path: "before.md", status: "deleted", staged: false });
    expect(status.changes).toContainEqual({ path: "after.md", status: "untracked", staged: false });
    expect(git("diff", "--cached", "--no-renames", "--name-only").trim().split("\n")).toEqual([".env", "restricted-rename.md"]);
  });

  test("handles an all-files selection beyond the command argument budget", async () => {
    const names = Array.from({ length: 110 }, (_, index) => `note-${index}-${"x".repeat(150)}.md`);
    await Promise.all(names.map((name) => writeFile(join(root, name), "fixture\n")));
    expect((await gitStage(root, { all: true })).changes.filter((change) => change.staged)).toHaveLength(names.length);
    expect((await gitUnstage(root, { all: true })).changes.filter((change) => !change.staged)).toHaveLength(names.length);
    expect(git("ls-files")).toBe("");
  });
});

describe("git discard", () => {
  test("restores tracked files from the index and removes only selected untracked files", async () => {
    await commitFiles({ "edited.md": "baseline\n", "removed.md": "baseline\n" });
    await writeFile(join(root, "edited.md"), "staged edit\n");
    await gitStage(root, { paths: ["edited.md"] });
    await writeFile(join(root, "edited.md"), "working edit\n");
    await rm(join(root, "removed.md"));
    await writeFile(join(root, "untracked.md"), "temporary\n");
    await writeFile(join(root, "keep.md"), "keep\n");

    expect((await gitDiscard(root, ["edited.md", "removed.md", "untracked.md"])).changes).toEqual([
      { path: "edited.md", status: "modified", staged: true },
      { path: "keep.md", status: "untracked", staged: false },
    ]);
    expect(await readFile(join(root, "edited.md"), "utf8")).toBe("staged edit\n");
    expect(await readFile(join(root, "removed.md"), "utf8")).toBe("baseline\n");
    await expect(access(join(root, "untracked.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("keep\n");
  });

  test("rejects restoring a path occupied by a directory", async () => {
    await commitFiles({ "note.md": "baseline\n" });
    await rm(join(root, "note.md"));
    await mkdir(join(root, "note.md"));
    await writeFile(join(root, "note.md", ".env"), "SYNTHETIC_FIXTURE=local\n");
    await expect(gitDiscard(root, ["note.md"])).rejects.toMatchObject({ code: "CONFLICT" });
    await access(join(root, "note.md", ".env"));
  });

  test("keeps a concurrently staged file on disk when discard runs after staging", async () => {
    await writeFile(join(root, "note.md"), "fixture\n");
    const [staged, discarded] = await Promise.all([
      gitStage(root, { paths: ["note.md"] }),
      gitDiscard(root, ["note.md"]),
    ]);
    expect(staged.changes).toEqual([{ path: "note.md", status: "added", staged: true }]);
    expect(discarded).toEqual(staged);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("fixture\n");
  });
});

describe("Git mutation path validation", () => {
  test("validates the full selection before any mutation", async () => {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "note.md"), "fixture\n");
    await writeFile(join(root, "nested", "child.md"), "fixture\n");
    await link(join(root, "note.md"), join(root, "hardlink.md"));
    await symlink(join(root, "nested"), join(root, "alias"), "dir");
    await symlink(join(root, "nested", "child.md"), join(root, "symlink.md"), "file");
    await writeFile(join(root, "safe.md"), "fixture\n");

    for (const mutate of [
      (paths: string[]) => gitStage(root, { paths }),
      (paths: string[]) => gitUnstage(root, { paths }),
      (paths: string[]) => gitDiscard(root, paths),
    ]) {
      await expect(mutate([])).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(mutate(["safe.md", "../outside.md"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(mutate(["safe.md", ".env"])).rejects.toMatchObject({ code: "FORBIDDEN", message: "This path is protected." });
      for (const path of ["hardlink.md", "alias/child.md", "symlink.md"]) {
        await expect(mutate(["safe.md", path])).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
    await expect(gitStage(root, { all: true, paths: [".env"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(git("ls-files")).toBe("");
    expect(await readFile(join(root, "safe.md"), "utf8")).toBe("fixture\n");
  });

  test("requires a Git worktree for mutations and history inspection", async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), "uya-plain-")));
    try {
      await expect(gitStage(plain, { all: true })).rejects.toMatchObject({
        code: "INVALID_INPUT", message: "This folder is not a Git repository.",
      });
      await expect(gitUnstage(plain, { all: true })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(gitDiscard(plain, ["note.md"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(gitCommit(plain, "Fixture")).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(gitBranches(plain)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(gitCheckout(plain, "main")).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(gitCreateBranch(plain, "topic")).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(gitLog(plain)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("git commit", () => {
  test("returns actual commit metadata and bypasses configured hooks and signing", async () => {
    git("config", "--local", "user.name", "Uya Fixture");
    git("config", "--local", "user.email", "fixture@example.test");
    git("config", "--local", "commit.gpgSign", "true");
    git("config", "--local", "gpg.program", "uya-fixture-gpg-does-not-exist");
    git("config", "--local", "commit.cleanup", "strip");
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks);
    git("config", "--local", "core.hooksPath", hooks);
    await writeFile(join(hooks, "prepare-commit-msg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(root, "note.md"), "fixture\n");
    await gitStage(root, { all: true });
    const result = await gitCommit(root, "  # Fixture subject \n\nBody\n ");
    expect(result).toEqual({
      hash: git("rev-parse", "HEAD").trim(),
      shortHash: git("rev-parse", "--short", "HEAD").trim(),
      branch: "main",
      subject: "# Fixture subject",
    });
    expect((await gitStatus(root)).changes).toEqual([]);
  });

  test("rejects empty or NUL messages, unstaged work and protected staged paths", async () => {
    await expect(gitCommit(root, " \n ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(gitCommit(root, "fixture\0message")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await writeFile(join(root, "untracked.md"), "fixture\n");
    await expect(gitCommit(root, "Fixture")).rejects.toMatchObject({
      code: "CONFLICT", message: "There are no staged changes to commit.",
    });
    git("add", "-N", "--", "untracked.md");
    await expect(gitCommit(root, "Fixture")).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(join(root, ".env"), "SYNTHETIC_FIXTURE=local\n");
    git("add", "--", ".env");
    await expect(gitCommit(root, "Fixture")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(git("diff", "--cached", "--name-only")).toContain(".env");
  });
});

describe("git branches and checkout", () => {
  test("creates and lists local branches with the current branch first and exact names", async () => {
    expect(await gitBranches(root)).toEqual([]);
    await commitFiles({ "note.md": "fixture\n" });
    const commit = git("rev-parse", "--short", "HEAD").trim();
    expect((await gitCreateBranch(root, "zeta", false)).branch).toBe("main");
    expect((await gitCreateBranch(root, "alpha")).branch).toBe("alpha");
    git("branch", "--set-upstream-to=main", "alpha");
    git("tag", "zeta");
    expect(await gitBranches(root)).toEqual([
      { name: "alpha", current: true, upstream: "main", commit },
      { name: "main", current: false, commit },
      { name: "zeta", current: false, commit },
    ]);
    await expect(gitCreateBranch(root, "zeta")).rejects.toMatchObject({ code: "CONFLICT", message: "That branch already exists." });
    expect((await gitCheckout(root, "zeta")).branch).toBe("zeta");
  });

  test("switches to a local branch and reports a dirty worktree conflict", async () => {
    await commitFiles({ "note.md": "main version\n" });
    await gitCreateBranch(root, "topic");
    await commitFiles({ "note.md": "topic version\n" });
    expect((await gitCheckout(root, "main")).branch).toBe("main");
    await writeFile(join(root, "note.md"), "dirty local edit\n");
    await expect(gitCheckout(root, "topic")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await gitStatus(root)).branch).toBe("main");
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("dirty local edit\n");
    await gitDiscard(root, ["note.md"]);
    expect((await gitCheckout(root, "topic")).branch).toBe("topic");
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("topic version\n");
  });

  test("validates branch names and refuses remote and tag fallbacks", async () => {
    await commitFiles({ "note.md": "fixture\n" });
    git("update-ref", "refs/remotes/origin/remote-only", "HEAD");
    git("tag", "tag-only");
    for (const name of ["--detach", "bad..name", "@{-1}", "HEAD", "with space", "nul\0name"]) {
      await expect(gitCheckout(root, name)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(gitCreateBranch(root, name)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    for (const name of ["remote-only", "tag-only"]) {
      await expect(gitCheckout(root, name)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  test("refuses to check out a protected file and preserves ignored local files", async () => {
    await commitFiles({ ".gitignore": "local.md\n" });
    git("switch", "-q", "-c", "protected");
    await commitFiles({ ".env": "SYNTHETIC_FIXTURE=tracked\n" });
    git("switch", "-q", "main");
    git("switch", "-q", "-c", "ignored");
    await writeFile(join(root, "local.md"), "branch version\n");
    git("add", "-f", "--", "local.md");
    git("commit", "-qm", "Fixture local file");
    git("switch", "-q", "main");
    await writeFile(join(root, "local.md"), "ignored worktree file\n");
    await expect(gitCheckout(root, "protected")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(access(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(gitCheckout(root, "ignored")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(root, "local.md"), "utf8")).toBe("ignored worktree file\n");
    expect((await gitStatus(root)).branch).toBe("main");
  });

  test("disables repository clean and smudge filters and checkout hooks", async () => {
    await commitFiles({ ".gitattributes": "*.md filter=fixture\n", "note.md": "main\n" });
    git("switch", "-q", "-c", "topic");
    await commitFiles({ "note.md": "topic\n" });
    git("switch", "-q", "main");
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks);
    git("config", "--local", "core.hooksPath", hooks);
    await writeFile(join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git("config", "--local", "filter.fixture.clean", "uya-fixture-clean-does-not-exist");
    git("config", "--local", "filter.fixture.smudge", "uya-fixture-smudge-does-not-exist");
    git("config", "--local", "filter.fixture.required", "true");
    await writeFile(join(root, "note.md"), "local\n");
    await gitStage(root, { paths: ["note.md"] });
    await gitUnstage(root, { all: true });
    await gitDiscard(root, ["note.md"]);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("main\n");
    expect((await gitCheckout(root, "topic")).branch).toBe("topic");
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("topic\n");
  });
});

describe("git log", () => {
  test("returns empty history for an unborn branch and parses commits with a bounded limit", async () => {
    expect(await gitLog(root)).toEqual([]);
    await commitFiles({ "note.md": "baseline\n" });
    const firstHash = git("rev-parse", "HEAD").trim();
    git("commit", "-qm", "Следующий\x1e коммит", "--allow-empty");
    const latest = {
      hash: git("rev-parse", "HEAD").trim(),
      shortHash: git("rev-parse", "--short", "HEAD").trim(),
      author: "Uya Fixture",
      subject: "Следующий\x1e коммит",
      date: git("log", "-1", "--format=%aI").trim(),
    };
    const log = await gitLog(root);
    expect(log).toEqual([latest, expect.objectContaining({ hash: firstHash, subject: "Fixture baseline" })]);
    expect(await gitLog(root, -10)).toEqual([latest]);
    expect(await gitLog(root, 1000)).toEqual(log);
  });
});
