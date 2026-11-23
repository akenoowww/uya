import { useImperativeHandle, useState } from "react";
import type { FormEvent } from "react";
import {
  ActionIcon, Alert, Badge, Button, Checkbox, Code, Divider, Group, Kbd,
  Modal, NumberInput, Paper, ScrollArea, Select, Stack, Tabs, Text, Textarea, TextInput,
} from "@mantine/core";
import {
  ArrowClockwise, CaretRight, Keyboard, PencilSimple, PlugsConnected,
  Plus, SlidersHorizontal, Trash,
} from "@phosphor-icons/react";
import type { CustomProviderInput, Provider, RoutingRule, RpcCall } from "@ide/protocol";
import { errorMessage } from "./bridge";
import { ProviderIcon } from "./components/ProviderIcon";
import { isMac, SHORTCUTS } from "./shortcuts";
import { SLASH_COMMANDS } from "./slashCommands";

interface Props {
  providers: Provider[];
  rules: RoutingRule[];
  rpc: RpcCall | undefined;
  onRefresh: () => Promise<void>;
  onRules: (rules: RoutingRule[]) => void;
}

export interface SettingsControls {
  showProviders: () => void;
  showRules: () => void;
  showShortcuts: () => void;
}

type SettingsTab = "providers" | "rules" | "shortcuts";
type ProviderAction = { kind: "create" } | { kind: "edit" | "remove"; provider: Provider };

function CustomProviderForm({ provider, busy, onSave, onCancel }: {
  provider?: Provider;
  busy: boolean;
  onSave: (input: CustomProviderInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [command, setCommand] = useState(provider?.configuredCommand ?? provider?.command ?? "");
  const [argsText, setArgsText] = useState(provider?.terminalArgs?.join("\n") ?? "");
  const [structured, setStructured] = useState(provider?.structuredArgs !== undefined);
  const [structuredText, setStructuredText] = useState(provider?.structuredArgs?.join("\n") ?? "");

  function splitArgs(text: string, previous?: string[]) {
    if (previous && text === previous.join("\n").replace(/\r\n?/g, "\n")) return previous;
    return text ? text.split(/\r?\n/) : [];
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    onSave({
      name: name.trim(),
      command: command.trim(),
      args: splitArgs(argsText, provider?.terminalArgs),
      structuredArgs: structured ? splitArgs(structuredText, provider?.structuredArgs) : undefined,
    });
  }

  return (
    <form onSubmit={submit}>
      <Divider my="sm" />
      <Stack gap="xs">
        <TextInput
          label="Display name"
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="My CLI"
          size="xs"
          autoFocus
        />
        <TextInput
          label="Executable"
          required
          value={command}
          onChange={(event) => setCommand(event.currentTarget.value)}
          placeholder="command or absolute path"
          spellCheck={false}
          size="xs"
        />
        <Textarea
          label="Terminal arguments, one per line"
          description="Use the CLI’s own sign-in. Keep credentials out of arguments."
          rows={2}
          spellCheck={false}
          value={argsText}
          onChange={(event) => setArgsText(event.currentTarget.value)}
          size="xs"
        />
        <Checkbox
          size="xs"
          label="Enable Structured"
          description="Trust this executable to read the prompt from stdin and write its reply to stdout inside a local macOS sandbox."
          checked={structured}
          onChange={(event) => setStructured(event.currentTarget.checked)}
        />
        {structured && (
          <Textarea
            label="Structured arguments, one per line"
            rows={2}
            spellCheck={false}
            value={structuredText}
            onChange={(event) => setStructuredText(event.currentTarget.value)}
            size="xs"
          />
        )}
        <Group justify="flex-end" gap="xs" pt="xs">
          <Button variant="default" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" color="iris" loading={busy}>
            {provider ? "Save provider" : "Add provider"}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function SettingsDialog({ controls, providers, rules, rpc, onRefresh, onRules }: Props & {
  controls: React.RefObject<SettingsControls | null>;
}) {
  const [opened, setOpened] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("providers");
  const [action, setAction] = useState<ProviderAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<RoutingRule[]>([]);
  const candidates = providers.filter((provider) => provider.available && provider.structured);

  function open(nextTab: SettingsTab) {
    setTab(nextTab);
    setAction(null);
    setError("");
    setDraft(rules);
    setOpened(true);
  }

  useImperativeHandle(controls, () => ({
    showProviders: () => open("providers"),
    showRules: () => open("rules"),
    showShortcuts: () => open("shortcuts"),
  }), [rules]);

  async function perform(operation: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function saveProvider(input: CustomProviderInput) {
    if (!rpc || busy) return;
    void perform(async () => {
      if (action?.kind === "edit") await rpc("providers.update", { ...input, id: action.provider.id });
      else await rpc("providers.add", input);
      setAction(null);
      await onRefresh();
    });
  }

  function removeProvider(provider: Provider) {
    if (!rpc || busy) return;
    void perform(async () => {
      await rpc("providers.remove", { id: provider.id });
      setAction(null);
      await onRefresh();
    });
  }

  function updateRule(index: number, patch: Partial<RoutingRule>) {
    setDraft((current) => current.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  }

  const shortcutCategories = ["Navigation", "Splits & Chat", "Workspace"] as const;
  const title = action?.kind === "remove"
    ? `Remove ${action.provider.name}?`
    : tab === "providers"
      ? "Providers"
      : tab === "rules"
        ? "Routing rules"
        : "Keyboard shortcuts";

  return (
    <Modal opened={opened} onClose={() => setOpened(false)} title={title} size={660}>
      {action?.kind === "remove" ? (
        <Stack gap="md" pt="sm">
          <Text size="xs" c="dimmed">
            This removes the provider registration and any routing rules that select it.
          </Text>
          {error && <Alert color="red" variant="light">{error}</Alert>}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" disabled={busy} onClick={() => setAction(null)}>Keep provider</Button>
            <Button color="red" variant="light" loading={busy} onClick={() => removeProvider(action.provider)}>
              Remove provider
            </Button>
          </Group>
        </Stack>
      ) : (
        <Tabs
          value={tab}
          onChange={(value) => {
            if (value) setTab(value as SettingsTab);
            setAction(null);
            setError("");
          }}
        >
          <Tabs.List mb="sm">
            <Tabs.Tab value="providers" leftSection={<PlugsConnected size={14} weight="duotone" />}>
              Providers
            </Tabs.Tab>
            <Tabs.Tab value="rules" leftSection={<SlidersHorizontal size={14} weight="duotone" />}>
              Routing rules
            </Tabs.Tab>
            <Tabs.Tab value="shortcuts" leftSection={<Keyboard size={14} weight="duotone" />}>
              Shortcuts
            </Tabs.Tab>
          </Tabs.List>

          {error && <Alert color="red" variant="light" mb="sm">{error}</Alert>}

          <Tabs.Panel value="providers">
            <Text size="xs" c="dimmed" mb="xs">
              Manage local runtimes, installed CLI agents, and discovered model versions.
            </Text>
            <ScrollArea.Autosize mah="46vh" type="auto" offsetScrollbars>
              <Stack gap={0}>
                {providers.map((provider) => (
                  <div className="provider-row" key={provider.id}>
                    <span className={`state-dot ${provider.available ? "connected" : ""}`} />
                    <ProviderIcon providerId={provider.id} size={14} />
                    <div className="provider-row-info">
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.detail
                          ? provider.detail
                          : provider.models?.length
                            ? `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}${provider.defaultModel ? ` · default ${provider.defaultModel}` : ""}`
                            : provider.command}
                      </small>
                    </div>
                    <Badge
                      size="xs"
                      variant="light"
                      color={provider.available ? (provider.structured ? "iris" : "gray") : "red"}
                    >
                      {provider.structured && provider.terminal
                        ? "Structured · TUI"
                        : provider.structured
                          ? "Structured"
                          : provider.terminal
                            ? "Terminal"
                            : "Unavailable"}
                    </Badge>
                    <Group gap={2} justify="flex-end" wrap="nowrap">
                      {provider.id.startsWith("custom-") && (
                        <>
                          <ActionIcon
                            aria-label={`Edit ${provider.name}`}
                            disabled={busy || !rpc}
                            onClick={() => setAction({ kind: "edit", provider })}
                          >
                            <PencilSimple size={14} />
                          </ActionIcon>
                          <ActionIcon
                            color="red"
                            aria-label={`Remove ${provider.name}`}
                            disabled={busy || !rpc}
                            onClick={() => setAction({ kind: "remove", provider })}
                          >
                            <Trash size={14} />
                          </ActionIcon>
                        </>
                      )}
                    </Group>
                  </div>
                ))}
                {!providers.length && <Text size="xs" c="dimmed" py="md">No providers discovered.</Text>}
              </Stack>
            </ScrollArea.Autosize>

            {action && (
              <CustomProviderForm
                key={action.kind === "edit" ? action.provider.id : "create"}
                provider={action.kind === "edit" ? action.provider : undefined}
                onSave={saveProvider}
                onCancel={() => setAction(null)}
                busy={busy}
              />
            )}

            {!action && (
              <Group justify="flex-end" gap="xs" pt="md" mt="xs" style={{ borderTop: "1px solid var(--line)" }}>
                <Button
                  variant="default"
                  leftSection={<ArrowClockwise size={14} />}
                  disabled={busy || !rpc}
                  onClick={() => void perform(onRefresh)}
                >
                  Refresh
                </Button>
                <Button
                  color="iris"
                  leftSection={<Plus size={14} weight="bold" />}
                  disabled={busy || !rpc}
                  onClick={() => setAction({ kind: "create" })}
                >
                  Custom CLI
                </Button>
              </Group>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="rules">
            <Text size="xs" c="dimmed" mb="xs">
              The first matching rule picks the provider for a routed run.
            </Text>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (rpc) void perform(async () => {
                  const saved = await rpc("runs.setRules", { rules: draft });
                  onRules(saved);
                  setOpened(false);
                });
              }}
            >
              <ScrollArea.Autosize mah="46vh" type="auto">
                <Stack gap="xs">
                  {!draft.length && (
                    <Text size="xs" c="dimmed" py="sm">No rules. The selected provider handles unmatched prompts.</Text>
                  )}
                  {draft.map((rule, index) => {
                    const providerOptions = [
                      ...(!candidates.some((item) => item.id === rule.providerId)
                        ? [{ value: rule.providerId, label: rule.providerId }]
                        : []),
                      ...candidates.map((provider) => ({ value: provider.id, label: provider.name })),
                    ];
                    return (
                      <Paper key={index} p="xs" withBorder radius="sm" bg="dark.8">
                        <div className="rule-row-mantine">
                          <TextInput
                            label="Tag"
                            size="xs"
                            value={rule.tag ?? ""}
                            onChange={(event) => updateRule(index, { tag: event.currentTarget.value || undefined })}
                          />
                          <TextInput
                            label="Extension"
                            size="xs"
                            placeholder=".ts"
                            value={rule.extension ?? ""}
                            onChange={(event) => updateRule(index, { extension: event.currentTarget.value || undefined })}
                          />
                          <NumberInput
                            label="Min chars"
                            size="xs"
                            min={0}
                            hideControls
                            value={rule.minContextChars ?? ""}
                            onChange={(value) => updateRule(index, {
                              minContextChars: value === "" ? undefined : Number(value),
                            })}
                          />
                          <CaretRight size={14} weight="bold" style={{ marginBottom: 8, color: "var(--muted)" }} />
                          <Select
                            label="Provider"
                            size="xs"
                            value={rule.providerId}
                            data={providerOptions}
                            onChange={(value) => { if (value) updateRule(index, { providerId: value }); }}
                          />
                          <ActionIcon
                            color="red"
                            aria-label={`Remove rule ${index + 1}`}
                            onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                            style={{ marginBottom: 2 }}
                          >
                            <Trash size={14} />
                          </ActionIcon>
                        </div>
                      </Paper>
                    );
                  })}
                </Stack>
              </ScrollArea.Autosize>
              <Group justify="flex-end" gap="xs" pt="md" mt="xs" style={{ borderTop: "1px solid var(--line)" }}>
                <Button
                  variant="default"
                  leftSection={<Plus size={14} weight="bold" />}
                  disabled={!candidates.length}
                  onClick={() => setDraft((current) => [...current, { providerId: candidates[0].id }])}
                >
                  Add rule
                </Button>
                <Button type="submit" color="iris" loading={busy} disabled={!rpc}>
                  Save rules
                </Button>
              </Group>
            </form>
          </Tabs.Panel>

          <Tabs.Panel value="shortcuts">
            <ScrollArea.Autosize mah="52vh" type="auto" offsetScrollbars>
              <Stack gap="md" pr="xs">
                {shortcutCategories.map((category) => (
                  <section className="shortcut-section" key={category}>
                    <h3>{category}</h3>
                    {SHORTCUTS.filter((item) => item.category === category).map((item) => (
                      <div className="shortcut-row" key={item.id}>
                        <span>{item.label}</span>
                        <Group gap={4} wrap="nowrap">
                          {(isMac ? item.mac : item.other).map((keycap) => (
                            <Kbd key={keycap}>{keycap}</Kbd>
                          ))}
                        </Group>
                      </div>
                    ))}
                  </section>
                ))}
                <section className="shortcut-section">
                  <h3>Inline Slash Commands</h3>
                  {SLASH_COMMANDS.map((cmd) => (
                    <div className="shortcut-row" key={cmd.name}>
                      <span>{cmd.description}</span>
                      <Code bg="dark.8" c="iris.2">{cmd.usage}</Code>
                    </div>
                  ))}
                </section>
              </Stack>
            </ScrollArea.Autosize>
          </Tabs.Panel>
        </Tabs>
      )}
    </Modal>
  );
}
