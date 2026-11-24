import { Button, Combobox, Group, Text, useCombobox } from "@mantine/core";
import { Brain, CaretDown, Check } from "@phosphor-icons/react";
import type { EffortLevel, Provider } from "@ide/protocol";

const AUTO_VALUE = "__uya_effort_auto__";

export const EFFORT_META: Readonly<Record<EffortLevel, { short: string; label: string; hint: string }>> = {
  minimal: { short: "Min", label: "Minimal", hint: "Fastest, minimal or no thinking" },
  low: { short: "Low", label: "Low", hint: "Quick responses with light reasoning" },
  medium: { short: "Med", label: "Medium", hint: "Balanced speed and reasoning depth" },
  high: { short: "High", label: "High", hint: "Deep reasoning for complex tasks" },
  xhigh: { short: "XHigh", label: "Extra High", hint: "Extended deep reasoning" },
  max: { short: "Max", label: "Max", hint: "Maximum reasoning depth" },
};

export const ALL_EFFORTS: readonly EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function resolveSupportedEfforts(provider: Provider | undefined, model: string | undefined): EffortLevel[] {
  if (!provider) return [];
  if (model && provider.modelEfforts && Object.hasOwn(provider.modelEfforts, model)) {
    return provider.modelEfforts[model];
  }
  return provider.supportedEfforts ?? [];
}

export function parseEffortArg(value: string): EffortLevel | "auto" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "default") return "auto";
  if (normalized === "min" || normalized === "off" || normalized === "none") return "minimal";
  if (normalized === "med") return "medium";
  if (ALL_EFFORTS.includes(normalized as EffortLevel)) return normalized as EffortLevel;
  return null;
}

interface Props {
  paneId: string;
  provider: Provider | undefined;
  model: string | undefined;
  effort: EffortLevel | undefined;
  onChange: (effort: EffortLevel | undefined) => void;
}

export function EffortPicker({ paneId, provider, model, effort, onChange }: Props) {
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });
  const supported = resolveSupportedEfforts(provider, model);
  if (!provider || !supported.length) return null;

  const activeEffort = effort && supported.includes(effort) ? effort : undefined;
  const defaultLabel = provider.defaultEffort ? EFFORT_META[provider.defaultEffort].short : "Auto";
  const triggerText = activeEffort ? EFFORT_META[activeEffort].short : defaultLabel;

  return (
    <Combobox
      store={combobox}
      withinPortal
      width={220}
      position="bottom-start"
      onOptionSubmit={(value) => {
        onChange(value === AUTO_VALUE ? undefined : (value as EffortLevel));
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target withAriaAttributes={false}>
        <Button
          size="compact-xs"
          variant={activeEffort ? "light" : "default"}
          color={activeEffort ? "iris" : "gray"}
          className="mantine-effort-trigger"
          data-effort-trigger={paneId}
          aria-label="Reasoning effort for split"
          title={
            activeEffort
              ? `Reasoning effort: ${EFFORT_META[activeEffort].label}`
              : `Reasoning effort: Auto${provider.defaultEffort ? ` (${EFFORT_META[provider.defaultEffort].label})` : ""}`
          }
          leftSection={<Brain size={12} weight={activeEffort ? "duotone" : "regular"} />}
          rightSection={<CaretDown size={9} weight="bold" />}
          onClick={() => combobox.toggleDropdown()}
        >
          {triggerText}
        </Button>
      </Combobox.Target>

      <Combobox.Dropdown className="mantine-dropdown">
        <Combobox.Options>
          <Combobox.Option value={AUTO_VALUE} active={!activeEffort} className="mantine-option">
            <Group gap={6} justify="space-between" wrap="nowrap">
              <div>
                <Text size="xs" fw={550}>
                  Auto{provider.defaultEffort ? ` (${EFFORT_META[provider.defaultEffort].label})` : ""}
                </Text>
                <Text size="10px" c="dimmed">Use provider default</Text>
              </div>
              {!activeEffort && <Check size={12} weight="bold" color="var(--accent)" />}
            </Group>
          </Combobox.Option>
          {supported.map((level) => {
            const meta = EFFORT_META[level];
            const selected = activeEffort === level;
            return (
              <Combobox.Option value={level} key={level} active={selected} className="mantine-option">
                <Group gap={6} justify="space-between" wrap="nowrap">
                  <div>
                    <Text size="xs" fw={550}>{meta.label}</Text>
                    <Text size="10px" c="dimmed">{meta.hint}</Text>
                  </div>
                  {selected && <Check size={12} weight="bold" color="var(--accent)" />}
                </Group>
              </Combobox.Option>
            );
          })}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
