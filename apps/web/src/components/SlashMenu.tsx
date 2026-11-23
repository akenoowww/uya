import { Code, Paper, Text } from "@mantine/core";
import type { SlashCommand } from "../slashCommands";

interface Props {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashMenu({ commands, selectedIndex, onSelect }: Props) {
  if (!commands.length) return null;
  return (
    <Paper className="slash-menu" role="listbox" aria-label="Slash commands" shadow="lg" radius="md" withBorder>
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          className={`slash-item ${index === selectedIndex ? "selected" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(command);
          }}
        >
          <Code bg="dark.8" c="iris.2">{command.usage}</Code>
          <Text size="xs" c="dimmed" truncate="end">{command.description}</Text>
        </button>
      ))}
    </Paper>
  );
}
