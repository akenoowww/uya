import type { EffortLevel } from "@ide/protocol";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./agents";
import { prepareCodex, prepareOpenCode } from "./cli-adapters";
import { buildGeminiInteractionBody, resolveGeminiThinkingLevel } from "./gemini";
import * as localRuntimes from "./local-runtimes";
import * as ollama from "./ollama";
import { ProviderRegistry } from "./provider-registry";

const registry = new ProviderRegistry(
  async () => ["ollama-fixture"],
  async (id) => [`${id}-fixture`],
  async (id) => ({ models: [`${id}-cli-model`], defaultModel: `${id}-cli-model` }),
);

async function runFixture(id: string, script: string, options: {
  effort?: EffortLevel;
  supportedEfforts?: EffortLevel[];
  run?: typeof registry.run;
} = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "uya-adapter-fixture-"));
  try {
    const command = join(fixture, "fixture-cli");
    await writeFile(command, "#!/bin/sh\nset -eu\n" + script, { mode: 0o700 });
    const events: [string, string][] = [];
    const { effort, supportedEfforts, run = (request) => registry.run(request) } = options;
    const usage = await run({
      provider: { id, name: "CLI Fixture", kind: "cli", command, structured: true, terminal: true, available: true, supportedEfforts },
      prompt: "/goal test @reference",
      effort,
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
      supportedEfforts: id === "ollama" ? ["minimal", "low", "medium", "high"] : ["low", "medium", "high"],
    });
  }
  expect(sources.find((source) => source.id === "kimi")?.structured).toBe(false);
});

test("registry forwards the requested effort to every local runtime", async () => {
  const ollamaRun = spyOn(ollama, "runOllama").mockResolvedValue({});
  const localRun = spyOn(localRuntimes, "runLocalRuntime").mockResolvedValue({});
  try {
    for (const provider of (await registry.discover()).filter((source) => source.kind === "runtime")) {
      await registry.run({
        provider, model: provider.models?.[0], prompt: "fixture", effort: "medium",
        signal: AbortSignal.timeout(1_000),
        output: { emit() {}, raw() {} },
      });
    }
    expect(ollamaRun.mock.calls.map((args) => [args[0], args[7]])).toEqual([["ollama-fixture", "medium"]]);
    expect(localRun.mock.calls.map((args) => [args[0], args[6]])).toEqual([
      ["llamacpp", "medium"], ["mlx", "medium"], ["lmstudio", "medium"],
    ]);
  } finally {
    ollamaRun.mockRestore();
    localRun.mockRestore();
  }
});

test("Qwen adapter opts out of tools and uses stdin for literal prompt and previous turns", async () => {
  const result = await runFixture("qwen", `
case " $* " in *" --safe-mode --max-tool-calls 0 --input-format text --output-format stream-json "*) ;; *) exit 2;; esac
[ ! -e .qwen/settings.json ]
payload=$(/bin/cat)
case "$payload" in *"Keep this answer"*"/goal test"*) ;; *) exit 3;; esac
case "$payload" in "@*"|"/"*|*"@"*) exit 4;; esac
printf '%s\\n' '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Qwen fixture"}}}'
printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":3,"output_tokens":2}}'
`);
  expect(result).toEqual({ events: [["text", "Qwen fixture"]], usage: { inputTokens: 3, outputTokens: 2 } });
});

test("Qwen adapter configures an advertised effort in the scratch workspace", async () => {
  const result = await runFixture("qwen", `
case " $* " in *" --safe-mode --max-tool-calls 0 --input-format text --output-format stream-json "*) ;; *) exit 2;; esac
/usr/bin/grep -q '"reasoningEffort":"xhigh"' .qwen/settings.json
/usr/bin/grep -q '"TRUST_FOLDER"' "$QWEN_CODE_TRUSTED_FOLDERS_PATH"
/bin/cat >/dev/null
printf '%s\\n' '{"type":"result","subtype":"success","result":"Qwen effort fixture"}'
`, { effort: "xhigh", supportedEfforts: ["high", "xhigh"] });
  expect(result.events).toEqual([["text", "Qwen effort fixture"]]);
});

test("Gemini API adapter streams Interactions API thought and text deltas with native multi-turn JSON stdin", async () => {
  const result = await runFixture("gemini", `
case " $* " in *" generate --no-interactive -o json "*) ;; *) exit 2;; esac
payload=$(/bin/cat)
case "$payload" in *'"store":false'*'"stream":true'*'"thinking_level":"xhigh"'*'"thinking_summaries":"auto"'*) ;; *) exit 3;; esac
case "$payload" in *'"type":"user_input"'*'First turn'*'"type":"model_output"'*'Keep this answer'*'/goal test @reference'*) ;; *) exit 4;; esac
printf '%s\\n' '{"data":{"event_type":"interaction.created","interaction":{"id":"v1_1","model":"gemini-4-hydrogen","status":"in_progress"}}}'
printf '%s\\n' '{"data":{"event_type":"step.delta","index":0,"delta":{"type":"thought_summary","content":{"type":"text","text":"Thinking..."}}}}'
printf '%s\\n' '{"data":{"event_type":"step.delta","index":1,"delta":{"type":"text","text":"Gemini "}}}'
printf '%s\\n' '{"data":{"event_type":"step.delta","index":1,"delta":{"type":"text","text":"API fixture"}}}'
printf '%s\\n' '{"data":{"event_type":"interaction.completed","interaction":{"id":"v1_1","model":"gemini-4-hydrogen","status":"completed","usage":{"total_input_tokens":14,"total_output_tokens":6}}}}'
`, { effort: "max" });
  expect(result).toEqual({
    events: [["thinking", "Thinking..."], ["text", "Gemini "], ["text", "API fixture"]],
    usage: { model: "gemini-4-hydrogen", inputTokens: 14, outputTokens: 6 },
  });
});

test("Gemini API request body maps effort dynamically and omits thinking config for non-thinking models", () => {
  expect(resolveGeminiThinkingLevel("minimal")).toBe("minimal");
  expect(resolveGeminiThinkingLevel("low")).toBe("low");
  expect(resolveGeminiThinkingLevel("medium")).toBe("medium");
  expect(resolveGeminiThinkingLevel("high")).toBe("high");
  expect(resolveGeminiThinkingLevel("xhigh")).toBe("xhigh");
  expect(resolveGeminiThinkingLevel("max")).toBe("xhigh");
  expect(resolveGeminiThinkingLevel(undefined)).toBeUndefined();

  const provider = {
    id: "gemini",
    name: "Gemini API",
    kind: "cli" as const,
    available: true,
    terminal: true,
    structured: true,
    defaultModel: "gemini-4-hydrogen",
    modelEfforts: {
      "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"] as EffortLevel[],
      "gemma-4-31b-it": [] as EffortLevel[],
    },
  };

  expect(buildGeminiInteractionBody({ provider, prompt: "hello", model: "gemma-4-31b-it" })).toEqual({
    store: false,
    stream: true,
    input: [{ type: "user_input", content: [{ type: "text", text: "hello" }] }],
  });
  expect(buildGeminiInteractionBody({ provider, prompt: "hello" }).generation_config).toEqual({
    thinking_summaries: "auto",
  });
  expect(buildGeminiInteractionBody({ provider, prompt: "hello", effort: "high" }).generation_config).toEqual({
    thinking_level: "high",
    thinking_summaries: "auto",
  });
});

test("OpenCode adapter uses the isolated tool-denying agent and parses normalized usage", async () => {
  const result = await runFixture("opencode", `
case " $* " in *" --pure run --format json --thinking --agent uya-structured-"*" --title Uya run "*) ;; *) exit 2;; esac
case " $* " in *" --variant high "*) ;; *) exit 4;; esac
case "$OPENCODE_CONFIG_CONTENT" in *'"share":"disabled"'*'"permission":{"*":"deny"}'*'"mode":"primary","permission":{"*":"deny"},"variant":"high"'*) ;; *) exit 5;; esac
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
`, { effort: "high", run: (request) => runCli(request, prepareOpenCode) });
  expect(result).toEqual({
    events: [["thinking", "Fixture rationale"], ["text", "OpenCode fixture"]],
    usage: { inputTokens: 5, outputTokens: 3 },
  });
});

test("Claude adapter passes --model and mapped --effort, captures the model, and classifies auth errors", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-claude-fixture-"));
  try {
    const okCommand = join(fixture, "claude-ok");
    await writeFile(okCommand, `#!/bin/sh
set -eu
case " $* " in *" --model claude-opus-4-6 "*) ;; *) exit 2;; esac
case " $* " in *" --effort high "*) ;; *) exit 3;; esac
/bin/cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","model":"claude-opus-4-6"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Fallback result text","usage":{"input_tokens":7,"output_tokens":4}}'
`, { mode: 0o700 });
    const events: [string, string][] = [];
    const usage = await registry.run({
      provider: { id: "claude", name: "Claude Code", kind: "cli", command: okCommand, structured: true, terminal: true, available: true },
      model: "claude-opus-4-6",
      effort: "xhigh",
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

test("Codex adapter passes --model and effort before exec and streams content without duplication", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-codex-fixture-"));
  try {
    const command = join(fixture, "codex-ok");
    await writeFile(command, `#!/bin/sh
set -eu
case " $* " in *" --model gpt-6.2-sol "*) ;; *) exit 2;; esac
case " $* " in *' -c model_reasoning_effort="low" exec '*) ;; *) exit 3;; esac
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
      effort: "minimal",
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

test("Codex omits the effort override for unset or unrecognized values", async () => {
  for (const effort of [undefined, 'high" -c web_search="live' as EffortLevel]) {
    const { args } = await prepareCodex({
      provider: { id: "codex", name: "Codex", kind: "cli", structured: true, terminal: true, available: true },
      prompt: "fixture", effort, signal: AbortSignal.timeout(1_000), output: { emit() {}, raw() {} },
    }, "", {});
    expect(args.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
  }
});

test("registry reports discovered CLI effort metadata and built-in fallbacks", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "uya-registry-efforts-"));
  const previousPath = process.env.PATH;
  try {
    for (const id of ["codex", "claude", "qwen"]) {
      await writeFile(join(fixture, id), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    process.env.PATH = fixture;
    const sources = await new ProviderRegistry(async () => [], async () => [], async (id) => id === "codex"
      ? {
        models: ["codex-fixture"], defaultModel: "codex-fixture", defaultEffort: "xhigh",
        supportedEfforts: ["medium", "xhigh"], modelEfforts: { "codex-fixture": ["medium", "xhigh"] },
      }
      : { models: [] }).discover();
    expect(sources.find((source) => source.id === "codex")).toMatchObject({
      defaultModel: "codex-fixture", defaultEffort: "xhigh",
      supportedEfforts: ["medium", "xhigh"], modelEfforts: { "codex-fixture": ["medium", "xhigh"] },
    });
    expect(sources.find((source) => source.id === "claude")?.supportedEfforts).toEqual(["low", "medium", "high", "max"]);
    expect(sources.find((source) => source.id === "qwen")?.supportedEfforts).toBeUndefined();
    expect(sources.find((source) => source.id === "gemini")?.supportedEfforts).toBeUndefined();
    for (const source of sources.filter((source) => source.kind === "runtime")) {
      expect(source.structured).toBe(false);
      expect(source.supportedEfforts).toBeUndefined();
    }
  } finally {
    process.env.PATH = previousPath;
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
  const previousOpenCodeSettings = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
  try {
    for (const id of ["opencode", "kimi"]) {
      await writeFile(join(fixture, id), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    process.env.PATH = fixture;
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
      for (const id of ["opencode", "kimi"]) {
        const provider = sources.find((entry) => entry.id === id);
        expect(provider).toMatchObject({ available: true, terminal: true, structured: false });
        expect(provider?.models).toBeUndefined();
        expect(provider?.supportedEfforts).toBeUndefined();
      }
    }
    expect(calls).toEqual([]);
  } finally {
    process.env.PATH = previousPath;
    if (previousOpenCodeSettings === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
    else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousOpenCodeSettings;
    await rm(fixture, { recursive: true, force: true });
  }
});
