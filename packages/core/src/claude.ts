import type { ExecutionMode } from "@ide/protocol";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const claudeTools: Record<ExecutionMode, string> = {
  isolated: "",
  "read-only": "Read,Glob,Grep,LS",
  agent: "Read,Edit,Write,Glob,Grep,Bash",
};

export async function claudeIsolationArgs(scratchDir: string, accessMode: ExecutionMode = "isolated"): Promise<string[]> {
  const mcpConfig = "uya-empty-mcp.json";
  const settings = "uya-claude-settings.json";
  const mcpPath = join(scratchDir, mcpConfig);
  const settingsPath = join(scratchDir, settings);
  await Promise.all([
    writeFile(mcpPath, '{"mcpServers":{}}', { mode: 0o600 }),
    writeFile(settingsPath, '{"disableAllHooks":true}', { mode: 0o600 }),
  ]);
  const isolated = accessMode === "isolated";
  const permissionMode = accessMode === "agent" ? "acceptEdits" : "plan";
  return [
    "--setting-sources", "user", "--disable-slash-commands",
    "--tools", claudeTools[accessMode],
    ...(isolated ? [] : ["--permission-mode", permissionMode]),
    "--strict-mcp-config", "--mcp-config", isolated ? mcpConfig : mcpPath,
    "--disallowedTools", "mcp__*", "--settings", isolated ? settings : settingsPath,
    "--no-session-persistence", "--no-chrome",
  ];
}
