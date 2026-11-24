import { lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function geminiInvocation(directory: string, protocol: "stream-json" | "acp" = "stream-json") {
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

