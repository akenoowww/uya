import type { ApprovalDecision, ApprovalOption, EffortLevel, ToolKind, ToolMeta, ToolStatus } from "@ide/protocol";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { version as clientVersion } from "../package.json";
import { cliEnv, spawnTarget } from "./agents";
import { classifyCliDiagnostic, drainCliDiagnostics } from "./cli-diagnostics";
import { isSafeCliModelName } from "./cli-models";
import { promptForCli } from "./conversation";
import {
  AdapterError, normalizeEffortLevel, normalizeExecutionMode, type AdapterApprovalPrompt, type AdapterRequest, type Usage,
} from "./provider-adapter";
import { AcpSessionPool, type AcpOptionMeta, type AcpSession } from "./session-pool";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

export interface AcpRunOptions {
  args: string[];
  command?: string;
  env?: NodeJS.ProcessEnv;
  encode?: (text: string) => string;
  fallbackError: string;
  pool?: AcpSessionPool;
}

const MAX_ACP_LINE_BYTES = 2_000_000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024;
const cancelledPermission = { outcome: { outcome: "cancelled" } };

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseOptionValues(value: unknown): string[] {
  const result: string[] = [];
  for (const item of asArray(value)) {
    const entry = asObject(item);
    const group = entry?.options;
    if (Array.isArray(group)) {
      result.push(...parseOptionValues(group));
      continue;
    }
    const val = typeof item === "string" ? item : entry?.value ?? entry?.id;
    if (typeof val === "string" && val.length > 0) result.push(val);
  }
  return result;
}

function parseConfigOptions(value: readonly unknown[]): AcpOptionMeta[] {
  const result: AcpOptionMeta[] = [];
  for (const raw of value) {
    const entry = asObject(raw);
    if (!entry) continue;
    const id = typeof entry.id === "string"
      ? entry.id
      : typeof entry.configId === "string" ? entry.configId : undefined;
    if (!id) continue;
    result.push({
      id,
      category: typeof entry.category === "string" ? entry.category : undefined,
      currentValue: typeof entry.currentValue === "string" ? entry.currentValue : undefined,
      values: parseOptionValues(entry.options),
    });
  }
  return result;
}

function findModelOption(options: readonly AcpOptionMeta[]): AcpOptionMeta | undefined {
  return options.find((opt) => opt.category === "model" || opt.id === "model");
}

function findEffortOption(options: readonly AcpOptionMeta[]): AcpOptionMeta | undefined {
  return options.find((opt) =>
    opt.category === "thought_level"
    || opt.category === "effort"
    || opt.category === "reasoning_effort"
    || opt.id === "thought_level"
    || opt.id === "effort"
    || opt.id === "reasoning_effort",
  );
}

function resolveAcpEffortValue(requested: EffortLevel, allowed: readonly string[]): string | undefined {
  if (!allowed.length) return requested;
  if (allowed.includes(requested)) return requested;
  if (requested === "max") {
    if (allowed.includes("xhigh")) return "xhigh";
    if (allowed.includes("high")) return "high";
  }
  if (requested === "xhigh" && allowed.includes("high")) return "high";
  if (requested === "minimal" && allowed.includes("low")) return "low";
  return undefined;
}

function selectPermissionRejection(params: JsonObject | undefined): JsonObject {
  for (const item of asArray(params?.options)) {
    const entry = asObject(item);
    const kind = typeof entry?.kind === "string" ? entry.kind : "";
    const optionId = typeof entry?.optionId === "string" ? entry.optionId : undefined;
    if (optionId && (kind === "reject_once" || kind === "reject_always")) {
      return permissionOutcome(optionId);
    }
  }
  return cancelledPermission;
}

function extractErrorText(error: unknown): string | undefined {
  const obj = asObject(error);
  if (!obj) return typeof error === "string" ? error : undefined;
  const parts: string[] = [];
  if (typeof obj.message === "string" && obj.message.trim()) parts.push(obj.message.trim());
  const data = obj.data;
  if (typeof data === "string" && data.trim()) {
    parts.push(data.trim());
  } else {
    const dataObj = asObject(data);
    if (typeof dataObj?.message === "string" && dataObj.message.trim()) {
      parts.push(dataObj.message.trim());
    }
    if (typeof dataObj?.details === "string" && dataObj.details.trim()) {
      parts.push(dataObj.details.trim());
    }
  }
  return parts.length ? parts.join(" ") : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && !!value.trim());
}

function normalizeToolName(name: string): string {
  return name.trim().replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_");
}

const readTools = new Set(["read", "read_file", "list_dir", "list_directory", "list_files", "view_file"]);
const searchTools = new Set(["search", "glob", "grep", "find_by_name", "search_files"]);

function namedToolKind(value: string | undefined): ToolKind | undefined {
  if (!value) return;
  const name = normalizeToolName(value);
  if (/^(?:shell|bash|sh|terminal|exec|execute|run|powershell|cmd)(?:\b|_)/.test(name)) return "shell";
  if (/^(?:edit|apply_patch|patch|replace|str_replace|update_file)(?:\b|_)/.test(name)) return "edit";
  if (/^(?:write|delete|remove|move|rename|save|create_file|mkdir|rmdir|rm|mv|cp|touch|truncate)(?:\b|_)/.test(name)) {
    return "write";
  }
  if (/^(?:fetch|web_fetch|download)(?:\b|_)/.test(name)) return "fetch";
  if (readTools.has(name)) return "read";
  if (searchTools.has(name)) return "search";
}

function isReadTool(kind: ToolKind): boolean {
  return kind === "read" || kind === "search";
}

function unsafeToolHint(value: string | undefined): ToolKind | undefined {
  const kind = namedToolKind(value);
  if (kind && !isReadTool(kind)) return kind;
}

function kindForTool(
  kinds: (ToolKind | undefined)[], command: string | undefined, input: JsonObject | undefined, reportedKind?: string,
): ToolKind {
  if (command || kinds.includes("shell")) return "shell";
  const mutation = kinds.find((kind) => kind === "edit" || kind === "write");
  if (mutation) return mutation;
  if (input?.patch != null || input?.newText != null || input?.new_text != null || input?.new_string != null) return "edit";
  if (input?.content != null && firstText(input.path, input.filePath, input.file_path)) return "write";
  if (kinds.includes("fetch")) return "fetch";
  if (reportedKind === "switch_mode" || reportedKind === "think") return "other";
  return kinds.find((kind) => kind !== undefined && isReadTool(kind)) ?? "other";
}

function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return firstText(value);
  const args = asArray(value);
  if (args.length) return args.every((arg) => typeof arg === "string") ? args.join(" ") : JSON.stringify(args);
  if (asObject(value)) return JSON.stringify(value);
}

function pathIn(value: unknown): string | undefined {
  for (const entry of asArray(value)) {
    const path = firstText(asObject(entry)?.path);
    if (path) return path;
  }
}

function toolOutput(call: JsonObject): string | undefined {
  const value = call.rawOutput ?? call.output;
  const raw = asObject(value);
  const text = firstText(value, raw?.output, raw?.stdout, raw?.text, raw?.stderr)
    ?? firstText(asArray(call.content).map((item) => {
      const entry = asObject(item);
      const block = entry?.type === "content" ? asObject(entry.content) : entry;
      return block?.type === "text" ? firstText(block.text) : undefined;
    }).filter(Boolean).join("\n"))
    ?? (value != null ? JSON.stringify(value) : undefined);
  if (text === undefined) return;
  const bytes = Buffer.from(text.slice(0, MAX_TOOL_OUTPUT_BYTES));
  return new StringDecoder("utf8").write(bytes.subarray(0, MAX_TOOL_OUTPUT_BYTES));
}

function toolStatus(status: unknown): ToolStatus | undefined {
  if (status === "completed" || status === "done") return "done";
  if (status === "failed" || status === "error") return "error";
  if (status === "pending" || status === "in_progress" || status === "running") return "running";
}

interface AcpToolCall extends Omit<ToolMeta, "name"> {
  name?: string;
  title?: string;
  detail?: string;
  reportedKind?: string;
}

function describeTool(call: JsonObject, id: string | undefined, previous?: AcpToolCall): AcpToolCall {
  const raw = asObject(call.rawInput);
  const input = asObject(raw?.arguments) ?? asObject(raw?.input) ?? raw;
  const name = firstText(call.name, call.toolName, raw?.toolName, raw?.tool_name, raw?.tool, previous?.name);
  const title = firstText(call.title, previous?.title)?.trim();
  const reportedKind = firstText(call.kind, previous?.reportedKind);
  const rawText = firstText(call.rawInput);
  const command = [
    call.command, input?.command, input?.cmd, input?.commands, input?.argv, input?.script, raw?.command, raw?.cmd,
  ].map(commandText).find(Boolean) ?? previous?.command;
  const kinds = [
    ...[reportedKind, name, title].map(namedToolKind),
    ...[firstText(raw?.name), firstText(input?.operation), firstText(input?.action), rawText].map(unsafeToolHint),
    previous?.kind,
  ];
  const kind = kindForTool(kinds, command, input, reportedKind);
  return {
    id, name, title, kind, reportedKind,
    command: command ?? (kind === "shell" ? rawText : undefined),
    path: firstText(call.path, input?.path, input?.filePath, input?.file_path, input?.file,
      pathIn(call.locations), pathIn(call.content), previous?.path),
    detail: firstText(call.detail, call.description, previous?.detail),
    summary: firstText(call.summary, asObject(call.rawOutput)?.summary, previous?.summary),
    status: toolStatus(call.status) ?? previous?.status ?? "running",
    output: toolOutput(call) ?? previous?.output,
  };
}

function approvalOptions(params: JsonObject | undefined): ApprovalOption[] {
  const parsed: ApprovalOption[] = [];
  for (const item of asArray(params?.options)) {
    const option = asObject(item);
    const id = firstText(option?.optionId);
    if (!id) continue;
    const kind = option?.kind === "allow_always" ? "allow_session" : option?.kind;
    if (kind === "allow_once" || kind === "allow_session" || kind === "reject_once" || kind === "reject_always") {
      parsed.push({ id, kind, label: firstText(option?.name, option?.label) ?? id });
    }
  }
  return parsed;
}

function permissionOutcome(optionId: string): JsonObject {
  return { outcome: { outcome: "selected", optionId } };
}

function updateConfigOptions(session: AcpSession, value: unknown): void {
  if (!Array.isArray(value)) return;
  const options = parseConfigOptions(value);
  session.configOptions = options;
  const model = findModelOption(options)?.currentValue;
  if (model && isSafeCliModelName(model)) session.model = model;
  session.effort = findEffortOption(options)?.currentValue ?? session.effort;
}

class AcpRpcError extends Error {
  constructor(readonly detail: unknown) {
    super("ACP request failed.");
  }
}

class AcpConnectionClosed extends Error {}

interface AcpReply {
  result?: JsonObject;
  line: string;
}

interface PendingRpc {
  id: number;
  method: string;
  resolve(reply: AcpReply): void;
  reject(reason: unknown): void;
}

class AcpConnection {
  readonly diagnostic: ReturnType<typeof drainCliDiagnostics>;
  turn?: AcpTurn;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 1;
  private pending?: PendingRpc;
  private failure?: { reason: unknown };

  constructor(
    private readonly session: AcpSession,
    args: readonly string[],
    private readonly onFailure: () => void,
  ) {
    const { child, closed } = session;
    this.diagnostic = drainCliDiagnostics(child.stderr, args);
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.receive(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    });
    child.stdout.once("end", () => {
      this.receive(this.decoder.end() + "\n");
      this.fail(new AcpConnectionClosed());
    });
    void closed.then(() => this.fail(new AcpConnectionClosed()));
  }

  request(method: string, params: JsonObject): Promise<AcpReply> {
    if (this.failure) return Promise.reject(this.failure.reason);
    if (this.pending) return Promise.reject(new AdapterError("An ACP request is already pending."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, method, resolve, reject };
      this.send({ id, method, params });
    });
  }

  respond(id: RpcId, result: JsonObject): void {
    this.send({ id, result });
  }

  cancelPrompt(): void {
    const sessionId = this.session.sessionId;
    if (sessionId) this.send({ method: "session/cancel", params: { sessionId } });
  }

  private send(message: JsonObject): void {
    if (this.failure) return;
    const stdin = this.session.child.stdin;
    try {
      if (!stdin.writable) throw new AcpConnectionClosed();
      stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    } catch {
      this.fail(new AcpConnectionClosed());
    }
  }

  private fail(reason: unknown): void {
    if (this.failure) return;
    this.failure = { reason };
    this.buffer = "";
    this.pending?.reject(reason);
    this.pending = undefined;
    this.onFailure();
  }

  private receive(text: string): void {
    if (this.failure) return;
    try {
      this.buffer += text;
      let offset = 0;
      for (let end = this.buffer.indexOf("\n"); end !== -1; end = this.buffer.indexOf("\n", offset)) {
        const line = this.buffer.slice(offset, end);
        this.checkLineSize(line);
        this.handleLine(line.trim());
        if (this.failure) return;
        offset = end + 1;
      }
      this.buffer = this.buffer.slice(offset);
      if (this.buffer.length > MAX_ACP_LINE_BYTES) this.checkLineSize(this.buffer);
    } catch (error) {
      this.fail(error);
    }
  }

  private checkLineSize(line: string): void {
    if (Buffer.byteLength(line) > MAX_ACP_LINE_BYTES) {
      throw new AdapterError("A CLI event exceeded the output limit.");
    }
  }

  private handleLine(line: string): void {
    if (!line.startsWith("{")) return;
    let message: JsonObject | undefined;
    try {
      message = asObject(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    if (typeof message.method === "string") {
      this.handleAgentMessage(line, message.method, message.id, asObject(message.params));
      return;
    }
    const pending = this.pending;
    if (!pending || pending.id !== message.id) return;
    this.pending = undefined;
    if (pending.method === "session/prompt") this.turn = undefined;
    if (message.error) pending.reject(new AcpRpcError(message.error));
    else pending.resolve({ result: asObject(message.result), line });
  }

  private handleAgentMessage(line: string, method: string, id: unknown, params: JsonObject | undefined): void {
    const matchesSession = params?.sessionId === undefined || params.sessionId === this.session.sessionId;
    if (id === undefined) {
      if (!matchesSession || method !== "session/update") return;
      const update = asObject(params?.update);
      if (!update) return;
      if (update.sessionUpdate === "config_option_update") updateConfigOptions(this.session, update.configOptions);
      else this.turn?.update(line, update);
      return;
    }
    if (typeof id !== "string" && typeof id !== "number" && id !== null) return;
    if (method === "session/request_permission") {
      if (matchesSession && this.session.sessionId && this.turn) this.turn.requestPermission(id, params);
      else this.respond(id, selectPermissionRejection(params));
      return;
    }
    this.send({ id, error: { code: -32601, message: "Method not supported in structured mode." } });
  }
}

interface PendingApproval {
  complete?: (decision: ApprovalDecision) => void;
}

function askForApproval(
  requestApproval: NonNullable<AdapterRequest["requestApproval"]>,
  prompt: AdapterApprovalPrompt,
  approval: PendingApproval,
): void {
  const complete = (decision: ApprovalDecision) => approval.complete?.(decision);
  try {
    void Promise.resolve(requestApproval(prompt)).then(complete, () => complete("reject"));
  } catch {
    complete("reject");
  }
}

class AcpTurn {
  private readonly tools = new Map<string, AcpToolCall>();
  private readonly pendingApprovals = new Map<RpcId, PendingApproval>();

  constructor(
    private readonly session: AcpSession,
    private readonly connection: AcpConnection,
    private readonly request: AdapterRequest,
  ) {}

  update(line: string, update: JsonObject): void {
    if (this.request.signal.aborted) return;
    const kind = update.sessionUpdate;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const { title, detail, name, reportedKind, ...meta } = this.rememberTool(update);
      const text = title ?? name ?? reportedKind?.replaceAll("_", " ") ?? "tool call";
      this.request.output.emit("tool", text, { ...meta, name: name ?? title ?? meta.kind, summary: meta.summary ?? detail ?? text });
    } else if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = asObject(update.content);
      if (content?.type === "text" && typeof content.text === "string" && content.text) {
        this.request.output.raw(line);
        this.request.output.emit(kind === "agent_message_chunk" ? "text" : "thinking", content.text);
      }
    }
  }

  requestPermission(id: RpcId, params: JsonObject | undefined): void {
    if (this.request.signal.aborted || !this.session.busy) {
      this.connection.respond(id, cancelledPermission);
      return;
    }
    if (this.session.accessMode === "isolated") {
      this.reply(id, params);
      return;
    }
    const tool = this.rememberTool(asObject(params?.toolCall) ?? {});
    const options = approvalOptions(params);
    const once = options.find((option) => option.kind === "allow_once")?.id;
    if (isReadTool(tool.kind)) {
      this.reply(id, params, once);
      return;
    }
    const toolName = tool.name ?? tool.title ?? tool.kind;
    const grantKey = JSON.stringify([tool.kind, normalizeToolName(toolName)]);
    const sessionOption = options.find((option) => option.kind === "allow_session")?.id;
    if (this.session.accessMode === "read-only") this.reply(id, params);
    else if (this.session.sessionAllowTools.has(grantKey)) this.reply(id, params, once ?? sessionOption);
    else if (this.request.requestApproval) this.requestInteractivePermission(id, params, tool, options, grantKey);
    else this.reply(id, params);
  }

  cancelApprovals(): void {
    for (const [id, approval] of this.pendingApprovals) {
      approval.complete = undefined;
      this.connection.respond(id, cancelledPermission);
    }
    this.pendingApprovals.clear();
  }

  private rememberTool(update: JsonObject): AcpToolCall {
    const id = firstText(update.toolCallId, update.id);
    const tool = describeTool(update, id, id ? this.tools.get(id) : undefined);
    if (id) this.tools.set(id, tool);
    return tool;
  }

  private reply(id: RpcId, params: JsonObject | undefined, optionId?: string): void {
    this.connection.respond(id, optionId ? permissionOutcome(optionId) : selectPermissionRejection(params));
  }

  private requestInteractivePermission(
    id: RpcId,
    params: JsonObject | undefined,
    tool: AcpToolCall,
    options: ApprovalOption[],
    grantKey: string,
  ): void {
    const requestApproval = this.request.requestApproval;
    if (!requestApproval || this.pendingApprovals.has(id)) return;
    const approval: PendingApproval = {};
    approval.complete = (decision) => {
      approval.complete = undefined;
      this.pendingApprovals.delete(id);
      if (!this.session.busy) return;
      const selected = decision === "allow_once" || decision === "allow_session"
        ? options.find((option) => option.kind === decision)?.id
        : undefined;
      if (selected && decision === "allow_session" && (tool.name || tool.title || tool.kind !== "other")) {
        this.session.sessionAllowTools.add(grantKey);
      }
      this.reply(id, params, selected);
    };
    this.pendingApprovals.set(id, approval);
    const toolName = tool.name ?? tool.title ?? tool.kind;
    askForApproval(requestApproval, {
      toolName, toolKind: tool.kind, title: tool.title ?? toolName, path: tool.path, command: tool.command,
      detail: tool.detail ?? tool.summary ?? firstText(params?.detail),
      options,
    }, approval);
  }
}

async function initializeSession(session: AcpSession, connection: AcpConnection): Promise<string> {
  await connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "uya", version: clientVersion },
  });
  const { result } = await connection.request("session/new", { cwd: session.cwd, mcpServers: [] });
  const sessionId = firstText(result?.sessionId);
  if (!sessionId) throw new AcpRpcError("ACP session missing sessionId.");
  session.sessionId = sessionId;
  const models = asObject(result?.models);
  session.availableModelIds = new Set(asArray(models?.availableModels).flatMap((entry) => {
    const model = asObject(entry);
    const id = firstText(entry, model?.modelId, model?.id);
    return id ? [id] : [];
  }));
  const currentModel = firstText(models?.currentModelId);
  if (currentModel && isSafeCliModelName(currentModel)) session.model = currentModel;
  updateConfigOptions(session, result?.configOptions);
  return sessionId;
}

async function configureModel(
  session: AcpSession, connection: AcpConnection, sessionId: string, model: string | undefined,
): Promise<void> {
  if (!model || model === session.model) return;
  const option = findModelOption(session.configOptions);
  const useConfig = option && (option.values.includes(model) || !session.availableModelIds.has(model));
  const { result } = useConfig
    ? await connection.request("session/set_config_option", { sessionId, configId: option.id, value: model })
    : await connection.request("session/set_model", { sessionId, modelId: model });
  session.model = model;
  if (useConfig) option.currentValue = model;
  updateConfigOptions(session, result?.configOptions);
}

async function configureEffort(
  session: AcpSession, connection: AcpConnection, sessionId: string, effort: EffortLevel | undefined,
): Promise<void> {
  const option = effort && findEffortOption(session.configOptions);
  if (!option) return;
  const value = resolveAcpEffortValue(effort, option.values);
  if (!value || value === session.effort) return;
  const { result } = await connection.request("session/set_config_option", { sessionId, configId: option.id, value });
  session.effort = value;
  option.currentValue = value;
  updateConfigOptions(session, result?.configOptions);
}

function readUsage(session: AcpSession, result: JsonObject | undefined): Usage {
  const usage: Usage = { providerSessionId: session.sessionId };
  if (session.model) usage.model = session.model;
  const stats = asObject(result?.usage);
  if (stats) {
    usage.inputTokens = tokenCount(stats.inputTokens ?? stats.input_tokens);
    const cached = tokenCount(stats.cachedInputTokens ?? stats.cached_input_tokens ?? stats.cacheReadInputTokens);
    if (cached !== undefined) usage.cachedInputTokens = cached;
    usage.outputTokens = tokenCount(stats.outputTokens ?? stats.output_tokens);
  }
  return usage;
}

async function promptSession(
  session: AcpSession, connection: AcpConnection, request: AdapterRequest, encode?: AcpRunOptions["encode"],
): Promise<Usage> {
  const priorSessionId = session.sessionId;
  const sessionId = priorSessionId ?? await initializeSession(session, connection);
  await configureModel(session, connection, sessionId, request.model);
  await configureEffort(session, connection, sessionId, normalizeEffortLevel(request.effort));
  request.signal.throwIfAborted();
  const prompt = priorSessionId ? request.prompt : promptForCli(request.prompt, request.messages);
  const reply = await connection.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: encode ? encode(prompt) : prompt }],
  });
  request.signal.throwIfAborted();
  if (reply.result?.stopReason === "cancelled") throw new AcpRpcError("The run was cancelled by the provider.");
  request.output.raw(reply.line);
  return readUsage(session, reply.result);
}

async function runTurn(
  session: AcpSession, connection: AcpConnection, request: AdapterRequest, options: AcpRunOptions, pool: AcpSessionPool,
): Promise<Usage> {
  const turn = new AcpTurn(session, connection, request);
  const onAbort = () => {
    turn.cancelApprovals();
    connection.cancelPrompt();
    void pool.invalidate(session, true);
  };
  connection.turn = turn;
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    request.signal.throwIfAborted();
    return await promptSession(session, connection, request, options.encode);
  } finally {
    connection.turn = undefined;
    request.signal.removeEventListener("abort", onAbort);
    turn.cancelApprovals();
  }
}

const sharedPool = new AcpSessionPool();
const connections = new WeakMap<AcpSession, AcpConnection>();

export function closeAcpConversation(conversationKey: string): Promise<void> {
  return sharedPool.closeConversation(conversationKey);
}

export function shutdownAcpSessions(): Promise<void> {
  return sharedPool.closeAll();
}

async function throwRunError(
  error: unknown, session: AcpSession, request: AdapterRequest, options: AcpRunOptions, pool: AcpSessionPool,
): Promise<never> {
  await pool.invalidate(session, request.signal.aborted);
  request.signal.throwIfAborted();
  if (!(error instanceof AcpConnectionClosed || error instanceof AcpRpcError)) throw error;
  const code = await session.closed;
  const detail = error instanceof AcpRpcError ? extractErrorText(error.detail) : undefined;
  const rpcDiagnostic = detail && classifyCliDiagnostic(detail, options.args)?.message;
  const diagnostic = rpcDiagnostic ?? (await connections.get(session)?.diagnostic)?.message;
  const fallback = error instanceof AcpConnectionClosed && code === 0
    ? request.provider.name + " did not return a complete structured response."
    : options.fallbackError;
  throw new AdapterError(diagnostic ?? fallback, code ?? undefined);
}

export async function runAcpCli(request: AdapterRequest, options: AcpRunOptions): Promise<Usage> {
  const { provider, model, signal } = request;
  const executable = options.command ?? provider.command;
  if (!executable) throw new AdapterError("This provider has no executable for structured runs.");
  if (model && !isSafeCliModelName(model)) throw new AdapterError("Invalid model name.");
  signal.throwIfAborted();

  const pool = options.pool ?? sharedPool;
  const session = pool.acquire({
    providerId: provider.id,
    conversationKey: request.conversationKey,
    cwd: request.workingDirectory ?? request.workspacePath,
    accessMode: normalizeExecutionMode(request.accessMode) ?? "isolated",
  }, (cwd) => {
    const target = spawnTarget(executable, options.args);
    return spawn(target.command, target.args, {
      cwd, env: cliEnv(options.env), detached: process.platform !== "win32",
      shell: target.shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
  });

  try {
    let connection = connections.get(session);
    if (!connection) {
      connection = new AcpConnection(session, options.args, () => void pool.invalidate(session));
      connections.set(session, connection);
    }
    const usage = await runTurn(session, connection, request, options, pool);
    signal.throwIfAborted();
    await pool.release(session);
    if (session.key === undefined) signal.throwIfAborted();
    return usage;
  } catch (error) {
    return throwRunError(error, session, request, options, pool);
  }
}
