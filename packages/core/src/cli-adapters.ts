import { lstatSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { CliResponseError, type CliPrepare } from "./agents";
import { claudeIsolationArgs } from "./claude";
import { classifyCliDiagnostic } from "./cli-diagnostics";
import { isSafeCliModelName } from "./cli-models";
import { customCliCommand, customStructuredBlockReason } from "./custom-cli";
import { buildGeminiInteractionBody } from "./gemini";
import { AdapterError, normalizeEffortLevel, type AdapterOutput, type AdapterRequest, type Usage } from "./provider-adapter";

const codexGlobalArgs = [
  "--ask-for-approval", "never",
  "--disable", "shell_tool",
  "-c", "features.hooks=false",
  "-c", "features.apps=false",
  "-c", "features.plugins=false",
];

const codexExecArgs = [
  "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check",
  "--ephemeral", "--ignore-user-config", "--ignore-rules", "-",
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

function parseLine(line: string): JsonObject {
  try {
    return record(JSON.parse(line));
  } catch {
    return {};
  }
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

function codexParser(output: AdapterOutput, usage: Usage, args: readonly string[]) {
  const streamedIds = new Set<string>();
  return (line: string): boolean => {
    const event = parseLine(line);
    if (typeof event.model === "string" && isSafeCliModelName(event.model)) {
      usage.model ??= event.model;
    }
    const item = record(event.item);
    const itemId = typeof item.id === "string" ? item.id : typeof event.item_id === "string" ? event.item_id : undefined;

    if (event.type === "item.delta" || event.type === "agent_message_delta" || event.type === "reasoning_delta") {
      const delta = typeof event.delta === "string" ? event.delta : typeof item.delta === "string" ? item.delta : undefined;
      if (delta) {
        const isThinking = event.type === "reasoning_delta" || item.type === "reasoning";
        if (itemId) streamedIds.add(itemId);
        output.raw(line);
        output.emit(isThinking ? "thinking" : "text", delta);
      }
    } else if (event.type === "item.completed") {
      if (item.type === "agent_message" || item.type === "reasoning") {
        const text = extractCodexText(item);
        if (text && (!itemId || !streamedIds.has(itemId))) {
          output.raw(line);
          output.emit(item.type === "agent_message" ? "text" : "thinking", text);
        }
      }
    } else if (event.type === "item.started" && typeof item.type === "string" && item.type.endsWith("_call")) {
      output.emit("tool", item.type.replaceAll("_", " "));
    } else if (event.type === "turn.completed") {
      output.raw(line);
      const counts = record(event.usage);
      usage.inputTokens = tokenCount(counts.input_tokens);
      usage.outputTokens = tokenCount(counts.output_tokens);
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
    }
    return false;
  };
}

function messageStreamParser(name: string, output: AdapterOutput, usage: Usage, args: readonly string[]) {
  let streamedText = false;
  let emittedAssistantText = false;
  let assistantError: string | undefined;
  return (line: string): boolean => {
    const event = parseLine(line);
    if (event.type === "system" && typeof event.model === "string" && isSafeCliModelName(event.model)) {
      usage.model ??= event.model;
    } else if (event.type === "stream_event") {
      const stream = record(event.event);
      const delta = record(stream.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        streamedText ||= delta.text.length > 0;
        output.raw(line);
        output.emit("text", delta.text);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        output.raw(line);
        output.emit("thinking", delta.thinking);
      } else {
        const block = record(stream.content_block);
        if (block.type === "tool_use") output.emit("tool", "tool call");
      }
    } else if (event.type === "assistant") {
      const content = record(event.message).content;
      const texts: string[] = [];
      if (Array.isArray(content)) {
        for (const part of content) {
          const block = record(part);
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
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
        const candidates: string[] = [];
        if (Array.isArray(event.errors)) {
          for (const item of event.errors) if (typeof item === "string") candidates.push(item);
        }
        if (typeof event.result === "string") candidates.push(event.result);
        if (assistantError) candidates.push(assistantError);
        const diagnostic = candidates
          .map((error) => classifyCliDiagnostic(error, args))
          .find(Boolean);
        throw new CliResponseError(`${name} could not complete this run. Check the CLI in Terminal.`, diagnostic?.message);
      }
      if (!streamedText && !emittedAssistantText && typeof event.result === "string" && event.result) {
        output.emit("text", event.result);
      }
      output.raw(line);
      const counts = record(event.usage);
      usage.inputTokens = tokenCount(counts.input_tokens);
      usage.outputTokens = tokenCount(counts.output_tokens);
      return true;
    }
    return false;
  };
}

function geminiApiParser(output: AdapterOutput, usage: Usage, args: readonly string[]) {
  return (line: string) => {
    const outer = parseLine(line);
    const event = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data)
      ? record(outer.data)
      : outer;
    const eventType = event.event_type;

    if (eventType === "interaction.created") {
      const interaction = record(event.interaction);
      if (typeof interaction.model === "string" && isSafeCliModelName(interaction.model)) {
        usage.model ??= interaction.model;
      }
    } else if (eventType === "step.delta") {
      const delta = record(event.delta);
      if (delta.type === "text" && typeof delta.text === "string") {
        output.raw(line);
        output.emit("text", delta.text);
      } else if (delta.type === "thought_summary") {
        const content = record(delta.content);
        const text = typeof content.text === "string"
          ? content.text
          : typeof delta.text === "string" ? delta.text : undefined;
        if (text) {
          output.raw(line);
          output.emit("thinking", text);
        }
      } else if (typeof delta.type === "string" && delta.type.endsWith("_call")) {
        output.emit("tool", delta.type.replaceAll("_", " "));
      }
    } else if (eventType === "error") {
      const error = record(event.error);
      const message = typeof error.message === "string"
        ? error.message
        : typeof event.message === "string" ? event.message : undefined;
      throw new CliResponseError(
        "Gemini API could not complete this run. Check authentication (gemini-api whoami / configure).",
        message ? classifyCliDiagnostic(message, args)?.message : undefined,
      );
    } else if (eventType === "interaction.completed") {
      const interaction = record(event.interaction);
      if (typeof interaction.model === "string" && isSafeCliModelName(interaction.model)) {
        usage.model ??= interaction.model;
      }
      const status = typeof interaction.status === "string" ? interaction.status : "completed";
      if (status === "failed" || status === "cancelled" || status === "budget_exceeded") {
        const error = record(interaction.error);
        const message = typeof error.message === "string" ? error.message : status;
        throw new CliResponseError(
          "Gemini API could not complete this run. Check authentication and limits in Terminal.",
          classifyCliDiagnostic(message, args)?.message,
        );
      }
      output.raw(line);
      const stats = record(interaction.usage);
      usage.inputTokens = tokenCount(stats.total_input_tokens ?? stats.input_tokens);
      usage.outputTokens = tokenCount(stats.total_output_tokens ?? stats.output_tokens);
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

export const prepareCodex: CliPrepare = (request, _cwd, usage) => {
  const effort = normalizeEffortLevel(request.effort);
  const level = effort === "minimal" ? "low" : effort;
  // TOML also accepts single quotes, which Windows command shims can pass through.
  const shim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(request.provider.command ?? "");
  const quote = shim ? "'" : '"';
  const args = [
    ...modelArgs(request), ...codexGlobalArgs, "-c", `web_search=${quote}disabled${quote}`,
    ...(level ? ["-c", `model_reasoning_effort=${quote}${level}${quote}`] : []),
    ...codexExecArgs,
  ];
  return {
    args,
    parse: codexParser(request.output, usage, args),
  };
};

export const prepareClaude: CliPrepare = async (request, cwd, usage) => {
  let effort = normalizeEffortLevel(request.effort);
  if (effort === "minimal") effort = "low";
  if (effort === "xhigh") effort = "high";
  const args = [
    ...modelArgs(request), ...(effort ? ["--effort", effort] : []),
    "-p", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", ...await claudeIsolationArgs(cwd),
  ];
  return {
    args,
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

export const prepareGemini: CliPrepare = (request, _cwd, usage) => {
  const args = ["generate", "--no-interactive", "-o", "json", ...modelArgs(request)];
  return {
    args,
    stdin: JSON.stringify(buildGeminiInteractionBody(request)),
    parse: geminiApiParser(request.output, usage, args),
  };
};

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

export const prepareOpenCode: CliPrepare = (request, cwd, usage) => {
  const agent = `uya-structured-${crypto.randomUUID()}`;
  const variant = normalizeEffortLevel(request.effort);
  const args = [
    "--pure", "run", "--format", "json", "--thinking", "--agent", agent, "--title", "Uya run",
    ...modelArgs(request), ...(variant ? ["--variant", variant] : []),
  ];
  return {
    args,
    parse: openCodeParser(request.output, usage, args),
    env: {
      XDG_CONFIG_HOME: cwd,
      XDG_DATA_HOME: cwd,
      XDG_STATE_HOME: cwd,
      XDG_CACHE_HOME: cwd,
      TMPDIR: cwd,
      OPENCODE_CONFIG_DIR: cwd,
      OPENCODE_CONFIG: undefined,
      OPENCODE_TEST_HOME: undefined,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DB: ":memory:",
      // Saved authorizations can include well-known remote configuration loaders.
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        share: "disabled",
        permission: { "*": "deny" },
        agent: { [agent]: { mode: "primary", permission: { "*": "deny" }, variant } },
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
