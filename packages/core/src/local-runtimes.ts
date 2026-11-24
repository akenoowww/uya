import type { ConversationMessage, EffortLevel } from "@ide/protocol";
import { fetchLoopback, type LoopbackFetch } from "./loopback-http";
import { normalizeEffortLevel } from "./provider-adapter";

const ports = {
  llamacpp: [9931, 8080],
  lmstudio: [1234],
  mlx: [8080],
} as const;

export type LocalRuntimeId = keyof typeof ports;

type FetchRuntime = LoopbackFetch;
type JsonObject = Record<string, unknown>;
type Usage = { inputTokens?: number; outputTokens?: number };
type Output = {
  emit(type: "text" | "thinking" | "tool", text: string): void;
  raw(line: string): void;
};
type LocalEndpoint = { origin: string; models: string[] };

const DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_CHARS = 1_048_576;
const MLX_PROBE_PATH = "/v1/models/uya/model-discovery-probe-7c284a";

const reasoningLevels = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const satisfies Record<EffortLevel, "low" | "medium" | "high">;

export function isLocalRuntimeId(id: string): id is LocalRuntimeId {
  return Object.hasOwn(ports, id);
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function modelName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/[-:]cloud(?:[:@]|$)/i.test(value);
}

function remote(model: JsonObject): boolean {
  return Boolean(model.remote_host || model.remote_model || model.remote === true || model.cloud === true);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function* decode(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (text) yield text;
      if (done) return;
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

async function fetchJson(fetchRuntime: FetchRuntime, url: string, signal: AbortSignal): Promise<JsonObject | undefined> {
  const response = await fetchRuntime(url, { method: "GET", signal });
  if (!response.ok || response.redirected || !response.body
    || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel();
    return;
  }
  let text = "";
  for await (const chunk of decode(response.body, signal)) {
    if (text.length + chunk.length > MAX_RESPONSE_CHARS) return;
    text += chunk;
  }
  return object(JSON.parse(text));
}

async function modelsAt(id: LocalRuntimeId, origin: string, signal: AbortSignal, fetchRuntime: FetchRuntime): Promise<string[]> {
  if (id === "lmstudio") {
    // The native endpoint distinguishes loaded local LLM instances from embeddings and downloadable models.
    const list = await fetchJson(fetchRuntime, origin + "/api/v1/models", signal);
    return array(list?.models).flatMap((entry) => {
      const model = object(entry);
      if (!model || model.type !== "llm" || (model.format !== "gguf" && model.format !== "mlx") || remote(model)) {
        return [];
      }
      return array(model.loaded_instances)
        .map((instance) => object(instance)?.id)
        .filter(modelName);
    });
  }

  const list = await fetchJson(fetchRuntime, origin + "/v1/models", signal);
  if (list?.object !== "list") return [];
  const models = array(list.data).flatMap((entry) => {
    const value = object(entry);
    return value && value.object === "model" && modelName(value.id) && !remote(value)
      ? [{ id: value.id, ownedBy: value.owned_by, status: value.status, created: value.created }]
      : [];
  });

  if (id === "llamacpp") {
    return models.filter((model) => {
      if (model.ownedBy !== "llamacpp") return false;
      const state = object(model.status)?.value;
      return model.status === undefined || state === "loaded" || state === "sleeping";
    }).map(({ id: name }) => name);
  }

  // Both servers commonly use port 8080. The MLX endpoint returns a filtered list
  // for an unknown repository, plus its startup model if configured by local path.
  const cached = models.filter((model) => model.ownedBy === undefined && count(model.created) !== undefined);
  if (!cached.length || cached.length !== models.length) return [];
  const scoped = await fetchJson(fetchRuntime, origin + MLX_PROBE_PATH, signal);
  if (scoped?.object !== "list" || !Array.isArray(scoped.data)) return [];
  const configuredPaths = new Set(cached.filter((model) => model.id.startsWith("/")).map((model) => model.id));
  return scoped.data.every((entry) => {
    const model = object(entry);
    return typeof model?.id === "string" && configuredPaths.has(model.id);
  }) ? cached.map((model) => model.id) : [];
}

async function discoverEndpoints(
  id: LocalRuntimeId, signal: AbortSignal, fetchRuntime: FetchRuntime,
): Promise<LocalEndpoint[]> {
  const checks = ports[id].map(async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const models = await modelsAt(id, origin, signal, fetchRuntime);
    return { origin, models };
  });
  return (await Promise.allSettled(checks)).flatMap((result) =>
    result.status === "fulfilled" && result.value.models.length ? [result.value] : []);
}

export async function discoverLocalRuntimeModels(id: LocalRuntimeId, fetchRuntime: FetchRuntime = fetchLoopback): Promise<string[]> {
  const endpoints = await discoverEndpoints(id, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), fetchRuntime);
  return [...new Set(endpoints.flatMap((endpoint) => endpoint.models))].sort();
}

async function* sseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  let pending = "";
  let data = "";
  for await (const chunk of decode(body, signal)) {
    pending += chunk;
    let start = 0;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n", start)) {
      if (end - start > MAX_RESPONSE_CHARS) throw new Error("The runtime returned an oversized stream record.");
      const line = pending.slice(start, end).replace(/\r$/, "");
      start = end + 1;
      if (line === "") {
        if (data) yield data;
        data = "";
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        data = data ? data + "\n" + value : value;
        if (data.length > MAX_RESPONSE_CHARS) throw new Error("The runtime returned an oversized stream record.");
      }
    }
    pending = pending.slice(start);
    if (pending.length > MAX_RESPONSE_CHARS) throw new Error("The runtime returned an oversized stream record.");
  }
}

async function readCompletion(body: ReadableStream<Uint8Array>, signal: AbortSignal, output: Output): Promise<Usage> {
  const usage: Usage = {};
  let finished = false;
  for await (const frame of sseFrames(body, signal)) {
    if (frame === "[DONE]") {
      if (!finished) break;
      return usage;
    }
    let packet: JsonObject | undefined;
    try {
      packet = object(JSON.parse(frame));
    } catch {
      throw new Error("The runtime returned a malformed stream record.");
    }
    if (!packet || packet.error != null || !Array.isArray(packet.choices)) {
      throw new Error("The runtime reported a generation error.");
    }

    const choice = object(packet.choices[0]);
    const delta = object(choice?.delta);
    if (array(delta?.tool_calls).length || delta?.function_call || choice?.finish_reason === "tool_calls") {
      throw new Error("The runtime requested a tool in a read-only run.");
    }
    const tokens = object(packet.usage);
    usage.inputTokens = count(tokens?.prompt_tokens) ?? usage.inputTokens;
    usage.outputTokens = count(tokens?.completion_tokens) ?? usage.outputTokens;
    const text = typeof delta?.content === "string" ? delta.content : undefined;
    const thought = delta?.reasoning_content ?? delta?.reasoning;
    const thinking = typeof thought === "string" ? thought : undefined;
    const reason = choice?.finish_reason;
    finished ||= reason === "stop" || reason === "length" || reason === "content_filter";
    if (thinking) output.emit("thinking", thinking);
    if (text) output.emit("text", text);
    if (text || thinking || tokens) output.raw(JSON.stringify({ text, thinking, usage }));
  }
  signal.throwIfAborted();
  if (finished) return usage;
  throw new Error("The runtime stream ended before completion.");
}

export async function runLocalRuntime(
  id: LocalRuntimeId,
  model: string,
  messages: readonly ConversationMessage[] | string,
  signal: AbortSignal,
  output: Output,
  fetchRuntime: FetchRuntime = fetchLoopback,
  effort?: EffortLevel,
): Promise<Usage> {
  signal.throwIfAborted();
  const endpoints = await discoverEndpoints(id, AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]), fetchRuntime);
  signal.throwIfAborted();
  const endpoint = endpoints.find(({ models }) => models.includes(model));
  if (!endpoint) throw new Error("The selected model is unavailable from the local runtime.");

  const level = normalizeEffortLevel(effort);
  const path = "/v1/chat/completions" + (id === "llamacpp" ? "?autoload=false" : "");
  const response = await fetchRuntime(endpoint.origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    signal,
    body: JSON.stringify({
      model,
      messages: typeof messages === "string" ? [{ role: "user", content: messages }] : messages,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: level ? reasoningLevels[level] : undefined,
    }),
  });
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new Error(`The local runtime rejected the request (HTTP ${response.status}).`);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    await response.body.cancel();
    throw new Error("The local runtime did not return an event stream.");
  }
  return await readCompletion(response.body, signal, output);
}
