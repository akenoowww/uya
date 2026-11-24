import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./agents";
import { geminiBlocked, prepareOpenCode } from "./cli-adapters";
import type { AdapterRequest } from "./provider-adapter";
import { ProviderRegistry } from "./provider-registry";

const registry = new ProviderRegistry(
  async () => ["ollama-fixture"],
  async (id) => [`${id}-fixture`],
  async (id) => ({ models: [`${id}-cli-model`], defaultModel: `${id}-cli-model` }),
);

async function runFixture(id: string, script: string, run = (request: AdapterRequest) => registry.run(request)) {
  const fixture = await mkdtemp(join(tmpdir(), "uya-adapter-fixture-"));
  try {
    const command = join(fixture, "fixture-cli");
    await writeFile(command, "#!/bin/sh\nset -eu\n" + script, { mode: 0o700 });
    const events: [string, string][] = [];
    const usage = await run({
      provider: { id, name: "CLI Fixture", kind: "cli", command, structured: true, terminal: true, available: true },
      prompt: "/goal test @reference",
      messages: [
        { role: "user", content: "First turn" },
        { role: "assistant", content: "Keep this answer" },
        { role: "user", content: "/goal test @reference" },
      ],
      signal: AbortSignal.timeout(3_000),
      output: {
        emit: (kind, text) => { events.push([kind, text]); },
        raw: () => {},
      },
    });
    return { events, usage };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("registry advertises HTTP runtime capability separately from installed terminal commands", async () => {
  const sources = await registry.discover();
  for (const id of ["ollama", "llamacpp", "lmstudio", "mlx"]) {
    expect(sources.find((source) => source.id === id)).toMatchObject({
      kind: "runtime", available: true, structured: true, models: [`${id}-fixture`],
    });
  }
  expect(sources.find((source) => source.id === "kimi")?.structured).toBe(false);
});

test("Qwen adapter opts out of tools and uses stdin for literal prompt and previous turns", async () => {
  const result = await runFixture("qwen", `
case " $* " in *" --safe-mode --max-tool-calls 0 --input-format text --output-format stream-json "*) ;; *) exit 2;; esac
payload=$(/bin/cat)
case "$payload" in *"Keep this answer"*"/goal test"*) ;; *) exit 3;; esac
case "$payload" in "@*"|"/"*|*"@"*) exit 4;; esac
printf '%s\\n' '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Qwen fixture"}}}'
printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":3,"output_tokens":2}}'
`);
  expect(result).toEqual({ events: [["text", "Qwen fixture"]], usage: { inputTokens: 3, outputTokens: 2 } });
});

const testGemini = geminiBlocked() ? test.skip : test;
testGemini("Gemini adapter isolates settings and decodes assistant deltas", async () => {
  const result = await runFixture("gemini", `
case " $* " in *" --extensions none --allowed-mcp-server-names "*" --policy "*" --approval-mode default --output-format stream-json "*) ;; *) exit 2;; esac
/usr/bin/grep -q '"hooksConfig":{"enabled":false}' "$GEMINI_CLI_SYSTEM_SETTINGS_PATH"
/usr/bin/grep -q '"tools":{"core":' "$GEMINI_CLI_SYSTEM_SETTINGS_PATH"
payload=$(/bin/cat)
case "$payload" in *"Keep this answer"*"/goal test"*) ;; *) exit 3;; esac
case "$payload" in "@"*|"/"*|*"@"*) exit 4;; esac
printf '%s\\n' '{"type":"message","role":"assistant","content":"Gemini fixture","delta":true}'
printf '%s\\n' '{"type":"message","role":"assistant","content":"Gemini fixture","delta":false}'
printf '%s\\n' '{"type":"result","status":"success","stats":{"input_tokens":4,"output_tokens":2}}'
`);
  expect(result).toEqual({ events: [["text", "Gemini fixture"]], usage: { inputTokens: 4, outputTokens: 2 } });
});

test("OpenCode adapter uses the isolated tool-denying agent and parses normalized usage", async () => {
  const result = await runFixture("opencode", `
case " $* " in *" --pure run --format json --thinking --agent uya-structured-"*" --title Uya run "*) ;; *) exit 2;; esac
[ "$XDG_CONFIG_HOME" = "$OPENCODE_CONFIG_DIR" ]
[ "$XDG_DATA_HOME" = "$XDG_CONFIG_HOME" ]
[ "$OPENCODE_AUTH_CONTENT" = '{}' ]
[ "$OPENCODE_DB" = ":memory:" ]
[ "$OPENCODE_PERMISSION" = '{"*":"deny"}' ]
payload=$(/bin/cat)
case "$payload" in *"Keep this answer"*"/goal test"*) ;; *) exit 3;; esac
printf '%s\\n' '{"type":"step_start"}'
printf '%s\\n' '{"type":"reasoning","part":{"text":"Fixture rationale"}}'
printf '%s\\n' '{"type":"text","part":{"text":"OpenCode fixture"}}'
printf '%s\\n' '{"type":"step_finish","part":{"tokens":{"input":5,"output":3}}}'
`, (request) => runCli(request, prepareOpenCode));
  expect(result).toEqual({
    events: [["thinking", "Fixture rationale"], ["text", "OpenCode fixture"]],
    usage: { inputTokens: 5, outputTokens: 3 },
  });
});

test("Claude adapter passes --model, captures init model, and classifies result auth errors", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-claude-fixture-"));
  try {
    const okCommand = join(fixture, "claude-ok");
    await writeFile(okCommand, `#!/bin/sh
set -eu
case " $* " in *" --model claude-opus-4-6 "*) ;; *) exit 2;; esac
/bin/cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","model":"claude-opus-4-6"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Fallback result text","usage":{"input_tokens":7,"output_tokens":4}}'
`, { mode: 0o700 });
    const events: [string, string][] = [];
    const usage = await registry.run({
      provider: { id: "claude", name: "Claude Code", kind: "cli", command: okCommand, structured: true, terminal: true, available: true },
      model: "claude-opus-4-6",
      prompt: "hi",
      signal: AbortSignal.timeout(3_000),
      output: { emit: (kind, text) => { events.push([kind, text]); }, raw: () => {} },
    });
    expect(events).toEqual([["text", "Fallback result text"]]);
    expect(usage).toEqual({ inputTokens: 7, outputTokens: 4, model: "claude-opus-4-6" });

    const errCommand = join(fixture, "claude-err");
    await writeFile(errCommand, `#!/bin/sh
set -eu
/bin/cat >/dev/null
printf '%s\\n' '{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Failed to authenticate. API Error: 401"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401"}'
`, { mode: 0o700 });
    const errEvents: [string, string][] = [];
    await expect(registry.run({
      provider: { id: "claude", name: "Claude Code", kind: "cli", command: errCommand, structured: true, terminal: true, available: true },
      prompt: "hi",
      signal: AbortSignal.timeout(3_000),
      output: { emit: (kind, text) => { errEvents.push([kind, text]); }, raw: () => {} },
    })).rejects.toThrow(/could not authenticate/i);
    expect(errEvents).toEqual([]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Codex adapter passes --model and supports delta and content block formats without duplication", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-codex-fixture-"));
  try {
    const command = join(fixture, "codex-ok");
    await writeFile(command, `#!/bin/sh
set -eu
case " $* " in *" --model gpt-6.2-sol "*) ;; *) exit 2;; esac
/bin/cat >/dev/null
printf '%s\\n' '{"type":"item.delta","item":{"id":"msg_1","type":"agent_message"},"delta":"Hello "}'
printf '%s\\n' '{"type":"item.delta","item":{"id":"msg_1","type":"agent_message"},"delta":"world"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"msg_1","type":"agent_message","text":"Hello world"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"msg_2","type":"agent_message","content":[{"type":"output_text","text":"!"}]}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}'
`, { mode: 0o700 });
    const events: [string, string][] = [];
    const usage = await registry.run({
      provider: { id: "codex", name: "Codex", kind: "cli", command, structured: true, terminal: true, available: true },
      model: "gpt-6.2-sol",
      prompt: "hi",
      signal: AbortSignal.timeout(3_000),
      output: { emit: (kind, text) => { events.push([kind, text]); }, raw: () => {} },
    });
    expect(events).toEqual([["text", "Hello "], ["text", "world"], ["text", "!"]]);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("registry keeps refreshed models when an older probe finishes later", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-registry-cache-"));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(fixture, "qwen"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = fixture;
    const calls: { id: string; command?: string; refresh?: boolean }[] = [];
    let finishInitial!: () => void;
    const initialProbe = new Promise<void>((resolve) => { finishInitial = resolve; });
    const cachedRegistry = new ProviderRegistry(
      async () => [],
      async () => [],
      async (id, options) => {
        calls.push({ id, command: options?.command, refresh: options?.refresh });
        const model = options?.refresh ? "qwen-v2" : "qwen-v1";
        if (!options?.refresh) await initialProbe;
        return { models: [model], defaultModel: model };
      },
    );

    const initial = cachedRegistry.discover();
    const refreshed = (await cachedRegistry.discover(true)).find((entry) => entry.id === "qwen");
    finishInitial();
    expect((await initial).find((entry) => entry.id === "qwen")?.models).toEqual(["qwen-v1"]);
    expect(refreshed?.models).toEqual(["qwen-v2"]);
    const cached = (await cachedRegistry.discover()).find((entry) => entry.id === "qwen");
    expect(cached?.models).toEqual(["qwen-v2"]);
    expect(calls).toEqual([
      { id: "qwen", command: join(fixture, "qwen"), refresh: false },
      { id: "qwen", command: join(fixture, "qwen"), refresh: true },
    ]);
  } finally {
    process.env.PATH = previousPath;
    await rm(fixture, { recursive: true, force: true });
  }
});

test("registry leaves managed and terminal-only providers in the terminal without probing models", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-registry-managed-"));
  const previousPath = process.env.PATH;
  const previousGeminiSettings = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const previousOpenCodeSettings = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
  try {
    for (const id of ["gemini", "opencode", "kimi"]) {
      await writeFile(join(fixture, id), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    process.env.PATH = fixture;
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(fixture, "gemini-settings.json");
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = join(fixture, "opencode-settings");
    const calls: string[] = [];
    const managedRegistry = new ProviderRegistry(
      async () => [],
      async () => [],
      async (id) => {
        calls.push(id);
        return { models: ["fixture-model"] };
      },
    );
    for (const refresh of [false, true]) {
      const sources = await managedRegistry.discover(refresh);
      for (const id of ["gemini", "opencode", "kimi"]) {
        const provider = sources.find((entry) => entry.id === id);
        expect(provider).toMatchObject({ available: true, terminal: true, structured: false });
        expect(provider?.models).toBeUndefined();
      }
    }
    expect(calls).toEqual([]);
  } finally {
    process.env.PATH = previousPath;
    if (previousGeminiSettings === undefined) delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = previousGeminiSettings;
    if (previousOpenCodeSettings === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
    else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousOpenCodeSettings;
    await rm(fixture, { recursive: true, force: true });
  }
});
