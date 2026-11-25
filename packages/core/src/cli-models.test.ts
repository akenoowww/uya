import type { EffortLevel } from "@ide/protocol";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as clientVersion } from "../package.json";
import { discoverCliModels, isSafeCliModelName, normalizeEffortLevel, type CliModelDiscovery } from "./cli-models";

const codexFallback: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const claudeEfforts: EffortLevel[] = ["low", "medium", "high", "max"];
const geminiCliEfforts: EffortLevel[] = ["minimal", "low", "medium", "high"];
const geminiApiEfforts: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

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

test("normalizes only known effort levels", () => {
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    expect(normalizeEffortLevel(level)).toBe(level);
  }
  for (const level of ["ultra", "high\n", 'high" --flag', "", null, { effort: "high" }]) {
    expect(normalizeEffortLevel(level)).toBeUndefined();
  }
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
            {
              id: "catalog-sol", model: "gpt-6.2-sol", hidden: false, isDefault: true,
              supportedReasoningLevels: [{ effort: "high" }, { effort: "medium" }, { effort: "ultra" }, "medium"],
              defaultReasoningLevel: "medium",
            },
            { id: "gpt-internal", model: "gpt-internal", hidden: true, supportedReasoningLevels: ["max"] },
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
            {
              id: "gpt-6.2-astra", hidden: false, isDefault: false,
              supported_reasoning_levels: ["low", "high", "xhigh"],
              default_reasoning_level: "high",
            },
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
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      modelEfforts: {
        "gpt-6.2-sol": ["medium", "high"],
        "gpt-6.2-astra": ["low", "high", "xhigh"],
      },
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
    const config = join(codexHome, "config.toml");
    await writeFile(config, 'model = "gpt-6.2-sol"\n[features]\nmodel_reasoning_effort = "low"\n');
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [
        {
          slug: "gpt-6.2-astra", visibility: "list", is_default: true,
          supported_reasoning_levels: ["medium", { effort: "max" }], default_reasoning_level: "max",
        },
        { slug: "gpt-internal", visibility: "hide" },
        {
          slug: "gpt-6.2-sol", visibility: "list",
          supported_reasoning_levels: [{ effort: "high" }, "xhigh", "ultra"], default_reasoning_level: "high",
        },
        { slug: "--bad-flag", visibility: "list" },
      ],
    }));
    const failingCli = await createFakeCli(fixture, "codex-old", "process.exit(1);");

    const options = {
      command: failingCli,
      home: fixture,
      env: { ...fixtureEnv(), CODEX_HOME: codexHome },
      timeoutMs: 2_000,
    };
    const cached: CliModelDiscovery = {
      defaultModel: "gpt-6.2-sol",
      models: ["gpt-6.2-sol", "gpt-6.2-astra"],
      supportedEfforts: ["medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      modelEfforts: {
        "gpt-6.2-astra": ["medium", "max"],
        "gpt-6.2-sol": ["high", "xhigh"],
      },
    };
    expect(await discoverCliModels("codex", options)).toEqual(cached);

    await writeFile(config, 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "xhigh"\n');
    expect(await discoverCliModels("codex", options)).toEqual({ ...cached, defaultEffort: "xhigh" });
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
    })).toEqual({ models: [], supportedEfforts: codexFallback });
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
    })).toEqual({ models: ["fixture-model"], defaultModel: "fixture-model", supportedEfforts: codexFallback });

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
    expect(JSON.parse(output)).toEqual({ models: [], supportedEfforts: codexFallback });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers Claude models via stream-json initialize control_request", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-claude-"));
  try {
    await mkdir(join(fixture, ".claude"), { recursive: true });
    const settings = join(fixture, ".claude", "settings.json");
    await writeFile(settings, JSON.stringify({ model: "opus[1m]", effortLevel: "high", effort: "low" }));
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
    const options = {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    };
    const expected = {
      defaultModel: "opus[1m]",
      models: ["opus[1m]", "sonnet[1m]", "haiku"],
      supportedEfforts: claudeEfforts,
    };
    expect(await discoverCliModels("claude", options)).toEqual({ ...expected, defaultEffort: "high" });

    await writeFile(settings, JSON.stringify({ model: "opus[1m]", effortLevel: "ultra", effort: "max" }));
    expect(await discoverCliModels("claude", options)).toEqual({ ...expected, defaultEffort: "max" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers Antigravity models and exact per-model efforts via ACP configOptions and availableModels", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-antigravity-acp-"));
  try {
    const command = await createFakeCli(fixture, "agy", `
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] !== "acp" || !args.includes("--sandbox") || !args.includes("--disable-telemetry")) process.exit(2);
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
        sessionId: "agy-1",
        models: {
          currentModelId: "gemini-4-neon-high",
          availableModels: [
            { modelId: "gemini-4-neon-high" },
            { modelId: "gemini-4-neon-xhigh" },
            { modelId: "gemini-4-neon-low" },
            { modelId: "gemini-4-carbon-medium" },
            { modelId: "gemini-4-carbon-high" },
            { modelId: "gemini-pro-orchestrator-neon" },
            { modelId: "gpt-oss-120b-medium" },
          ],
        },
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "gemini-4-neon",
            options: [
              { value: "gemini-4-neon", name: "Gemini 4 Neon" },
              { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
              { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
              { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
              { value: "--injected", name: "Bad" },
            ],
          },
          {
            id: "thought_level",
            category: "thought_level",
            currentValue: "high",
            options: [
              { value: "low" },
              { value: "medium" },
              { value: "high" },
              { value: "xhigh" },
            ],
          },
        ],
      },
    }));
  }
});
`);
    const discovered = await discoverCliModels("antigravity", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    });
    expect(discovered).toEqual({
      defaultModel: "gemini-4-neon",
      defaultEffort: "high",
      models: ["gemini-4-neon", "gemini-4-carbon", "gemini-pro-orchestrator-neon", "gpt-oss-120b-medium"],
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      modelEfforts: {
        "gemini-4-neon": ["low", "high", "xhigh"],
        "gemini-4-carbon": ["medium", "high"],
        "gemini-pro-orchestrator-neon": [],
        "gpt-oss-120b-medium": [],
      },
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("falls back to agy models output when Antigravity ACP is unavailable", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-antigravity-models-"));
  try {
    const command = await createFakeCli(fixture, "agy", `
const args = process.argv.slice(2);
if (args[0] === "acp") process.exit(2);
if (args[0] === "models") {
  console.log("\\r⠋ Fetching available models...\\rgemini-4-neon-high\\tGemini 4 Neon (High)");
  console.log("gemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)");
  console.log("gemini-4-neon-low\\tGemini 4 Neon (Low)");
  console.log("gpt-oss-120b-medium  GPT-OSS 120B (Medium)");
  console.log("--flag-bad\\tIgnored");
} else {
  process.exit(3);
}
`);
    const discovered = await discoverCliModels("antigravity", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    });
    expect(discovered).toEqual({
      defaultModel: undefined,
      models: ["gemini-4-neon", "gpt-oss-120b-medium"],
      supportedEfforts: ["low", "high", "xhigh"],
      modelEfforts: {
        "gemini-4-neon": ["low", "high", "xhigh"],
        "gpt-oss-120b-medium": [],
      },
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers Gemini CLI models via isolated ACP and falls back to models list JSON", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-gemini-cli-"));
  try {
    await mkdir(join(fixture, ".gemini"), { recursive: true });
    await writeFile(join(fixture, ".gemini", "settings.json"), JSON.stringify({ model: { name: "gemini-3.8-flash" } }));
    const acpCli = await createFakeCli(fixture, "gemini", `
import readline from "node:readline";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (!args.includes("--acp") || !args.includes("--policy")) process.exit(2);
if (!process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) process.exit(3);
const settings = JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
if (settings.hooksConfig?.enabled !== false) process.exit(4);
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
        sessionId: "gemini-1",
        models: {
          currentModelId: "auto",
          availableModels: [
            { modelId: "auto", name: "Auto" },
            { modelId: "gemini-3.1-pro-preview" },
            { modelId: "gemini-3.8-flash" },
          ],
        },
        ...(process.env.FIXTURE_EFFORT ? {
          configOptions: [{
            id: "thought_level",
            category: "thought_level",
            currentValue: "medium",
            options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
          }],
        } : {}),
      },
    }));
  }
});
`);

    const env = { ...fixtureEnv(), GEMINI_CLI_SYSTEM_SETTINGS_PATH: undefined };
    expect(await discoverCliModels("gemini", { command: acpCli, home: fixture, env, timeoutMs: 3_000 })).toEqual({
      defaultModel: "gemini-3.8-flash",
      models: ["gemini-3.8-flash", "auto", "gemini-3.1-pro-preview"],
      supportedEfforts: geminiCliEfforts,
    });
    expect(await discoverCliModels("gemini", {
      command: acpCli, home: fixture, env: { ...env, FIXTURE_EFFORT: "1" }, timeoutMs: 3_000,
    })).toEqual({
      defaultModel: "gemini-3.8-flash",
      defaultEffort: "medium",
      models: ["gemini-3.8-flash", "auto", "gemini-3.1-pro-preview"],
      supportedEfforts: ["low", "medium", "high"],
    });

    const listOnlyCli = await createFakeCli(fixture, "gemini-list", `
const args = process.argv.slice(2);
if (args.includes("--acp")) process.exit(2);
if (args[0] === "models" && args[1] === "list" && args.includes("json")) {
  console.log(JSON.stringify([
    { modelId: "auto", name: "Auto" },
    { modelId: "gemini-3.8-flash", name: "gemini-3.8-flash" },
    { modelId: "--bad", name: "Bad" },
  ]));
} else {
  process.exit(3);
}
`);
    expect(await discoverCliModels("gemini", { command: listOnlyCli, home: fixture, env, timeoutMs: 3_000 })).toEqual({
      defaultModel: "gemini-3.8-flash",
      models: ["gemini-3.8-flash", "auto"],
      supportedEfforts: geminiCliEfforts,
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers live Gemini API models, thinking capabilities, and schema effort levels", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-gemini-api-"));
  try {
    const command = await createFakeCli(fixture, "gemini-api", `
const args = process.argv.slice(2);
if (args[0] === "models" && args[1] === "list") {
  console.log(JSON.stringify({
    models: [
      { name: "models/gemini-4-hydrogen", supportedGenerationMethods: ["generateContent"], thinking: true },
      { name: "models/gemini-4-neon", supportedGenerationMethods: ["generateContent"], thinking: true },
      { name: "models/gemma-4-31b-it", supportedGenerationMethods: ["generateContent"], thinking: false },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/--flag-injection", supportedGenerationMethods: ["generateContent"] },
    ],
  }));
} else if (args[0] === "models") {
  console.log(JSON.stringify([
    { group: "Gemini", value: "gemini-4-hydrogen", default: true },
    { group: "Image", value: "gemini-nano-banana-2.1", default: false },
  ]));
} else if (args[0] === "generate" && args.includes("--schema")) {
  console.log(JSON.stringify({
    $defs: {
      ThinkingLevel: { enum: ["minimal", "low", "medium", "high", "xhigh"] },
    },
  }));
} else {
  process.exit(2);
}
`);
    const discovered = await discoverCliModels("gemini-api", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    });
    expect(discovered).toEqual({
      defaultModel: "gemini-4-hydrogen",
      models: ["gemini-4-hydrogen", "gemini-4-neon", "gemma-4-31b-it"],
      supportedEfforts: geminiApiEfforts,
      modelEfforts: {
        "gemini-4-hydrogen": geminiApiEfforts,
        "gemini-4-neon": geminiApiEfforts,
        "gemma-4-31b-it": [],
      },
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("falls back to gemini-api CLI catalog when live models list is unauthenticated", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-cli-gemini-catalog-"));
  try {
    const command = await createFakeCli(fixture, "gemini-api", `
const args = process.argv.slice(2);
if (args[0] === "models" && args[1] === "list") {
  process.exit(3);
} else if (args[0] === "models") {
  console.log(JSON.stringify([
    { group: "Gemma", value: "gemma-4-31b-it", default: false },
    { group: "Gemini", value: "gemini-4-hydrogen", default: true },
    { group: "Video", value: "gemini-omni-1.2-flash", default: false },
  ]));
} else if (args[0] === "generate" && args.includes("--schema")) {
  console.log(JSON.stringify({
    $defs: {
      ThinkingLevel: { enum: ["low", "medium", "high", "xhigh"] },
    },
  }));
} else {
  process.exit(2);
}
`);
    const discovered = await discoverCliModels("gemini-api", {
      command,
      home: fixture,
      env: fixtureEnv(),
      timeoutMs: 3_000,
    });
    expect(discovered).toEqual({
      defaultModel: "gemini-4-hydrogen",
      models: ["gemini-4-hydrogen", "gemma-4-31b-it"],
      supportedEfforts: ["low", "medium", "high", "xhigh"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("discovers Qwen models and optional effort via flat and grouped ACP options", async () => {
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
          ...(process.env.FIXTURE_EFFORT ? [
            {
              id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "medium",
              options: [
                { value: "default" },
                { value: "low" },
                { group: "levels", options: [{ value: "medium" }, { value: "xhigh" }, { value: "ultra" }] },
              ],
            },
            { id: "depth", category: "effort", options: [{ value: "max" }] },
          ] : []),
        ],
      },
    }));
  }
});
`);

    const options = { command: qwen, home: fixture, env: fixtureEnv(), timeoutMs: 3_000 };
    const modelDiscovery = {
      defaultModel: "qwen3-coder-next",
      models: ["qwen3-coder-next", "qwen3-max-latest"],
    };
    expect(await discoverCliModels("qwen", options)).toEqual(modelDiscovery);
    expect(await discoverCliModels("qwen", { ...options, env: { ...options.env, FIXTURE_EFFORT: "1" } })).toEqual({
      ...modelDiscovery,
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "xhigh", "max"],
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
      supportedEfforts: ["low", "medium", "high", "max"],
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
      supportedEfforts: ["low", "medium", "high", "max"],
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

    expect(await discoverCliModels("antigravity", { home: fixture, env: {} })).toEqual({ models: [] });
    expect(await discoverCliModels("antigravity", { command: failing, home: fixture, env: fixtureEnv(), timeoutMs: 1_000 })).toEqual({
      models: [],
    });
    expect(await discoverCliModels("gemini", { home: fixture, env: {} })).toEqual({ models: [] });
    expect(await discoverCliModels("gemini", { command: failing, home: fixture, env: fixtureEnv(), timeoutMs: 1_000 })).toEqual({
      models: [],
      supportedEfforts: geminiCliEfforts,
    });
    expect(await discoverCliModels("gemini-api", { command: failing, home: fixture, env: fixtureEnv(), timeoutMs: 1_000 })).toEqual({
      models: [],
      supportedEfforts: geminiApiEfforts,
    });
    expect(await discoverCliModels("claude", { command: failing, home: fixture, env: fixtureEnv(), timeoutMs: 1_000 })).toEqual({
      models: [],
      supportedEfforts: claudeEfforts,
    });
    expect(await discoverCliModels("codex", { command: hanging, home: fixture, env: { ...fixtureEnv(), CODEX_HOME: join(fixture, ".codex") }, timeoutMs: 250 })).toEqual({
      models: [],
      supportedEfforts: codexFallback,
    });
    await Bun.sleep(1_400);
    await expect(access(markerPath)).rejects.toThrow();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
