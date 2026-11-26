import type { ExecutionMode, ToolKind, ToolMeta } from "@ide/protocol";
import { lstatSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { runAcpCli } from "./acp-runner";
import { CliResponseError, type CliPrepare } from "./agents";
import { claudeIsolationArgs, mcpServersForMode } from "./claude";
import { classifyCliDiagnostic } from "./cli-diagnostics";
import { isSafeCliModelName } from "./cli-models";
import { customCliCommand, customStructuredBlockReason } from "./custom-cli";
import { buildGeminiInteractionBody, geminiCliInvocation, geminiHasUnmanagedSettings } from "./gemini";
import { AdapterError, normalizeEffortLevel, type AdapterOutput, type AdapterRequest, type Usage } from "./provider-adapter";

const codexFeatureArgs = [
  "-c", "features.hooks=false",
  "-c", "features.apps=false",
  "-c", "features.plugins=false",
];

const qwenArgs = [
  "--safe-mode", "--max-tool-calls", "0", "--input-format", "text",
  "--output-format", "stream-json", "--include-partial-messages",
];

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function collectTokenUsage(usage: Usage, input: unknown, output: unknown, cached: number | undefined): void {
  usage.inputTokens = tokenCount(input);
  usage.outputTokens = tokenCount(output);
  if (cached !== undefined) usage.cachedInputTokens = cached;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseLine(line: string): JsonObject {
  try {
    return record(JSON.parse(line));
  } catch {
    return {};
  }
}

const toolKinds: Readonly<Record<string, ToolKind>> = {
  bash: "shell", command_execution: "shell", run_shell_command: "shell", shell: "shell",
  read: "read", read_file: "read", ls: "read", list: "read", list_directory: "read",
  glob: "search", grep: "search", grep_search: "search", search_file_content: "search",
  search: "search", websearch: "search", web_search: "search",
  edit: "edit", multiedit: "edit", notebookedit: "edit", file_change: "edit", replace: "edit",
  write: "write", write_file: "write",
  webfetch: "fetch", web_fetch: "fetch", fetch: "fetch",
};

function toolKind(name: string): ToolKind {
  const key = name.toLowerCase();
  return Object.hasOwn(toolKinds, key) ? toolKinds[key] : "other";
}

function toolPath(input: JsonObject): string | undefined {
  return stringValue(input.file_path) ?? stringValue(input.path) ?? stringValue(input.dir_path);
}

const MAX_TOOL_OUTPUT = 2_000;

function truncateToolOutput(output: string | undefined): string | undefined {
  if (!output || output.length <= MAX_TOOL_OUTPUT) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function extractCodexText(item: JsonObject): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return undefined;
  const parts: string[] = [];
  for (const part of item.content) {
    const block = record(part);
    if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length ? parts.join("") : undefined;
}

function codexTextKind(eventType: unknown, itemType: unknown): "text" | "thinking" | undefined {
  if (eventType === "reasoning_delta" || itemType === "reasoning") return "thinking";
  if (eventType === "agent_message_delta" || itemType === "agent_message") return "text";
  if (eventType === "item.delta" && itemType === undefined) return "text";
}

function codexTextEmitter(output: AdapterOutput) {
  const streamedIds = new Set<string>();
  const anonymousStreams = new Set<"text" | "thinking">();
  let hasEmittedText = false;
  return (event: JsonObject, item: JsonObject, itemId: string | undefined, line: string) => {
    const kind = codexTextKind(event.type, item.type);
    if (!kind) return;
    if (event.type === "item.started") {
      if (!itemId) anonymousStreams.delete(kind);
      return;
    }

    const completed = event.type === "item.completed";
    const continuing = itemId ? streamedIds.has(itemId) : anonymousStreams.has(kind);
    if (completed && !itemId) anonymousStreams.delete(kind);
    if (completed && continuing) return;

    const text = completed ? extractCodexText(item) : stringValue(event.delta) ?? stringValue(item.delta);
    if (!text) return;
    if (!completed) {
      if (itemId) streamedIds.add(itemId);
      else anonymousStreams.add(kind);
    }
    output.raw(line);
    if (kind === "text") {
      // A completed item can contain just the punctuation ending the previous sentence.
      const punctuation = completed && /^[.!?…。！？]+$/u.test(text);
      if (!continuing && hasEmittedText && !punctuation) output.emit("text", "\n\n");
      hasEmittedText = true;
    }
    output.emit(kind, text);
  };
}

function codexToolMeta(item: JsonObject, id: string | undefined, completed: boolean): ToolMeta | undefined {
  const type = stringValue(item.type);
  if (!type || (!type.endsWith("_call") && !["command_execution", "file_change", "web_search"].includes(type))) return;
  const name = stringValue(item.tool) ?? stringValue(item.name) ?? type;
  const input = record(item.arguments ?? item.input);
  const change = Array.isArray(item.changes) ? record(item.changes[0]) : {};
  const path = toolPath(item) ?? stringValue(change.path) ?? toolPath(input);
  const command = stringValue(item.command) ?? stringValue(input.command);
  const failed = item.status === "failed" || item.status === "error" || item.status === "declined"
    || Boolean(item.error) || (typeof item.exit_code === "number" && item.exit_code !== 0);
  const result = stringValue(item.aggregated_output) ?? stringValue(item.output) ?? stringValue(item.result)
    ?? extractCodexText(record(item.result)) ?? stringValue(record(item.error).message) ?? stringValue(item.error);
  return {
    id, name, path, command,
    kind: type === "command_execution" || type === "file_change" ? toolKind(type) : toolKind(name),
    status: completed ? (failed ? "error" : "done") : "running",
    summary: stringValue(item.summary) ?? stringValue(item.query) ?? command ?? path,
    output: truncateToolOutput(result),
  };
}

function codexParser(output: AdapterOutput, usage: Usage, args: readonly string[]) {
  const emitText = codexTextEmitter(output);
  return (line: string): boolean => {
    const event = parseLine(line);
    if (typeof event.model === "string" && isSafeCliModelName(event.model)) {
      usage.model ??= event.model;
    }
    if (event.type === "thread.started" || event.type === "session.created") {
      const sessionId = stringValue(event.thread_id) ?? stringValue(event.session_id);
      if (sessionId) usage.providerSessionId = sessionId;
    } else if (event.type === "turn.completed") {
      output.raw(line);
      const counts = record(event.usage);
      collectTokenUsage(usage, counts.input_tokens, counts.output_tokens, tokenCount(counts.cached_input_tokens));
      return true;
    } else if (event.type === "turn.failed" || event.type === "error") {
      const error = record(event.error);
      const rawMessage = typeof error.message === "string"
        ? error.message
        : typeof event.message === "string" ? event.message : undefined;
      throw new CliResponseError(
        "Codex could not complete this run. Check the CLI in Terminal.",
        rawMessage ? classifyCliDiagnostic(rawMessage, args)?.message : undefined,
      );
    } else if (event.type === "item.delta" || event.type === "agent_message_delta" || event.type === "reasoning_delta"
      || event.type === "item.started" || event.type === "item.completed") {
      const item = record(event.item);
      const itemId = stringValue(item.id) ?? stringValue(event.item_id);
      emitText(event, item, itemId, line);
      if (event.type === "item.started" || event.type === "item.completed") {
        const meta = codexToolMeta(item, itemId, event.type === "item.completed");
        if (meta) output.emit("tool", meta.summary ?? meta.name.replaceAll("_", " "), meta);
      }
    }
    return false;
  };
}

function messageToolEmitter(output: AdapterOutput) {
  const emitted = new Set<string>();
  return (block: JsonObject) => {
    if (block.type !== "tool_use") return;
    const id = stringValue(block.id);
    if (id && emitted.has(id)) return;
    if (id) emitted.add(id);
    const name = stringValue(block.name) ?? "tool call";
    const input = record(block.input);
    const path = toolPath(input);
    const command = stringValue(input.command);
    const summary = stringValue(input.description) ?? command ?? path;
    output.emit("tool", summary ?? name, { id, name, kind: toolKind(name), status: "running", path, command, summary });
  };
}

function messageStreamError(event: JsonObject, name: string, args: readonly string[], assistantError?: string) {
  const errors: unknown[] = Array.isArray(event.errors) ? event.errors : [];
  const diagnostic = [...errors, event.result, assistantError]
    .filter((error): error is string => typeof error === "string")
    .map((error) => classifyCliDiagnostic(error, args))
    .find(Boolean);
  return new CliResponseError(`${name} could not complete this run. Check the CLI in Terminal.`, diagnostic?.message);
}

function emitMessageDelta(stream: JsonObject, output: AdapterOutput, line: string, emitTool: (block: JsonObject) => void): boolean {
  const delta = record(stream.delta);
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    output.raw(line);
    output.emit("text", delta.text);
    return delta.text.length > 0;
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    output.raw(line);
    output.emit("thinking", delta.thinking);
  } else {
    emitTool(record(stream.content_block));
  }
  return false;
}

function messageStreamParser(name: string, output: AdapterOutput, usage: Usage, args: readonly string[]) {
  let streamedText = false;
  let emittedAssistantText = false;
  let assistantError: string | undefined;
  const emitTool = messageToolEmitter(output);
  return (line: string): boolean => {
    const event = parseLine(line);
    if (event.type === "system" || event.type === "result") {
      const sessionId = stringValue(event.session_id);
      if (sessionId) usage.providerSessionId = sessionId;
    }
    if (event.type === "system" && typeof event.model === "string" && isSafeCliModelName(event.model)) {
      usage.model ??= event.model;
    } else if (event.type === "stream_event") {
      streamedText = emitMessageDelta(record(event.event), output, line, emitTool) || streamedText;
    } else if (event.type === "assistant") {
      const content = record(event.message).content;
      const texts: string[] = [];
      if (Array.isArray(content)) {
        for (const part of content) {
          const block = record(part);
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
          else if (!event.error) emitTool(block);
        }
      }
      if (event.error) {
        assistantError = texts.join("\n") || String(event.error);
      } else if (!streamedText) {
        for (const text of texts) {
          emittedAssistantText ||= text.length > 0;
          output.emit("text", text);
        }
      }
    } else if (event.type === "result") {
      if (event.is_error === true || event.subtype !== "success") {
        throw messageStreamError(event, name, args, assistantError);
      }
      if (!streamedText && !emittedAssistantText && typeof event.result === "string" && event.result) {
        output.emit("text", event.result);
      }
      output.raw(line);
      const counts = record(event.usage);
      collectTokenUsage(usage, counts.input_tokens, counts.output_tokens, tokenCount(counts.cache_read_input_tokens));
      return true;
    }
    return false;
  };
}

function geminiCachedTokens(stats: JsonObject): number | undefined {
  return tokenCount(stats.total_cached_tokens) ?? tokenCount(stats.cached_content_token_count)
    ?? tokenCount(stats.cached_tokens) ?? tokenCount(stats.cached);
}

function geminiCliParser(output: AdapterOutput, usage: Usage, args: readonly string[]) {
  let streamed = false;
  return (line: string) => {
    const event = parseLine(line);
    if (event.type === "init" && typeof event.model === "string" && isSafeCliModelName(event.model)) {
      usage.model ??= event.model;
    } else if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      if (event.delta !== true && streamed) return false;
      streamed ||= event.delta === true;
      output.raw(JSON.stringify({ type: "text", text: event.content }));
      output.emit("text", event.content);
    } else if (event.type === "thought" && typeof event.content === "string") {
      output.raw(JSON.stringify({ type: "thinking", text: event.content }));
      output.emit("thinking", event.content);
    } else if (event.type === "error") {
      const error = record(event.error);
      const message = typeof error.message === "string"
        ? error.message
        : typeof event.message === "string" ? event.message : undefined;
      throw new CliResponseError(
        "Gemini CLI could not complete this run. Check the CLI in Terminal.",
        message ? classifyCliDiagnostic(message, args)?.message : undefined,
      );
    } else if (event.type === "result") {
      if (event.status !== "success") {
        const error = record(event.error);
        throw new CliResponseError(
          "Gemini CLI could not complete this run. Check the CLI in Terminal.",
          typeof error.message === "string" ? classifyCliDiagnostic(error.message, args)?.message : undefined,
        );
      }
      const stats = record(event.stats);
      collectTokenUsage(usage, stats.input_tokens, stats.output_tokens, geminiCachedTokens(stats));
      return true;
    }
    return false;
  };
}

function geminiApiErrorText(error: JsonObject, fallback?: string): string | undefined {
  const code = stringValue(error.code)?.trim();
  const message = stringValue(error.message)?.trim() || fallback;
  return [code, message].filter(Boolean).join(": ") || undefined;
}

function emitGeminiApiDelta(delta: JsonObject, output: AdapterOutput, line: string): void {
  if (delta.type === "text" && typeof delta.text === "string") {
    output.raw(line);
    output.emit("text", delta.text);
  } else if (delta.type === "thought_summary") {
    const content = record(delta.content);
    const text = typeof content.text === "string" ? content.text : stringValue(delta.text);
    if (text) {
      output.raw(line);
      output.emit("thinking", text);
    }
  } else if (typeof delta.type === "string" && delta.type.endsWith("_call")) {
    output.emit("tool", delta.type.replaceAll("_", " "));
  }
}

function geminiApiParser(output: AdapterOutput, usage: Usage, args: readonly string[]) {
  return (line: string) => {
    const outer = parseLine(line);
    const event = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data)
      ? record(outer.data)
      : outer;
    const eventType = event.event_type;

    if (eventType === "step.delta") {
      emitGeminiApiDelta(record(event.delta), output, line);
    } else if (eventType === "error") {
      const message = geminiApiErrorText(record(event.error), stringValue(event.message));
      throw new CliResponseError(
        "Gemini API could not complete this run. Check authentication (gemini-api whoami / configure).",
        message ? classifyCliDiagnostic(message, args)?.message : undefined,
      );
    } else if (eventType === "interaction.created" || eventType === "interaction.completed") {
      const interaction = record(event.interaction);
      if (typeof interaction.model === "string" && isSafeCliModelName(interaction.model)) {
        usage.model ??= interaction.model;
      }
      if (eventType === "interaction.created") return false;
      const status = typeof interaction.status === "string" ? interaction.status : "completed";
      if (status === "failed" || status === "cancelled" || status === "budget_exceeded") {
        const message = geminiApiErrorText(record(interaction.error), status);
        throw new CliResponseError(
          "Gemini API could not complete this run. Check authentication and limits in Terminal.",
          message ? classifyCliDiagnostic(message, args)?.message : undefined,
        );
      }
      output.raw(line);
      const stats = record(interaction.usage);
      collectTokenUsage(usage, stats.total_input_tokens ?? stats.input_tokens,
        stats.total_output_tokens ?? stats.output_tokens, geminiCachedTokens(stats));
      return true;
    }
    return false;
  };
}

function openCodeParser(output: AdapterOutput, usage: Usage, args: readonly string[]) {
  let stepComplete = false;
  return (line: string) => {
    const event = parseLine(line);
    const part = record(event.part);
    if (event.type === "step_start") stepComplete = false;
    if ((event.type === "text" || event.type === "reasoning") && typeof part.text === "string") {
      output.raw(JSON.stringify({ type: event.type, text: part.text }));
      output.emit(event.type === "text" ? "text" : "thinking", part.text);
    } else if (event.type === "step_finish") {
      const tokens = record(part.tokens);
      const input = tokenCount(tokens.input);
      const outputCount = tokenCount(tokens.output);
      if (input !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + input;
      if (outputCount !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + outputCount;
      stepComplete = true;
    } else if (event.type === "error") {
      const error = record(event.error);
      const message = record(error.data).message;
      throw new CliResponseError("OpenCode could not complete this run. Check the CLI in Terminal.",
        typeof message === "string" ? classifyCliDiagnostic(message, args)?.message : undefined);
    }
    return stepComplete;
  };
}

function modelArgs({ model }: AdapterRequest) {
  if (!model) return [];
  if (!isSafeCliModelName(model)) throw new AdapterError("Invalid model name.");
  return ["--model", model];
}

function literalPrompt(prompt: string) {
  // These CLIs also read @paths and interpret certain leading slash commands.
  const json = JSON.stringify(prompt).replaceAll("@", "\\u0040");
  return `Answer the user request below. It is encoded as a JSON string, so interpret JSON escapes as literal user text.\n\n${json}`;
}

function cliAccess({ accessMode = "isolated", workingDirectory, workspacePath }: AdapterRequest): {
  mode: ExecutionMode; cwd?: string;
} {
  const cwd = accessMode === "isolated" ? undefined : workingDirectory ?? workspacePath;
  return cwd ? { mode: accessMode, cwd } : { mode: "isolated" };
}

function safeSessionId(id: string | undefined): string | undefined {
  return id && !id.startsWith("-") && /^[A-Za-z0-9_-]{4,128}$/.test(id) ? id : undefined;
}

export const prepareCodex: CliPrepare = (request, _cwd, usage) => {
  const { mode, cwd } = cliAccess(request);
  const sessionId = cwd ? safeSessionId(request.providerSessionId) : undefined;
  const effort = normalizeEffortLevel(request.effort);
  const level = effort === "minimal" ? "low" : effort;
  // TOML also accepts single quotes, which Windows command shims can pass through.
  const shim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(request.provider.command ?? "");
  const tomlString = (value: string): string => {
    if (!shim) return JSON.stringify(value).replaceAll("\x7f", "\\u007f");
    if (/'''|[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new AdapterError("The MCP command or argument cannot be passed through a Codex Windows command shim.");
    }
    const quote = value.includes("'") ? "'''" : "'";
    return `${quote}${value}${quote}`;
  };
  const activeMcpServers = mcpServersForMode(mode, request.mcpServers);
  const mcpArgs = activeMcpServers.flatMap(({ name, command, args }) => [
    "-c", `mcp_servers.${name}.command=${tomlString(command)}`,
    "-c", `mcp_servers.${name}.args=[${args.map(tomlString).join(",")}]`,
  ]);
  const sandbox = ["--sandbox", mode === "agent" ? "workspace-write" : "read-only", ...(cwd ? ["-C", cwd] : [])];
  // Codex's resume subcommand accepts JSON output but takes sandbox and cwd from its parent.
  const exec = sessionId
    ? [...sandbox, "exec", "resume", sessionId, "--json"]
    : ["exec", "--json", ...sandbox];
  const args = [
    ...modelArgs(request), "--ask-for-approval", "never",
    ...(mode === "isolated" ? ["--disable", "shell_tool"] : []),
    ...codexFeatureArgs, "-c", `web_search=${tomlString("disabled")}`,
    ...(level ? ["-c", `model_reasoning_effort=${tomlString(level)}`] : []),
    ...mcpArgs,
    ...exec, "--skip-git-repo-check",
    ...(!cwd || !request.conversationKey ? ["--ephemeral"] : []),
    "--ignore-user-config", "--ignore-rules", "-",
  ];
  return {
    args, cwd, useSingleTurnPrompt: Boolean(sessionId),
    parse: codexParser(request.output, usage, args),
  };
};

export const prepareClaude: CliPrepare = async (request, scratchDir, usage) => {
  const { mode, cwd } = cliAccess(request);
  const sessionId = cwd ? safeSessionId(request.providerSessionId) : undefined;
  const isolationArgs = await claudeIsolationArgs(scratchDir, mode, request.mcpServers);
  const accessArgs = cwd && request.conversationKey
    ? isolationArgs.filter((arg) => arg !== "--no-session-persistence")
    : isolationArgs;
  let effort = normalizeEffortLevel(request.effort);
  if (effort === "minimal") effort = "low";
  if (effort === "xhigh") effort = "high";
  const args = [
    ...modelArgs(request), ...(effort ? ["--effort", effort] : []),
    "-p", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", ...accessArgs,
    ...(sessionId ? ["--resume", sessionId] : []),
  ];
  return {
    args, cwd, configDir: scratchDir, useSingleTurnPrompt: Boolean(sessionId),
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    parse: messageStreamParser(request.provider.name, request.output, usage, args),
  };
};

export const prepareQwen: CliPrepare = async (request, cwd, usage) => {
  const args = [...modelArgs(request), ...qwenArgs];
  const invocation = {
    args,
    encode: literalPrompt,
    parse: messageStreamParser(request.provider.name, request.output, usage, args),
  };
  const effort = normalizeEffortLevel(request.effort);
  if (!effort || !request.provider.supportedEfforts?.includes(effort)) return invocation;

  // Qwen's headless CLI reads the effort from workspace settings. Trust only
  // the scratch directory created for this run and keep safe mode enabled.
  const settingsDir = join(cwd, ".qwen");
  const trustPath = join(cwd, "qwen-trusted-folders.json");
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(settingsDir, "settings.json"), JSON.stringify({
      model: { reasoningEffort: effort === "minimal" ? "low" : effort },
    }), { mode: 0o600 }),
    writeFile(trustPath, JSON.stringify({ [cwd]: "TRUST_FOLDER" }), { mode: 0o600 }),
  ]);
  return { ...invocation, env: { QWEN_CODE_TRUSTED_FOLDERS_PATH: trustPath } };
};

export function geminiBlocked() {
  return geminiHasUnmanagedSettings() ? undefined : "System-managed Gemini settings use the interactive terminal.";
}

export const prepareGeminiCli: CliPrepare = async (request, scratchDir, usage) => {
  const { mode, cwd } = cliAccess(request);
  const invocation = await geminiCliInvocation(scratchDir, "stream-json", request.effort, mode, request.mcpServers);
  const args = [...modelArgs(request), ...invocation.args];
  return {
    args, cwd, configDir: scratchDir,
    encode: literalPrompt,
    env: {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: invocation.settingsPath,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    },
    parse: geminiCliParser(request.output, usage, args),
  };
};

export const prepareGeminiApi: CliPrepare = (request, _cwd, usage) => {
  const args = ["generate", "--no-interactive", "-o", "json", ...modelArgs(request)];
  return {
    args,
    stdin: JSON.stringify(buildGeminiInteractionBody(request)),
    parse: geminiApiParser(request.output, usage, args),
  };
};

export async function runAntigravity(request: AdapterRequest): Promise<Usage> {
  const { providerSessionId, cachedInputTokens, ...usage } = await runAcpCli(request, {
    args: ["acp", "--sandbox", "--disable-telemetry"],
    encode: literalPrompt,
    fallbackError: "Antigravity could not complete this run. Check your Google sign-in in Terminal (`agy`).",
  });
  // One-shot ACP sessions are disposed at the end of the run.
  return {
    ...usage,
    ...(request.conversationKey && providerSessionId ? { providerSessionId } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

function mayExist(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

export function openCodeBlocked() {
  const notice = "System or legacy OpenCode configuration is available in the interactive terminal.";
  if (process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR) return notice;

  const managed = process.platform === "darwin" ? "/Library/Application Support/opencode"
    : process.platform === "win32" ? join(process.env.ProgramData || "C:\\ProgramData", "opencode")
    : process.platform === "linux" ? "/etc/opencode" : undefined;
  if (!managed) return notice;
  const paths = [join(homedir(), ".opencode"), join(managed, "opencode.json"), join(managed, "opencode.jsonc")];
  if (process.platform === "darwin") {
    // OpenCode loads these after the inline config. Refuse their presence without reading them.
    let username: string;
    try {
      username = userInfo().username;
    } catch {
      return notice;
    }
    const preferences = "/Library/Managed Preferences";
    paths.push(join(preferences, "ai.opencode.managed.plist"), join(preferences, username, "ai.opencode.managed.plist"));
  }
  if (paths.some(mayExist)) return notice;
}

export const prepareOpenCode: CliPrepare = (request, scratchDir, usage) => {
  const { mode, cwd } = cliAccess(request);
  const activeMcpServers = mcpServersForMode(mode, request.mcpServers);
  // OpenCode uses the last matching rule, so list the default before the exceptions.
  const permission = {
    "*": "deny",
    ...(mode !== "isolated" ? { read: "allow", glob: "allow", grep: "allow", list: "allow" } : {}),
    ...(mode === "agent" ? { edit: "allow", write: "allow" } : {}),
    ...Object.fromEntries(activeMcpServers.map(({ name }) => [`${name}_*`, "allow"])),
  };
  const agent = `uya-structured-${crypto.randomUUID()}`;
  const variant = normalizeEffortLevel(request.effort);
  const args = [
    "--pure", "run", "--format", "json", "--thinking", "--agent", agent, "--title", "Uya run",
    ...modelArgs(request), ...(variant ? ["--variant", variant] : []),
  ];
  return {
    args, cwd, configDir: scratchDir,
    parse: openCodeParser(request.output, usage, args),
    env: {
      XDG_CONFIG_HOME: scratchDir,
      XDG_DATA_HOME: scratchDir,
      XDG_STATE_HOME: scratchDir,
      XDG_CACHE_HOME: scratchDir,
      TMPDIR: scratchDir,
      OPENCODE_CONFIG_DIR: scratchDir,
      OPENCODE_CONFIG: undefined,
      OPENCODE_TEST_HOME: undefined,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DB: ":memory:",
      // Saved authorizations can include well-known remote configuration loaders.
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_PERMISSION: JSON.stringify(permission),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        share: "disabled",
        permission,
        agent: { [agent]: { mode: "primary", permission, variant } },
        ...(activeMcpServers.length ? {
          mcp: Object.fromEntries(activeMcpServers.map(({ name, command, args, env }) => [
            name, { type: "local", command: [command, ...args], enabled: true, ...(env ? { environment: env } : {}) },
          ])),
        } : {}),
      }),
    },
  };
};

export const prepareCustomCli: CliPrepare = async ({ provider }, cwd) => {
  if (!provider.command || provider.structuredArgs === undefined) {
    throw new AdapterError("This Custom CLI is not configured for Structured runs.");
  }
  const reason = customStructuredBlockReason();
  if (reason) throw new AdapterError(reason);
  return {
    ...await customCliCommand(provider.command, provider.structuredArgs, cwd),
    replaceEnv: true,
    diagnosticArgs: [],
  };
};
