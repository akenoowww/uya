import { Code, Group, Paper, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import type { SlashCommand } from "../slashCommands";

interface Props {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashMenu({ commands, selectedIndex, onSelect }: Props) {
  if (!commands.length) return null;
  return (
    <Paper className="slash-menu" role="listbox" aria-label="Slash commands" shadow="lg" radius="md" withBorder p={4}>
      <ScrollArea.Autosize mah={220} type="auto">
        <Stack gap={1}>
          {commands.map((command, index) => (
            <UnstyledButton
              key={command.name}
              role="option"
              aria-selected={index === selectedIndex}
              className={`slash-item${index === selectedIndex ? " selected" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(command);
              }}
            >
              <Group justify="space-between" gap="xs" wrap="nowrap" w="100%">
                <Code bg="dark.8" c="iris.2" fz="11px">{command.usage}</Code>
                <Text size="xs" c="dimmed" truncate="end">{command.description}</Text>
              </Group>
            </UnstyledButton>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}
