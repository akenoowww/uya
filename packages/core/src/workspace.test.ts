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
});
