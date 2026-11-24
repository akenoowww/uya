import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";

let fixture: string;
let project: string;
let workspace: Workspace;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "ide-workspace-")));
  project = join(fixture, "project");
  await mkdir(project);
  workspace = new Workspace({ globalPromptsDir: join(fixture, "prompts") });
  await workspace.open({ path: project });
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("workspace files", () => {
  test("opens files and retains permissions when saving", async () => {
    await mkdir(join(project, "src"));
    const sourcePath = join(project, "src/main.ts");
    await writeFile(sourcePath, "\uFEFFconsole.log('sample');\r\n");
    await chmod(sourcePath, 0o750);
    expect(await workspace.list()).toEqual([{ path: "src", name: "src", kind: "directory" }]);
    const before = await workspace.read({ path: "src/main.ts" });
    expect(before.text).toBe("\uFEFFconsole.log('sample');\r\n");
    const saved = await workspace.write({ ...before, text: "// edited\r\n" });
    expect(saved.revision).not.toBe(before.revision);
    expect(await readFile(sourcePath, "utf8")).toBe("// edited\r\n");
    expect((await stat(sourcePath)).mode & 0o777).toBe(0o750);
  });

  test("rejects stale and concurrent saves using the opened revision", async () => {
    const path = join(project, "notes.txt");
    await writeFile(path, "baseline");
    const initial = await workspace.read({ path: "notes.txt" });
    const outcomes = await Promise.allSettled([
      workspace.write({ ...initial, text: "first save" }),
      workspace.write({ ...initial, text: "second save" }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    const saved = await workspace.read({ path: "notes.txt" });
    await writeFile(path, "external save");
    await expect(workspace.write({ ...saved, text: "stale save" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(path, "utf8")).toBe("external save");
  });

  test("rejects path escapes, protected paths, aliases, and non-UTF-8 files", async () => {
    const outside = join(fixture, "outside.txt");
    await writeFile(outside, "synthetic fixture");
    await symlink(outside, join(project, "alias.txt"));
    await symlink(fixture, join(project, "external"));
    await link(outside, join(project, "hardlink.txt"));
    await writeFile(join(project, "binary"), Buffer.from([0xff, 0x00]));
    await writeFile(join(project, ".env.example"), "PUBLIC_SAMPLE=true");

    for (const path of ["../outside.txt", "/outside.txt"]) {
      await expect(workspace.read({ path })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    for (const path of [".env.local", "var/ai/design.md", "providers.json", "alias.txt", "external/outside.txt", "hardlink.txt"]) {
      await expect(workspace.read({ path })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await workspace.list()).map(({ name }) => name)).not.toContain("alias.txt");
    expect((await workspace.read({ path: ".env.example" })).text).toBe("PUBLIC_SAMPLE=true");
    await expect(workspace.read({ path: "binary" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("lists, opens, attaches, and saves source files with credential-related names", async () => {
    await mkdir(join(project, "src/auth"), { recursive: true });
    const names = ["credentials.ts", "secret_store.rs", "api_key.py", "access-token.tsx"];
    for (const name of names) await writeFile(join(project, "src/auth", name), "");

    const listed = await workspace.list({ path: "src/auth" });
    expect(listed.map(({ name }) => name).sort()).toEqual(names.toSorted());
    const path = "src/auth/credentials.ts";
    const file = await workspace.read({ path });
    await workspace.write({ ...file, text: "export const publicExample = true;\n" });
    expect(await workspace.context([path])).toEqual([{ path, text: "export const publicExample = true;\n" }]);
  });

  test("protects private config paths and allows explicitly named example files", async () => {
    for (const folder of ["var/ai", ".codex", "credentials.ts"]) {
      await mkdir(join(project, folder), { recursive: true });
      await writeFile(join(project, folder, "source.ts"), "// synthetic fixture\n");
    }
    const protectedFiles = [
      "providers.json", "models.yaml", "auth.toml", "api_key.txt", ".env.local",
      ".env.example.local", "production.env", "sample.example.pem",
    ];
    for (const path of protectedFiles) await writeFile(join(project, path), "synthetic fixture");
    await writeFile(join(project, "providers.example.json"), "{}");
    await writeFile(join(project, ".env.production.example"), "PUBLIC_SAMPLE=true");

    const listed = await workspace.list();
    expect(listed.map(({ name }) => name).sort()).toEqual([".env.production.example", "providers.example.json", "var"]);
    expect(await workspace.list({ path: "var" })).toEqual([]);
    expect((await workspace.read({ path: "providers.example.json" })).text).toBe("{}");
    expect((await workspace.read({ path: ".env.production.example" })).text).toBe("PUBLIC_SAMPLE=true");
    for (const path of [...protectedFiles, "var/ai/source.ts", ".codex/source.ts", "credentials.ts/source.ts"]) {
      await expect(workspace.read({ path })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(workspace.open({ path: join(project, "var/ai") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(workspace.context(["providers.json"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(workspace.write({ path: "auth.toml", revision: "synthetic", text: "" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("validates attached file content and selections against disk", async () => {
    await writeFile(join(project, "example.ts"), "export const sample = true;\n");
    const { revision } = await workspace.read({ path: "example.ts" });
    expect(await workspace.context(["example.ts", "example.ts"])).toEqual([
      { path: "example.ts", text: "export const sample = true;\n" },
    ]);
    expect(await workspace.validateSelection({ path: "example.ts", text: "sample = true", revision }))
      .toEqual({ path: "example.ts", text: "sample = true" });
    await expect(workspace.validateSelection({ path: "example.ts", text: "sample = false", revision }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(join(project, "example.ts"), "export const sample = true;\n// External change");
    await expect(workspace.validateSelection({ path: "example.ts", text: "sample = true", revision }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("creates, renames and removes files and folders", async () => {
    expect(await workspace.create({ path: "docs", kind: "directory" }))
      .toEqual({ path: "docs", name: "docs", kind: "directory" });
    expect(await workspace.create({ path: "docs/note.md", kind: "file", text: "Hello 🌏\n" }))
      .toEqual({ path: "docs/note.md", name: "note.md", kind: "file" });
    await workspace.create({ path: "empty.txt", kind: "file" });
    expect((await workspace.read({ path: "empty.txt" })).text).toBe("");

    expect(await workspace.rename({ from: "docs/note.md", to: "docs/intro.md" }))
      .toEqual({ path: "docs/intro.md", name: "intro.md", kind: "file" });
    expect(await workspace.rename({ from: "docs", to: "guide" }))
      .toEqual({ path: "guide", name: "guide", kind: "directory" });
    expect((await workspace.read({ path: "guide/intro.md" })).text).toBe("Hello 🌏\n");
    await expect(workspace.read({ path: "docs/note.md" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await workspace.remove({ path: "empty.txt" });
    await workspace.create({ path: "guide/appendices", kind: "directory" });
    await workspace.create({ path: "guide/appendices/index.md", kind: "file" });
    await workspace.remove({ path: "guide" });
    expect(await workspace.list()).toEqual([]);
  });

  test("requires existing parents and never replaces an existing entry", async () => {
    await workspace.create({ path: "keep.txt", kind: "file", text: "keep me" });
    await workspace.create({ path: "other.txt", kind: "file", text: "other" });
    await workspace.create({ path: "folder", kind: "directory" });
    await expect(workspace.create({ path: "keep.txt", kind: "file", text: "replacement" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(workspace.create({ path: "folder", kind: "directory" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(workspace.rename({ from: "other.txt", to: "keep.txt" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(workspace.rename({ from: "folder", to: "folder/nested" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const kind of ["file", "directory"] as const) {
      await expect(workspace.create({ path: "missing/new", kind })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(workspace.rename({ from: "other.txt", to: "missing/new" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(workspace.remove({ path: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await workspace.read({ path: "keep.txt" })).text).toBe("keep me");
    expect((await workspace.read({ path: "other.txt" })).text).toBe("other");
  });

  test("serializes creates and renames targeting the same name", async () => {
    await workspace.create({ path: "source.txt", kind: "file", text: "move me" });
    const results = await Promise.allSettled([
      workspace.rename({ from: "source.txt", to: "destination.txt" }),
      workspace.create({ path: "destination.txt", kind: "file", text: "replacement" }),
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: { path: "destination.txt", name: "destination.txt", kind: "file" } },
      { status: "rejected", reason: expect.objectContaining({ code: "CONFLICT" }) },
    ]);
    expect((await workspace.read({ path: "destination.txt" })).text).toBe("move me");
    await expect(workspace.read({ path: "source.txt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("rejects invalid paths, protected paths, aliases and invalid file text", async () => {
    const outside = join(fixture, "outside.txt");
    await writeFile(outside, "external fixture");
    await writeFile(join(project, "inside.txt"), "internal fixture");
    await symlink(fixture, join(project, "external"), "dir");
    await symlink(outside, join(project, "alias.txt"), "file");
    await link(outside, join(project, "linked.txt"));
    for (const path of ["../outside.txt", outside, "wrong\\path", ""]) {
      await expect(workspace.create({ path, kind: "file" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(workspace.rename({ from: "inside.txt", to: path })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(workspace.remove({ path })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    for (const path of [".env", "var/ai/notes.md", "alias.txt", "external/outside.txt", "linked.txt"]) {
      await expect(workspace.rename({ from: path, to: "renamed.txt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(workspace.remove({ path })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    for (const path of [".env.local", "external/new.txt", "alias.txt"]) {
      await expect(workspace.create({ path, kind: "file" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(workspace.rename({ from: "inside.txt", to: path })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(workspace.create({ path: "nul.txt", kind: "file", text: "bad\0text" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(workspace.create({ path: "large.txt", kind: "file", text: "🌏".repeat(262_145) }))
      .rejects.toMatchObject({ code: "LIMIT" });
    expect(await readFile(outside, "utf8")).toBe("external fixture");
    expect((await workspace.read({ path: "inside.txt" })).text).toBe("internal fixture");
  });

  test("preflights every descendant before removing or moving a folder", async () => {
    const outside = join(fixture, "external.txt");
    await writeFile(outside, "external fixture");
    await mkdir(join(project, "moving/nested"), { recursive: true });
    await writeFile(join(project, "moving/keep.txt"), "safe");
    const protectedPath = join(project, "moving/nested/.env");
    const linkPath = join(project, "moving/nested/link.txt");
    const blockers = [
      { path: protectedPath, create: () => writeFile(protectedPath, "SYNTHETIC_FIXTURE=true") },
      { path: linkPath, create: () => symlink(outside, linkPath, "file") },
      { path: linkPath, create: () => link(outside, linkPath) },
    ];
    for (const { path, create } of blockers) {
      await create();
      await expect(workspace.remove({ path: "moving" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(workspace.rename({ from: "moving", to: "relocated" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await workspace.read({ path: "moving/keep.txt" })).text).toBe("safe");
      await rm(path);
    }
    await mkdir(join(project, "relocate/ai"), { recursive: true });
    await writeFile(join(project, "relocate/ai/notes.md"), "fixture");
    await expect(workspace.rename({ from: "relocate", to: "var" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await workspace.read({ path: "relocate/ai/notes.md" })).text).toBe("fixture");
  });

  test("ranks filename prefixes, filename substrings, path substrings and subsequences", async () => {
    const ranked = ["Needle.ts", "zNeedle.ts", "src/needle/readme.md", "n-e-e-d-l-e.md"];
    await mkdir(join(project, "src/needle"), { recursive: true });
    for (const path of [...ranked.toReversed(), "ignored.md"]) await writeFile(join(project, path), "");
    expect(await workspace.files({ query: " NEEDLE " })).toEqual(ranked);
    expect(await workspace.files({ query: "needle", limit: 2 })).toEqual(ranked.slice(0, 2));
    expect(await workspace.files({ query: "no matches" })).toEqual([]);
    expect(await workspace.files({ limit: 0 })).toEqual([]);
    expect(await workspace.files()).toEqual(["ignored.md", "n-e-e-d-l-e.md", "Needle.ts", "zNeedle.ts", "src/needle/readme.md"]);
  });

  test("bounds the flat index and skips protected paths, build output and links", async () => {
    for (const folder of ["node_modules", ".next", ".git", "build", "target", "dist", "var/ai", ".ide-save-tmp"]) {
      await mkdir(join(project, folder), { recursive: true });
      await writeFile(join(project, folder, "reserved.md"), "fixture");
    }
    await writeFile(join(project, ".env.local"), "SYNTHETIC_FIXTURE=true");
    await writeFile(join(project, ".env.example"), "PUBLIC_SAMPLE=true");
    await writeFile(join(project, ".ide-save-file"), "");
    const external = join(fixture, "external.md");
    await writeFile(external, "fixture");
    await link(external, join(project, "hardlink.md"));
    await symlink(external, join(project, "alias.md"), "file");
    await symlink(fixture, join(project, "external"), "dir");
    const depthTwelve = Array.from({ length: 12 }, (_, index) => `d${index}`).join("/");
    await mkdir(join(project, depthTwelve, "deeper"), { recursive: true });
    await writeFile(join(project, depthTwelve, "visible.md"), "");
    await writeFile(join(project, depthTwelve, "deeper/too-deep.md"), "");
    expect(await workspace.files()).toEqual([".env.example", depthTwelve + "/visible.md"]);

    await mkdir(join(project, "results"));
    await Promise.all(Array.from({ length: 505 }, (_, index) => writeFile(join(project, "results", `result-${index}.md`), "")));
    expect(await workspace.files({ query: "result-" })).toHaveLength(100);
    expect(await workspace.files({ query: "result-", limit: 1000 })).toHaveLength(500);
  });

  test("caps the breadth-first scan at 5000 files before filtering results", async () => {
    await mkdir(join(project, "nested"));
    await writeFile(join(project, "nested/needle.md"), "");
    expect(await workspace.files({ query: "needle" })).toEqual(["nested/needle.md"]);
    for (let offset = 0; offset < 5000; offset += 250) {
      await Promise.all(Array.from({ length: 250 }, (_, index) => writeFile(join(project, `f-${offset + index}.md`), "")));
    }
    expect(await workspace.files({ query: "needle" })).toEqual([]);
  });
});

describe("project rules", () => {
  test("returns an empty list when no rules or workspace exist", async () => {
    expect(await workspace.projectRules()).toEqual([]);
    expect(await workspace.readProjectRulesContext()).toEqual([]);
    workspace.close();
    expect(await workspace.projectRules()).toEqual([]);
    expect(await workspace.readProjectRulesContext()).toEqual([]);
  });

  test("discovers readable rules in priority order with UTF-8 byte counts", async () => {
    const rules = [
      { path: "AGENTS.md", text: "Root instructions 📝\n" },
      { path: "CLAUDE.md", text: "Secondary instructions\n" },
      { path: ".uya/rules.md", text: "Uya instructions\n" },
      { path: ".cursorrules", text: "Cursor instructions\n" },
      { path: ".github/copilot-instructions.md", text: "Copilot instructions\n" },
    ];
    await mkdir(join(project, ".github"));
    await mkdir(join(project, ".uya"));
    for (const { path, text } of rules.toReversed()) await writeFile(join(project, path), text);
    expect(await workspace.projectRules()).toEqual(rules.map(({ path, text }) => ({ path, bytes: Buffer.byteLength(text) })));
    expect(await workspace.readProjectRulesContext()).toEqual(rules);
  });

  test("skips linked and invalid UTF-8 rules", async () => {
    const external = join(fixture, "external.md");
    await writeFile(external, "fixture");
    await symlink(external, join(project, "AGENTS.md"), "file");
    await link(external, join(project, "CLAUDE.md"));
    await symlink(fixture, join(project, ".uya"), "dir");
    await writeFile(join(project, "rules.md"), "workspace file");
    await writeFile(join(fixture, "rules.md"), "external fixture");
    await writeFile(join(project, ".cursorrules"), Buffer.from([0xff, 0x00]));
    await mkdir(join(project, ".github"));
    const path = ".github/copilot-instructions.md";
    await writeFile(join(project, path), "Valid\n");
    expect(await workspace.projectRules()).toEqual([{ path, bytes: 6 }]);
    expect(await workspace.readProjectRulesContext()).toEqual([{ path, text: "Valid\n" }]);
  });

  test("fits whole rules into the 64 KiB byte budget", async () => {
    const budget = 64 * 1024;
    const agents = "a".repeat(budget - 4);
    await writeFile(join(project, "AGENTS.md"), agents);
    await writeFile(join(project, "CLAUDE.md"), "🎯x");
    await mkdir(join(project, ".uya"));
    await writeFile(join(project, ".uya/rules.md"), "🎯");
    await writeFile(join(project, ".cursorrules"), "outside the budget");
    expect(await workspace.projectRules()).toEqual([
      { path: "AGENTS.md", bytes: budget - 4 },
      { path: ".uya/rules.md", bytes: 4 },
    ]);
    expect(await workspace.readProjectRulesContext()).toEqual([
      { path: "AGENTS.md", text: agents },
      { path: ".uya/rules.md", text: "🎯" },
    ]);
  });
});

describe("prompt libraries", () => {
  const ref = { scope: "project", path: "dev/review.prompt.md" } as const;
  const source = [
    "---",
    "title: Code review",
    "providerId: model-fixture",
    "mode: fallback",
    "variables:",
    "  language: TypeScript",
    "  focus:",
    "---",
    "Review {{language}} code for {{ focus }} using {{style}}.",
  ].join("\r\n");

  test("lists and renders a saved prompt with default and inferred variables", async () => {
    expect(await workspace.listPrompts()).toEqual([]);
    const saved = await workspace.writePrompt({ ref, source });
    await workspace.writePrompt({ ref: { scope: "global", path: "summary.prompt.md" }, source: "Summarize this." });
    expect(await workspace.listPrompts()).toEqual([
      { ref, title: "Code review" },
      { ref: { scope: "global", path: "summary.prompt.md" }, title: "summary" },
    ]);
    expect(saved.variables).toEqual([{ name: "language", defaultValue: "TypeScript" }, { name: "focus" }, { name: "style" }]);
    expect(await workspace.renderPrompt({ ref, values: { focus: "correctness", style: "a short list" } })).toEqual({
      text: "Review TypeScript code for correctness using a short list.",
      providerId: "model-fixture",
      mode: "fallback",
      revision: saved.revision,
    });
    await expect(workspace.renderPrompt({ ref, values: { focus: "tests" } })).rejects.toMatchObject({ code: "INVALID_PROMPT" });
    await expect(workspace.writePrompt({ ref, source })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("allows repairing invalid on-disk YAML while protecting the revision", async () => {
    const root = join(project, ".ai/prompts");
    await mkdir(root, { recursive: true });
    const brokenRef = { scope: "project", path: "broken.prompt.md" } as const;
    const invalid = "---\nvariables: [broken\n---\nDraft";
    await writeFile(join(root, brokenRef.path), invalid);
    const broken = await workspace.readPrompt({ ref: brokenRef });
    expect(broken.source).toBe(invalid);
    expect(broken.parseError).toBeTruthy();
    await expect(workspace.renderPrompt({ ref: brokenRef, values: {} })).rejects.toMatchObject({ code: "INVALID_PROMPT" });
    const fixed = await workspace.writePrompt({ ref: brokenRef, source: "Fixed body", revision: broken.revision });
    expect(fixed.body).toBe("Fixed body");
    expect(fixed.parseError).toBeUndefined();
  });

  test("preserves each supported effort through parsing and rendering", async () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const effortRef = { scope: "project", path: `${effort}.prompt.md` } as const;
      const saved = await workspace.writePrompt({ ref: effortRef, source: `---\neffort: "${effort}"\n---\nReview.\n` });
      expect(saved.effort).toBe(effort);
      expect((await workspace.readPrompt({ ref: effortRef })).effort).toBe(effort);
      expect(await workspace.renderPrompt({ ref: effortRef, values: {} }))
        .toEqual({ effort, text: "Review.\n", revision: saved.revision });
    }
  });

  test("rejects unsupported and non-string efforts", async () => {
    for (const effort of ["ultra", "HIGH", "null", "42", "true", "[high]"]) {
      await expect(workspace.writePrompt({ ref, source: `---\neffort: ${effort}\n---\nReview.` }))
        .rejects.toMatchObject({ code: "INVALID_PROMPT", message: expect.stringContaining("effort") });
    }
    const directory = join(project, ".ai/prompts/dev");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "review.prompt.md"), "---\neffort: unsupported\n---\nDraft");
    expect((await workspace.readPrompt({ ref })).parseError).toContain("effort");
    await expect(workspace.renderPrompt({ ref, values: {} })).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });
});
