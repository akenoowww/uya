import type { EffortLevel } from "@ide/protocol";
import { execFile, spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { version as clientVersion } from "../package.json";
import { cliEnv, spawnTarget } from "./agents";
import { claudeIsolationArgs } from "./claude";
import {
  GEMINI_THINKING_LEVELS,
  parseGeminiCatalogJson,
  parseGeminiModelsListJson,
  parseGeminiSchemaThinkingLevels,
} from "./gemini";
import { effortLevels, normalizeEffortLevel } from "./provider-adapter";

export { normalizeEffortLevel } from "./provider-adapter";

export interface CliModelDiscovery {
  models: string[];
  defaultModel?: string;
  supportedEfforts?: EffortLevel[];
  defaultEffort?: EffortLevel;
  modelEfforts?: Record<string, EffortLevel[]>;
}

export interface DiscoverCliModelsOptions {
  command?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  refresh?: boolean;
}

export type CliModelDiscoverer = (
  id: string,
  options?: DiscoverCliModelsOptions,
) => Promise<CliModelDiscovery>;

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const MAX_MODEL_PAGES = 5;

export function fallbackCliEfforts(id: string): EffortLevel[] | undefined {
  switch (id) {
    case "codex": return ["low", "medium", "high", "xhigh", "max"];
    case "claude":
    case "opencode": return ["low", "medium", "high", "max"];
    case "gemini": return [...GEMINI_THINKING_LEVELS];
  }
}

const CODEX_DISCOVERY_ARGS = [
  "-c", "features.hooks=false",
  "-c", "features.apps=false",
  "-c", "features.plugins=false",
  "app-server", "--listen", "stdio://",
];

type JsonObject = Record<string, unknown>;

export function isSafeCliModelName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !value.startsWith("-")
    && !/[\s\x00-\x1f\x7f]/.test(value);
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function parseJsonLine(line: string): JsonObject | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function isPlaceholderModel(value: string): boolean {
  return value.toLowerCase() === "default";
}

function normalizeDefaultModel(value: unknown): string | undefined {
  if (!isSafeCliModelName(value)) return undefined;
  const lower = value.toLowerCase();
  return lower === "default" || lower === "auto" ? undefined : value;
}

function uniqueModels(candidates: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  for (const item of candidates) {
    if (isSafeCliModelName(item) && !isPlaceholderModel(item)) {
      seen.add(item);
    }
  }
  return [...seen];
}

function uniqueEfforts(candidates: Iterable<unknown>): EffortLevel[] {
  const seen = new Set(candidates);
  return effortLevels.filter((level) => seen.has(level));
}

function readBoundedText(path: string): string | undefined {
  try {
    const candidate = statSync(path);
    if (!candidate.isFile() || candidate.size > MAX_CONFIG_BYTES) return undefined;

    // On POSIX a path replaced with a FIFO between stat and open must not block.
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOCTTY);
    const fd = openSync(path, flags);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) return undefined;
      const buffer = Buffer.allocUnsafe(opened.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (count === 0) return buffer.toString("utf8", 0, offset);
        offset += count;
      }
      // A file that grew during the read can be reconsidered on the next refresh.
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function parseJsonObject(path: string): JsonObject | undefined {
  const raw = readBoundedText(path);
  if (!raw) return undefined;
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseTopLevelTomlString(content: string, key: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const match = new RegExp(`^${key}\\s*=\\s*(?:"([^"\\\\]+)"|'([^']+)')`).exec(line);
    const value = match?.[1] ?? match?.[2];
    if (value !== undefined) return value;
  }
  return undefined;
}

function probeEnv(baseEnv: NodeJS.ProcessEnv | undefined, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = baseEnv ? { ...baseEnv, ...extra } : cliEnv(extra);
  delete merged.IDE_SESSION_TOKEN;
  delete merged.IDE_DATA_DIR;
  delete merged.IDE_MANAGED_SIDECAR;
  delete merged.IDE_DEV_ORIGIN;
  merged.NO_BROWSER = "true";
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

interface CliProbeOptions {
  command: string;
  args: string[];
  cwd: string;
  baseEnv?: NodeJS.ProcessEnv;
  extraEnv?: NodeJS.ProcessEnv;
  timeoutMs: number;
  initialInput?: string;
  closeStdin?: boolean;
  onLine: (line: string, send: (text: string) => void, finish: () => void) => void;
}

async function runCliProbe(options: CliProbeOptions): Promise<void> {
  let target: { command: string; args: string[]; shell: boolean };
  try {
    target = spawnTarget(options.command, options.args);
  } catch {
    return;
  }

  const group = process.platform !== "win32";
  const child = spawn(target.command, target.args, {
    cwd: options.cwd,
    env: probeEnv(options.baseEnv, options.extraEnv),
    detached: group,
    shell: target.shell,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });

  const killChild = () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      // The process may have exited.
    }
  };

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (pid) {
      try {
        if (group) {
          process.kill(-pid, "SIGKILL");
          return;
        }
        if (target.shell) {
          const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
          execFile(taskkill, ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: 2_000 }, (error) => {
            if (error) killChild();
          });
          return;
        }
      } catch {
        // Fall back to direct child termination.
      }
    }
    killChild();
  };

  let settled = false;
  let totalBytes = 0;
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  const closePromise = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate();
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      resolve();
    };

    const timer = setTimeout(finish, Math.max(100, options.timeoutMs));

    const send = (text: string) => {
      if (settled || child.stdin.destroyed || !child.stdin.writable) return;
      try {
        child.stdin.write(text);
      } catch {
        // Stdin closed early.
      }
    };

    const emitLine = (raw: string) => {
      if (settled) return;
      const line = raw.trim();
      if (!line) return;
      try {
        options.onLine(line, send, finish);
      } catch {
        finish();
      }
    };

    child.stdin.on("error", () => undefined);
    child.once("error", finish);
    child.once("close", () => {
      if (!settled) {
        buffer += decoder.decode();
        if (buffer.trim()) emitLine(buffer);
      }
      finish();
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      totalBytes += bytes;
      if (totalBytes > MAX_PROBE_BYTES) {
        finish();
        return;
      }
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let offset = 0;
      for (let next = buffer.indexOf("\n"); next !== -1; next = buffer.indexOf("\n", offset)) {
        emitLine(buffer.slice(offset, next));
        offset = next + 1;
        if (settled) return;
      }
      buffer = buffer.slice(offset);
    });

    child.stdout.on("end", () => {
      if (settled) return;
      buffer += decoder.decode();
      if (buffer.trim()) emitLine(buffer);
    });

    if (options.initialInput !== undefined) {
      if (options.closeStdin) {
        try {
          child.stdin.end(options.initialInput);
        } catch {
          // Stdin closed early.
        }
      } else {
        send(options.initialInput);
      }
    } else if (options.closeStdin) {
      try {
        child.stdin.end();
      } catch {
        // Stdin closed early.
      }
    }
  });

  await done;
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closePromise,
    new Promise<void>((resolve) => {
      grace = setTimeout(resolve, 250);
      grace.unref?.();
    }),
  ]);
  if (grace) clearTimeout(grace);
}

async function withTempDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "uya-models-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true }).catch(() => undefined);
  }
}

interface CodexModel {
  slug: string;
  isDefault: boolean;
  supportedEfforts: EffortLevel[];
  defaultEffort?: EffortLevel;
}

function parseCodexModel(value: unknown): CodexModel | undefined {
  const entry = asObject(value);
  if (!entry || entry.hidden === true || entry.visibility === "hide") return;
  const slug = entry.model ?? entry.slug ?? entry.id;
  if (!isSafeCliModelName(slug) || isPlaceholderModel(slug)) return;
  const levels = entry.supported_reasoning_levels ?? entry.supportedReasoningLevels;
  return {
    slug,
    isDefault: entry.isDefault === true || entry.is_default === true,
    supportedEfforts: uniqueEfforts(Array.isArray(levels) ? levels.map((level) => asObject(level)?.effort ?? level) : []),
    defaultEffort: normalizeEffortLevel(entry.default_reasoning_level ?? entry.defaultReasoningLevel),
  };
}

function readCodexLocalCache(codexHome: string): CodexModel[] {
  const cache = parseJsonObject(join(codexHome, "models_cache.json"));
  const entries = Array.isArray(cache?.models) ? cache.models : [];
  return entries.map(parseCodexModel).filter((model) => model !== undefined);
}

async function discoverCodexModels(
  command: string,
  home: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<CliModelDiscovery> {
  const env = baseEnv ?? process.env;
  const codexHome = env.CODEX_HOME?.trim() ? env.CODEX_HOME : join(home, ".codex");
  const configText = readBoundedText(join(codexHome, "config.toml")) ?? "";
  const configuredModel = normalizeDefaultModel(parseTopLevelTomlString(configText, "model"));
  const configuredEffort = normalizeEffortLevel(parseTopLevelTomlString(configText, "model_reasoning_effort"));
  const discovered: CodexModel[] = [];
  let listRequestId = 2;
  let pages = 0;

  await withTempDir((cwd) => runCliProbe({
    command,
    args: CODEX_DISCOVERY_ARGS,
    cwd,
    baseEnv,
    timeoutMs,
    initialInput: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "uya", version: clientVersion },
        capabilities: { experimentalApi: true },
      },
    }) + "\n",
    onLine(line, send, finish) {
      const msg = parseJsonLine(line);
      if (!msg) return;
      if (msg.id === 1) {
        if (msg.error) {
          finish();
          return;
        }
        send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
        send(JSON.stringify({
          jsonrpc: "2.0",
          id: listRequestId,
          method: "model/list",
          params: { limit: 100 },
        }) + "\n");
        return;
      }
      if (msg.id !== listRequestId) return;
      if (msg.error) {
        finish();
        return;
      }
      const result = asObject(msg.result);
      const data = Array.isArray(result?.data) ? result.data : [];
      for (const entry of data) {
        const model = parseCodexModel(entry);
        if (model) discovered.push(model);
      }
      const nextCursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      pages += 1;
      if (nextCursor && pages < MAX_MODEL_PAGES) {
        listRequestId += 1;
        send(JSON.stringify({
          jsonrpc: "2.0",
          id: listRequestId,
          method: "model/list",
          params: { limit: 100, cursor: nextCursor },
        }) + "\n");
      } else {
        finish();
      }
    },
  }));

  const catalog = discovered.length ? discovered : readCodexLocalCache(codexHome);
  const defaultModel = configuredModel ?? catalog.find((model) => model.isDefault && normalizeDefaultModel(model.slug))?.slug;
  const modelEfforts = Object.fromEntries(catalog
    .filter((model) => model.supportedEfforts.length > 0)
    .map((model) => [model.slug, model.supportedEfforts]));
  const supportedEfforts = uniqueEfforts(Object.values(modelEfforts).flat());
  return {
    models: uniqueModels([configuredModel, ...catalog.map((model) => model.slug)]),
    defaultModel,
    supportedEfforts: supportedEfforts.length ? supportedEfforts : fallbackCliEfforts("codex"),
    defaultEffort: configuredEffort ?? catalog.find((model) => model.slug === defaultModel)?.defaultEffort,
    modelEfforts: supportedEfforts.length ? modelEfforts : undefined,
  };
}

async function discoverClaudeModels(
  command: string,
  home: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<CliModelDiscovery> {
  const settings = parseJsonObject(join(home, ".claude", "settings.json"));
  const configuredDefault = normalizeDefaultModel(settings?.model);
  const defaultEffort = normalizeEffortLevel(settings?.effortLevel) ?? normalizeEffortLevel(settings?.effort);
  const discovered: string[] = [];

  await withTempDir(async (cwd) => runCliProbe({
    command,
    args: [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      ...await claudeIsolationArgs(cwd),
    ],
    cwd,
    baseEnv,
    extraEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    timeoutMs,
    initialInput: JSON.stringify({
      type: "control_request",
      request_id: "uya-models",
      request: { subtype: "initialize" },
    }) + "\n",
    closeStdin: true,
    onLine(line, _send, finish) {
      const msg = parseJsonLine(line);
      if (!msg || msg.type !== "control_response") return;
      const outer = asObject(msg.response);
      if (outer?.request_id && outer.request_id !== "uya-models") return;
      const inner = asObject(outer?.response) ?? outer;
      const rawModels = Array.isArray(inner?.models) ? inner.models : [];
      for (const entry of rawModels) {
        if (typeof entry === "string") {
          discovered.push(entry);
          continue;
        }
        const record = asObject(entry);
        const value = record?.value ?? record?.id ?? record?.model;
        if (typeof value === "string") discovered.push(value);
      }
      finish();
    },
  }));

  const models = uniqueModels([configuredDefault, ...discovered]);
  return { models, defaultModel: configuredDefault, supportedEfforts: fallbackCliEfforts("claude"), defaultEffort };
}

function acpOptionValues(value: unknown): unknown[] {
  const options = Array.isArray(value) ? value : [];
  return options
    .flatMap((item) => {
      const group = asObject(item)?.options;
      return Array.isArray(group) ? group : [item];
    })
    .map((item) => {
      if (typeof item === "string") return item;
      const entry = asObject(item);
      return entry?.value ?? entry?.id;
    });
}

function extractAcpModels(result: JsonObject | undefined): CliModelDiscovery {
  if (!result) return { models: [] };

  const candidates: unknown[] = [];
  let defaultModel: string | undefined;
  const effortCandidates: unknown[] = [];
  let defaultEffort: EffortLevel | undefined;

  const modelsSection = asObject(result.models);
  if (modelsSection) {
    defaultModel ??= normalizeDefaultModel(modelsSection.currentModelId);
    const available = Array.isArray(modelsSection.availableModels) ? modelsSection.availableModels : [];
    for (const entry of available) {
      if (typeof entry === "string") {
        candidates.push(entry);
        continue;
      }
      const record = asObject(entry);
      const modelId = record?.modelId ?? record?.id ?? record?.value;
      if (typeof modelId === "string") candidates.push(modelId);
    }
  }

  const configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
  for (const option of configOptions) {
    const record = asObject(option);
    if (!record) continue;
    const isModelOption = record.category === "model"
      || record.id === "model"
      || record.configId === "model";
    if (isModelOption) {
      defaultModel ??= normalizeDefaultModel(record.currentValue);
      for (const value of acpOptionValues(record.options)) candidates.push(value);
    } else if ([record.category, record.id, record.configId]
      .some((key) => key === "effort" || key === "reasoning_effort" || key === "thought_level")) {
      defaultEffort ??= normalizeEffortLevel(record.currentValue);
      for (const value of acpOptionValues(record.options)) effortCandidates.push(value);
    }
  }

  const supportedEfforts = uniqueEfforts(effortCandidates);
  return {
    models: uniqueModels(candidates),
    defaultModel,
    ...(supportedEfforts.length ? { supportedEfforts, defaultEffort } : {}),
  };
}

async function discoverAcpModels(
  command: string,
  args: string[],
  baseEnv: NodeJS.ProcessEnv | undefined,
  extraEnv: NodeJS.ProcessEnv | undefined,
  cwd: string,
  timeoutMs: number,
): Promise<CliModelDiscovery> {
  let result: CliModelDiscovery = { models: [] };

  await runCliProbe({
    command,
    args,
    cwd,
    baseEnv,
    extraEnv,
    timeoutMs,
    initialInput: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "uya", version: clientVersion },
      },
    }) + "\n",
    onLine(line, send, finish) {
      const msg = parseJsonLine(line);
      if (!msg) return;
      if (msg.id === 1) {
        if (msg.error) {
          finish();
          return;
        }
        send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd, mcpServers: [] },
        }) + "\n");
        return;
      }
      if (msg.id !== 2) return;
      if (!msg.error) {
        result = extractAcpModels(asObject(msg.result));
      }
      finish();
    },
  });

  return result;
}

async function captureProbeStdout(
  command: string,
  args: string[],
  cwd: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<string> {
  const chunks: string[] = [];
  await runCliProbe({
    command,
    args,
    cwd,
    baseEnv,
    timeoutMs,
    closeStdin: true,
    onLine(line) {
      chunks.push(line);
    },
  });
  return chunks.join("\n").trim();
}

async function discoverGeminiModels(
  command: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<CliModelDiscovery> {
  return withTempDir(async (cwd) => {
    const [liveRaw, catalogRaw, schemaRaw] = await Promise.all([
      captureProbeStdout(
        command,
        ["models", "list", "--no-interactive", "--all", "--max-pages", String(MAX_MODEL_PAGES), "-o", "json"],
        cwd,
        baseEnv,
        timeoutMs,
      ),
      captureProbeStdout(command, ["models", "--no-interactive", "-o", "json"], cwd, baseEnv, timeoutMs),
      captureProbeStdout(command, ["generate", "--schema"], cwd, baseEnv, timeoutMs),
    ]);

    const schemaEfforts = parseGeminiSchemaThinkingLevels(schemaRaw);
    const availableEfforts = schemaEfforts.length ? schemaEfforts : fallbackCliEfforts("gemini");
    const live = parseGeminiModelsListJson(liveRaw);
    const catalog = parseGeminiCatalogJson(catalogRaw);

    if (live.length > 0) {
      const liveIds = uniqueModels(live.map((entry) => entry.id));
      const defaultModel = catalog.defaultModel && liveIds.includes(catalog.defaultModel)
        ? catalog.defaultModel
        : undefined;
      const models = defaultModel
        ? uniqueModels([defaultModel, ...liveIds])
        : liveIds;
      const modelEfforts: Record<string, EffortLevel[]> = {};
      if (availableEfforts?.length) {
        for (const entry of live) {
          if (entry.thinking === true) {
            modelEfforts[entry.id] = [...availableEfforts];
          } else if (entry.thinking === false) {
            modelEfforts[entry.id] = [];
          }
        }
      }
      return {
        models,
        defaultModel,
        supportedEfforts: availableEfforts,
        ...(Object.keys(modelEfforts).length ? { modelEfforts } : {}),
      };
    }

    const fallbackIds = uniqueModels(catalog.models);
    const defaultModel = catalog.defaultModel && fallbackIds.includes(catalog.defaultModel)
      ? catalog.defaultModel
      : undefined;
    const models = defaultModel
      ? uniqueModels([defaultModel, ...fallbackIds])
      : fallbackIds;
    return {
      models,
      defaultModel,
      supportedEfforts: availableEfforts,
    };
  });
}

async function discoverQwenModels(
  command: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<CliModelDiscovery> {
  return withTempDir((cwd) => discoverAcpModels(
    command,
    ["--acp", "--safe-mode", "--approval-mode", "default"],
    baseEnv,
    undefined,
    cwd,
    timeoutMs,
  ));
}

function readOpenCodeConfigDefault(home: string, env: NodeJS.ProcessEnv): string | undefined {
  const configBase = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : join(home, ".config");
  const settings = parseJsonObject(join(configBase, "opencode", "opencode.json"))
    ?? (env.APPDATA ? parseJsonObject(join(env.APPDATA, "opencode", "opencode.json")) : undefined);
  return normalizeDefaultModel(settings?.model);
}

async function discoverOpenCodeModels(
  command: string,
  home: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  refresh: boolean,
): Promise<CliModelDiscovery> {
  const env = baseEnv ?? process.env;
  const configuredDefault = readOpenCodeConfigDefault(home, env);
  const discovered: string[] = [];

  await withTempDir((cwd) => runCliProbe({
    command,
    args: refresh ? ["models", "--pure", "--refresh"] : ["models", "--pure"],
    cwd,
    baseEnv,
    extraEnv: {
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
      OPENCODE_DB: ":memory:",
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        share: "disabled",
        permission: { "*": "deny" },
      }),
    },
    timeoutMs,
    closeStdin: true,
    onLine(line) {
      if (isSafeCliModelName(line) && line.includes("/")) {
        discovered.push(line);
      }
    },
  }));

  const models = uniqueModels(discovered);
  const defaultModel = configuredDefault && models.includes(configuredDefault)
    ? configuredDefault
    : undefined;
  return { models, defaultModel, supportedEfforts: fallbackCliEfforts("opencode") };
}

export async function discoverCliModels(
  id: string,
  options: DiscoverCliModelsOptions = {},
): Promise<CliModelDiscovery> {
  const command = options.command;
  if (!command) return { models: [] };

  const home = options.home ?? homedir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const refresh = options.refresh ?? false;

  switch (id) {
    case "codex":
      return discoverCodexModels(command, home, options.env, timeoutMs);
    case "claude":
      return discoverClaudeModels(command, home, options.env, timeoutMs);
    case "gemini":
      return discoverGeminiModels(command, options.env, timeoutMs);
    case "qwen":
      return discoverQwenModels(command, options.env, timeoutMs);
    case "opencode":
      return discoverOpenCodeModels(command, home, options.env, timeoutMs, refresh);
    default:
      return { models: [] };
  }
}
