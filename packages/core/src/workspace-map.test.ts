import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Workspace } from "./workspace";
import { buildWorkspaceMap } from "./workspace-map";

let fixture: string;
let project: string;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "uya-workspace-map-")));
  project = join(fixture, "project");
  await mkdir(project);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function writeTree(paths: string[]) {
  for (const path of paths) {
    const target = join(project, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "synthetic fixture");
  }
}

test("renders a deterministic two-level tree and the active file", async () => {
  await writeTree(["src/main.ts", "src/lib/deep.ts", "tests/smoke.ts", "README.md"]);
  const expected = [
    "# project", "", "Active file `src/main.ts`", "", "```text",
    "- README.md", "- src/", "  - lib/", "  - main.ts", "- tests/", "  - smoke.ts", "```",
  ].join("\n");
  const map = { path: "@workspace-map", text: expected };
  expect(await buildWorkspaceMap(project, "src/main.ts")).toEqual(map);
  expect(await buildWorkspaceMap(project, "src/main.ts")).toEqual(map);
});

test("hides protected paths, links, metadata files and excluded directories", async () => {
  const paths = [
    ".env", "src/.env.local", ".git/config", ".ssh/id_rsa", "server.key", "providers.json",
    "var/ai/fixture.md", "credentials.ts/source.ts", ".DS_Store", "src/Thumbs.db", "desktop.ini",
    "node_modules/fixture.ts", ".next/fixture.ts", ".venv/fixture.py", "__pycache__/fixture.py",
    "target/fixture.txt", "Dist/fixture.txt", "build/fixture.txt", ".ide-save-tmp",
  ];
  await writeTree([...paths, "src/notes.md", "providers.example.json", ".env.example"]);
  const outside = join(fixture, "outside.txt");
  await writeFile(outside, "synthetic fixture");
  await symlink(outside, join(project, "file-link.txt"), "file");
  await symlink(fixture, join(project, "dir-link"), "dir");

  const { text } = await buildWorkspaceMap(project);
  expect(text.split("\n").filter((line) => line.trimStart().startsWith("- "))).toEqual([
    "- .env.example", "- providers.example.json", "- src/", "  - notes.md", "- var/",
  ]);
});

test("omits unsafe active paths and supports new editor buffers", async () => {
  await writeTree(["src/main.ts", ".env"]);
  await symlink(join(project, "src"), join(project, "alias"), "dir");
  for (const path of [".env", "var/ai/new.md", "../outside.txt", "/outside.txt", "src\\main.ts", "alias/main.ts", "src"]) {
    expect((await buildWorkspaceMap(project, path)).text).not.toContain("Active file");
  }
  expect((await buildWorkspaceMap(project, "src/draft.ts")).text).toContain("Active file `src/draft.ts`");
});

test("limits the number of entries and counts the omitted names", async () => {
  await writeTree(Array.from({ length: 125 }, (_, index) => String(index).padStart(3, "0") + ".txt"));
  const { text } = await buildWorkspaceMap(project);
  expect(text.match(/^- /gmu)?.length).toBe(120);
  expect(text).toContain("- 119.txt\n... (5 more)\n```");
});

test("caps the Markdown at 6 KiB without cutting UTF-8 names or its closing fence", async () => {
  const names = Array.from({ length: 140 }, (_, index) => String(index).padStart(3, "0") + "文".repeat(70) + ".txt");
  await writeTree(names);
  const { text } = await buildWorkspaceMap(project);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(6 * 1024);
  const listed = [...text.matchAll(/^- (.+)$/gmu)].map((line) => line[1]);
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.length).toBeLessThan(120);
  expect(listed).toEqual(names.slice(0, listed.length));
  expect(text.endsWith("... (" + (names.length - listed.length) + " more)\n```")).toBe(true);
});

test("exposes the map and Gemini project rules through Workspace", async () => {
  const workspace = new Workspace();
  await expect(workspace.workspaceMap()).rejects.toMatchObject({ code: "NO_WORKSPACE" });
  await writeTree(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
  await workspace.open({ path: project });
  expect(await workspace.workspaceMap("GEMINI.md")).toEqual(await buildWorkspaceMap(project, "GEMINI.md"));
  expect((await workspace.projectRules()).map(({ path }) => path)).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
});
