import type { ApprovalDecision, ToolMeta } from "@ide/protocol";
import { afterEach, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { closeAcpConversation, runAcpCli, shutdownAcpSessions } from "./acp-runner";
import type { AdapterApprovalPrompt, AdapterRequest } from "./provider-adapter";
import { AcpSessionPool, type AcpSession } from "./session-pool";

const workspace = realpathSync(process.cwd());
const permissionOptions = [
  { optionId: "permit-once", kind: "allow_once", name: "Allow once" },
  { optionId: "permit-session", kind: "allow_always", name: "Allow for session" },
  { optionId: "deny", kind: "reject_once", name: "Reject" },
];

interface FixturePermission {
  toolCall: Record<string, unknown>;
  options?: typeof permissionOptions;
}

interface Fixture {
  tools?: FixturePermission[];
  updates?: Record<string, unknown>[];
  usage?: Record<string, number>;
  exitDuringPrompt?: boolean;
}

interface FixtureLog {
  cwd: string;
  pid: number;
  requests: { id: number; method: string; params: Record<string, unknown> }[];
  decisions: { outcome: string; optionId?: string }[];
}

const fixtureProgram = String.raw`
import { createInterface } from "node:readline";

const sessionId = "fixture-" + process.pid;
const requests = [];
let decisions = [];
let promptId;
let permissionIndex = 0;
let model = "fixture-default";
let effort = "low";

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function reply(id, result) {
  send({ id, result });
}

function update(update) {
  send({ method: "session/update", params: { sessionId, update } });
}

function configOptions() {
  return [
    { id: "model", category: "model", currentValue: model, options: ["fixture-default", "fixture-next"] },
    { id: "effort", category: "thought_level", currentValue: effort, options: ["low", "medium", "high"] },
  ];
}

function nextPermission() {
  const permission = fixture.tools?.[permissionIndex++];
  if (permission) {
    send({
      id: "permission-" + permissionIndex, method: "session/request_permission",
      params: { sessionId, options: defaults, ...permission },
    });
    return;
  }
  const log = { pid: process.pid, cwd: process.cwd(), requests, decisions };
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(log) } });
  reply(promptId, { stopReason: "end_turn", usage: fixture.usage ?? { inputTokens: 21, cachedInputTokens: 4, outputTokens: 9 } });
}

const methods = {
  initialize(message) {
    reply(message.id, { protocolVersion: 1 });
  },
  "session/new"(message) {
    reply(message.id, { sessionId, configOptions: configOptions(), models: { availableModels: [{ modelId: "fixture-legacy" }] } });
  },
  "session/set_config_option"(message) {
    const { configId, value } = message.params;
    if (configId === "model") model = value;
    if (configId === "effort") effort = value;
    reply(message.id, { configOptions: configOptions() });
  },
  "session/set_model"(message) {
    model = message.params.modelId;
    reply(message.id, {});
  },
  "session/prompt"(message) {
    if (fixture.exitDuringPrompt) process.exit(17);
    promptId = message.id;
    permissionIndex = 0;
    decisions = [];
    for (const event of fixture.updates ?? []) update(event);
    nextPermission();
  },
  "session/cancel"() {},
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    requests.push(message);
    methods[message.method](message);
  } else if (message.id === "permission-" + permissionIndex) {
    decisions.push(message.result.outcome);
    nextPermission();
  }
});
`;

type FixtureRequest = Partial<Omit<AdapterRequest, "provider" | "output">>;
const pools = new Set<AcpSessionPool>();

function startFixture(fixture: Fixture, request: FixtureRequest = {}, pool?: AcpSessionPool) {
  if (pool) pools.add(pool);
  const toolEvents: { title: string; meta: ToolMeta | undefined }[] = [];
  const messages: string[] = [];
  const script = "const fixture = " + JSON.stringify(fixture)
    + ";\nconst defaults = " + JSON.stringify(permissionOptions) + ";\n" + fixtureProgram;
  const run = runAcpCli({
    provider: {
      id: "fixture-acp", name: "Fixture ACP", kind: "cli", available: true,
      structured: true, terminal: false, command: process.execPath,
    },
    prompt: "Fixture prompt", signal: AbortSignal.timeout(2_500), ...request,
    output: {
      raw() {},
      emit(type, text, meta) {
        if (type === "tool") toolEvents.push({ title: text, meta });
        if (type === "text") messages.push(text);
      },
    },
  }, { args: ["--no-env-file", "-e", script], fallbackError: "The ACP fixture stopped early.", pool });
  return { run, toolEvents, messages };
}

async function runFixture(fixture: Fixture, request?: FixtureRequest, pool?: AcpSessionPool) {
  const { run, toolEvents, messages } = startFixture(fixture, request, pool);
  const usage = await run;
  expect(messages).toHaveLength(1);
  const log: FixtureLog = JSON.parse(messages[0]);
  return { usage, log, toolEvents };
}

function selected(...ids: string[]) {
  return ids.map((optionId) => ({ outcome: "selected", optionId }));
}

afterEach(async () => {
  await Promise.all([shutdownAcpSessions(), ...[...pools].map((pool) => pool.closeAll())]);
  pools.clear();
});

test("omitting access mode uses an isolated one-shot cwd and rejects permissions", async () => {
  const { usage, log } = await runFixture({
    tools: [
      { toolCall: { kind: "read", title: "read_file" } },
      { toolCall: { kind: "shell" }, options: permissionOptions.slice(0, 1) },
    ],
  }, { workingDirectory: workspace });
  const cwd = log.requests.find(({ method }) => method === "session/new")?.params.cwd;
  expect(typeof cwd).toBe("string");
  expect(basename(cwd as string)).toStartWith("uya-run-");
  expect(basename(log.cwd)).toBe(basename(cwd as string));
  expect(existsSync(log.cwd)).toBe(false);
  expect(log.decisions).toEqual([...selected("deny"), { outcome: "cancelled" }]);
  expect(usage).toEqual({
    providerSessionId: "fixture-" + log.pid, model: "fixture-default", inputTokens: 21, cachedInputTokens: 4, outputTokens: 9,
  });
});

test("read-only uses the working directory and allows only read and search tools", async () => {
  const { log } = await runFixture({
    updates: [
      { sessionUpdate: "tool_call", toolCallId: "grep", title: "grep" },
      { sessionUpdate: "tool_call", toolCallId: "mode", kind: "switch_mode", title: "read_file" },
    ],
    tools: [
      { toolCall: { kind: "read", title: "Read document" } },
      { toolCall: { toolCallId: "grep" } },
      { toolCall: { kind: "search", title: "Search documents" } },
      { toolCall: { kind: "edit", title: "Edit document" } },
      { toolCall: { kind: "execute", title: "Run fixture" } },
      { toolCall: { kind: "read", title: "read_file", rawInput: { command: "echo fixture" } } },
      { toolCall: { kind: "search", title: "delete_file" } },
      { toolCall: { kind: "read", rawInput: { path: "document.txt", content: "replacement" } } },
      { toolCall: { kind: "search", rawInput: { command: "", arguments: { cmd: "echo fixture" } } } },
      { toolCall: { kind: "other", rawInput: "grep" } },
      { toolCall: { toolCallId: "mode" } },
    ],
  }, { accessMode: "read-only", workspacePath: tmpdir(), workingDirectory: workspace });
  expect(log.cwd).toBe(workspace);
  expect(log.requests.find(({ method }) => method === "session/new")?.params).toEqual({ cwd: workspace, mcpServers: [] });
  expect(log.decisions).toEqual(selected("permit-once", "permit-once", "permit-once", ...Array<string>(8).fill("deny")));
  expect(existsSync(workspace)).toBe(true);
});

test("agent mode uses workspacePath and fails closed without an approval callback", async () => {
  const { log } = await runFixture({
    tools: [{ toolCall: { title: "list_dir" } }, { toolCall: { kind: "write", title: "Write file" } }],
  }, { accessMode: "agent", workspacePath: workspace });
  expect(log.cwd).toBe(workspace);
  expect(log.requests[1].params.cwd).toBe(workspace);
  expect(log.decisions).toEqual(selected("permit-once", "deny"));
});

test("agent mode without a working directory falls back to isolated permissions", async () => {
  let approvals = 0;
  const requestApproval = async (): Promise<ApprovalDecision> => {
    approvals++;
    return "allow_once";
  };
  const { log } = await runFixture({
    tools: [{ toolCall: { kind: "read" } }, { toolCall: { kind: "execute" } }],
  }, { accessMode: "agent", requestApproval });
  expect(basename(log.cwd)).toStartWith("uya-run-");
  expect(log.decisions).toEqual(selected("deny", "deny"));
  expect(approvals).toBe(0);
});

test("agent approval distinguishes a one-time decision, a session grant, and rejection", async () => {
  const pool = new AcpSessionPool();
  const fixture: Fixture = {
    tools: [
      { toolCall: { kind: "read", title: "view_file" } },
      { toolCall: { kind: "execute", name: "terminal", rawInput: { command: "echo fixture" } } },
      { toolCall: { kind: "edit", name: "apply_patch", title: "Edit document", description: "Update heading",
        locations: [{ path: "/fixture/readme.md" }] } },
      { toolCall: { kind: "edit", name: "replace_selection" } },
    ],
  };
  const prompts: AdapterApprovalPrompt[] = [];
  const request: FixtureRequest = {
    conversationKey: "approvals", accessMode: "agent", workspacePath: workspace,
    async requestApproval(prompt) {
      prompts.push(prompt);
      if (prompt.toolName === "terminal") return "allow_once";
      return prompt.toolName === "apply_patch" ? "allow_session" : "reject";
    },
  };
  const first = await runFixture(fixture, request, pool);
  expect(first.log.decisions).toEqual(selected("permit-once", "permit-once", "permit-session", "deny"));
  expect(prompts[0]).toMatchObject({ toolName: "terminal", toolKind: "shell", command: "echo fixture" });
  expect(prompts[1]).toMatchObject({
    toolName: "apply_patch", toolKind: "edit", title: "Edit document", detail: "Update heading", path: "/fixture/readme.md",
    options: [
      { id: "permit-once", kind: "allow_once", label: "Allow once" },
      { id: "permit-session", kind: "allow_session", label: "Allow for session" },
      { id: "deny", kind: "reject_once", label: "Reject" },
    ],
  });
  const second = await runFixture(fixture, request, pool);
  expect(second.log.pid).toBe(first.log.pid);
  expect(second.log.decisions).toEqual(selected("permit-once", "permit-once", "permit-once", "deny"));
  expect(prompts.map(({ toolName }) => toolName)).toEqual([
    "terminal", "apply_patch", "replace_selection", "terminal", "replace_selection",
  ]);
});

test("an interactive approval only selects a matching available option", async () => {
  const { log } = await runFixture({
    tools: [{ toolCall: { kind: "execute" }, options: permissionOptions.slice(1) }],
  }, {
    accessMode: "agent", workspacePath: workspace,
    requestApproval: async () => "allow_once",
  });
  expect(log.decisions).toEqual(selected("deny"));
});

class CapturingPool extends AcpSessionPool {
  session?: AcpSession;
  stdout = "";

  override acquire(...args: Parameters<AcpSessionPool["acquire"]>): AcpSession {
    const session = super.acquire(...args);
    if (this.session !== session) {
      this.session = session;
      session.child.stdout.on("data", (chunk: Buffer) => { this.stdout += chunk.toString("utf8"); });
    }
    return session;
  }
}

test("aborting a pending approval sends cancelled and invalidates the session", async () => {
  const pool = new CapturingPool();
  const controller = new AbortController();
  const pending = Promise.withResolvers<ApprovalDecision>();
  const asked = Promise.withResolvers<void>();
  const request: FixtureRequest = { conversationKey: "abort", accessMode: "agent", workingDirectory: workspace };
  const { run } = startFixture({ tools: [{ toolCall: { kind: "execute" } }] }, {
    ...request, signal: controller.signal,
    requestApproval() {
      asked.resolve();
      return pending.promise;
    },
  }, pool);
  await Promise.race([asked.promise, run]);
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(pool.stdout).toContain('\\"outcome\\":\\"cancelled\\"');
  const cancelled = pool.session;
  expect(cancelled?.child.exitCode != null || cancelled?.child.signalCode != null).toBe(true);
  pending.resolve("allow_session");
  const next = await runFixture({}, request, pool);
  expect(next.usage.providerSessionId).not.toBe(cancelled?.sessionId);
  expect(cancelled?.sessionAllowTools.size).toBe(0);
});

test("warm turns send only the current prompt and apply model and effort changes once", async () => {
  const pool = new AcpSessionPool();
  const request: FixtureRequest = { conversationKey: "persistent", model: "fixture-next", effort: "high" };
  const first = await runFixture({}, {
    ...request, prompt: "First question",
    messages: [
      { role: "user", content: "Previous question" }, { role: "assistant", content: "Previous answer" },
      { role: "user", content: "First question" },
    ],
  }, pool);
  expect(first.log.requests.at(-1)?.params.prompt).toEqual([
    { type: "text", text: expect.stringContaining("Previous answer") },
  ]);

  const nextRequest: FixtureRequest = {
    ...request, model: "fixture-legacy", effort: "medium", prompt: "Follow-up",
    messages: [{ role: "assistant", content: "First answer" }, { role: "user", content: "Follow-up" }],
  };
  const second = await runFixture({}, nextRequest, pool);
  expect(second.usage).toMatchObject({ providerSessionId: first.usage.providerSessionId, model: "fixture-legacy" });
  expect(second.log.requests.map(({ method }) => method)).toEqual([
    "initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt",
    "session/set_model", "session/set_config_option", "session/prompt",
  ]);
  expect(second.log.requests.at(-2)?.params).toMatchObject({ configId: "effort", value: "medium" });
  expect(second.log.requests.at(-1)?.params).toMatchObject({
    sessionId: first.usage.providerSessionId, prompt: [{ type: "text", text: "Follow-up" }],
  });
  const third = await runFixture({}, nextRequest, pool);
  expect(third.log.requests.slice(-2).map(({ method }) => method)).toEqual(["session/prompt", "session/prompt"]);
  expect(new Set(third.log.requests.map(({ id }) => id)).size).toBe(third.log.requests.length);
});

test("structured tool updates carry forward metadata and cap output at 4 KiB", async () => {
  const output = "x".repeat(4095) + "🦊".repeat(128);
  const { toolEvents } = await runFixture({ updates: [
    { sessionUpdate: "tool_call", toolCallId: "exec1", name: "shell", title: "Run formatter", kind: "execute",
      rawInput: { command: ["echo", "fixture"] }, locations: [{ path: "/fixture" }], summary: "Format files" },
    { sessionUpdate: "tool_call_update", toolCallId: "exec1", status: "completed", rawOutput: { stdout: output } },
    { sessionUpdate: "tool_call", toolCallId: "read1", title: "read_file", kind: "read" },
    { sessionUpdate: "tool_call_update", toolCallId: "read1", status: "failed",
      content: [{ type: "content", content: { type: "text", text: "File missing" } }] },
  ] });
  const meta = { id: "exec1", name: "shell", kind: "shell", path: "/fixture", command: "echo fixture", summary: "Format files" };
  expect(toolEvents).toMatchObject([
    { title: "Run formatter", meta: { ...meta, status: "running" } },
    { title: "Run formatter", meta: { ...meta, status: "done", output: "x".repeat(4095) } },
    { title: "read_file", meta: { id: "read1", name: "read_file", kind: "read", status: "running" } },
    { title: "read_file", meta: { id: "read1", kind: "read", status: "error", output: "File missing" } },
  ]);
});

test.each(["cached_input_tokens", "cacheReadInputTokens"])("reads %s usage", async (alias) => {
  const { usage } = await runFixture({ usage: { input_tokens: 12, [alias]: 3, output_tokens: 5 } });
  expect(usage).toMatchObject({ inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 });
});

test("a process that exits mid-turn sheds its scratch dir and can be replaced", async () => {
  const pool = new CapturingPool();
  const request = { conversationKey: "interrupted" };
  const { run } = startFixture({ exitDuringPrompt: true }, request, pool);
  await expect(run).rejects.toMatchObject({ message: "The ACP fixture stopped early.", exitCode: 17 });
  const stopped = pool.session;
  expect(stopped?.tempDir).toBeDefined();
  expect(existsSync(stopped!.cwd)).toBe(false);
  const fresh = await runFixture({}, request, pool);
  expect(fresh.usage.providerSessionId).not.toBe(stopped?.sessionId);
  expect(fresh.log.requests.map(({ method }) => method)).toEqual(["initialize", "session/new", "session/prompt"]);
});

test("the shared pool supports closing a conversation and shutting down", async () => {
  const request = { conversationKey: "shared" };
  const first = await runFixture({}, request);
  expect(existsSync(first.log.cwd)).toBe(true);
  await closeAcpConversation(request.conversationKey);
  expect(existsSync(first.log.cwd)).toBe(false);
  const second = await runFixture({}, request);
  expect(second.usage.providerSessionId).not.toBe(first.usage.providerSessionId);
  await shutdownAcpSessions();
  expect(existsSync(second.log.cwd)).toBe(false);
});
