import { Combobox, Group, InputBase, Text, useCombobox } from "@mantine/core";
import { CaretDown, Check, Eye, Lock, Wrench } from "@phosphor-icons/react";
import type { ExecutionMode, Provider } from "@ide/protocol";
import { resolveAccessMode } from "../workbenchStore";

export const ACCESS_MODE_META: Readonly<Record<ExecutionMode, { label: string; short: string; hint: string }>> = {
  isolated: {
    label: "Isolated",
    short: "Chat",
    hint: "Disposable temp folder, 0 tools, only explicitly attached @context",
  },
  "read-only": {
    label: "Explore",
    short: "Explore",
    hint: "Read-only workspace access — agents can inspect files & search without editing",
  },
  agent: {
    label: "Agent",
    short: "Agent",
    hint: "Workspace edit mode with inline approval cards and automatic pre-run checkpoints",
  },
};

export function parseAccessModeArg(raw: string): ExecutionMode | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "isolated" || value === "chat" || value === "sandbox") return "isolated";
  if (value === "read-only" || value === "readonly" || value === "ro" || value === "explore" || value === "ask") return "read-only";
  if (value === "agent" || value === "edit" || value === "write") return "agent";
  return undefined;
}

function ModeIcon({ mode, size = 12 }: { mode: ExecutionMode; size?: number }) {
  if (mode === "agent") return <Wrench size={size} weight="duotone" color="var(--accent)" aria-hidden="true" />;
  if (mode === "read-only") return <Eye size={size} weight="duotone" color="var(--positive)" aria-hidden="true" />;
  return <Lock size={size} weight="duotone" color="var(--muted)" aria-hidden="true" />;
}

const ALL_MODES: readonly ExecutionMode[] = ["isolated", "read-only", "agent"];

export function AccessModePicker({
  paneId,
  provider,
  accessMode,
  hasWorkspace,
  onChange,
}: {
  paneId: string;
  provider: Provider | undefined;
  accessMode: ExecutionMode | undefined;
  hasWorkspace: boolean;
  onChange: (mode: ExecutionMode) => void;
}) {
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });
  const effective = resolveAccessMode(provider, accessMode, hasWorkspace);
  const supported = provider?.supportedModes ?? ["isolated"];
  const meta = ACCESS_MODE_META[effective];

  if (!provider?.structured) return null;

  return (
    <Combobox
      store={combobox}
      withinPortal
      position="bottom-start"
      width={276}
      onOptionSubmit={(value) => {
        onChange(value as ExecutionMode);
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target>
        <InputBase
          component="button"
          type="button"
          size="xs"
          variant="default"
          className="mantine-effort-trigger"
          data-mode-trigger={paneId}
          aria-label={`Workspace access mode: ${meta.label}`}
          title={hasWorkspace ? `${meta.label}: ${meta.hint}` : "Open a project folder to unlock Explore and Agent modes"}
          leftSection={<ModeIcon mode={effective} size={12} />}
          leftSectionWidth={22}
          rightSection={<CaretDown size={10} weight="bold" aria-hidden="true" />}
          rightSectionWidth={18}
          onClick={() => combobox.toggleDropdown()}
        >
          <span>{meta.short}</span>
        </InputBase>
      </Combobox.Target>

      <Combobox.Dropdown className="mantine-dropdown">
        <Combobox.Header>
          <Text size="10px" fw={650} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
            Workspace access mode
          </Text>
        </Combobox.Header>
        <Combobox.Options>
          {ALL_MODES.map((mode) => {
            const info = ACCESS_MODE_META[mode];
            const modeSupported = supported.includes(mode);
            const disabled = mode !== "isolated" && (!hasWorkspace || !modeSupported);
            const selected = effective === mode;
            return (
              <Combobox.Option key={mode} value={mode} disabled={disabled} className="mantine-option">
                <Group gap={8} wrap="nowrap" align="flex-start">
                  <span style={{ marginTop: 2 }}><ModeIcon mode={mode} size={13} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text size="xs" fw={selected ? 650 : 500}>{info.label}</Text>
                      {!modeSupported && mode !== "isolated" && (
                        <Text size="10px" c="dimmed">(uses Workspace Map)</Text>
                      )}
                      {modeSupported && !hasWorkspace && mode !== "isolated" && (
                        <Text size="10px" c="dimmed">(open folder)</Text>
                      )}
                    </Group>
                    <Text size="10px" c="dimmed" lh={1.35}>{info.hint}</Text>
                  </div>
                  {selected && <Check size={12} weight="bold" color="var(--accent)" aria-hidden="true" />}
                </Group>
              </Combobox.Option>
            );
          })}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
