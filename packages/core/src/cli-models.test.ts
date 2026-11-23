import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCliModels, isSafeCliModelName } from "./cli-models";

test("validates CLI model names safely against flag injection and whitespace", () => {
  expect(isSafeCliModelName("gpt-6.2-sol")).toBe(true);
  expect(isSafeCliModelName("claude-sonnet-4-6")).toBe(true);
  expect(isSafeCliModelName("anthropic/claude-opus-4-6")).toBe(true);
  expect(isSafeCliModelName("llama3.2:latest")).toBe(true);
  expect(isSafeCliModelName("--exec")).toBe(false);
  expect(isSafeCliModelName("-m")).toBe(false);
  expect(isSafeCliModelName("model with space")).toBe(false);
  expect(isSafeCliModelName("")).toBe(false);
});

test("discovers Codex models from local cache and config while filtering hidden entries", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-models-"));
  try {
    const codexHome = join(fixture, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), 'model = "gpt-6.2-sol"\n[features]\nmodel = "ignored-section"\n');
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-6.2-astra", visibility: "list" },
        { slug: "gpt-internal", visibility: "hide" },
        { slug: "gpt-6.2-sol", visibility: "list" },
        { slug: "--bad-flag", visibility: "list" },
      ],
    }));

    const discovered = discoverCliModels("codex", { home: fixture, env: { CODEX_HOME: codexHome } });
    expect(discovered).toEqual({
      defaultModel: "gpt-6.2-sol",
      models: ["gpt-6.2-sol", "gpt-6.2-astra"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("returns curated fallback models when local CLI configs do not exist", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-models-empty-"));
  try {
    const codex = discoverCliModels("codex", { home: fixture, env: {} });
    const claude = discoverCliModels("claude", { home: fixture, env: {} });
    const gemini = discoverCliModels("gemini", { home: fixture, env: {} });
    expect(codex.models.length).toBeGreaterThan(0);
    expect(claude.models).toContain("claude-sonnet-4-6");
    expect(gemini.models).toContain("gemini-2.5-pro");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
