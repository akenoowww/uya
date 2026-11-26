import { afterAll, describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApprovalDecision, ArtifactItem, CapabilityDomain, CapabilityPack, SpecialistRecommendation, VerifyRun, WorkbenchSnapshot,
} from "@ide/protocol";
import * as z from "zod";
import { writeMcpBridgeSpec } from "./mcp-stdio";
import type { AdapterApprovalPrompt } from "./provider-adapter";
import {
  buildSynapseAwarenessPrompt, extractSynapseFallbackActions, MAX_CALLS_PER_RUN, MAX_SYNAPSE_DEPTH,
  SynapseBroker, type SynapseRunSessionContext,
} from "./synapse-broker";

const fixtureUrl = "http://127.0.0.1:28193/mcp";
const toolNames = [
  "uya_get_workbench", "uya_open_file", "uya_run_verify", "uya_consult_specialist", "uya_red_team",
  "uya_propose_mission", "uya_use_capability",
];
const verifyPreset = { id: "test", label: "Unit tests", command: "bun test" };
const snapshot: WorkbenchSnapshot = {
  workspacePath: "/fixture", gitBranch: "main", activeFilePath: "src/app.ts",
  splits: [{
    paneId: "split-1", alias: "Reviewer", providerId: "reviewer", providerName: "Fixture Reviewer", model: "fixture-v1",
    accessMode: "read-only", busy: false,
  }],
};
const recommendation: SpecialistRecommendation = {
  domain: "code", providerId: "reviewer", providerName: "Fixture Reviewer", model: "fixture-v1",
  effort: "low", elo: 1350, localWinRate: 0.75, reason: "Fixture ranking",
};
const capability: CapabilityPack = {
  id: "fixture-image", name: "Fixture Image", description: "Create a fixture image.", domain: "image", kind: "rest",
  enabled: true, requiresApproval: true, secretKeys: [],
  rest: {
    method: "POST", url: "https://fixture.invalid/internal", headers: { Authorization: "fixture-header" },
    outputKind: "image", inputSchema: [{ name: "prompt", type: "string", description: "Image prompt", required: true }],
  },
};
const disabledCapability = { ...capability, id: "disabled-fixture", enabled: false };
const artifact: ArtifactItem = { id: "artifact-1", kind: "image", label: "Fixture", path: "output.png", createdAt: 1 };
const verifyRun: VerifyRun = {
  id: "verify-1", workspacePath: "/fixture", cwd: "/fixture", command: verifyPreset.command,
  status: "passed", startedAt: 1, finishedAt: 2, exitCode: 0, output: "ok", truncated: false,
};
const consultation = { providerName: "Fixture Reviewer", model: "fixture-v1", reply: "Reviewed the task.", childRunId: "child-1" };
const critiques = { critiques: [{ reviewer: "Fixture Reviewer", lens: "correctness", findings: "No issues found." }] };

function fixtureContext(runId = "run-1", depth = 0, signal = new AbortController().signal) {
  return {
    runId, depth, signal, providerId: "root", workspacePath: snapshot.workspacePath,
    getWorkbench: mock(async () => ({
      snapshot, recommendations: { code: recommendation }, capabilities: [capability, disabledCapability], verifyPresets: [verifyPreset],
    })),
    emitUiCommand: mock<SynapseRunSessionContext["emitUiCommand"]>(() => {}),
    emitSynapseCall: mock<SynapseRunSessionContext["emitSynapseCall"]>(() => {}),
    emitArtifact: mock<SynapseRunSessionContext["emitArtifact"]>(() => {}),
    emitMissionProposed: mock<SynapseRunSessionContext["emitMissionProposed"]>(() => {}),
    requestApproval: mock((_prompt: AdapterApprovalPrompt): Promise<ApprovalDecision> => Promise.resolve("allow_once")),
    runVerify: mock(async (command?: string) => ({ ...verifyRun, command: command ?? verifyRun.command })),
    consultSpecialist: mock<SynapseRunSessionContext["consultSpecialist"]>(async () => consultation),
    runRedTeam: mock<SynapseRunSessionContext["runRedTeam"]>(async () => critiques),
    proposeMission: mock<SynapseRunSessionContext["proposeMission"]>(async (input) => ({
      id: "mission-1", workspacePath: snapshot.workspacePath, title: input.title, objective: input.objective,
      steps: input.steps.map((step, index) => ({ ...step, id: `step-${index}`, kind: step.kind ?? "agent", status: "proposed" })),
      status: "proposed", autonomous: false, maxHops: input.steps.length, hopsUsed: 0, createdAt: 1, updatedAt: 1,
    })),
    invokeCapability: mock<SynapseRunSessionContext["invokeCapability"]>(async () => ({ text: "Generated a fixture image.", artifact })),
  } satisfies SynapseRunSessionContext;
}

function rpc(method: string, params?: Record<string, unknown>, id: number | string | null = 1) {
  return { jsonrpc: "2.0", id, method, ...(params && { params }) };
}

function post(broker: SynapseBroker, token: string | undefined, message: unknown) {
  return broker.handleHttp(new Request(fixtureUrl, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token !== undefined && { "X-Uya-Mcp-Token": token }) },
    body: JSON.stringify(message),
  }));
}

async function call(broker: SynapseBroker, token: string, name: string, args?: unknown): Promise<unknown> {
  return (await post(broker, token, rpc("tools/call", { name, arguments: args }))).json();
}

const toolReply = z.object({ result: z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).length(1), isError: z.boolean().optional(),
}) });

function resultText(response: unknown): string {
  const result = toolReply.parse(response).result;
  expect(result.isError).toBeUndefined();
  return result.content[0].text;
}

function expectToolError(response: unknown, message: string): void {
  expect(toolReply.parse(response).result).toEqual({ content: [{ type: "text", text: message }], isError: true });
}

describe("SynapseBroker", () => {
  test("authorizes POST with the run token and revokes it on close or abort", async () => {
    const broker = new SynapseBroker();
    const controller = new AbortController();
    const first = broker.registerSession(fixtureContext("first"));
    const second = broker.registerSession(fixtureContext("second", 0, controller.signal));
    expect(/^[A-Za-z0-9_-]{43}$/.test(first.token)).toBe(true);
    expect(Buffer.from(first.token, "base64url").length).toBe(32);
    expect(first.token === second.token).toBe(false);
    const ping = rpc("ping");
    for (const invalid of [undefined, "short", `${first.token[0] === "A" ? "B" : "A"}${first.token.slice(1)}`]) {
      expect((await post(broker, invalid, ping)).status).toBe(401);
    }
    expect((await broker.handleHttp(new Request(fixtureUrl, { headers: { "X-Uya-Mcp-Token": first.token } }))).status).toBe(405);
    expect((await post(broker, first.token, ping)).status).toBe(200);
    first.close();
    first.close();
    expect((await post(broker, first.token, ping)).status).toBe(401);
    expect((await post(broker, second.token, ping)).status).toBe(200);
    controller.abort();
    expect((await post(broker, second.token, ping)).status).toBe(401);
  });

  test("initializes, advertises, and executes all seven tools with paired activity events", async () => {
    const broker = new SynapseBroker();
    const context = fixtureContext();
    const session = broker.registerSession(context);
    const serverInfo = { name: "uya", version: "0.5.0" };
    expect(await (await post(broker, session.token, rpc("initialize", { protocolVersion: "2025-03-26" }, "init"))).json()).toEqual({
      jsonrpc: "2.0", id: "init", result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo },
    });
    expect(await (await post(broker, session.token, rpc("initialize"))).json()).toMatchObject({
      result: { protocolVersion: "2024-11-05" },
    });
    const notification = await post(broker, session.token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
    expect(await (await post(broker, session.token, rpc("notifications/initialized", undefined, 0))).json()).toEqual({
      jsonrpc: "2.0", id: 0, result: {},
    });
    const list: unknown = await (await post(broker, session.token, rpc("tools/list"))).json();
    expect(list).toMatchObject({ result: { tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })) } });
    expect(list).toMatchObject({ result: { tools: expect.arrayContaining([
      expect.objectContaining({ name: "uya_open_file", inputSchema: expect.objectContaining({ required: ["path"] }) }),
    ]) } });

    const workbench = resultText(await call(broker, session.token, "uya_get_workbench"));
    expect(JSON.parse(workbench)).toMatchObject({
      snapshot, recommendations: { code: recommendation }, verifyPresets: [verifyPreset],
      capabilities: [{ id: capability.id, inputs: capability.rest?.inputSchema }],
    });
    for (const privateMetadata of ["fixture-header", "fixture.invalid/internal", disabledCapability.id]) {
      expect(workbench).not.toContain(privateMetadata);
    }
    const file = { path: "src/app.ts", line: 12 };
    expect(resultText(await call(broker, session.token, "uya_open_file", file))).toBe("Opened src/app.ts at line 12.");
    expect(context.emitUiCommand).toHaveBeenCalledWith({ action: "open_file", ...file });
    expect(JSON.parse(resultText(await call(broker, session.token, "uya_run_verify", { command: verifyPreset.command })))).toEqual(verifyRun);
    expect(context.runVerify).toHaveBeenCalledWith(verifyPreset.command);

    const consultArgs = {
      domain: "code", task: "Review the fixture", providerId: "reviewer", model: "fixture-v1", effort: "low",
      attachPaths: ["src/app.ts"], attachDiff: true,
    };
    expect(JSON.parse(resultText(await call(broker, session.token, "uya_consult_specialist", consultArgs)))).toEqual(consultation);
    expect(context.consultSpecialist).toHaveBeenCalledWith({ ...consultArgs, depth: 1 });
    const redTeamArgs = { subject: "Review the fixture", includeGitDiff: true };
    expect(JSON.parse(resultText(await call(broker, session.token, "uya_red_team", redTeamArgs)))).toEqual(critiques);
    expect(context.runRedTeam).toHaveBeenCalledWith({ ...redTeamArgs, depth: 1 });

    const missionArgs = {
      title: "Review mission", objective: "Validate the fixture",
      steps: [
        { title: "Review", domain: "code", kind: "agent", accessMode: "read-only", contract: "Summarize findings" },
        { title: "Generate image", domain: "image", kind: "capability", capabilityId: capability.id, capabilityArgs: { prompt: "A fixture" }, contract: "Produce an image" },
        { title: "Verify", domain: "code", kind: "verify", verifyCommand: verifyPreset.command, contract: "Run tests" },
      ],
    };
    const mission: unknown = JSON.parse(resultText(await call(broker, session.token, "uya_propose_mission", missionArgs)));
    expect(mission).toMatchObject({ id: "mission-1", status: "proposed", title: missionArgs.title });
    expect(context.proposeMission).toHaveBeenCalledWith(missionArgs);
    expect(context.emitMissionProposed).toHaveBeenCalledWith(mission);
    const capabilityArgs = { prompt: "A fixture" };
    expect(resultText(await call(broker, session.token, "uya_use_capability", { id: capability.id, args: capabilityArgs })))
      .toBe("Generated a fixture image.");
    expect(context.requestApproval).toHaveBeenCalledTimes(1);
    expect(context.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: "uya_use_capability" }));
    expect(context.invokeCapability).toHaveBeenCalledWith(capability.id, capabilityArgs);
    expect(context.emitArtifact).toHaveBeenCalledWith(artifact);

    const calls = context.emitSynapseCall.mock.calls.map(([event]) => event);
    expect(calls).toHaveLength(14);
    const kinds = ["handoff", "handoff", "verify", "consult", "red_team", "handoff", "capability"];
    for (const [index, kind] of kinds.entries()) {
      const running = calls[index * 2];
      expect(running).toMatchObject({ kind, status: "running" });
      expect(calls[index * 2 + 1]).toMatchObject({ id: running.id, kind, status: "done", target: running.target });
    }
    expect(calls[7].childRunId).toBe("child-1");
    session.close();
  });

  test("hides and blocks recursive tools for child sessions and checks registration depth", async () => {
    const broker = new SynapseBroker();
    expect(() => broker.registerSession(fixtureContext("too-deep", MAX_SYNAPSE_DEPTH + 1))).toThrow(RangeError);
    expect(() => broker.registerSession(fixtureContext("negative", -1))).toThrow(RangeError);
    expect(() => broker.registerSession(fixtureContext("fraction", 0.5))).toThrow(RangeError);
    for (const depth of [1, MAX_SYNAPSE_DEPTH]) {
      const context = fixtureContext(`child-${depth}`, depth);
      const session = broker.registerSession(context);
      const allowed = toolNames.filter((name) => name !== "uya_consult_specialist" && name !== "uya_red_team");
      expect(await (await post(broker, session.token, rpc("tools/list"))).json()).toMatchObject({
        result: { tools: allowed.map((name) => ({ name })) },
      });
      expect(await call(broker, session.token, "uya_consult_specialist", { domain: "code", task: "Review" }))
        .toMatchObject({ error: { code: -32602 } });
      expect(await call(broker, session.token, "uya_red_team", { subject: "Review" })).toMatchObject({ error: { code: -32602 } });
      expect(context.consultSpecialist).not.toHaveBeenCalled();
      expect(context.runRedTeam).not.toHaveBeenCalled();
      expect(resultText(await call(broker, session.token, "uya_open_file", { path: "src/app.ts" }))).toBe("Opened src/app.ts.");
      session.close();
    }
  });

  test("reserves the eight call slots before awaiting tool callbacks", async () => {
    const broker = new SynapseBroker();
    const context = fixtureContext();
    const runVerify = mock(async () => {
      await Bun.sleep(15);
      return verifyRun;
    });
    const run = { ...context, runVerify };
    const session = broker.registerSession(run);
    expect(() => broker.registerSession(context)).toThrow("already has a Synapse session");
    expect(MAX_CALLS_PER_RUN).toBe(8);
    const responses = await Promise.all(Array.from({ length: MAX_CALLS_PER_RUN + 2 }, () => call(broker, session.token, "uya_run_verify")));
    const successes = responses.filter((response) => !toolReply.parse(response).result.isError);
    expect(successes).toHaveLength(MAX_CALLS_PER_RUN);
    expect(runVerify).toHaveBeenCalledTimes(MAX_CALLS_PER_RUN);
    expect(context.emitSynapseCall).toHaveBeenCalledTimes(MAX_CALLS_PER_RUN * 2);
    expectToolError(await call(broker, session.token, "uya_get_workbench"), "A Uya run can make up to 8 tool calls.");
    expect(await (await post(broker, session.token, rpc("ping", undefined, "keepalive"))).json())
      .toEqual({ jsonrpc: "2.0", id: "keepalive", result: {} });
    session.close();
    const replacement = broker.registerSession(run);
    expectToolError(await call(broker, replacement.token, "uya_get_workbench"), "A Uya run can make up to 8 tool calls.");
    replacement.close();
  });

  test("reports malformed RPC and arguments before invoking dependencies", async () => {
    const broker = new SynapseBroker();
    const context = fixtureContext();
    const session = broker.registerSession(context);
    const malformed = await broker.handleHttp(new Request(fixtureUrl, {
      method: "POST", headers: { "X-Uya-Mcp-Token": session.token }, body: "{",
    }));
    expect(await malformed.json()).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await (await post(broker, session.token, { id: "bad", method: "ping" })).json()).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await (await post(broker, session.token, rpc("unknown"))).json()).toMatchObject({ error: { code: -32601 } });
    const invalidCalls: Array<[string, unknown]> = [
      ["__proto__", {}], ["uya_get_workbench", []], ["uya_open_file", { path: "../private.txt" }],
      ["uya_open_file", { path: "src/app.ts", line: 0 }], ["uya_run_verify", { command: " " }],
      ["uya_consult_specialist", { task: "Review", domain: "unknown" }],
      ["uya_consult_specialist", { task: "Review", domain: "code", depth: 0 }],
      ["uya_red_team", { subject: "Review", includeGitDiff: "true" }],
      ["uya_propose_mission", { title: "Review", objective: "Review", steps: [{ title: "Missing contract", domain: "code" }] }],
      ["uya_propose_mission", { title: "Review", objective: "Review", steps: [{ title: "Verify", domain: "code", kind: "verify", contract: "Check" }] }],
      ["uya_use_capability", { id: capability.id, args: [] }],
    ];
    for (const [name, args] of invalidCalls) {
      expect(await call(broker, session.token, name, args)).toMatchObject({ error: { code: -32602 } });
    }
    const notification = await post(broker, session.token, {
      jsonrpc: "2.0", method: "tools/call", params: { name: "uya_open_file", arguments: { path: "src/app.ts" } },
    });
    expect(notification.status).toBe(202);
    expect(context.emitUiCommand).not.toHaveBeenCalled();
    expect(context.emitSynapseCall).not.toHaveBeenCalled();
    expect(resultText(await call(broker, session.token, "uya_open_file", { path: "src/app.ts" }))).toBe("Opened src/app.ts.");
    session.close();
  });

  test("records tool failures and enforces required capability approvals", async () => {
    const broker = new SynapseBroker();
    const context = fixtureContext();
    context.requestApproval.mockResolvedValue("reject");
    context.runVerify.mockRejectedValue(new Error("private fixture diagnostic"));
    const session = broker.registerSession(context);
    expectToolError(await call(broker, session.token, "uya_use_capability", { id: disabledCapability.id }), "This capability is unavailable.");
    expectToolError(await call(broker, session.token, "uya_use_capability", { id: capability.id }), "The user declined this tool call.");
    expectToolError(await call(broker, session.token, "uya_run_verify", { command: "bun run custom-check" }), "The user declined this tool call.");
    expect(context.runVerify).not.toHaveBeenCalled();
    expectToolError(await call(broker, session.token, "uya_run_verify"), "Uya could not complete uya_run_verify.");
    expect(context.invokeCapability).not.toHaveBeenCalled();
    expect(context.emitArtifact).not.toHaveBeenCalled();
    expect(context.emitSynapseCall.mock.calls.map(([event]) => event.status)).toEqual([
      "running", "error", "running", "error", "running", "error", "running", "error",
    ]);
    session.close();
    const withoutApproval = broker.registerSession({ ...context, requestApproval: undefined });
    expectToolError(await call(broker, withoutApproval.token, "uya_use_capability", { id: capability.id }), "This tool requires user approval.");
    expectToolError(await call(broker, withoutApproval.token, "uya_run_verify", { command: "bun run custom-check" }), "This tool requires user approval.");
    expect(context.runVerify).toHaveBeenCalledTimes(1);
    withoutApproval.close();
  });

  test("keeps session approval scoped to the exact verify command", async () => {
    const broker = new SynapseBroker();
    const context = fixtureContext();
    context.requestApproval.mockResolvedValueOnce("allow_session").mockResolvedValueOnce("reject");
    const session = broker.registerSession(context);
    const args = { command: "bun run custom-check" };
    resultText(await call(broker, session.token, "uya_run_verify", args));
    resultText(await call(broker, session.token, "uya_run_verify", args));
    expectToolError(await call(broker, session.token, "uya_run_verify", { command: "bun run other-check" }), "The user declined this tool call.");
    expect(context.requestApproval).toHaveBeenCalledTimes(2);
    expect(context.runVerify.mock.calls).toEqual([[args.command], [args.command]]);
    session.close();
  });

  test("checks session lifetime after asynchronous approval", async () => {
    const broker = new SynapseBroker();
    const context = fixtureContext();
    context.requestApproval.mockImplementation(async () => {
      session.close();
      return "allow_session";
    });
    const session = broker.registerSession(context);
    expectToolError(await call(broker, session.token, "uya_use_capability", { id: capability.id }), "The Uya run has ended.");
    expect(context.invokeCapability).not.toHaveBeenCalled();
    expect((await post(broker, session.token, rpc("ping"))).status).toBe(401);
  });
});

test("awareness shows peer splits, ranked specialists, and enabled capability inputs within its budget", () => {
  const recommendations = {
    text: { ...recommendation, domain: "text", providerName: "Lower ranked", elo: 1100 }, code: recommendation,
  } satisfies Partial<Record<CapabilityDomain, SpecialistRecommendation>>;
  const info = { snapshot, recommendations, capabilities: [capability, disabledCapability] };
  const native = buildSynapseAwarenessPrompt({ ...info, hasNativeMcp: true });
  expect(native).toContain("You are running inside Uya.");
  expect(native).toContain("Reviewer (Fixture Reviewer/fixture-v1, idle)");
  expect(native).toContain("Arena Elo 1350, 75% local verify pass");
  expect(native.indexOf("code Fixture Reviewer")).toBeLessThan(native.indexOf("text Lower ranked"));
  expect(native).toContain("fixture-image (Fixture Image, inputs prompt (string, required))");
  expect(native).toContain("uya_get_workbench");
  expect(native).not.toContain("disabled-fixture");
  expect(native).not.toContain("```uya-action");

  const fallback = buildSynapseAwarenessPrompt({
    ...info, hasNativeMcp: false,
    snapshot: { ...snapshot, splits: [{ ...snapshot.splits[0], alias: "a".repeat(3000) }] },
    capabilities: [capability, { ...capability, name: "b".repeat(3000) }],
  });
  expect(fallback.length).toBeLessThanOrEqual(1400);
  expect(extractSynapseFallbackActions(fallback)).toEqual([{ tool: "uya_get_workbench", arguments: {} }]);
});

test("fallback actions ignore malformed payloads and action examples inside other code fences", () => {
  const text = [
    "```uya-action", "{bad JSON}", "```",
    "```uya-action", '[{"tool":"uya_get_workbench"}]', "```",
    "```uya-action", '{"tool":"uya_get_workbench","arguments":null}', "```",
    "````markdown", "```uya-action", '{"tool":"uya_run_verify"}', "```", "````",
    "```uya-action", '{"tool":"uya_open_file","arguments":{"path":"src/app.ts"}}', "```",
    "```uya-action", "{unfinished action",
    "```uya-action", '{"tool":"uya_get_workbench"}', "```",
  ].join("\r\n");
  expect(extractSynapseFallbackActions(text)).toEqual([
    { tool: "uya_open_file", arguments: { path: "src/app.ts" } }, { tool: "uya_get_workbench", arguments: {} },
  ]);
});

const bridgeImport = JSON.stringify(fileURLToPath(new URL("./mcp-stdio.ts", import.meta.url)));
const bridgeScript = `import { runMcpStdioBridge } from ${bridgeImport}; await runMcpStdioBridge(process.argv[1]);`;

test("bridge specs keep the token in a private scratch file and select the source entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uya-bridge-spec-"));
  try {
    const configPath = join(dir, "uya-mcp-bridge.json");
    const config = { url: fixtureUrl, token: "synthetic-token" };
    const spec = await writeMcpBridgeSpec(dir, config);
    expect(spec).toEqual({
      name: "uya", command: process.execPath,
      args: ["--no-env-file", fileURLToPath(new URL("./index.ts", import.meta.url)), "--mcp-stdio", configPath],
    });
    if (process.platform !== "win32") await chmod(configPath, 0o644);
    const updated = await writeMcpBridgeSpec(dir, config, "fixture-entry.ts");
    expect(updated.args).toEqual(["--no-env-file", "fixture-entry.ts", "--mcp-stdio", configPath]);
    if (process.platform !== "win32") expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the bridge rejects configurations outside the loopback MCP URL and header formats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uya-bridge-url-"));
  try {
    const configPath = join(dir, "uya-mcp-bridge.json");
    const token = "synthetic-token";
    for (const config of [
      { url: "http://localhost:28193/mcp", token },
      { url: "http://127.0.0.1/mcp", token },
      { url: "http://127.0.0.1:28193/mcp?extra=1", token },
      { url: fixtureUrl, token: `${token}\r\n` },
    ]) {
      await writeMcpBridgeSpec(dir, config);
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", bridgeScript, configPath], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(4000),
      });
      const [exitCode, output, diagnostic] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(output).toBe("");
      expect(diagnostic).toContain("Invalid Uya MCP bridge configuration.");
      expect(diagnostic).not.toContain(token);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type Framing = "newline" | "content-length";
const exchanges = [
  {
    message: rpc("initialize", { protocolVersion: "2024-11-05" }, "hello 🌱"),
    reply: {
      jsonrpc: "2.0", id: "hello 🌱",
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "uya", version: "0.5.0" } },
    },
  },
  { message: { jsonrpc: "2.0", method: "notifications/initialized" } },
  { message: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "fixture" } } },
  { message: rpc("ping", undefined, 0), reply: { jsonrpc: "2.0", id: 0, result: {} } },
  {
    message: rpc("tools/call", { name: "uya_open_file", arguments: { path: "src/café.ts" } }, 2),
    reply: { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Opened src/café.ts." }] } },
  },
];

function encode(message: unknown, framing: Framing): Buffer {
  if (framing === "newline") return Buffer.from(`${JSON.stringify(message)}\r\n`);
  const body = JSON.stringify(message, null, 2);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\nContent-Type: application/json\r\n\r\n${body}`);
}

function decode(output: Buffer, framing: Framing): unknown[] {
  if (framing === "newline") {
    const lines = output.toString("utf8").split("\n");
    expect(lines.pop()).toBe("");
    return lines.map((line): unknown => JSON.parse(line));
  }
  const responses: unknown[] = [];
  while (output.length > 0) {
    const separator = output.indexOf("\r\n\r\n");
    const header = /^Content-Length: ([0-9]+)$/.exec(output.subarray(0, separator).toString("ascii"));
    if (!header || separator < 0) throw new Error("Expected a Content-Length reply.");
    const start = separator + 4;
    const end = start + Number(header[1]);
    expect(end).toBeLessThanOrEqual(output.length);
    responses.push(JSON.parse(output.subarray(start, end).toString("utf8")));
    output = output.subarray(end);
  }
  return responses;
}

async function runBridge(framing: Framing, url: string, token: string, script: string) {
  const dir = await mkdtemp(join(tmpdir(), "uya-bridge-roundtrip-"));
  try {
    const spec = await writeMcpBridgeSpec(dir, { url, token });
    const child = Bun.spawn([spec.command, "--no-env-file", "-e", script, join(dir, "uya-mcp-bridge.json")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(4000),
      env: {
        HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1",
        NO_PROXY: "fixture.invalid", no_proxy: "fixture.invalid",
      },
    });
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    try {
      // Split the first message across writes, including inside a multibyte character.
      const first = encode(exchanges[0].message, framing);
      const insideEmoji = first.indexOf("🌱") + 1;
      for (const piece of [first.subarray(0, 5), first.subarray(5, insideEmoji), first.subarray(insideEmoji)]) {
        child.stdin.write(piece);
        await child.stdin.flush();
        await Bun.sleep(5);
      }
      const firstReply = await reader.read();
      if (firstReply.done) throw new Error(`Bridge exited without replying. ${await stderr}`);
      child.stdin.write(Buffer.concat(exchanges.slice(1).map(({ message }) => encode(message, framing))));
      await child.stdin.end();
      const output = [firstReply.value];
      for (let next = await reader.read(); !next.done; next = await reader.read()) output.push(next.value);
      expect([await child.exited, await stderr]).toEqual([0, ""]);
      expect(decode(Buffer.concat(output), framing)).toEqual(exchanges.flatMap(({ reply }) => reply ? [reply] : []));
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function startLoopback(broker: SynapseBroker) {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, fetch: (request) => broker.handleHttp(request) });
  } catch (error) {
    // Bun can report sandbox bind denial as EADDRINUSE even though the OS assigns the port.
    if (error instanceof Error && "code" in error &&
      (error.code === "EADDRINUSE" || error.code === "EPERM" || error.code === "EACCES")) return undefined;
    throw error;
  }
}

const socketBroker = new SynapseBroker();
const loopback = startLoopback(socketBroker);
afterAll(async () => { await loopback?.stop(true); });

const mockTransport = `
  import { MockAgent, setGlobalDispatcher } from ${JSON.stringify(import.meta.resolve("undici/index.js"))};
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const endpoint = agent.get(${JSON.stringify(new URL(fixtureUrl).origin)});
  endpoint.intercept({
    path: "/mcp", method: "POST", headers: { "content-type": "application/json", "x-uya-mcp-token": /^[A-Za-z0-9_-]{43}$/ },
  }).reply(({ body }) => {
    const exchanges = ${JSON.stringify(exchanges)};
    const message = JSON.parse(body);
    const exchange = exchanges.find(({ message: expected }) => JSON.stringify(message) === JSON.stringify(expected));
    if (!exchange) throw new Error("Unexpected JSON-RPC message.");
    return { statusCode: exchange.reply ? 200 : 202, data: exchange.reply ?? "" };
  }).times(${exchanges.length});
  ${bridgeScript}
  agent.assertNoPendingInterceptors();
  await agent.close();
`;

for (const framing of ["newline", "content-length"] as const) {
  test(`bridge subprocess round-trips ${framing} messages with a mocked HTTP dispatcher`, async () => {
    const session = new SynapseBroker().registerSession(fixtureContext());
    try {
      await runBridge(framing, fixtureUrl, session.token, mockTransport);
    } finally {
      session.close();
    }
  });

  test.skipIf(!loopback)(`bridge subprocess round-trips ${framing} messages against a real loopback server`, async () => {
    if (!loopback) throw new Error("The loopback server is unavailable.");
    const context = fixtureContext(framing);
    const session = socketBroker.registerSession(context);
    try {
      await runBridge(framing, `http://127.0.0.1:${loopback.port}/mcp`, session.token, bridgeScript);
      expect(context.emitUiCommand).toHaveBeenCalledTimes(1);
      expect(context.emitUiCommand).toHaveBeenCalledWith({ action: "open_file", path: "src/café.ts" });
    } finally {
      session.close();
    }
  });
}
