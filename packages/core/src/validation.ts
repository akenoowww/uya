import { isAbsolute } from "node:path";
import type { RpcMethod, RpcParams } from "@ide/protocol";
import * as z from "zod";

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

function text(label: string, max: number, allowEmpty = false) {
  const error = `${label} must be ${allowEmpty ? "text" : "nonempty text"} of at most ${max} characters without NUL.`;
  // Match the existing UTF-16 limits; Zod's string length checks count Unicode code points.
  return z.string({ error }).refine(
    (value) => value.length <= max && !value.includes("\0") && (allowEmpty || value.trim() !== ""),
    { error },
  );
}

function integer(label: string, min: number, max: number) {
  const error = `${label} must be an integer between ${min} and ${max}.`;
  return z.int({ error }).min(min, { error }).max(max, { error });
}

function boundedArray<T extends z.ZodType>(item: T, limit: number, error: string) {
  // Reject oversized collections before validating their members.
  return z.custom<unknown[]>((value) => Array.isArray(value) && value.length <= limit, { error })
    .pipe(z.array(item));
}

const projectPath = text("Project path", 4096);
const filePath = text("File path", 4096);
const fileText = text("File content", 1_048_576, true);
const revision = text("Revision", 256);
const providerId = text("Provider ID", 100);
const runId = text("Run ID", 100);
const entityId = (label: string) => text(label, 100).regex(/^[A-Za-z0-9_-]+$/, { error: `Invalid ${label.toLowerCase()}.` });
const conversationId = text("Conversation ID", 100)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "Invalid conversation ID." });
const broadcastGroupId = text("Broadcast group ID", 100)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "Invalid broadcast group ID." });
const effortLevel = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"], { error: "Unknown effort level." });
const executionMode = z.enum(["isolated", "read-only", "agent"], { error: "Unknown execution mode." });
const approvalDecision = z.enum(["allow_once", "allow_session", "reject"], { error: "Unknown approval decision." });
const capabilityDomain = z.enum(
  ["code", "webdev", "text", "vision", "search", "audio", "image", "video"],
  { error: "Unknown capability domain." },
);
const capabilityOutputKind = z.enum(
  ["text", "json", "audio", "image", "video", "file"],
  { error: "Unknown capability output kind." },
);
const modelName = text("Model", 256).refine((value) => !value.startsWith("-") && !/[\x00-\x1f\x7f]/.test(value), {
  error: "Invalid model name.",
});
const gitBranchName = text("Branch name", 256).refine(
  (value) => !value.startsWith("-") && !/[\s~^:?*[\]\\]|\.\.|@\{|\/\/|\/$|\.$|\.lock$/u.test(value),
  { error: "Invalid Git branch name." },
);
const attachmentByteLimit = 128 * 1024;
const attachments = boundedArray(z.object({
  path: filePath,
  text: text("Attachment text", attachmentByteLimit, true).refine(
    (value) => Buffer.byteLength(value) <= attachmentByteLimit,
    { error: "Each attachment is limited to 128 KiB." },
  ),
}, { error: "Each attachment must be an object." }), 10, "Attach up to 10 files.");
const historyList = z.object({
  limit: integer("Result limit", 1, 200).optional(),
  query: text("Search query", 512, true).optional(),
  workspacePath: projectPath.nullable().optional(),
});

const customProvider = z.object({
  name: text("Display name", 100).trim(),
  command: text("Executable", 4096).trim().refine((value) => !value.includes("/") || isAbsolute(value), {
    error: "Use a command on PATH or an absolute executable path.",
  }),
  args: boundedArray(text("Terminal argument", 4096, true), 50, "Set up to 50 terminal arguments."),
  structuredArgs: boundedArray(text("Structured argument", 4096, true), 50, "Set up to 50 structured arguments.").optional(),
});

const originActor = z.object({
  alias: text("Actor alias", 64),
  providerId,
  kind: z.enum(["consult", "handoff", "red_team", "mission", "forward"], { error: "Unknown actor kind." }),
}, { error: "Origin actor must be an object." });

const splitPresence = z.object({
  paneId: text("Pane ID", 100),
  alias: text("Split alias", 64),
  role: text("Split role", 64).optional(),
  providerId,
  providerName: text("Provider name", 100),
  model: modelName.optional(),
  effort: effortLevel.optional(),
  accessMode: executionMode,
  busy: z.boolean({ error: "Busy must be a boolean." }),
}, { error: "Each split presence must be an object." });

const workbenchSnapshot = z.object({
  workspacePath: projectPath.nullable(),
  gitBranch: text("Git branch", 256).nullable(),
  activeFilePath: filePath.optional(),
  selectionPath: filePath.optional(),
  splits: boundedArray(splitPresence, 24, "Include up to 24 splits."),
}, { error: "Workbench snapshot must be an object." });

const runInput = z.object({
  conversationId: conversationId.optional(),
  broadcastGroupId: broadcastGroupId.optional(),
  workspacePath: projectPath.nullable().optional(),
  providerId: providerId.optional(),
  model: modelName.optional(),
  effort: effortLevel.optional(),
  accessMode: executionMode.optional(),
  includeWorkspaceMap: z.boolean({ error: "Include workspace map must be a boolean." }).optional(),
  activeFilePath: filePath.optional(),
  arenaId: entityId("Arena ID").optional(),
  arenaSlotId: entityId("Arena slot ID").optional(),
  createCheckpoint: z.boolean({ error: "Create checkpoint must be a boolean." }).optional(),
  synapseEnabled: z.boolean({ error: "Synapse enabled must be a boolean." }).optional(),
  workbenchSnapshot: workbenchSnapshot.optional(),
  originActor: originActor.optional(),
  prompt: text("Prompt", 256_000),
  contextPaths: boundedArray(filePath, 20, "Select up to 20 context files.").optional(),
  attachments: attachments.optional(),
  includeProjectRules: z.boolean({ error: "Include project rules must be a boolean." }).optional(),
  mode: z.enum(["manual", "rule", "fallback"], { error: "Unknown routing mode." })
    .nullish().transform((value) => value ?? "manual"),
  fallbackIds: boundedArray(providerId, 8, "Select up to 8 fallback providers.").optional(),
  tags: boundedArray(text("Tag", 100), 20, "Set up to 20 tags.").optional(),
  promptVersion: text("Prompt version", 256).optional(),
  selection: z.object({
    path: filePath,
    text: text("Selection text", 128_000),
    revision,
  }, { error: "Selection must be an object." }).optional(),
});

const routingRule = z.object({
  providerId,
  tag: text("Tag", 100).optional(),
  extension: text("File extension", 32)
    .transform((value) => value.toLowerCase().replace(/^\./, ""))
    .pipe(z.string().regex(/^[a-z0-9_+-]+$/, { error: "Invalid file extension." })).optional(),
  minContextChars: integer("Minimum context characters", 0, 512_000).optional(),
}, { error: "Each rule must be an object." });

const promptRef = z.object({
  scope: z.enum(["global", "project"], { error: "Unknown prompt scope." }),
  path: text("Prompt path", 4096),
}, { error: "Prompt reference must be an object." });

const promptValues = z.custom<Record<string, unknown>>((value) => {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length <= 128;
}, { error: "Provide a mapping with up to 128 prompt variables." })
  .transform((value) => Object.entries(value))
  // Entry tuples preserve literal variable names even when they shadow Object.prototype.
  .pipe(z.array(z.tuple([z.string(), text("Variable value", 128_000, true)])))
  .transform((entries) => Object.fromEntries(entries));

const arenaSlotInput = z.object({
  paneId: text("Pane ID", 100),
  providerId,
  providerName: text("Provider name", 100),
  model: modelName.optional(),
  effort: effortLevel.optional(),
}, { error: "Each arena slot must be an object." });

const searchOptions = z.object({
  query: text("Search query", 512),
  caseSensitive: z.boolean({ error: "Case sensitive must be a boolean." }).optional(),
  regex: z.boolean({ error: "Regex must be a boolean." }).optional(),
  wholeWord: z.boolean({ error: "Whole word must be a boolean." }).optional(),
  glob: text("Glob filter", 256, true).optional(),
  maxResults: integer("Result limit", 1, 500).optional(),
  workspacePath: projectPath.optional(),
});

const stringMap = (maxEntries: number, valueMax: number, error: string) =>
  z.custom<Record<string, unknown>>((value) => {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length <= maxEntries;
  }, { error })
    .transform((value) => Object.entries(value))
    .pipe(z.array(z.tuple([text("Header or key", 128), text("Value", valueMax, true)])))
    .transform((entries) => Object.fromEntries(entries));

const capabilityInputField = z.object({
  name: text("Field name", 64).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { error: "Invalid field name." }),
  type: z.enum(["string", "number", "boolean"], { error: "Invalid field type." }),
  description: text("Field description", 512),
  required: z.boolean({ error: "Required must be a boolean." }).optional(),
  default: z.union([text("Default text", 1024, true), z.number(), z.boolean()], { error: "Invalid default value." }).optional(),
  enum: boundedArray(text("Enum option", 128), 32, "Provide up to 32 enum options.").optional(),
}, { error: "Each input field must be an object." });

const capabilityPollSpec = z.object({
  urlTemplate: text("Poll URL", 2048),
  statusPath: text("Status path", 256),
  doneValues: boundedArray(text("Done status", 64), 16, "Provide up to 16 done statuses."),
  failedValues: boundedArray(text("Failed status", 64), 16, "Provide up to 16 failed statuses."),
  resultUrlPath: text("Result URL path", 256),
  intervalMs: integer("Poll interval", 250, 30_000).optional(),
  timeoutMs: integer("Poll timeout", 1_000, 300_000).optional(),
}, { error: "Poll specification must be an object." });

const capabilityRestSpec = z.object({
  method: z.enum(["GET", "POST"], { error: "Choose GET or POST." }),
  url: text("Capability URL", 2048),
  headers: stringMap(32, 4096, "Provide up to 32 headers.").optional(),
  bodyTemplate: text("Body template", 65_536, true).optional(),
  inputSchema: boundedArray(capabilityInputField, 32, "Provide up to 32 input fields."),
  outputKind: capabilityOutputKind,
  outputPathTemplate: filePath.optional(),
  responsePath: text("Response path", 256).optional(),
  poll: capabilityPollSpec.optional(),
}, { error: "REST specification must be an object." });

const capabilityMcpSpec = z.object({
  command: text("MCP command", 4096).optional(),
  args: boundedArray(text("MCP argument", 4096, true), 50, "Provide up to 50 MCP arguments.").optional(),
  url: text("MCP URL", 2048).optional(),
  headers: stringMap(32, 4096, "Provide up to 32 headers.").optional(),
}, { error: "MCP specification must be an object." });

const capabilityPackSchema = z.object({
  id: entityId("Capability ID"),
  name: text("Capability name", 100),
  description: text("Capability description", 1024),
  domain: capabilityDomain,
  kind: z.enum(["rest", "mcp-stdio", "mcp-http"], { error: "Unknown capability kind." }),
  enabled: z.boolean({ error: "Enabled must be a boolean." }),
  builtin: z.boolean({ error: "Builtin must be a boolean." }).optional(),
  scope: z.enum(["builtin", "global", "project"], { error: "Unknown capability scope." }).optional(),
  requiresApproval: z.boolean({ error: "Requires approval must be a boolean." }),
  secretKeys: boundedArray(
    text("Secret key", 64).regex(/^[A-Z][A-Z0-9_]{1,63}$/, { error: "Secret key must use UPPER_SNAKE_CASE." }),
    16,
    "Provide up to 16 secret keys.",
  ),
  configuredSecrets: boundedArray(text("Secret key", 64), 16, "Provide up to 16 configured keys.").optional(),
  rest: capabilityRestSpec.optional(),
  mcp: capabilityMcpSpec.optional(),
}, { error: "Capability pack must be an object." });

const capabilityArgs = z.custom<Record<string, unknown>>((value) => {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length <= 64;
}, { error: "Provide up to 64 capability arguments." })
  .transform((value) => Object.entries(value))
  .pipe(z.array(z.tuple([
    text("Argument name", 64),
    z.union([text("Argument text", 65_536, true), z.number(), z.boolean(), z.null()], { error: "Invalid argument value." }),
  ])))
  .transform((entries) => Object.fromEntries(entries));

const missionStepOverride = z.object({
  stepId: entityId("Step ID"),
  providerId: providerId.optional(),
  model: modelName.optional(),
  effort: effortLevel.optional(),
}, { error: "Each step override must be an object." });

const rpcParams: { [Method in RpcMethod]: z.ZodType<RpcParams<Method>> } = {
  "providers.list": z.object({ refresh: z.boolean({ error: "Refresh must be a boolean." }).optional() }),
  "providers.add": customProvider,
  "providers.update": customProvider.extend({ id: providerId }),
  "providers.remove": z.object({ id: providerId }),
  "runs.start": runInput,
  "runs.get": z.object({ id: runId }),
  "runs.list": historyList,
  "runs.conversation": z.object({ id: conversationId, workspacePath: projectPath.nullable() }),
  "runs.conversations": historyList,
  "runs.fork": z.object({ conversationId, workspacePath: projectPath.nullable(), upToRunId: runId.optional() }),
  "runs.delete": z.object({ id: runId }),
  "runs.deleteConversation": z.object({ id: conversationId, workspacePath: projectPath.nullable() }),
  "runs.usage": z.object({ days: integer("Usage window in days", 1, Number.MAX_SAFE_INTEGER).optional() }),
  "runs.cancel": z.object({ id: runId }),
  "runs.respondApproval": z.object({
    runId,
    requestId: entityId("Approval request ID"),
    decision: approvalDecision,
  }),
  "runs.closeSession": z.object({
    conversationId,
    workspacePath: projectPath.nullable(),
  }),
  "runs.getRules": z.object({}),
  "runs.setRules": z.object({ rules: boundedArray(routingRule, 50, "Set up to 50 routing rules.") }),
  "workspace.open": z.object({ path: projectPath }),
  "workspace.close": z.object({ path: projectPath }),
  "workspace.list": z.object({ path: text("Directory path", 4096, true).optional(), workspacePath: projectPath.optional() }),
  "workspace.files": z.object({
    query: text("File query", 4096, true).optional(),
    limit: integer("Result limit", 1, 500).optional(),
    workspacePath: projectPath.optional(),
  }),
  "workspace.search": searchOptions,
  "workspace.read": z.object({ path: filePath, workspacePath: projectPath.optional() }),
  "workspace.readBinary": z.object({ path: filePath, workspacePath: projectPath.optional() }),
  "workspace.write": z.object({ path: filePath, text: fileText, revision, workspacePath: projectPath.optional() }),
  "workspace.create": z.object({
    path: filePath,
    kind: z.enum(["file", "directory"], { error: "Choose a file or directory." }),
    text: fileText.optional(),
    workspacePath: projectPath.optional(),
  }),
  "workspace.rename": z.object({ from: filePath, to: filePath, workspacePath: projectPath.optional() }),
  "workspace.remove": z.object({ path: filePath, workspacePath: projectPath.optional() }),
  "workspace.projectRules": z.object({ workspacePath: projectPath.optional() }),
  "git.status": z.object({ workspacePath: projectPath.optional() }),
  "git.diff": z.object({
    path: filePath.optional(),
    staged: z.boolean({ error: "Staged must be a boolean." }).optional(),
    workspacePath: projectPath.optional(),
  }),
  "git.stage": z.object({
    paths: boundedArray(filePath, 200, "Select up to 200 paths.").optional(),
    all: z.boolean({ error: "All must be a boolean." }).optional(),
    workspacePath: projectPath.optional(),
  }),
  "git.unstage": z.object({
    paths: boundedArray(filePath, 200, "Select up to 200 paths.").optional(),
    all: z.boolean({ error: "All must be a boolean." }).optional(),
    workspacePath: projectPath.optional(),
  }),
  "git.discard": z.object({
    paths: boundedArray(filePath, 200, "Select up to 200 paths.").refine((value) => value.length > 0, {
      error: "Select at least one path to discard.",
    }),
    workspacePath: projectPath.optional(),
  }),
  "git.commit": z.object({
    message: text("Commit message", 8192),
    workspacePath: projectPath.optional(),
  }),
  "git.branches": z.object({ workspacePath: projectPath.optional() }),
  "git.checkout": z.object({
    branch: gitBranchName,
    workspacePath: projectPath.optional(),
  }),
  "git.createBranch": z.object({
    name: gitBranchName,
    checkout: z.boolean({ error: "Checkout must be a boolean." }).optional(),
    workspacePath: projectPath.optional(),
  }),
  "git.log": z.object({
    limit: integer("Commit limit", 1, 100).optional(),
    workspacePath: projectPath.optional(),
  }),
  "checkpoints.list": z.object({
    workspacePath: projectPath.optional(),
    limit: integer("Checkpoint limit", 1, 100).optional(),
  }),
  "checkpoints.restore": z.object({
    id: entityId("Checkpoint ID"),
    workspacePath: projectPath.optional(),
  }),
  "arena.create": z.object({
    workspacePath: projectPath.optional(),
    prompt: text("Prompt", 256_000),
    slots: boundedArray(arenaSlotInput, 6, "Use between 2 and 6 arena slots.").refine((value) => value.length >= 2, {
      error: "Use between 2 and 6 arena slots.",
    }),
    includeDirty: z.boolean({ error: "Include dirty changes must be a boolean." }).optional(),
  }),
  "arena.get": z.object({ id: entityId("Arena ID") }),
  "arena.list": z.object({
    workspacePath: projectPath.optional(),
    limit: integer("Arena limit", 1, 50).optional(),
  }),
  "arena.slotDiff": z.object({
    arenaId: entityId("Arena ID"),
    slotId: entityId("Arena slot ID"),
    path: filePath.optional(),
  }),
  "arena.verify": z.object({
    arenaId: entityId("Arena ID"),
    slotId: entityId("Arena slot ID"),
    command: text("Verify command", 1024),
  }),
  "arena.apply": z.object({
    arenaId: entityId("Arena ID"),
    slotId: entityId("Arena slot ID"),
    mode: z.enum(["workspace", "branch"], { error: "Unknown arena apply mode." }),
    branchName: gitBranchName.optional(),
    cleanup: z.boolean({ error: "Cleanup must be a boolean." }).optional(),
  }),
  "arena.discard": z.object({ arenaId: entityId("Arena ID") }),
  "verify.presets": z.object({ workspacePath: projectPath.optional() }),
  "verify.start": z.object({
    command: text("Verify command", 1024),
    workspacePath: projectPath.optional(),
    arenaId: entityId("Arena ID").optional(),
    arenaSlotId: entityId("Arena slot ID").optional(),
  }),
  "verify.get": z.object({ id: entityId("Verify run ID") }),
  "verify.cancel": z.object({ id: entityId("Verify run ID") }),
  "prompts.list": z.object({}),
  "prompts.read": z.object({ ref: promptRef }),
  "prompts.write": z.object({ ref: promptRef, source: text("Prompt source", 1_048_576, true), revision: revision.optional() }),
  "prompts.render": z.object({ ref: promptRef, values: promptValues }),
  "synapse.matrix": z.object({ workspacePath: projectPath.nullable().optional() }),
  "synapse.syncArena": z.object({}),
  "synapse.setOverride": z.object({
    domain: capabilityDomain,
    providerId: providerId.nullable(),
    model: modelName.optional(),
    effort: effortLevel.optional(),
    workspacePath: projectPath.nullable().optional(),
  }),
  "synapse.recommend": z.object({
    domain: capabilityDomain,
    workspacePath: projectPath.nullable().optional(),
    preferWarmProviderId: providerId.optional(),
  }),
  "capabilities.list": z.object({ workspacePath: projectPath.nullable().optional() }),
  "capabilities.save": z.object({ pack: capabilityPackSchema }),
  "capabilities.remove": z.object({ id: entityId("Capability ID") }),
  "capabilities.setSecret": z.object({
    key: text("Secret key", 64).regex(/^[A-Z][A-Z0-9_]{1,63}$/, { error: "Secret key must use UPPER_SNAKE_CASE." }),
    value: text("Secret value", 8192).nullable(),
  }),
  "capabilities.invoke": z.object({
    id: entityId("Capability ID"),
    args: capabilityArgs,
    workspacePath: projectPath.nullable().optional(),
    runId: runId.optional(),
  }),
  "missions.list": z.object({
    workspacePath: projectPath.nullable().optional(),
    limit: integer("Mission limit", 1, 100).optional(),
  }),
  "missions.get": z.object({ id: entityId("Mission ID") }),
  "missions.approve": z.object({
    id: entityId("Mission ID"),
    autonomous: z.boolean({ error: "Autonomous must be a boolean." }).optional(),
    stepOverrides: boundedArray(missionStepOverride, 24, "Provide up to 24 step overrides.").optional(),
  }),
  "missions.cancel": z.object({ id: entityId("Mission ID") }),
};

const requestId = z.union([z.string(), z.int()]);
export const rpcResponseId = z.object({ id: requestId });
export const rpcEnvelope = rpcResponseId.extend({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

export const subscription = z.object({
  token: z.unknown(),
  runId,
  after: integer("Sequence", 0, Number.MAX_SAFE_INTEGER),
});

export function isRpcMethod(value: string): value is RpcMethod {
  return Object.hasOwn(rpcParams, value);
}

export function parseRpcParams<Method extends RpcMethod>(method: Method, value: unknown): RpcParams<Method> {
  const result = rpcParams[method].safeParse(value === undefined ? {} : value, { error: () => "Invalid parameters." });
  if (!result.success) {
    // Issue messages use fixed labels. Issue paths and inputs can contain client-supplied data.
    throw new RpcError(-32602, result.error.issues[0]?.message ?? "Invalid parameters.");
  }
  return result.data;
}
