import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliModelDiscovery {
  models: string[];
  defaultModel?: string;
}

const FALLBACK_CLI_MODELS: Readonly<Record<string, readonly string[]>> = {
  codex: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "o3", "o4-mini"],
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "sonnet", "opus", "haiku"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-pro-preview", "gemini-3-flash-preview"],
  qwen: ["qwen3-coder-plus", "qwen3-coder-flash", "qwen3-max"],
  opencode: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4", "google/gemini-2.5-pro"],
  kimi: ["kimi-for-coding", "kimi-k2-thinking", "kimi-k2-0905-preview"],
};

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export function isSafeCliModelName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !value.startsWith("-")
    && !/[\s\x00-\x1f\x7f]/.test(value);
}

function readBoundedText(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    return content.length <= MAX_CONFIG_BYTES ? content : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(path: string): Record<string, unknown> | undefined {
  const raw = readBoundedText(path);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
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

function uniqueModels(candidates: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  for (const item of candidates) {
    if (isSafeCliModelName(item)) seen.add(item);
  }
  return [...seen];
}

function discoverCodexModels(home: string, env: NodeJS.ProcessEnv): CliModelDiscovery {
  const codexHome = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME : join(home, ".codex");
  const configText = readBoundedText(join(codexHome, "config.toml"));
  const configured = configText ? parseTopLevelTomlString(configText, "model") : undefined;
  const defaultModel = isSafeCliModelName(configured) ? configured : undefined;

  const cache = parseJsonObject(join(codexHome, "models_cache.json"));
  const cachedEntries = Array.isArray(cache?.models) ? cache.models : [];
  const cachedSlugs = cachedEntries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (record.visibility === "hide") return [];
    const slug = record.slug ?? record.id;
    return isSafeCliModelName(slug) ? [slug] : [];
  });

  const base = cachedSlugs.length > 0 ? cachedSlugs : FALLBACK_CLI_MODELS.codex;
  const models = uniqueModels([defaultModel, ...base]);
  return { models, defaultModel: defaultModel ?? models[0] };
}

function discoverClaudeModels(home: string): CliModelDiscovery {
  const settings = parseJsonObject(join(home, ".claude", "settings.json"));
  const defaultModel = isSafeCliModelName(settings?.model) ? settings.model : undefined;
  const models = uniqueModels([defaultModel, ...FALLBACK_CLI_MODELS.claude]);
  return { models, defaultModel };
}

function discoverGeminiModels(home: string): CliModelDiscovery {
  const settings = parseJsonObject(join(home, ".gemini", "settings.json"));
  const modelSetting = settings?.model;
  const configured = typeof modelSetting === "string"
    ? modelSetting
    : modelSetting && typeof modelSetting === "object" && !Array.isArray(modelSetting)
      ? (modelSetting as Record<string, unknown>).name
      : undefined;
  const defaultModel = isSafeCliModelName(configured) ? configured : undefined;
  const models = uniqueModels([defaultModel, ...FALLBACK_CLI_MODELS.gemini]);
  return { models, defaultModel };
}

function discoverOpenCodeModels(home: string, env: NodeJS.ProcessEnv): CliModelDiscovery {
  const configBase = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : join(home, ".config");
  const settings = parseJsonObject(join(configBase, "opencode", "opencode.json"))
    ?? (env.APPDATA ? parseJsonObject(join(env.APPDATA, "opencode", "opencode.json")) : undefined);
  const defaultModel = isSafeCliModelName(settings?.model) ? settings.model : undefined;
  const models = uniqueModels([defaultModel, ...FALLBACK_CLI_MODELS.opencode]);
  return { models, defaultModel };
}

export function discoverCliModels(
  id: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): CliModelDiscovery {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  switch (id) {
    case "codex":
      return discoverCodexModels(home, env);
    case "claude":
      return discoverClaudeModels(home);
    case "gemini":
      return discoverGeminiModels(home);
    case "opencode":
      return discoverOpenCodeModels(home, env);
    default: {
      const preset = FALLBACK_CLI_MODELS[id];
      return { models: preset ? [...preset] : [] };
    }
  }
}
