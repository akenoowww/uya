export interface SlashCommand {
  name: string;
  aliases?: readonly string[];
  usage: string;
  description: string;
  takesArg?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "new", aliases: ["clear"], usage: "/new", description: "Start a fresh conversation in this split" },
  { name: "model", usage: "/model <version>", description: "Switch model version (or /model default)", takesArg: true },
  { name: "effort", usage: "/effort <level>", description: "Set reasoning effort (auto, minimal, low, medium, high, xhigh, max)", takesArg: true },
  { name: "provider", usage: "/provider <name>", description: "Switch provider for this split", takesArg: true },
  { name: "terminal", usage: "/terminal", description: "Toggle interactive terminal mode in this split" },
  { name: "split", usage: "/split", description: "Open a new model split" },
  { name: "broadcast", usage: "/broadcast", description: "Toggle Broadcast multi-model mode" },
  { name: "judge", usage: "/judge", description: "Cross-review or synthesize latest broadcast responses" },
  { name: "git", usage: "/git", description: "Toggle Git changes sidebar" },
  { name: "prompts", usage: "/prompts", description: "Open Prompt Library" },
  { name: "providers", usage: "/providers", description: "Manage providers & local runtimes" },
  { name: "rules", usage: "/rules", description: "Edit routing rules" },
  { name: "shortcuts", aliases: ["help"], usage: "/shortcuts", description: "Show keyboard shortcuts" },
];

export function matchSlashSuggestions(input: string): SlashCommand[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const token = input.slice(1).split(/\s+/)[0].toLowerCase();
  if (input.includes(" ")) {
    return SLASH_COMMANDS.filter((cmd) => cmd.takesArg && (cmd.name === token || cmd.aliases?.includes(token)));
  }
  return SLASH_COMMANDS.filter((cmd) =>
    cmd.name.startsWith(token) || Boolean(cmd.aliases?.some((alias) => alias.startsWith(token))),
  );
}

export function parseSlashInvocation(input: string): { command: SlashCommand; arg: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return null;
  const space = trimmed.indexOf(" ");
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
  const command = SLASH_COMMANDS.find((cmd) => cmd.name === name || cmd.aliases?.includes(name));
  if (!command) return null;
  if (!command.takesArg && arg) return null;
  return { command, arg };
}
