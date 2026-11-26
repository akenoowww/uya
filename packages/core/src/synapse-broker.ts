import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ApprovalDecision, ArtifactItem, CapabilityDomain, CapabilityInvokeResult, CapabilityPack, EffortLevel,
  ExecutionMode, MissionPlan, MissionStep, SpecialistRecommendation, SynapseCallInfo, UiCommand,
  VerifyRun, WorkbenchSnapshot,
} from "@ide/protocol";
import * as z from "zod";
import type { AdapterApprovalPrompt } from "./provider-adapter";
import { RpcError } from "./validation";
import { isProtectedRelativePath } from "./workspace-files";

export const MAX_CALLS_PER_RUN = 8;
export const MAX_SYNAPSE_DEPTH = 2;
const TOKEN_BYTES = 32;
const TOKEN_LENGTH = Math.ceil(TOKEN_BYTES * 4 / 3);
const MAX_AWARENESS_CHARS = 1400;
const MAX_MISSION_STEPS = 12;

export interface SynapseRunSessionContext {
  runId: string;
  providerId: string;
  workspacePath: string | null;
  depth: number;
  signal: AbortSignal;
  getWorkbench: () => Promise<{
    snapshot: WorkbenchSnapshot;
    recommendations: Partial<Record<CapabilityDomain, SpecialistRecommendation>>;
    capabilities: CapabilityPack[];
    verifyPresets: Array<{ id: string; label: string; command: string }>;
  }>;
  emitUiCommand: (command: UiCommand) => void;
  emitSynapseCall: (call: SynapseCallInfo) => void;
  emitArtifact: (artifact: ArtifactItem) => void;
  emitMissionProposed: (mission: MissionPlan) => void;
  requestApproval?: (prompt: AdapterApprovalPrompt) => Promise<ApprovalDecision>;
  runVerify: (command?: string) => Promise<VerifyRun>;
  consultSpecialist: (input: {
    domain: CapabilityDomain;
    task: string;
    providerId?: string;
    model?: string;
    effort?: EffortLevel;
    attachPaths?: string[];
    attachDiff?: boolean;
    depth: number;
  }) => Promise<{ providerName: string; model?: string; reply: string; childRunId: string }>;
  runRedTeam: (input: {
    subject: string;
    includeGitDiff?: boolean;
    depth: number;
  }) => Promise<{ critiques: Array<{ reviewer: string; lens: string; findings: string }> }>;
  proposeMission: (input: {
    title: string;
    objective: string;
    steps: Array<Pick<MissionStep, "title" | "domain" | "providerId" | "model" | "effort" | "accessMode" |
      "capabilityId" | "capabilityArgs" | "contract" | "verifyCommand"> & { kind?: MissionStep["kind"] }>;
  }) => Promise<MissionPlan>;
  invokeCapability: (id: string, args: Record<string, unknown>) => Promise<CapabilityInvokeResult>;
}

interface RunState {
  readonly depth: number;
  calls: number;
}

interface Session {
  readonly context: SynapseRunSessionContext;
  readonly token: Buffer;
  readonly run: RunState;
  readonly approvals: Set<string>;
  closed: boolean;
}

class ToolExecutionError extends Error {}

function assertActive(session: Session): void {
  if (session.closed || session.context.signal.aborted) throw new ToolExecutionError("The Uya run has ended.");
}

async function requireApproval(
  session: Session,
  resource: string,
  prompt: Omit<AdapterApprovalPrompt, "options">,
): Promise<void> {
  assertActive(session);
  const key = JSON.stringify([prompt.toolName, resource]);
  if (session.approvals.has(key)) return;
  if (!session.context.requestApproval) throw new ToolExecutionError("This tool requires user approval.");
  const decision = await session.context.requestApproval({
    ...prompt,
    options: [
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "allow_session", label: "Allow for this session", kind: "allow_session" },
      { id: "reject", label: "Reject", kind: "reject_once" },
    ],
  });
  assertActive(session);
  if (decision === "allow_session") session.approvals.add(key);
  else if (decision !== "allow_once") throw new ToolExecutionError("The user declined this tool call.");
}

const nonemptyText = (max: number) => z.string().min(1).max(max).refine(
  (value) => value.trim() !== "" && !value.includes("\0"),
  { error: "Use nonempty text without NUL characters." },
);
const filePath = nonemptyText(4096).refine((path) => {
  try {
    return !isProtectedRelativePath(path);
  } catch {
    return false;
  }
}, { error: "Use an unprotected path relative to the workspace." });
const domain = z.enum(["code", "webdev", "text", "vision", "search", "audio", "image", "video"]);
const command = nonemptyText(1024);
const capabilityId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const capabilityArgs = z.record(z.string().min(1).max(64), z.unknown()).refine(
  (value) => Object.keys(value).length <= 64,
  { error: "Provide up to 64 capability arguments." },
);
const specialistOptions = {
  providerId: nonemptyText(100).optional(),
  model: nonemptyText(256).refine((value) => !value.startsWith("-") && !/[\x00-\x1f\x7f]/.test(value)).optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
};
const missionStep = z.strictObject({
  title: nonemptyText(200),
  domain,
  kind: z.enum(["agent", "capability", "verify"]).optional(),
  ...specialistOptions,
  accessMode: z.enum(["isolated", "read-only", "agent"]).optional(),
  capabilityId: capabilityId.optional(),
  capabilityArgs: capabilityArgs.optional(),
  contract: nonemptyText(16_384),
  verifyCommand: command.optional(),
}).refine((step) => step.kind !== "capability" || step.capabilityId !== undefined, {
  path: ["capabilityId"], error: "A capability step requires a capability ID.",
}).refine((step) => step.kind !== "verify" || step.verifyCommand !== undefined, {
  path: ["verifyCommand"], error: "A verify step requires a command.",
});

interface ToolOutcome {
  text: string;
  isError?: boolean;
  summary?: string;
  childRunId?: string;
}

function defineTool<Args>(options: {
  name: string;
  description: string;
  input: z.ZodType<Args>;
  rootOnly?: boolean;
  activity: (args: Args) => Pick<SynapseCallInfo, "kind" | "target" | "domain">;
  run: (session: Session, args: Args) => ToolOutcome | Promise<ToolOutcome>;
}) {
  const { name, description, input, rootOnly, activity, run } = options;
  return {
    definition: { name, description, inputSchema: z.toJSONSchema(input, { target: "draft-07", io: "input" }) },
    rootOnly,
    prepare(args: unknown) {
      const result = input.safeParse(args);
      if (!result.success) {
        const path = result.error.issues[0]?.path.join(".");
        throw new RpcError(-32602, path ? `Invalid argument at ${path}.` : "Invalid tool arguments.");
      }
      return { activity: activity(result.data), run: (session: Session) => run(session, result.data) };
    },
  };
}

function capabilityMetadata(pack: CapabilityPack) {
  return {
    id: pack.id, name: pack.name, description: pack.description, kind: pack.kind,
    domain: pack.domain, requiresApproval: pack.requiresApproval,
    inputs: pack.rest?.inputSchema.map(({ name, type, description, required, enum: values }) => ({
      name, type, description, required, enum: values,
    })),
  };
}

const tools = [
  defineTool({
    name: "uya_get_workbench",
    description: "List the workspace context, open splits, specialist recommendations, verification presets, and enabled capabilities.",
    input: z.strictObject({}),
    activity: () => ({ kind: "handoff", target: "Workbench" }),
    async run({ context }) {
      const { snapshot, recommendations, capabilities, verifyPresets } = await context.getWorkbench();
      return { text: JSON.stringify({
        snapshot, recommendations, verifyPresets,
        capabilities: capabilities.filter((pack) => pack.enabled).map(capabilityMetadata),
      }) };
    },
  }),
  defineTool({
    name: "uya_open_file",
    description: "Open a workspace-relative file in the Uya interface, optionally at a one-based line number.",
    input: z.strictObject({ path: filePath, line: z.int().min(1).optional() }),
    activity: ({ path }) => ({ kind: "handoff", target: path }),
    run({ context }, { path, line }) {
      context.emitUiCommand({ action: "open_file", path, ...(line !== undefined && { line }) });
      return { text: `Opened ${path}${line === undefined ? "" : ` at line ${line}`}.` };
    },
  }),
  defineTool({
    name: "uya_run_verify",
    description: "Run workspace verification. Omit the command to use the workspace default. Custom commands require user approval.",
    input: z.strictObject({ command: command.optional() }),
    activity: ({ command }) => ({ kind: "verify", target: command ?? "Workspace verification" }),
    async run(session, { command }) {
      const { context } = session;
      if (command !== undefined) {
        const { verifyPresets } = await context.getWorkbench();
        if (!verifyPresets.some((preset) => preset.command === command)) {
          await requireApproval(session, command, {
            toolName: "uya_run_verify", toolKind: "shell", title: "Run workspace verification", command,
          });
        }
      }
      assertActive(session);
      const result = await context.runVerify(command);
      return {
        text: JSON.stringify(result), summary: `Verification ${result.status}.`,
        isError: result.status === "failed" || result.status === "cancelled",
      };
    },
  }),
  defineTool({
    name: "uya_consult_specialist",
    description: "Ask a specialist to review a task in the selected domain. Optionally attach workspace paths and the Git diff.",
    input: z.strictObject({
      domain, task: nonemptyText(256_000), ...specialistOptions,
      attachPaths: z.array(filePath).max(20).optional(), attachDiff: z.boolean().optional(),
    }),
    rootOnly: true,
    activity: ({ domain, providerId }) => ({ kind: "consult", target: providerId ?? domain, domain }),
    async run({ context, run }, args) {
      const result = await context.consultSpecialist({ ...args, depth: run.depth + 1 });
      return { text: JSON.stringify(result), childRunId: result.childRunId, summary: `Consulted ${result.providerName}.` };
    },
  }),
  defineTool({
    name: "uya_red_team",
    description: "Request independent critiques of a subject, optionally including the workspace Git diff.",
    input: z.strictObject({ subject: nonemptyText(256_000), includeGitDiff: z.boolean().optional() }),
    rootOnly: true,
    activity: () => ({ kind: "red_team", target: "Red team" }),
    async run({ context, run }, args) {
      const result = await context.runRedTeam({ ...args, depth: run.depth + 1 });
      return { text: JSON.stringify(result) };
    },
  }),
  defineTool({
    name: "uya_propose_mission",
    description: "Propose a mission for the user to review. Include capabilityId for capability steps and verifyCommand for verify steps.",
    input: z.strictObject({
      title: nonemptyText(200), objective: nonemptyText(16_384), steps: z.array(missionStep).min(1).max(MAX_MISSION_STEPS),
    }),
    activity: ({ title }) => ({ kind: "handoff", target: title }),
    async run(session, args) {
      const mission = await session.context.proposeMission(args);
      assertActive(session);
      session.context.emitMissionProposed(mission);
      return { text: JSON.stringify(mission) };
    },
  }),
  defineTool({
    name: "uya_use_capability",
    description: "Invoke an enabled capability by its ID with the inputs listed by uya_get_workbench.",
    input: z.strictObject({ id: capabilityId, args: capabilityArgs.optional() }),
    activity: ({ id }) => ({ kind: "capability", target: id }),
    async run(session, { id, args = {} }) {
      const { context } = session;
      const { capabilities } = await context.getWorkbench();
      const pack = capabilities.find((candidate) => candidate.id === id && candidate.enabled);
      if (!pack) throw new ToolExecutionError("This capability is unavailable.");
      if (pack.requiresApproval) {
        await requireApproval(session, id, {
          toolName: "uya_use_capability", toolKind: "other", title: `Use capability ${pack.name}`, detail: pack.description,
        });
      }
      assertActive(session);
      const result = await context.invokeCapability(id, args);
      assertActive(session);
      if (result.artifact) context.emitArtifact(result.artifact);
      return { text: result.text };
    },
  }),
];

const rpcId = z.union([z.string(), z.number(), z.null()]);
const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"), id: rpcId.optional(), method: z.string().min(1), params: z.unknown().optional(),
});
type RpcId = z.infer<typeof rpcId>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

function rpcError(id: RpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function visibleAtDepth(tool: { rootOnly?: boolean }, depth: number): boolean {
  return !tool.rootOnly || depth === 0;
}

export class SynapseBroker {
  private readonly sessions = new Map<string, Session>();
  // A replacement bridge for the same run shares the original call budget and depth.
  private readonly runsBySignal = new WeakMap<AbortSignal, Map<string, RunState>>();

  registerSession(ctx: SynapseRunSessionContext): { token: string; close: () => void } {
    const { runId, depth, signal } = ctx;
    if (!Number.isInteger(depth) || depth < 0 || depth > MAX_SYNAPSE_DEPTH) {
      throw new RangeError("Uya Synapse session depth is out of bounds.");
    }
    if (signal.aborted) throw new Error("The Uya run has ended.");
    if (this.sessions.has(runId)) throw new Error("The Uya run already has a Synapse session.");

    const runs = this.runsBySignal.get(signal) ?? new Map<string, RunState>();
    const run = runs.get(runId) ?? { depth, calls: 0 };
    if (run.depth !== depth) throw new RangeError("Uya Synapse session depth changed for the run.");
    runs.set(runId, run);
    this.runsBySignal.set(signal, runs);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const session: Session = { context: ctx, token: Buffer.from(token), run, closed: false, approvals: new Set() };
    const close = () => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(runId);
      signal.removeEventListener("abort", close);
    };
    this.sessions.set(runId, session);
    signal.addEventListener("abort", close, { once: true });
    return { token, close };
  }

  private authenticate(header: string | null): Session | undefined {
    if (header?.length !== TOKEN_LENGTH || /[^A-Za-z0-9_-]/.test(header)) return;
    const token = Buffer.from(header);
    let match: Session | undefined;
    for (const session of this.sessions.values()) {
      if (timingSafeEqual(session.token, token)) match = session;
    }
    return match;
  }

  private async callTool(session: Session, params: Record<string, unknown>) {
    const { name, arguments: args = {} } = params;
    const tool = tools.find((candidate) => candidate.definition.name === name && visibleAtDepth(candidate, session.run.depth));
    if (!tool) throw new RpcError(-32602, "Unknown or unavailable Uya tool.");
    if (session.run.calls >= MAX_CALLS_PER_RUN) {
      return toolResult(`A Uya run can make up to ${MAX_CALLS_PER_RUN} tool calls.`, true);
    }
    const prepared = tool.prepare(args);
    session.run.calls++;

    const { context } = session;
    const call = { id: randomUUID(), ...prepared.activity };
    context.emitSynapseCall({ ...call, status: "running" });
    let result: ToolOutcome;
    try {
      assertActive(session);
      result = await prepared.run(session);
      assertActive(session);
    } catch (error) {
      const message = error instanceof ToolExecutionError || error instanceof RpcError
        ? error.message
        : `Uya could not complete ${tool.definition.name}.`;
      result = { text: message, summary: message, isError: true };
    }
    context.emitSynapseCall({
      ...call, status: result.isError ? "error" : "done",
      ...(result.summary !== undefined && { summary: result.summary }),
      ...(result.childRunId !== undefined && { childRunId: result.childRunId }),
    });
    return toolResult(result.text, result.isError);
  }

  async handleHttp(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const session = this.authenticate(request.headers.get("X-Uya-Mcp-Token"));
    if (!session) return new Response(null, { status: 401 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, "Parse error.");
    }
    if (session.closed) return new Response(null, { status: 401 });
    const parsed = rpcRequest.safeParse(body);
    if (!parsed.success) return rpcError(null, -32600, "Invalid request.");

    const { id, method, params } = parsed.data;
    if (id === undefined) return new Response(null, { status: 202 });
    if (params !== undefined && !isObject(params)) return rpcError(id, -32602, "MCP params must be an object.");
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    try {
      switch (method) {
        case "initialize": {
          const version = params?.protocolVersion;
          return reply({
            protocolVersion: typeof version === "string" && version !== "" ? version : "2024-11-05",
            capabilities: { tools: {} }, serverInfo: { name: "uya", version: "0.5.0" },
          });
        }
        case "notifications/initialized":
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: tools.filter((tool) => visibleAtDepth(tool, session.run.depth)).map((tool) => tool.definition) });
        case "tools/call":
          return reply(await this.callTool(session, params ?? {}));
        default:
          return rpcError(id, -32601, "Method not found.");
      }
    } catch (error) {
      return error instanceof RpcError ? rpcError(id, error.code, error.message) : rpcError(id, -32603, "Internal error.");
    }
  }
}

function promptList(items: string[], limit: number): string {
  const text = items.join("; ").replace(/[\x00-\x1f\x7f`]/g, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text || "none";
}

export function buildSynapseAwarenessPrompt(info: {
  snapshot?: WorkbenchSnapshot;
  recommendations: Partial<Record<CapabilityDomain, SpecialistRecommendation>>;
  capabilities: readonly CapabilityPack[];
  hasNativeMcp: boolean;
}): string {
  const splits = (info.snapshot?.splits ?? []).map(({ alias, providerName, model, busy }) =>
    `${alias} (${providerName}${model ? `/${model}` : ""}, ${busy ? "busy" : "idle"})`);
  const specialists = Object.values(info.recommendations)
    .filter((item): item is SpecialistRecommendation => item !== undefined)
    .sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0) || (b.localWinRate ?? 0) - (a.localWinRate ?? 0))
    .map(({ domain, providerName, model, elo, localWinRate }) => [
      `${domain} ${providerName}${model ? `/${model}` : ""}`,
      ...(elo === undefined ? [] : [`Arena Elo ${elo}`]),
      ...(localWinRate === undefined ? [] : [`${Math.round(localWinRate * 100)}% local verify pass`]),
    ].join(", "));
  const capabilities = info.capabilities.filter((pack) => pack.enabled).map(({ id, name, rest }) => {
    const inputs = rest?.inputSchema.map((field) => `${field.name} (${field.type}${field.required ? ", required" : ""})`);
    return `${id} (${name}${inputs?.length ? `, inputs ${inputs.join(", ")}` : ""})`;
  });
  const names = tools.map(({ definition }) => definition.name).join(", ");
  const invocation = info.hasNativeMcp
    ? `Call these MCP tools as needed. ${names}.`
    : `If needed, request a Uya action using one fenced JSON block per call. Tools available through this format include ${names}.\n` +
      '```uya-action\n{"tool":"uya_get_workbench","arguments":{}}\n```';
  const context = [
    "You are running inside Uya.",
    `Open peer splits — ${promptList(splits, 220)}`,
    `Top specialists — ${promptList(specialists, 300)}`,
    `Enabled capabilities — ${promptList(capabilities, 400)}`,
  ].join("\n");
  return `${context.slice(0, MAX_AWARENESS_CHARS - invocation.length - 1)}\n${invocation}`;
}

export function extractSynapseFallbackActions(replyText: string): Array<{ tool: string; arguments: Record<string, unknown> }> {
  const actions: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  let fence: { width: number; action: boolean; start: number } | undefined;
  for (const match of replyText.matchAll(/^[ \t]*(`{3,})([^`\r\n]*)\r?$/gm)) {
    const width = match[1].length;
    const label = match[2].trim();
    const action = label === "uya-action";
    if (!fence || (fence.action && action)) {
      fence = { width, action, start: match.index + match[0].length };
    } else if (!label && width >= fence.width) {
      if (fence.action) {
        try {
          const payload: unknown = JSON.parse(replyText.slice(fence.start, match.index));
          if (isObject(payload) && typeof payload.tool === "string" && payload.tool.trim() !== "" &&
            (payload.arguments === undefined || isObject(payload.arguments))) {
            actions.push({ tool: payload.tool, arguments: payload.arguments ?? {} });
          }
        } catch {
          // A malformed action does not affect later blocks.
        }
      }
      fence = undefined;
    }
  }
  return actions;
}
