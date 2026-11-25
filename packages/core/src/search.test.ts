import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SearchResponse } from "@ide/protocol";
import { searchWorkspace } from "./search";
import { Workspace } from "./workspace";

const rgPath = Bun.which("rg");
let fixture: string;
let project: string;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "uya-search-")));
  project = join(fixture, "project");
  await mkdir(project);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function write(path: string, contents: string) {
  const target = join(project, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function matchedText(result: SearchResponse): string[] {
  return result.files.flatMap(({ matches }) => matches.map(({ text, matchStart, matchEnd }) => text.slice(matchStart, matchEnd)));
}

for (const engine of ["native", "rg"] as const) {
  describe.skipIf(engine === "rg" && !rgPath)(engine + " workspace search", () => {
    const deps = { rgPath: engine === "rg" ? rgPath : null };
    async function search(options: Parameters<typeof searchWorkspace>[1]) {
      const result = await searchWorkspace(project, options, deps);
      expect(result.engine).toBe(engine);
      return result;
    }

    test("finds literals and regexes with sorted paths and UTF-16 offsets", async () => {
      await write("z.ts", "a+b a+b\r\n");
      await write("a.ts", "😀a+b\nab aaab\n");

      const literal = await search({ query: "a+b" });
      expect(literal.files.map(({ path }) => path)).toEqual(["a.ts", "z.ts"]);
      expect(literal.files[0]?.matches).toEqual([{ line: 1, column: 3, text: "😀a+b", matchStart: 2, matchEnd: 5 }]);
      expect(literal.totalMatches).toBe(3);

      const regex = await search({ query: "a+b", regex: true });
      expect(regex.files).toEqual([{
        path: "a.ts",
        matches: [
          { line: 2, column: 1, text: "ab aaab", matchStart: 0, matchEnd: 2 },
          { line: 2, column: 4, text: "ab aaab", matchStart: 3, matchEnd: 7 },
        ],
      }]);
    });

    test("applies case sensitivity and Unicode whole-word boundaries", async () => {
      await write("words.md", "cat CAT scatter cat_ cat2 écat caté (cat) cat\u0301 cat\u200c\n");
      expect((await search({ query: "cat" })).totalMatches).toBe(10);
      expect(matchedText(await search({ query: "cat", wholeWord: true }))).toEqual(["cat", "CAT", "cat"]);
      expect(matchedText(await search({ query: "cat", wholeWord: true, caseSensitive: true }))).toEqual(["cat", "cat"]);
      await write("fold.md", "Kelvin KELVIN");
      expect(matchedText(await search({ query: "kelvin" }))).toEqual(["Kelvin", "KELVIN"]);
    });

    test("matches regex character classes and line anchors consistently", async () => {
      await write("numbers.txt", "٤1\r\nA9\r\nletters\r");
      expect(matchedText(await search({ query: "\\D\\d$", regex: true }))).toEqual(["٤1", "A9"]);
      expect(matchedText(await search({ query: "^[\\w]+$", regex: true }))).toEqual(["A9", "letters"]);
      const emptyMatches = await search({ query: "$", regex: true });
      expect(emptyMatches.files[0]?.matches.map(({ line, column, matchStart, matchEnd }) =>
        [line, column, matchStart, matchEnd])).toEqual([[1, 3, 2, 2], [2, 3, 2, 2], [3, 8, 7, 7]]);
    });

    test("applies recursive and anchored globs and accepts leading hyphens in a query", async () => {
      const paths = ["z.ts", "src/[a] {b}.ts", "src/deep/main.ts", "src/notes.md", "notes.md", ".hidden.ts"];
      for (const path of paths) await write(path, "-needle\n");
      expect((await search({ query: "-needle", glob: "src/**/*.ts" })).files.map(({ path }) => path))
        .toEqual(["src/[a] {b}.ts", "src/deep/main.ts"]);
      expect((await search({ query: "-needle", glob: "*.md" })).files.map(({ path }) => path))
        .toEqual(["notes.md", "src/notes.md"]);
      expect((await search({ query: "-needle", glob: "/z.ts" })).files.map(({ path }) => path)).toEqual(["z.ts"]);
      expect((await search({ query: "-needle", glob: "!src/" })).files.map(({ path }) => path))
        .toEqual([".hidden.ts", "notes.md", "z.ts"]);
    });

    test("rejects invalid regexes and unsafe globs", async () => {
      await expect(searchWorkspace(project, { query: "[", regex: true }, deps))
        .rejects.toMatchObject({ code: "INVALID_INPUT", message: "Invalid search pattern." });
      for (const glob of ["--no-follow", "a\0*"]) {
        await expect(searchWorkspace(project, { query: "x", glob }, deps))
          .rejects.toMatchObject({ code: "INVALID_INPUT", message: "Invalid search glob." });
      }
    });

    test("bounds the default and explicit result limits and identifies omitted matches", async () => {
      await write("few.txt", "match match");
      expect(await search({ query: "match", maxResults: 2 })).toMatchObject({ totalMatches: 2, truncated: false });
      expect(await search({ query: "match", maxResults: -10 })).toMatchObject({ totalMatches: 1, truncated: true });

      await write("many.txt", "hit ".repeat(600));
      expect(await search({ query: "hit" })).toMatchObject({ totalMatches: 200, truncated: true });
      expect(await search({ query: "hit", maxResults: 10_000 })).toMatchObject({ totalMatches: 500, truncated: true });
    });

    test("caps matched lines per file and still includes later files", async () => {
      await write("a.txt", "hit\n".repeat(51));
      await write("z.txt", "hit");
      const result = await search({ query: "hit" });
      expect(result).toMatchObject({ totalMatches: 51, truncated: true });
      expect(result.files.map(({ matches }) => matches.length)).toEqual([50, 1]);
    });

    test("clips previews around matches without splitting Unicode characters", async () => {
      const prefix = "x" + "😀".repeat(400);
      await write("long.txt", prefix + "tiny" + "😀".repeat(400) + "\n" + "a".repeat(600));
      const tiny = (await search({ query: "tiny" })).files[0]?.matches[0];
      expect(tiny?.column).toBe(prefix.length + 1);
      expect(tiny?.text.length).toBeLessThanOrEqual(400);
      expect(tiny?.text.slice(tiny.matchStart, tiny.matchEnd)).toBe("tiny");
      expect(tiny?.text).toBe(Buffer.from(tiny?.text ?? "").toString());
      const long = (await search({ query: "a{600}", regex: true })).files[0]?.matches[0];
      expect(long).toEqual({ line: 2, column: 1, text: "a".repeat(400), matchStart: 0, matchEnd: 400 });
    });

    test("searches only eligible files even with a broad glob", async () => {
      const hidden = [
        ".env", ".git/index", ".ssh/id_rsa", "file.pem", "providers.json", "var/ai/fixture.txt",
        "credentials.ts/nested.ts", ".env.example/nested.txt", "node_modules/notes.md", ".next/code.js",
        ".venv/synthetic.py", "__pycache__/file.py", "Build/src.ts", "dist/example.js", "target/doc.md",
        ".DS_Store", "Thumbs.db", "desktop.ini", ".ide-save-tmp",
      ];
      for (const path of hidden) await write(path, "needle");
      await write("a/b/.env.example", "needle public example");
      await write(".visible.ts", "needle");
      await write("binary.txt", "needle\n" + "a".repeat(100_000) + "\0");
      await write("oversized.txt", "needle\n" + "a".repeat(1024 * 1024));
      const outside = join(fixture, "outside.txt");
      await writeFile(outside, "needle outside");
      await symlink(outside, join(project, "file-link.txt"), "file");
      await symlink(fixture, join(project, "dir-link"), "dir");
      await link(outside, join(project, "hard-link.txt"));

      const result = await search({ query: "needle", glob: "**" });
      expect(result.files.map(({ path }) => path)).toEqual([".visible.ts", "a/b/.env.example"]);
    });
  });
}

test("falls back when the resolved ripgrep command cannot be spawned", async () => {
  await write("source.txt", "needle");
  expect(await searchWorkspace(project, { query: "needle" }, { rgPath: join(fixture, "missing-rg") }))
    .toMatchObject({ engine: "native", totalMatches: 1 });
});

test("supports JavaScript regex assertions even with ripgrep available", async () => {
  await write("words.txt", "preword word and éword");
  const lookbehind = await searchWorkspace(project, { query: "(?<=pre)word", regex: true });
  expect(matchedText(lookbehind)).toEqual(["word"]);
  const boundary = await searchWorkspace(project, { query: "\\bword", regex: true });
  expect(matchedText(boundary)).toEqual(["word", "word"]);
});

test("validates the root and exposes code search through Workspace", async () => {
  await expect(searchWorkspace("relative", { query: "needle" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const workspace = new Workspace();
  await expect(workspace.search({ query: "needle" })).rejects.toMatchObject({ code: "NO_WORKSPACE" });
  await write("source.ts", "needle");
  await workspace.open({ path: project });
  expect(await workspace.search({ query: "needle" })).toMatchObject({ engine: rgPath ? "rg" : "native", totalMatches: 1 });
});
