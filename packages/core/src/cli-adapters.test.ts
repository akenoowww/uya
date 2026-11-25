import type { ExecutionMode, ToolMeta } from "@ide/protocol";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliPrepare } from "./agents";
import { prepareClaude, prepareCodex, prepareGeminiApi, prepareGeminiCli, prepareOpenCode } from "./cli-adapters";
import { geminiCliInvocation } from "./gemini";
import type { AdapterOutput, AdapterRequest, Usage } from "./provider-adapter";

const workspacePath = join(tmpdir(), "uya fixture workspace");
const worktreePath = join(tmpdir(), "uya fixture worktree");
const providerSessionId = "fixture_session-123";

function cliFixture(id: string, options: Partial<AdapterRequest> = {}) {
  const events: { type: Parameters<AdapterOutput["emit"]>[0]; text: string; meta?: ToolMeta }[] = [];
  const request: AdapterRequest = {
    provider: { id, name: id, kind: "cli", command: process.execPath, available: true, structured: true, terminal: true },
    prompt: "Current turn",
    signal: AbortSignal.timeout(4_000),
    output: { emit: (type, text, meta) => events.push({ type, text, meta }), raw() {} },
    ...options,
  };
  const usage: Usage = {};
  return { request, events, usage };
}

function parseEvents(invocation: Awaited<ReturnType<CliPrepare>>, ...events: Record<string, unknown>[]): boolean[] {
  const { parse } = invocation;
  if (!parse) throw new Error("Expected a structured CLI parser.");
  return events.map((event) => parse(JSON.stringify(event)));
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function withFixture<T>(use: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "uya-cli-test-"));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Codex separates new text items, preserves streamed chunks, and records session and cache usage", async () => {
  const { request, events, usage } = cliFixture("codex");
  const invocation = await prepareCodex(request, "", usage);
  const complete = parseEvents(invocation,
    { type: "thread.started", thread_id: providerSessionId },
    { type: "reasoning_delta", item_id: "thought", delta: "Checking the files" },
    { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "...если он есть." } },
    { type: "agent_message_delta", item_id: "msg_2", delta: "Вижу" },
    { type: "item.delta", item: { id: "msg_2", type: "agent_message" }, delta: " файл." },
    { type: "item.completed", item: { id: "msg_2", type: "agent_message", text: "Вижу файл." } },
    { type: "item.completed", item: { id: "msg_3", type: "agent_message", content: [{ type: "output_text", text: "Готово." }] } },
    { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 12, output_tokens: 7 } },
  );
  expect(complete).toEqual([false, false, false, false, false, false, false, true]);
  expect(events.map(({ type, text }) => [type, text])).toEqual([
    ["thinking", "Checking the files"], ["text", "...если он есть."], ["text", "\n\n"],
    ["text", "Вижу"], ["text", " файл."], ["text", "\n\n"], ["text", "Готово."],
  ]);
  expect(usage).toEqual({ providerSessionId, inputTokens: 20, cachedInputTokens: 12, outputTokens: 7 });
});

test("Codex handles anonymous deltas and attaches standalone sentence punctuation", async () => {
  const { request, events, usage } = cliFixture("codex");
  const invocation = await prepareCodex(request, "", usage);
  parseEvents(invocation,
    { type: "agent_message_delta", delta: "First" },
    { type: "agent_message_delta", delta: " sentence" },
    { type: "item.completed", item: { type: "agent_message", text: "First sentence" } },
    { type: "item.completed", item: { type: "agent_message", text: "!" } },
    { type: "item.completed", item: { type: "agent_message", text: "Second sentence." } },
  );
  expect(events.map(({ text }) => text)).toEqual(["First", " sentence", "!", "\n\n", "Second sentence."]);
});

test("Codex emits structured command, file change, MCP, and generic tool events", async () => {
  const { request, events, usage } = cliFixture("codex");
  const invocation = await prepareCodex(request, "", usage);
  const command = { id: "cmd", type: "command_execution", command: "rg fixture" };
  parseEvents(invocation,
    { type: "session.created", session_id: providerSessionId },
    { type: "item.started", item: { ...command, status: "in_progress" } },
    { type: "item.completed", item: { ...command, status: "completed", exit_code: 2, aggregated_output: "x".repeat(4_000) } },
    { type: "item.completed", item: { id: "patch", type: "file_change", changes: [{ path: "notes.txt", kind: "update" }], status: "completed" } },
    { type: "item.completed", item: { id: "mcp", type: "mcp_tool_call", tool: "read_file", arguments: { file_path: "notes.txt" },
      status: "completed", result: { content: [{ type: "text", text: "Fixture contents" }] } } },
    { type: "item.completed", item: { id: "call", type: "custom_tool_call", name: "fixture", status: "failed",
      summary: "Fixture lookup", error: { message: "Lookup failed" } } },
  );
  expect(usage.providerSessionId).toBe(providerSessionId);
  expect(events).toHaveLength(5);
  expect(events.every(({ type }) => type === "tool")).toBe(true);
  expect(events.map(({ meta }) => meta)).toMatchObject([
    { id: "cmd", name: "command_execution", kind: "shell", status: "running", command: "rg fixture", summary: "rg fixture" },
    { id: "cmd", name: "command_execution", kind: "shell", status: "error", command: "rg fixture" },
    { id: "patch", name: "file_change", kind: "edit", status: "done", path: "notes.txt" },
    { id: "mcp", name: "read_file", kind: "read", status: "done", path: "notes.txt", output: "Fixture contents" },
    { id: "call", name: "fixture", kind: "other", status: "error", summary: "Fixture lookup", output: "Lookup failed" },
  ]);
  expect(events[1].meta?.output).toBe(`${"x".repeat(1_999)}…`);
});

test("Codex keeps the original isolation flags by default and when a workspace mode has no target", async () => {
  const cases: Partial<AdapterRequest>[] = [{ workspacePath }, { accessMode: "isolated", workingDirectory: worktreePath }, { accessMode: "agent" }];
  for (const options of cases) {
    const { request, usage } = cliFixture("codex", { ...options, providerSessionId, conversationKey: "conversation" });
    const invocation = await prepareCodex(request, "", usage);
    expect(invocation.cwd).toBeUndefined();
    expect(invocation.useSingleTurnPrompt).toBe(false);
    expect(invocation.args).toEqual([
      "--ask-for-approval", "never", "--disable", "shell_tool", "-c", "features.hooks=false",
      "-c", "features.apps=false", "-c", "features.plugins=false", "-c", 'web_search="disabled"',
      "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-",
    ]);
  }
});

test.each(["read-only", "agent"] as const)("Codex uses the workspace sandbox and resumes in %s mode", async (accessMode) => {
  const workingDirectory = accessMode === "read-only" ? worktreePath : undefined;
  const cwd = workingDirectory ?? workspacePath;
  const { request, usage } = cliFixture("codex", { accessMode, workingDirectory, workspacePath });
  const fresh = await prepareCodex(request, "", usage);
  expect(fresh.cwd).toBe(cwd);
  expect(argValue(fresh.args, "-C")).toBe(cwd);
  expect(argValue(fresh.args, "--sandbox")).toBe(accessMode === "agent" ? "workspace-write" : "read-only");
  expect(fresh.args).toEqual(expect.arrayContaining([
    "--ask-for-approval", "never", "features.hooks=false", "features.apps=false", "features.plugins=false",
    'web_search="disabled"', "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral",
  ]));
  expect(fresh.args).not.toContain("shell_tool");

  const conversation = { ...request, conversationKey: "conversation" };
  const persistent = await prepareCodex(conversation, "", usage);
  expect(persistent.args).not.toContain("--ephemeral");
  expect(persistent.useSingleTurnPrompt).toBe(false);

  const resumed = await prepareCodex({ ...conversation, providerSessionId }, "", usage);
  const exec = resumed.args.indexOf("exec");
  expect(resumed.args.slice(exec, exec + 4)).toEqual(["exec", "resume", providerSessionId, "--json"]);
  expect(argValue(resumed.args.slice(0, exec), "--sandbox")).toBe(argValue(fresh.args, "--sandbox"));
  expect(argValue(resumed.args.slice(0, exec), "-C")).toBe(cwd);
  expect(resumed.args).not.toContain("--ephemeral");
  expect(resumed.cwd).toBe(cwd);
  expect(resumed.useSingleTurnPrompt).toBe(true);
});

test("Codex ignores session IDs that can be parsed as flags or paths", async () => {
  for (const id of ["--last", "../session", "x".repeat(129)]) {
    const { request, usage } = cliFixture("codex", { accessMode: "agent", workspacePath, providerSessionId: id });
    const invocation = await prepareCodex(request, "", usage);
    expect(invocation.args).not.toContain("resume");
    expect(invocation.args).not.toContain(id);
    expect(invocation.useSingleTurnPrompt).toBe(false);
  }
});

const claudeModes = [
  ["isolated", "", undefined],
  ["read-only", "Read,Glob,Grep,LS", "plan"],
  ["agent", "Read,Edit,Write,Glob,Grep,Bash", "acceptEdits"],
] as const satisfies readonly (readonly [ExecutionMode, string, string | undefined])[];

test.each(claudeModes)("Claude applies %s tools and settings without writing into the workspace", async (accessMode, tools, permission) => {
  await withFixture(async (scratch) => {
    const { request, usage } = cliFixture("claude", { accessMode, workspacePath, conversationKey: "conversation", providerSessionId });
    const invocation = await prepareClaude(request, scratch, usage);
    const isolated = accessMode === "isolated";
    const settingsName = "uya-claude-settings.json";
    const mcpName = "uya-empty-mcp.json";
    expect(invocation.cwd).toBe(isolated ? undefined : workspacePath);
    expect(invocation.configDir).toBe(scratch);
    expect(argValue(invocation.args, "--tools")).toBe(tools);
    expect(argValue(invocation.args, "--permission-mode")).toBe(permission);
    expect(invocation.args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-chrome"]));
    expect(argValue(invocation.args, "--disallowedTools")).toBe("mcp__*");
    expect(argValue(invocation.args, "--settings")).toBe(isolated ? settingsName : join(scratch, settingsName));
    expect(argValue(invocation.args, "--mcp-config")).toBe(isolated ? mcpName : join(scratch, mcpName));
    expect(JSON.parse(await readFile(join(scratch, settingsName), "utf8"))).toEqual({ disableAllHooks: true });
    expect(JSON.parse(await readFile(join(scratch, mcpName), "utf8"))).toEqual({ mcpServers: {} });
    expect(invocation.args.includes("--no-session-persistence")).toBe(isolated);
    expect(argValue(invocation.args, "--resume")).toBe(isolated ? undefined : providerSessionId);
    expect(invocation.useSingleTurnPrompt).toBe(!isolated);
  });
});

test("Claude captures init and result sessions, cached usage, and distinct tool uses", async () => {
  await withFixture(async (scratch) => {
    const { request, events, usage } = cliFixture("claude");
    const invocation = await prepareClaude(request, scratch, usage);
    const read = { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "notes.txt" } };
    parseEvents(invocation, { type: "system", subtype: "init", session_id: "init-session", model: "claude-sonnet-4-6" });
    expect(usage.providerSessionId).toBe("init-session");
    const complete = parseEvents(invocation,
      { type: "stream_event", event: { type: "content_block_start", content_block: read } },
      { type: "assistant", message: { content: [read, { type: "tool_use", id: "tool_2", name: "Bash", input: { command: "rg fixture" } }] } },
      { type: "stream_event", event: { delta: { type: "text_delta", text: "Read it." } } },
      { type: "result", subtype: "success", session_id: providerSessionId, result: "Read it.",
        usage: { input_tokens: 2, cache_read_input_tokens: 34, output_tokens: 5 } },
    );
    expect(complete).toEqual([false, false, false, true]);
    expect(events).toHaveLength(3);
    expect(events).toMatchObject([
      { type: "tool", meta: { id: "tool_1", name: "Read", kind: "read", status: "running", path: "notes.txt" } },
      { type: "tool", meta: { id: "tool_2", name: "Bash", kind: "shell", status: "running", command: "rg fixture" } },
      { type: "text", text: "Read it." },
    ]);
    expect(usage).toEqual({ providerSessionId, model: "claude-sonnet-4-6", inputTokens: 2, cachedInputTokens: 34, outputTokens: 5 });
  });
});

const geminiReadTools = ["read_file", "list_directory", "glob", "grep_search", "search_file_content"];
const geminiModes = [
  ["isolated", []],
  ["read-only", geminiReadTools],
  ["agent", [...geminiReadTools, "replace", "write_file"]],
] as const satisfies readonly (readonly [ExecutionMode, readonly string[]])[];

test.each(geminiModes)("Gemini CLI generates the %s tool policy", async (accessMode, allowedTools) => {
  await withFixture(async (scratch) => {
    const { args, settingsPath } = accessMode === "isolated"
      ? await geminiCliInvocation(scratch)
      : await geminiCliInvocation(scratch, "stream-json", "low", accessMode);
    const policyPath = argValue(args, "--policy");
    expect(policyPath).toBe(join(scratch, "uya-read-only.toml"));
    const policy = await readFile(join(scratch, "uya-read-only.toml"), "utf8");
    if (!allowedTools.length) {
      expect(policy).toBe('[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n');
    } else {
      expect(Bun.TOML.parse(policy)).toEqual({ rule: [
        { toolName: allowedTools, decision: "allow", priority: 999 },
        { toolName: "*", decision: "deny", priority: 998 },
      ] });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({ tools: { core: allowedTools } });
    }
  });
});

test("Gemini CLI and API report normalized cache tokens, including zero", async () => {
  await withFixture(async (scratch) => {
    for (const [field, value] of [["cached_content_token_count", 8], ["cached_tokens", 6], ["cached", 0], ["total_cached_tokens", 12]] as const) {
      const counts = { [field]: value };
      const cli = cliFixture("gemini", { accessMode: "read-only", workingDirectory: worktreePath, workspacePath });
      const invocation = await prepareGeminiCli(cli.request, scratch, cli.usage);
      expect(invocation.cwd).toBe(worktreePath);
      expect(invocation.configDir).toBe(scratch);
      expect(invocation.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(join(scratch, "settings.json"));
      expect(parseEvents(invocation, { type: "result", status: "success", stats: counts })).toEqual([true]);
      expect(cli.usage.cachedInputTokens).toBe(value);

      const api = cliFixture("gemini-api");
      const apiInvocation = await prepareGeminiApi(api.request, scratch, api.usage);
      expect(parseEvents(apiInvocation, { data: {
        event_type: "interaction.completed", interaction: { status: "completed", usage: counts },
      } })).toEqual([true]);
      expect(api.usage.cachedInputTokens).toBe(value);
    }
  });
});

const openCodeReadPermission = { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" };
const openCodeModes = [
  ["isolated", { "*": "deny" }],
  ["read-only", openCodeReadPermission],
  ["agent", { ...openCodeReadPermission, edit: "allow", write: "allow" }],
] as const satisfies readonly (readonly [ExecutionMode, Record<string, string>])[];

test.each(openCodeModes)("OpenCode sets the ordered %s permission rules", async (accessMode, permission) => {
  const { request, usage } = cliFixture("opencode", { accessMode, workspacePath });
  const invocation = await prepareOpenCode(request, "/fixture/scratch", usage);
  const agent = argValue(invocation.args, "--agent");
  if (!agent) throw new Error("Expected an OpenCode agent.");
  expect(invocation.cwd).toBe(accessMode === "isolated" ? undefined : workspacePath);
  expect(invocation.env?.OPENCODE_CONFIG_DIR).toBe("/fixture/scratch");
  expect(invocation.env?.OPENCODE_PERMISSION).toBe(JSON.stringify(permission));
  expect(JSON.parse(invocation.env?.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({
    permission, agent: { [agent]: { mode: "primary", permission } },
  });
});

test("runCli uses the scratch cwd and conversation history in isolated mode", async () => {
  const { request, events } = cliFixture("claude", {
    workspacePath,
    messages: [{ role: "assistant", content: "Prior response" }, { role: "user", content: "Current turn" }],
  });
  await runCli(request, async (input, scratch, usage) => {
    const invocation = await prepareClaude(input, scratch, usage);
    const script = `
      if (!(await Bun.file("uya-claude-settings.json").json()).disableAllHooks) process.exit(2);
      const prompt = await Bun.stdin.text();
      if (!prompt.includes("Prior response") || !prompt.endsWith("Current turn")) process.exit(3);
      console.log(JSON.stringify({ type: "result", subtype: "success", result: "Isolated fixture" }));
    `;
    return { ...invocation, args: ["--no-env-file", "-e", script], replaceEnv: true, env: {} };
  });
  expect(events).toMatchObject([{ type: "text", text: "Isolated fixture" }]);
});

test.each(["success", "authentication error"])("runCli keeps workspace cwd and cleans scratch after %s", async (outcome) => {
  await withFixture(async (workspace) => {
    await writeFile(join(workspace, "sentinel.txt"), "workspace fixture");
    const { request, events } = cliFixture("claude", {
      accessMode: "read-only", workspacePath: workspace, conversationKey: "conversation", providerSessionId,
      messages: [{ role: "assistant", content: "Prior response" }, { role: "user", content: "Current turn" }],
    });
    const failure = outcome === "authentication error";
    const result = failure
      ? { type: "result", subtype: "error", is_error: true, result: "API Error: 401 Authentication failed" }
      : { type: "result", subtype: "success", result: "Workspace confirmed", session_id: providerSessionId };
    const scratchDirs: string[] = [];
    const run = runCli(request, async (input, scratch, usage) => {
      scratchDirs.push(scratch);
      const invocation = await prepareClaude(input, scratch, usage);
      const settingsPath = argValue(invocation.args, "--settings");
      const script = `
        if (await Bun.file("sentinel.txt").text() !== "workspace fixture") process.exit(2);
        if (!(await Bun.file(${JSON.stringify(settingsPath)}).json()).disableAllHooks) process.exit(3);
        if (await Bun.stdin.text() !== ${JSON.stringify(input.prompt)}) process.exit(4);
        console.log(JSON.stringify(${JSON.stringify(result)}));
        process.exit(${failure ? 1 : 0});
      `;
      return { ...invocation, args: ["--no-env-file", "-e", script], replaceEnv: true, env: {} };
    });

    if (failure) {
      await expect(run).rejects.toThrow(/could not authenticate/i);
      expect(events).toEqual([]);
    } else {
      expect(await run).toMatchObject({ providerSessionId });
      expect(events).toMatchObject([{ type: "text", text: "Workspace confirmed" }]);
    }
    expect(scratchDirs).toHaveLength(1);
    expect(scratchDirs[0]).toStartWith(join(tmpdir(), "uya-run-"));
    await expect(stat(scratchDirs[0])).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(workspace)).toEqual(["sentinel.txt"]);
    expect(await readFile(join(workspace, "sentinel.txt"), "utf8")).toBe("workspace fixture");
  });
});
