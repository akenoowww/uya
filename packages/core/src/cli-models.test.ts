import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as clientVersion } from "../package.json";
import { discoverCliModels, isSafeCliModelName } from "./cli-models";

function fixtureEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return {};
  return {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    ProgramData: process.env.ProgramData,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
}

async function createFakeCli(dir: string, name: string, source: string): Promise<string> {
  const scriptPath = join(dir, `${name}.mjs`);
  await writeFile(scriptPath, source, "utf8");
  if (process.platform === "win32") {
    const cmdPath = join(dir, `${name}.cmd`);
    await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return cmdPath;
  }
  const binPath = join(dir, name);
  await writeFile(binPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o700 });
  return binPath;
}

test("validates CLI model names safely against flag injection and whitespace", () => {
  expect(isSafeCliModelName("gpt-6.2-sol")).toBe(true);
  expect(isSafeCliModelName("claude-sonnet-4-6")).toBe(true);
  expect(isSafeCliModelName("sonnet[1m]")).toBe(true);
  expect(isSafeCliModelName("anthropic/claude-opus-4-6")).toBe(true);
  expect(isSafeCliModelName("llama3.2:latest")).toBe(true);
  expect(isSafeCliModelName("--exec")).toBe(false);
  expect(isSafeCliModelName("-m")).toBe(false);
  expect(isSafeCliModelName("model with space")).toBe(false);
  expect(isSafeCliModelName("")).toBe(false);
});

test("discovers Codex models live via paginated app-server model/list and strips secrets", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-codex-"));
  try {
    const command = await createFakeCli(fixture, "codex", `
import readline from "node:readline";
const args = process.argv.slice(2);
if (!args.includes("app-server") || !args.includes("stdio://")) process.exit(2);
if (process.env.IDE_SESSION_TOKEN) process.exit(3);
if (process.env.NO_BROWSER !== "true") process.exit(4);
let sawInitialized = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    if (msg.params?.clientInfo?.version !== process.env.FIXTURE_UYA_VERSION) process.exit(6);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "codex-fixture" } }));
  } else if (msg.method === "initialized") {
    sawInitialized = true;
  } else if (msg.method === "model/list") {
    if (!sawInitialized) process.exit(5);
    if (!msg.params?.cursor) {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          data: [
            { id: "gpt-6.2-sol", model: "gpt-6.2-sol", hidden: false, isDefault: true },
            { id: "gpt-internal", model: "gpt-internal", hidden: true, isDefault: false },
            { id: "--bad-flag", model: "--bad-flag", hidden: false, isDefault: false },
          ],
          nextCursor: "page-2",
        },
      }));
    } else if (msg.params.cursor === "page-2") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          data: [
            { id: "gpt-6.2-astra", model: "gpt-6.2-astra", hidden: false, isDefault: false },
            { id: "gpt-hidden-vis", visibility: "hide" },
          ],
          nextCursor: null,
        },
      }));
    }
  }
});
`);
    const discovered = await discoverCliModels("codex", {
      command,
      home: fixture,
      env: {
        ...fixtureEnv(), CODEX_HOME: join(fixture, ".codex"), IDE_SESSION_TOKEN: "fixture-token",
        FIXTURE_UYA_VERSION: clientVersion,
      },
      timeoutMs: 3_000,
    });
    expect(discovered).toEqual({
      defaultModel: "gpt-6.2-sol",
      models: ["gpt-6.2-sol", "gpt-6.2-astra"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("falls back to Codex local CLI cache when app-server is unavailable", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-codex-cache-"));
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
    const failingCli = await createFakeCli(fixture, "codex-old", "process.exit(1);");

    const discovered = await discoverCliModels("codex", {
      command: failingCli,
      home: fixture,
      env: { ...fixtureEnv(), CODEX_HOME: codexHome },
      timeoutMs: 2_000,
    });
    expect(discovered).toEqual({
      defaultModel: "gpt-6.2-sol",
      models: ["gpt-6.2-sol", "gpt-6.2-astra"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("measures the config size limit in bytes before decoding", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-oversized-config-"));
  try {
    const command = await createFakeCli(fixture, "codex", "process.exit(1);");
    await writeFile(join(fixture, "config.toml"), 'model = "ignored-model"\n#' + "é".repeat(1024 * 1024));
    expect(await discoverCliModels("codex", {
      command, home: fixture, env: { ...fixtureEnv(), CODEX_HOME: fixture }, timeoutMs: 2_000,
    })).toEqual({ models: [], defaultModel: undefined });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("reads a symlink to a regular config and skips a symlink to a FIFO", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-symlink-config-"));
  try {
    const command = await createFakeCli(fixture, "codex", "process.exit(1);");
    const config = join(fixture, "config.toml");
    const regular = join(fixture, "regular.toml");
    await writeFile(regular, 'model = "fixture-model"');
    await symlink(regular, config);
    expect(await discoverCliModels("codex", {
      command, home: fixture, env: { CODEX_HOME: fixture }, timeoutMs: 2_000,
    })).toEqual({ models: ["fixture-model"], defaultModel: "fixture-model" });

    const fifo = join(fixture, "fifo");
    await unlink(config);
    execFileSync("mkfifo", [fifo], { stdio: "ignore", timeout: 1_000 });
    await symlink(fifo, config);
    // Keep the test process responsive if a future regression blocks on opening the FIFO.
    const output = execFileSync(process.execPath, [
      "--no-env-file", "-e",
      `import { discoverCliModels } from ${JSON.stringify(import.meta.resolve("./cli-models"))};
       const [command, fixture] = process.argv.slice(-2);
       console.log(JSON.stringify(await discoverCliModels("codex", {
         command, home: fixture, env: { CODEX_HOME: fixture }, timeoutMs: 1_000,
       })));`,
      command, fixture,
    ], { encoding: "utf8", env: {}, timeout: 3_000 });
    expect(JSON.parse(output)).toEqual({ models: [] });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers Claude models via stream-json initialize control_request", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-claude-"));
  try {
    await mkdir(join(fixture, ".claude"), { recursive: true });
    await writeFile(join(fixture, ".claude", "settings.json"), JSON.stringify({ model: "opus[1m]" }));
    const command = await createFakeCli(fixture, "claude", `
import readline from "node:readline";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (!args.includes("--input-format") || !args.includes("stream-json") || !args.includes("--no-session-persistence")) {
  process.exit(2);
}
if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1") process.exit(3);
const argValue = (flag) => args[args.indexOf(flag) + 1];
if (argValue("--tools") !== "" || !args.includes("--strict-mcp-config")) process.exit(4);
if (JSON.stringify(JSON.parse(readFileSync(argValue("--mcp-config"), "utf8"))) !== '{"mcpServers":{}}') process.exit(5);
if (JSON.parse(readFileSync(argValue("--settings"), "utf8")).disableAllHooks !== true) process.exit(6);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    console.log(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response: {
          models: [
            { value: "default", displayName: "Default" },
            { value: "sonnet[1m]", displayName: "Sonnet (1M)" },
            { value: "opus[1m]", displayName: "Opus (1M)" },
            { value: "haiku", displayName: "Haiku" },
            { value: "--injected", displayName: "Bad" },
          ],
        },
      },
    }));
    process.exit(0);
  }
});
`);
    const discovered = await discoverCliModels("claude", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    });
    expect(discovered).toEqual({
      defaultModel: "opus[1m]",
      models: ["opus[1m]", "sonnet[1m]", "haiku"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers Gemini models via ACP session/new and ignores stdout noise", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-gemini-"));
  try {
    const command = await createFakeCli(fixture, "gemini", `
import readline from "node:readline";
const args = process.argv.slice(2);
if (!args.includes("--acp") || args.includes("--output-format")) process.exit(2);
if (process.env.NO_BROWSER !== "true") process.exit(3);
console.log("non-json startup banner");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-1",
        models: {
          currentModelId: "auto",
          availableModels: [
            { modelId: "auto", name: "Auto" },
            { modelId: "gemini-3.1-pro-preview" },
            { modelId: "gemini-3.5-flash" },
            { modelId: "--flag-injection" },
          ],
        },
      },
    }));
  }
});
`);
    const discovered = await discoverCliModels("gemini", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    });
    expect(discovered).toEqual({
      defaultModel: undefined,
      models: ["auto", "gemini-3.1-pro-preview", "gemini-3.5-flash"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("leaves a managed Gemini CLI for the interactive terminal", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-gemini-managed-"));
  try {
    const markerPath = join(fixture, "probe-started.txt");
    const command = await createFakeCli(fixture, "gemini", `await Bun.write(${JSON.stringify(markerPath)}, "started");`);
    expect(await discoverCliModels("gemini", {
      command,
      home: fixture,
      env: { ...fixtureEnv(), GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(fixture, "managed-settings.json") },
    })).toEqual({ models: [] });
    await expect(access(markerPath)).rejects.toThrow();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers Qwen models via flat and grouped ACP model options", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-acp-"));
  try {
    const qwen = await createFakeCli(fixture, "qwen", `
import readline from "node:readline";
const args = process.argv.slice(2);
if (!args.includes("--acp") || !args.includes("--safe-mode")) process.exit(2);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "qwen-1",
        configOptions: [
          { id: "mode", category: "mode", currentValue: "default", options: [{ value: "default" }] },
          {
            id: "model",
            category: "model",
            currentValue: "qwen3-coder-next",
            options: [
              { value: "qwen3-coder-next", name: "Qwen3 Coder Next" },
              { group: "recommended", options: [{ value: "qwen3-max-latest", name: "Qwen3 Max" }] },
            ],
          },
        ],
      },
    }));
  }
});
`);

    expect(await discoverCliModels("qwen", { command: qwen, home: fixture, env: fixtureEnv(), timeoutMs: 3_000 })).toEqual({
      defaultModel: "qwen3-coder-next",
      models: ["qwen3-coder-next", "qwen3-max-latest"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers OpenCode models via opencode models --pure with isolated env and refresh flag", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-opencode-"));
  try {
    const command = await createFakeCli(fixture, "opencode", `
const args = process.argv.slice(2);
if (args[0] !== "models" || !args.includes("--pure")) process.exit(2);
if (process.env.OPENCODE_AUTH_CONTENT !== "{}" || process.env.OPENCODE_DB !== ":memory:") process.exit(3);
console.log("Warning: ignoring non-model line with spaces");
console.log("opencode/big-pickle");
console.log("anthropic/claude-sonnet-4-6");
if (args.includes("--refresh")) console.log("openai/gpt-6.2-sol");
console.log("--bad/model");
`);

    const initial = await discoverCliModels("opencode", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    });
    expect(initial).toEqual({
      defaultModel: undefined,
      models: ["opencode/big-pickle", "anthropic/claude-sonnet-4-6"],
    });

    const refreshed = await discoverCliModels("opencode", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
      refresh: true,
    });
    expect(refreshed).toEqual({
      defaultModel: undefined,
      models: ["opencode/big-pickle", "anthropic/claude-sonnet-4-6", "openai/gpt-6.2-sol"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("returns no hardcoded fallback models when CLI fails, times out, or is missing", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-empty-"));
  try {
    const failing = await createFakeCli(fixture, "fail-cli", "process.exit(1);");
    const markerPath = join(fixture, "probe-survived.txt");
    const hanging = await createFakeCli(fixture, "hang-cli", `setTimeout(() => Bun.write(${JSON.stringify(markerPath)}, "survived"), 1_250);`);

    expect(await discoverCliModels("gemini", { home: fixture, env: {} })).toEqual({ models: [] });
    expect(await discoverCliModels("gemini", { command: failing, home: fixture, env: fixtureEnv(), timeoutMs: 1_000 })).toEqual({
      defaultModel: undefined,
      models: [],
    });
    expect(await discoverCliModels("claude", { command: failing, home: fixture, env: fixtureEnv(), timeoutMs: 1_000 })).toEqual({
      defaultModel: undefined,
      models: [],
    });
    expect(await discoverCliModels("codex", { command: hanging, home: fixture, env: { ...fixtureEnv(), CODEX_HOME: join(fixture, ".codex") }, timeoutMs: 250 })).toEqual({
      defaultModel: undefined,
      models: [],
    });
    await Bun.sleep(1_400);
    await expect(access(markerPath)).rejects.toThrow();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
