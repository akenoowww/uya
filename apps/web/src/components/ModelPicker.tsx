import { useMemo, useState } from "react";
import { Button, Combobox, Group, ScrollArea, Text, useCombobox } from "@mantine/core";
import { CaretDown, Check, MagnifyingGlass, Plus, Sparkle } from "@phosphor-icons/react";
import type { Provider } from "@ide/protocol";
import { resolveModel, shortModelName } from "../workbenchStore";

const DEFAULT_VALUE = "__uya_cli_default__";
const CUSTOM_PREFIX = "__uya_custom__:";

interface Props {
  paneId: string;
  provider: Provider | undefined;
  configuredModel: string | undefined;
  onChange: (model: string | undefined) => void;
}

export function ModelPicker({ paneId, provider, configuredModel, onChange }: Props) {
  const [query, setQuery] = useState("");
  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setQuery("");
    },
    onDropdownOpen: () => {
      combobox.focusSearchInput();
    },
  });

  const models = provider?.models ?? [];
  const activeModel = resolveModel(provider, configuredModel);
  const isCli = provider?.kind === "cli";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((item) => item.toLowerCase().includes(q));
  }, [models, query]);

  if (!provider || (!models.length && !isCli)) return null;

  const trimmedQuery = query.trim();
  const validCustom = isCli
    && trimmedQuery.length > 0
    && !trimmedQuery.startsWith("-")
    && !/\s/.test(trimmedQuery)
    && !models.includes(trimmedQuery);

  const label = activeModel
    ? shortModelName(activeModel)
    : provider.defaultModel
      ? `Auto (${shortModelName(provider.defaultModel)})`
      : "Default";

  function handleSelect(val: string) {
    if (val === DEFAULT_VALUE) onChange(undefined);
    else if (val.startsWith(CUSTOM_PREFIX)) onChange(val.slice(CUSTOM_PREFIX.length));
    else onChange(val);
    combobox.closeDropdown();
  }

  return (
    <Combobox
      store={combobox}
      withinPortal
      width={275}
      position="bottom-start"
      onOptionSubmit={handleSelect}
    >
      <Combobox.Target withAriaAttributes={false}>
        <Button
          size="compact-xs"
          variant="default"
          className="mantine-model-trigger"
          data-model-trigger={paneId}
          aria-label="Model version for split"
          title={activeModel ? `Model: ${activeModel}` : `Default CLI model${provider.defaultModel ? ` (${provider.defaultModel})` : ""}`}
          rightSection={<CaretDown size={10} weight="bold" />}
          onClick={() => combobox.toggleDropdown()}
        >
          <span className="model-trigger-label">{label}</span>
        </Button>
      </Combobox.Target>

      <Combobox.Dropdown className="mantine-dropdown">
        <Combobox.Search
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={isCli ? "Filter or type model ID…" : "Filter local models…"}
          leftSection={<MagnifyingGlass size={13} />}
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              if (filtered.length === 0 && validCustom) {
                event.preventDefault();
                handleSelect(`${CUSTOM_PREFIX}${trimmedQuery}`);
              }
            }
          }}
        />
        <Combobox.Options>
          <ScrollArea.Autosize mah={250} type="auto">
            {isCli && !trimmedQuery && (
              <Combobox.Option value={DEFAULT_VALUE} active={!activeModel} className="mantine-option">
                <Group gap={7} wrap="nowrap" justify="space-between">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Sparkle size={12} weight="duotone" color="var(--accent)" />
                    <Text size="xs" ff="monospace" truncate="end">CLI default</Text>
                    {provider.defaultModel && (
                      <Text size="10px" c="dimmed" ff="monospace" truncate="end">{provider.defaultModel}</Text>
                    )}
                  </Group>
                  {!activeModel && <Check size={12} weight="bold" color="var(--accent)" />}
                </Group>
              </Combobox.Option>
            )}

            {filtered.map((item) => {
              const selected = activeModel === item;
              return (
                <Combobox.Option value={item} key={item} active={selected} className="mantine-option">
                  <Group gap={6} wrap="nowrap" justify="space-between">
                    <Text size="11px" ff="monospace" truncate="end">{item}</Text>
                    {selected && <Check size={12} weight="bold" color="var(--accent)" />}
                  </Group>
                </Combobox.Option>
              );
            })}

            {validCustom && (
              <Combobox.Option value={`${CUSTOM_PREFIX}${trimmedQuery}`} className="mantine-option">
                <Group gap={6} wrap="nowrap">
                  <Plus size={12} weight="bold" color="var(--accent)" />
                  <Text size="xs" c="iris.3" truncate="end">Use “{trimmedQuery}”</Text>
                </Group>
              </Combobox.Option>
            )}

            {!filtered.length && !validCustom && (
              <Combobox.Empty>No matching models</Combobox.Empty>
            )}
          </ScrollArea.Autosize>
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
