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
const conversationId = text("Conversation ID", 100)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "Invalid conversation ID." });

const customProvider = z.object({
  name: text("Display name", 100).trim(),
  command: text("Executable", 4096).trim().refine((value) => !value.includes("/") || isAbsolute(value), {
    error: "Use a command on PATH or an absolute executable path.",
  }),
  args: boundedArray(text("Terminal argument", 4096, true), 50, "Set up to 50 terminal arguments."),
  structuredArgs: boundedArray(text("Structured argument", 4096, true), 50, "Set up to 50 structured arguments.").optional(),
});

const runInput = z.object({
  conversationId: conversationId.optional(),
  workspacePath: projectPath.nullable().optional(),
  providerId: providerId.optional(),
  model: text("Model", 256).refine((value) => !value.startsWith("-") && !/[\x00-\x1f\x7f]/.test(value), {
    error: "Invalid model name.",
  }).optional(),
  prompt: text("Prompt", 256_000),
  contextPaths: boundedArray(filePath, 20, "Select up to 20 context files.").optional(),
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

const rpcParams: { [Method in RpcMethod]: z.ZodType<RpcParams<Method>> } = {
  "providers.list": z.object({ refresh: z.boolean({ error: "Refresh must be a boolean." }).optional() }),
  "providers.add": customProvider,
  "providers.update": customProvider.extend({ id: providerId }),
  "providers.remove": z.object({ id: providerId }),
  "runs.start": runInput,
  "runs.get": z.object({ id: runId }),
  "runs.list": z.object({ limit: integer("Result limit", 1, 200).optional() }),
  "runs.conversation": z.object({ id: conversationId, workspacePath: projectPath.nullable() }),
  "runs.cancel": z.object({ id: runId }),
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
  "workspace.read": z.object({ path: filePath, workspacePath: projectPath.optional() }),
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
  "prompts.list": z.object({}),
  "prompts.read": z.object({ ref: promptRef }),
  "prompts.write": z.object({ ref: promptRef, source: text("Prompt source", 1_048_576, true), revision: revision.optional() }),
  "prompts.render": z.object({ ref: promptRef, values: promptValues }),
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
