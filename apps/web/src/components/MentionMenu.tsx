import { Badge, Group, Paper, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { FileCode, GitDiff, TerminalWindow } from "@phosphor-icons/react";

export type MentionItem =
  | { kind: "git-diff"; id: string; label: string; description: string; staged: boolean }
  | { kind: "terminal"; id: string; label: string; description: string }
  | { kind: "file"; id: string; label: string; path: string };

export function extractMentionQuery(value: string, cursor: number): { start: number; query: string } | null {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = before.length - query.length - 1;
  return { start, query };
}

export function MentionMenu({
  items,
  selectedIndex,
  onSelect,
}: {
  items: readonly MentionItem[];
  selectedIndex: number;
  onSelect: (item: MentionItem) => void;
}) {
  if (!items.length) return null;
  return (
    <Paper className="slash-menu mention-menu" role="listbox" aria-label="Context mentions" shadow="lg" withBorder radius="md" p={4}>
      <ScrollArea.Autosize mah={220} type="auto">
        <Stack gap={1}>
          {items.map((item, index) => (
            <UnstyledButton
              key={item.id}
              role="option"
              aria-selected={index === selectedIndex}
              className={`slash-item${index === selectedIndex ? " selected" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(item);
              }}
            >
              <Group justify="space-between" gap="xs" wrap="nowrap" w="100%">
                <Group gap={7} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                  {item.kind === "git-diff" && <GitDiff size={13} weight="duotone" color="var(--accent)" />}
                  {item.kind === "terminal" && <TerminalWindow size={13} weight="duotone" color="var(--positive)" />}
                  {item.kind === "file" && <FileCode size={13} weight="duotone" color="#92adc9" />}
                  <Text size="xs" ff="monospace" fw={560} truncate="end">
                    {item.label}
                  </Text>
                </Group>
                {item.kind === "file" ? (
                  <Text size="10px" c="dimmed" truncate="end" style={{ maxWidth: "46%" }}>
                    {item.path}
                  </Text>
                ) : (
                  <Badge size="xs" variant="light" color={item.kind === "terminal" ? "teal" : "iris"} radius="sm">
                    {item.description}
                  </Badge>
                )}
              </Group>
            </UnstyledButton>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}
