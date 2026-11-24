import type { EffortLevel } from "@ide/protocol";
import { lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeEffortLevel } from "./provider-adapter";

const thinkingLevels = {
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

function geminiModelConfigs(effort: EffortLevel | undefined) {
  const selected = normalizeEffortLevel(effort);
  if (!selected) return;
  const { level: thinkingLevel, budget: thinkingBudget } = thinkingLevels[selected];
  // Match Gemini CLI's aliases so the override also applies when Auto selects a model.
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

export async function geminiInvocation(
  directory: string, protocol: "stream-json" | "acp" = "stream-json", effort?: EffortLevel,
) {
  const settingsPath = join(directory, "settings.json");
  const policyPath = join(directory, "uya-read-only.toml");
  const disabledName = `uya-disabled-${crypto.randomUUID()}`;
  const settings = {
    hooksConfig: { enabled: false },
    mcp: { serverCommand: "" },
    context: { fileName: `${disabledName}.md`, includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false },
    tools: { core: [disabledName], allowed: [], discoveryCommand: "", callCommand: "" },
    skills: { enabled: false },
    ide: { enabled: false },
    experimental: { enableAgents: false, adk: { agentSessionNoninteractiveEnabled: false } },
    telemetry: { enabled: false },
    privacy: { usageStatisticsEnabled: false },
    modelConfigs: geminiModelConfigs(effort),
  };
  const policy = '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n';
  await Promise.all([
    writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }),
    writeFile(policyPath, policy, { mode: 0o600 }),
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

