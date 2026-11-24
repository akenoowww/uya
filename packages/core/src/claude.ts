import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function claudeIsolationArgs(cwd: string): Promise<string[]> {
  const mcpConfig = "uya-empty-mcp.json";
  const settings = "uya-claude-settings.json";
  await Promise.all([
    writeFile(join(cwd, mcpConfig), '{"mcpServers":{}}', { mode: 0o600 }),
    writeFile(join(cwd, settings), '{"disableAllHooks":true}', { mode: 0o600 }),
  ]);
  return [
    "--setting-sources", "user", "--disable-slash-commands",
    "--tools", "", "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--disallowedTools", "mcp__*", "--settings", settings,
    "--no-session-persistence", "--no-chrome",
  ];
}
