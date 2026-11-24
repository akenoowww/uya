import type { ConversationMessage, EffortLevel } from "@ide/protocol";
import { fetchLoopback, type LoopbackFetch } from "./loopback-http";
import { normalizeEffortLevel } from "./provider-adapter";

const OLLAMA_URL = "http://127.0.0.1:11434";
const DISCOVERY_TIMEOUT_MS = 2_000;
const GENERATION_TIMEOUT_MS = 300_000;
const MAX_RECORD_LENGTH = 1_048_576;

const thinkingLevels = {
  minimal: false,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const satisfies Record<EffortLevel, boolean | string>;

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function isRemote(value: Record<string, unknown>): boolean {
  return Boolean(value.remote_host || value.remote_model);
}

function isCloudTag(name: string): boolean {
  const basename = name.slice(name.lastIndexOf("/") + 1);
  return /-cloud(?=\s*(?::|$))|:\s*cloud$/i.test(basename);
}

async function installedModels(signal: AbortSignal, fetchOllama: LoopbackFetch): Promise<string[]> {
  const response = await fetchOllama(`${OLLAMA_URL}/api/tags`, {
    method: "GET",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Ollama model discovery failed");
  }

  const result = record(await response.json());
  if (!Array.isArray(result?.models)) return [];

  const names = new Set<string>();
  for (const value of result.models) {
    const model = record(value);
    if (!model || isRemote(model)) continue;
    const name = typeof model.model === "string" ? model.model : model.name;
    if (typeof name === "string" && name.trim() === name && name && !isCloudTag(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

export async function discoverOllamaModels(fetchOllama: LoopbackFetch = fetchLoopback): Promise<string[]> {
  try {
    return await installedModels(AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), fetchOllama);
  } catch {
    return [];
  }
}

function parseFrame(line: string): Record<string, unknown> {
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(line));
  } catch {
    throw new Error("Ollama returned a malformed stream record");
  }

  if (!value) throw new Error("Ollama returned a malformed stream record");
  if (isRemote(value)) throw new Error("Ollama returned a remote model response");
  if (value.error != null) throw new Error("Ollama reported a generation error");
  return value;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function streamResponse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onRaw: (line: string) => void,
  onThinking?: (delta: string) => void,
): Promise<Usage> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  let pending = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      pending += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });

      let start = 0;
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n", start)) {
        if (end - start > MAX_RECORD_LENGTH) throw new Error("Ollama stream record is too large");
        const line = pending.slice(start, end).trim();
        start = end + 1;
        if (!line) continue;

        signal.throwIfAborted();
        const frame = parseFrame(line);
        onRaw(line);
        signal.throwIfAborted();
        const message = record(frame.message);
        const thinking = message?.thinking;
        if (typeof thinking === "string" && thinking) onThinking?.(thinking);
        signal.throwIfAborted();
        const content = message?.content;
        if (typeof content === "string" && content) onText(content);
        signal.throwIfAborted();
        if (frame.done === true) {
          return {
            inputTokens: tokenCount(frame.prompt_eval_count),
            outputTokens: tokenCount(frame.eval_count),
          };
        }
      }

      pending = pending.slice(start);
      if (pending.length > MAX_RECORD_LENGTH) throw new Error("Ollama stream record is too large");
      if (done) throw new Error("Ollama stream ended before completion");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function runOllama(
  model: string,
  prompt: string | readonly ConversationMessage[],
  signal: AbortSignal,
  onText: (delta: string) => void,
  onRaw: (line: string) => void,
  fetchOllama: LoopbackFetch = fetchLoopback,
  onThinking?: (delta: string) => void,
  effort?: EffortLevel,
): Promise<Usage> {
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)]);
  runSignal.throwIfAborted();

  // Ollama's loopback API can also serve cloud-backed tags.
  const discoverySignal = AbortSignal.any([runSignal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
  let models: string[];
  try {
    models = await installedModels(discoverySignal, fetchOllama);
  } catch {
    runSignal.throwIfAborted();
    throw new Error("Cannot list models from the local Ollama service");
  }
  if (!models.includes(model)) throw new Error("The selected model is unavailable as a local Ollama model");

  const level = normalizeEffortLevel(effort);
  const think = level ? thinkingLevels[level] : undefined;
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  const postChat = (thinking?: typeof think) => {
    runSignal.throwIfAborted();
    return fetchOllama(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: runSignal,
      body: JSON.stringify({ model, messages, stream: true, think: thinking }),
    });
  };
  let response: Response;
  try {
    response = await postChat(think);
    if (response.status === 400 && think !== undefined) {
      // Older servers and models may reject the parameter or a named level.
      await response.body?.cancel().catch(() => undefined);
      response = await postChat();
    }
  } catch {
    runSignal.throwIfAborted();
    throw new Error("Cannot connect to the local Ollama service");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Ollama chat failed (HTTP ${response.status})`);
  }

  return await streamResponse(response.body, runSignal, onText, onRaw, onThinking);
}
