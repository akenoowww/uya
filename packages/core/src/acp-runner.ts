import type { EffortLevel } from "@ide/protocol";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as clientVersion } from "../package.json";
import { cliEnv, spawnTarget } from "./agents";
import { classifyCliDiagnostic, drainCliDiagnostics } from "./cli-diagnostics";
import { isSafeCliModelName } from "./cli-models";
import { promptForCli } from "./conversation";
import { AdapterError, normalizeEffortLevel, type AdapterRequest, type Usage } from "./provider-adapter";

type JsonObject = Record<string, unknown>;

interface AcpOptionMeta {
  id: string;
  category?: string;
  currentValue?: string;
  values: string[];
}

export interface AcpRunOptions {
  args: string[];
  command?: string;
  env?: NodeJS.ProcessEnv;
  encode?: (text: string) => string;
  fallbackError: string;
}

const MAX_ACP_LINE_BYTES = 2_000_000;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseOptionValues(value: unknown): string[] {
  const options = Array.isArray(value) ? value : [];
  const result: string[] = [];
  for (const item of options) {
    const group = asObject(item)?.options;
    if (Array.isArray(group)) {
      result.push(...parseOptionValues(group));
      continue;
    }
    const val = typeof item === "string" ? item : asObject(item)?.value ?? asObject(item)?.id;
    if (typeof val === "string" && val.length > 0) result.push(val);
  }
  return result;
}

function parseConfigOptions(value: unknown): AcpOptionMeta[] {
  if (!Array.isArray(value)) return [];
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
  const options = Array.isArray(params?.options) ? params.options : [];
  for (const item of options) {
    const entry = asObject(item);
    const kind = typeof entry?.kind === "string" ? entry.kind : "";
    const optionId = typeof entry?.optionId === "string" ? entry.optionId : undefined;
    if (optionId && (kind === "reject_once" || kind === "reject_always")) {
      return { outcome: { outcome: "selected", optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
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

export async function runAcpCli(request: AdapterRequest, options: AcpRunOptions): Promise<Usage> {
  const { provider, prompt, messages, signal, output } = request;
  const executable = options.command ?? provider.command;
  if (!executable) throw new AdapterError("This provider has no executable for structured runs.");

  const requestedModel = request.model;
  if (requestedModel && !isSafeCliModelName(requestedModel)) {
    throw new AdapterError("Invalid model name.");
  }
  const requestedEffort = normalizeEffortLevel(request.effort);

  const cwd = await mkdtemp(join(tmpdir(), "uya-run-"));
  const usage: Usage = {};

  try {
    signal.throwIfAborted();
    const env = cliEnv(options.env);
    const group = process.platform !== "win32";
    const target = spawnTarget(executable, options.args);
    const child = spawn(target.command, target.args, {
      cwd,
      env,
      detached: group,
      shell: target.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const diagnostic = drainCliDiagnostics(child.stderr, options.args);
    const close = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", (code) => resolve(code));
    });

    let sessionId: string | undefined;
    let finished = false;
    let rpcFailure: { message?: string; diagnostic?: string } | undefined;
    let nextId = 1;
    let initId = 0;
    let newSessionId = 0;
    let setModelId = 0;
    let setEffortId = 0;
    let promptId = 0;
    let configOptions: AcpOptionMeta[] = [];
    let availableModelIds = new Set<string>();

    const send = (payload: JsonObject) => {
      if (child.stdin.destroyed || !child.stdin.writable) return;
      try {
        child.stdin.write(JSON.stringify(payload) + "\n");
      } catch {
        // Stdin closed early.
      }
    };

    const terminate = () => {
      try {
        if (group && child.pid) {
          process.kill(-child.pid, "SIGKILL");
          return;
        }
      } catch {
        // Process group may already have exited.
      }
      try {
        if (process.platform === "win32") child.kill();
        else child.kill("SIGKILL");
      } catch {
        // Ignore already-exited child.
      }
    };

    const onAbort = () => {
      if (sessionId) {
        send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      }
      terminate();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdin.on("error", () => undefined);

    const failAndStop = (rawError: unknown) => {
      const errorText = extractErrorText(rawError);
      rpcFailure = {
        message: options.fallbackError,
        diagnostic: errorText ? classifyCliDiagnostic(errorText, options.args)?.message : undefined,
      };
      try {
        child.stdin.end();
      } catch {
        // Ignore.
      }
      terminate();
    };

    const sendPrompt = () => {
      if (!sessionId) {
        failAndStop("ACP session missing sessionId");
        return;
      }
      const rawPrompt = promptForCli(prompt, messages);
      const text = options.encode ? options.encode(rawPrompt) : rawPrompt;
      promptId = nextId++;
      send({
        jsonrpc: "2.0",
        id: promptId,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text }],
        },
      });
    };

    const sendEffortOrPrompt = () => {
      if (!sessionId) {
        failAndStop("ACP session missing sessionId");
        return;
      }
      if (!requestedEffort) {
        sendPrompt();
        return;
      }
      const effortOpt = findEffortOption(configOptions);
      if (!effortOpt) {
        sendPrompt();
        return;
      }
      const targetValue = resolveAcpEffortValue(requestedEffort, effortOpt.values);
      if (!targetValue || targetValue === effortOpt.currentValue) {
        sendPrompt();
        return;
      }
      setEffortId = nextId++;
      send({
        jsonrpc: "2.0",
        id: setEffortId,
        method: "session/set_config_option",
        params: {
          sessionId,
          configId: effortOpt.id,
          value: targetValue,
        },
      });
    };

    const sendModelOrEffort = () => {
      if (!sessionId) {
        failAndStop("ACP session missing sessionId");
        return;
      }
      if (!requestedModel) {
        sendEffortOrPrompt();
        return;
      }
      const modelOpt = findModelOption(configOptions);
      if (modelOpt && (modelOpt.values.includes(requestedModel) || !availableModelIds.has(requestedModel))) {
        usage.model = requestedModel;
        if (modelOpt.currentValue === requestedModel) {
          sendEffortOrPrompt();
          return;
        }
        setModelId = nextId++;
        send({
          jsonrpc: "2.0",
          id: setModelId,
          method: "session/set_config_option",
          params: {
            sessionId,
            configId: modelOpt.id,
            value: requestedModel,
          },
        });
        return;
      }
      usage.model = requestedModel;
      setModelId = nextId++;
      send({
        jsonrpc: "2.0",
        id: setModelId,
        method: "session/set_model",
        params: {
          sessionId,
          modelId: requestedModel,
        },
      });
    };

    const handleNotification = (line: string, method: string, params: JsonObject | undefined) => {
      if (method !== "session/update") return;
      const update = asObject(params?.update);
      if (!update) return;
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const content = asObject(update.content);
        if (content?.type === "text" && typeof content.text === "string" && content.text) {
          output.raw(line);
          output.emit("text", content.text);
        }
      } else if (kind === "agent_thought_chunk") {
        const content = asObject(update.content);
        if (content?.type === "text" && typeof content.text === "string" && content.text) {
          output.raw(line);
          output.emit("thinking", content.text);
        }
      } else if (kind === "tool_call") {
        const title = typeof update.title === "string" && update.title.trim()
          ? update.title.trim()
          : typeof update.kind === "string" && update.kind.trim()
            ? update.kind.trim().replaceAll("_", " ")
            : "tool call";
        output.emit("tool", title);
      } else if (kind === "config_option_update") {
        const updated = parseConfigOptions(update.configOptions);
        if (updated.length) configOptions = updated;
      }
    };

    const handleAgentRequest = (id: unknown, method: string, params: JsonObject | undefined) => {
      if (method === "session/request_permission") {
        send({ jsonrpc: "2.0", id, result: selectPermissionRejection(params) });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not supported in structured mode." },
      });
    };

    const handleLine = (line: string) => {
      if (finished || rpcFailure) return;
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let msg: JsonObject | undefined;
      try {
        msg = asObject(JSON.parse(trimmed));
      } catch {
        return;
      }
      if (!msg) return;

      // Agent -> client notification or request
      if (typeof msg.method === "string") {
        const params = asObject(msg.params);
        if (msg.id !== undefined) {
          handleAgentRequest(msg.id, msg.method, params);
        } else {
          handleNotification(trimmed, msg.method, params);
        }
        return;
      }

      if (msg.id === initId) {
        if (msg.error) {
          failAndStop(msg.error);
          return;
        }
        newSessionId = nextId++;
        send({
          jsonrpc: "2.0",
          id: newSessionId,
          method: "session/new",
          params: { cwd, mcpServers: [] },
        });
      } else if (msg.id === newSessionId) {
        if (msg.error) {
          failAndStop(msg.error);
          return;
        }
        const res = asObject(msg.result);
        sessionId = typeof res?.sessionId === "string" ? res.sessionId : undefined;
        configOptions = parseConfigOptions(res?.configOptions);
        const modelsObj = asObject(res?.models);
        const avail = Array.isArray(modelsObj?.availableModels) ? modelsObj.availableModels : [];
        availableModelIds = new Set(avail.flatMap((entry) => {
          const id = typeof entry === "string" ? entry : asObject(entry)?.modelId ?? asObject(entry)?.id;
          return typeof id === "string" ? [id] : [];
        }));
        const initialModel = findModelOption(configOptions)?.currentValue
          ?? (typeof modelsObj?.currentModelId === "string" ? modelsObj.currentModelId : undefined);
        if (initialModel && isSafeCliModelName(initialModel)) {
          usage.model ??= initialModel;
        }
        sendModelOrEffort();
      } else if (msg.id === setModelId) {
        if (msg.error) {
          failAndStop(msg.error);
          return;
        }
        const res = asObject(msg.result);
        const updated = parseConfigOptions(res?.configOptions);
        if (updated.length) configOptions = updated;
        sendEffortOrPrompt();
      } else if (msg.id === setEffortId) {
        if (msg.error) {
          failAndStop(msg.error);
          return;
        }
        const res = asObject(msg.result);
        const updated = parseConfigOptions(res?.configOptions);
        if (updated.length) configOptions = updated;
        sendPrompt();
      } else if (msg.id === promptId) {
        if (msg.error) {
          failAndStop(msg.error);
          return;
        }
        const res = asObject(msg.result);
        const stopReason = typeof res?.stopReason === "string" ? res.stopReason : undefined;
        if (stopReason === "cancelled" && !signal.aborted) {
          failAndStop("The run was cancelled by the provider.");
          return;
        }
        const stats = asObject(res?.usage);
        if (stats) {
          usage.inputTokens = tokenCount(stats.inputTokens ?? stats.input_tokens);
          usage.outputTokens = tokenCount(stats.outputTokens ?? stats.output_tokens);
        }
        output.raw(trimmed);
        finished = true;
        try {
          child.stdin.end();
        } catch {
          // Ignore.
        }
      }
    };

    initId = nextId++;
    send({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "uya", version: clientVersion },
      },
    });

    try {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        signal.throwIfAborted();
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let offset = 0;
        for (let next = buffer.indexOf("\n"); next !== -1; next = buffer.indexOf("\n", offset)) {
          if (next - offset > MAX_ACP_LINE_BYTES) {
            throw new AdapterError("A CLI event exceeded the output limit.");
          }
          handleLine(buffer.slice(offset, next));
          offset = next + 1;
          if (finished || rpcFailure) break;
        }
        buffer = buffer.slice(offset);
        if (buffer.length > MAX_ACP_LINE_BYTES) {
          throw new AdapterError("A CLI event exceeded the output limit.");
        }
        if (finished || rpcFailure) break;
      }
      if (!finished && !rpcFailure) {
        buffer += decoder.decode();
        if (buffer.trim()) handleLine(buffer);
      }

      if (finished) {
        // ACP servers stay alive until stdin EOF or termination; give a brief grace window then exit cleanly.
        let grace: ReturnType<typeof setTimeout> | undefined;
        const exited = await Promise.race([
          close.then(() => true),
          new Promise<boolean>((resolve) => {
            grace = setTimeout(() => resolve(false), 250);
            grace.unref?.();
          }),
        ]);
        if (grace) clearTimeout(grace);
        if (!exited && child.exitCode === null) terminate();
      }

      const code = await close;
      signal.throwIfAborted();
      if (rpcFailure || !finished) {
        const reason = rpcFailure?.diagnostic ?? (await diagnostic)?.message ?? rpcFailure?.message;
        const fallback = code === 0
          ? `${provider.name} did not return a complete structured response.`
          : options.fallbackError;
        throw new AdapterError(reason ?? fallback, code ?? undefined);
      }
      return usage;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null) terminate();
      await close;
      await diagnostic;
    }
  } finally {
    await rm(cwd, { force: true, recursive: true }).catch(() => undefined);
  }
}
