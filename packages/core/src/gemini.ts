import type { EffortLevel, ExecutionMode } from "@ide/protocol";
import { lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeEffortLevel, type AdapterRequest } from "./provider-adapter";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export const GEMINI_THINKING_LEVELS: readonly GeminiThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const GEMINI_CLI_THINKING_LEVELS: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

function isSafeModelId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !value.startsWith("-")
    && !/[\s\x00-\x1f\x7f]/.test(value);
}

// ---------------------------------------------------------------------------
// Gemini CLI (`@google/gemini-cli`, OAuth / API key / Vertex AI)
// ---------------------------------------------------------------------------

const geminiCliThinkingLevels = {
  minimal: { level: "MINIMAL", budget: 512 },
  low: { level: "LOW", budget: 1024 },
  medium: { level: "MEDIUM", budget: 4096 },
  high: { level: "HIGH", budget: 8192 },
  xhigh: { level: "HIGH", budget: 8192 },
  max: { level: "HIGH", budget: 8192 },
} as const satisfies Record<EffortLevel, { level: string; budget: number }>;

function thinkingOverride(model: string, thinkingConfig: { thinkingLevel: string } | { thinkingBudget: number }) {
  return { match: { model }, modelConfig: { generateContentConfig: { thinkingConfig } } };
}

function geminiCliModelConfigs(effort: EffortLevel | undefined) {
  const selected = normalizeEffortLevel(effort);
  if (!selected) return;
  const { level: thinkingLevel, budget: thinkingBudget } = geminiCliThinkingLevels[selected];
  // Match Gemini CLI's built-in base aliases so overrides apply to manual models and Auto routing.
  const customOverrides = [
    thinkingOverride("chat-base-3", { thinkingLevel }),
    thinkingOverride("chat-base-2.5", { thinkingBudget }),
  ];
  if (thinkingLevel === "MINIMAL" || thinkingLevel === "MEDIUM") {
    customOverrides.push(thinkingOverride("gemini-3-pro-preview", { thinkingLevel: "LOW" }));
  }
  if (thinkingLevel === "MINIMAL") {
    for (const model of ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-3.8-flash"]) {
      customOverrides.push(thinkingOverride(model, { thinkingLevel: "LOW" }));
    }
  }
  return { customOverrides };
}

export function geminiHasUnmanagedSettings(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return false;
  const path = process.platform === "darwin" ? "/Library/Application Support/GeminiCli/settings.json"
    : process.platform === "win32" ? join(env.ProgramData || "C:\\ProgramData", "gemini-cli", "settings.json")
    : process.platform === "linux" ? "/etc/gemini-cli/settings.json" : undefined;
  if (!path) return false;
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

const geminiReadTools = ["read_file", "list_directory", "glob", "grep_search", "search_file_content"];
const geminiTools: Record<ExecutionMode, string[]> = {
  isolated: [],
  "read-only": geminiReadTools,
  agent: [...geminiReadTools, "replace", "write_file"],
};

function geminiToolPolicy(tools: readonly string[]): string {
  // Gemini CLI accepts priorities from 0 through 999.
  const allow = tools.length
    ? `[[rule]]\ntoolName = ${JSON.stringify(tools)}\ndecision = "allow"\npriority = 999\n\n`
    : "";
  return `${allow}[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = ${tools.length ? 998 : 999}\n`;
}

export async function geminiCliInvocation(
  scratchDir: string,
  protocol: "stream-json" | "acp" = "stream-json",
  effort?: EffortLevel,
  accessMode: ExecutionMode = "isolated",
) {
  const settingsPath = join(scratchDir, "settings.json");
  const policyPath = join(scratchDir, "uya-read-only.toml");
  const disabledName = `uya-disabled-${crypto.randomUUID()}`;
  const tools = geminiTools[accessMode];
  const settings = {
    hooksConfig: { enabled: false },
    mcp: { serverCommand: "" },
    context: { fileName: `${disabledName}.md`, includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false },
    tools: { core: tools.length ? tools : [disabledName], allowed: [], discoveryCommand: "", callCommand: "" },
    skills: { enabled: false },
    ide: { enabled: false },
    experimental: { enableAgents: false, adk: { agentSessionNoninteractiveEnabled: false } },
    telemetry: { enabled: false },
    privacy: { usageStatisticsEnabled: false },
    modelConfigs: geminiCliModelConfigs(effort),
  };
  await Promise.all([
    writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }),
    writeFile(policyPath, geminiToolPolicy(tools), { mode: 0o600 }),
  ]);
  return {
    settingsPath,
    args: [
      "--extensions", "none", "--allowed-mcp-server-names", disabledName,
      "--policy", policyPath, "--approval-mode", "default",
      ...(protocol === "acp" ? ["--acp"] : ["--output-format", "stream-json"]),
    ],
  };
}

export function parseGeminiCliModelsListJson(raw: string): string[] {
  const seen = new Set<string>();
  const collect = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === "string") {
      if (isSafeModelId(value) && value.toLowerCase() !== "default") seen.add(value);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.models)) {
      for (const item of obj.models) collect(item);
      return;
    }
    const candidate = obj.modelId ?? obj.id ?? obj.value;
    if (isSafeModelId(candidate) && candidate.toLowerCase() !== "default") {
      seen.add(candidate);
    }
  };
  try {
    collect(JSON.parse(raw));
  } catch {
    // Ignore non-JSON output from older Gemini CLI builds without `models list -o json`.
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Gemini API (`gemini-api` CLI, Interactions API)
// ---------------------------------------------------------------------------

export interface DiscoveredGeminiModel {
  id: string;
  thinking?: boolean;
}

export function parseGeminiSchemaThinkingLevels(raw: string): EffortLevel[] {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const defs = parsed.$defs;
    if (!defs || typeof defs !== "object" || Array.isArray(defs)) return [];
    const thinkingLevel = (defs as Record<string, unknown>).ThinkingLevel;
    if (!thinkingLevel || typeof thinkingLevel !== "object" || Array.isArray(thinkingLevel)) return [];
    const values = (thinkingLevel as Record<string, unknown>).enum;
    if (!Array.isArray(values)) return [];
    const levels: EffortLevel[] = [];
    for (const value of values) {
      const normalized = normalizeEffortLevel(value);
      if (normalized && !levels.includes(normalized)) levels.push(normalized);
    }
    return levels;
  } catch {
    return [];
  }
}

export function parseGeminiModelsListJson(raw: string): DiscoveredGeminiModel[] {
  const seen = new Map<string, DiscoveredGeminiModel>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.models)) {
      for (const item of obj.models) collect(item);
      return;
    }
    const rawName = typeof obj.name === "string" ? obj.name : typeof obj.id === "string" ? obj.id : undefined;
    if (!rawName) return;
    const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
    if (!isSafeModelId(id)) return;

    // When the live API reports supportedGenerationMethods, keep models capable of text generation.
    if (Array.isArray(obj.supportedGenerationMethods) && obj.supportedGenerationMethods.length > 0) {
      const methods = obj.supportedGenerationMethods.filter((m): m is string => typeof m === "string");
      const supportsGeneration = methods.some((m) =>
        m === "generateContent" || m === "streamGenerateContent" || m === "interactions",
      );
      if (!supportsGeneration) return;
    }

    const thinking = typeof obj.thinking === "boolean" ? obj.thinking : undefined;
    const prev = seen.get(id);
    if (!prev || (prev.thinking === undefined && thinking !== undefined)) {
      seen.set(id, { id, thinking });
    }
  };

  try {
    collect(JSON.parse(raw));
  } catch {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        collect(JSON.parse(trimmed));
      } catch {
        // Ignore non-JSON lines.
      }
    }
  }
  return [...seen.values()];
}

export function parseGeminiCatalogJson(raw: string): { models: string[]; defaultModel?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { models: [] };
  }
  if (!Array.isArray(parsed)) return { models: [] };
  const models: string[] = [];
  let defaultModel: string | undefined;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const group = typeof entry.group === "string" ? entry.group : "";
    if (group && group !== "Gemini" && group !== "Gemma") continue;
    if (!isSafeModelId(entry.value)) continue;
    if (!models.includes(entry.value)) models.push(entry.value);
    if (entry.default === true) defaultModel = entry.value;
  }
  return { models, defaultModel };
}

export function resolveGeminiThinkingLevel(effort: EffortLevel | undefined): GeminiThinkingLevel | undefined {
  const selected = normalizeEffortLevel(effort);
  if (!selected) return undefined;
  return selected === "max" ? "xhigh" : selected;
}

export interface GeminiInteractionBody {
  store: false;
  stream: true;
  input: Array<{
    type: "user_input" | "model_output";
    content: Array<{ type: "text"; text: string }>;
  }>;
  generation_config?: {
    thinking_level?: GeminiThinkingLevel;
    thinking_summaries?: "auto";
  };
}

export function buildGeminiInteractionBody(
  request: Pick<AdapterRequest, "prompt" | "messages" | "provider" | "model" | "effort">,
): GeminiInteractionBody {
  const input: GeminiInteractionBody["input"] = [
    ...(request.messages ?? []).map((message) => ({
      type: (message.role === "assistant" ? "model_output" : "user_input") as "user_input" | "model_output",
      content: [{ type: "text" as const, text: message.content }],
    })),
    {
      type: "user_input",
      content: [{ type: "text", text: request.prompt }],
    },
  ];

  const thinkingLevel = resolveGeminiThinkingLevel(request.effort);
  const modelKey = request.model ?? request.provider.defaultModel;
  const modelSupportsThinking = Boolean(
    modelKey && request.provider.modelEfforts?.[modelKey]?.length,
  );
  const generationConfig = thinkingLevel || modelSupportsThinking
    ? {
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      thinking_summaries: "auto" as const,
    }
    : undefined;

  return {
    store: false,
    stream: true,
    input,
    ...(generationConfig ? { generation_config: generationConfig } : {}),
  };
}
