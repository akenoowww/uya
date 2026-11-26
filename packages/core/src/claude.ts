import type { ExecutionMode } from "@ide/protocol";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError, type McpStdioServerSpec } from "./provider-adapter";

const claudeTools: Record<ExecutionMode, string> = {
  isolated: "",
  "read-only": "Read,Glob,Grep,LS",
  agent: "Read,Edit,Write,Glob,Grep,Bash",
};

export function mcpServersForMode(
  mode: ExecutionMode, servers: readonly McpStdioServerSpec[] | undefined,
): readonly McpStdioServerSpec[] {
  if (mode === "isolated" || !servers?.length) return [];
  if (servers.some(({ name }) => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name))) {
    throw new AdapterError("Invalid MCP server name.");
  }
  return servers;
}

export async function claudeIsolationArgs(
  scratchDir: string, accessMode: ExecutionMode = "isolated", mcpServers?: readonly McpStdioServerSpec[],
): Promise<string[]> {
  const activeMcpServers = mcpServersForMode(accessMode, mcpServers);
  const mcpConfig = activeMcpServers.length ? "uya-claude-mcp.json" : "uya-empty-mcp.json";
  const settings = "uya-claude-settings.json";
  const mcpPath = join(scratchDir, mcpConfig);
  const settingsPath = join(scratchDir, settings);
  const mcpTools = activeMcpServers.map(({ name }) => `mcp__${name}__*`);
  await Promise.all([
    writeFile(mcpPath, JSON.stringify({
      mcpServers: Object.fromEntries(activeMcpServers.map(({ name, command, args, env }) => [
        name, { command, args, ...(env ? { env } : {}) },
      ])),
    }), { mode: 0o600 }),
    writeFile(settingsPath, '{"disableAllHooks":true}', { mode: 0o600 }),
  ]);
  const isolated = accessMode === "isolated";
  const permissionMode = accessMode === "agent" ? "acceptEdits" : "plan";
  return [
    "--setting-sources", "user", "--disable-slash-commands",
    "--tools", claudeTools[accessMode],
    ...(isolated ? [] : ["--permission-mode", permissionMode]),
    "--strict-mcp-config", "--mcp-config", isolated ? mcpConfig : mcpPath,
    ...(mcpTools.length ? ["--allowedTools", mcpTools.join(",")] : ["--disallowedTools", "mcp__*"]),
    "--settings", isolated ? settings : settingsPath,
    "--no-session-persistence", "--no-chrome",
  ];
}
