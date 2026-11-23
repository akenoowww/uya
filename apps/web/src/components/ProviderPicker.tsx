import { Badge, Combobox, Group, InputBase, ScrollArea, Text, useCombobox } from "@mantine/core";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { Provider } from "@ide/protocol";
import { ProviderIcon } from "./ProviderIcon";

interface Props {
  value: string | undefined;
  providers: Provider[];
  onChange: (providerId: string) => void;
}

export function ProviderPicker({ value, providers, onChange }: Props) {
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });
  const available = providers.filter((entry) => entry.available);
  const current = available.find((entry) => entry.id === value);

  return (
    <Combobox
      store={combobox}
      withinPortal
      width={230}
      position="bottom-start"
      onOptionSubmit={(next) => {
        onChange(next);
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target>
        <InputBase
          component="button"
          type="button"
          size="xs"
          variant="unstyled"
          className="mantine-provider-trigger"
          disabled={!available.length}
          aria-label="Provider for split"
          pointer
          onClick={() => combobox.toggleDropdown()}
          rightSection={<CaretDown size={11} weight="bold" />}
          rightSectionPointerEvents="none"
          rightSectionWidth={20}
        >
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <ProviderIcon providerId={current?.id} size={13} />
            <Text size="xs" fw={600} truncate="end">
              {current?.name ?? "Choose provider"}
            </Text>
          </Group>
        </InputBase>
      </Combobox.Target>

      <Combobox.Dropdown className="mantine-dropdown">
        <Combobox.Options>
          <ScrollArea.Autosize mah={280} type="auto">
            {available.map((entry) => {
              const selected = entry.id === value;
              const badgeLabel = entry.structured ? (entry.kind === "runtime" ? "Local" : "CLI") : "TUI";
              return (
                <Combobox.Option value={entry.id} key={entry.id} active={selected} className="mantine-option">
                  <Group gap={8} wrap="nowrap" justify="space-between">
                    <Group gap={8} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                      <ProviderIcon providerId={entry.id} size={13} />
                      <Text size="xs" fw={520} truncate="end">{entry.name}</Text>
                    </Group>
                    <Group gap={6} wrap="nowrap">
                      <Badge size="xs" variant="light" color={entry.kind === "runtime" ? "teal" : "gray"} radius="sm">
                        {badgeLabel}
                      </Badge>
                      {selected && <Check size={12} weight="bold" color="var(--accent)" />}
                    </Group>
                  </Group>
                </Combobox.Option>
              );
            })}
          </ScrollArea.Autosize>
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
