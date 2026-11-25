import { useEffect, useImperativeHandle, useState } from "react";
import type { FormEvent } from "react";
import {
  ActionIcon, Alert, Badge, Button, Checkbox, Code, Divider, Group, Kbd,
  Modal, NumberInput, Paper, Progress, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Tabs, Text, Textarea, TextInput,
} from "@mantine/core";
import {
  ArrowClockwise, CaretRight, ChartBar, Keyboard, PencilSimple, PlugsConnected,
  Plus, SlidersHorizontal, Trash,
} from "@phosphor-icons/react";
import type { CustomProviderInput, Provider, RoutingRule, RpcCall, UsageStats } from "@ide/protocol";
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
  showUsage: () => void;
  showShortcuts: () => void;
}

type SettingsTab = "providers" | "rules" | "usage" | "shortcuts";
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

function UsagePanel({ rpc, active }: { rpc: RpcCall | undefined; active: boolean }) {
  const [days, setDays] = useState("30");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || !rpc) return;
    let current = true;
    setError("");
    void rpc("runs.usage", { days: Number(days) }).then((result) => {
      if (current) setStats(result);
    }).catch((reason: unknown) => {
      if (current) setError(errorMessage(reason));
    });
    return () => { current = false; };
  }, [active, days, rpc]);

  const totals = stats ? stats.byProvider.reduce(
    (acc, row) => ({
      succeeded: acc.succeeded + row.succeeded,
      inputTokens: acc.inputTokens + row.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + (row.cachedInputTokens ?? 0),
      tokens: acc.tokens + row.inputTokens + row.outputTokens,
      costUsd: acc.costUsd + (row.estimatedCostUsd ?? 0),
      ttftWeighted: acc.ttftWeighted + (row.avgTtftMs ?? 0) * (row.avgTtftMs !== undefined ? row.runs : 0),
      ttftRuns: acc.ttftRuns + (row.avgTtftMs !== undefined ? row.runs : 0),
    }),
    { succeeded: 0, inputTokens: 0, cachedInputTokens: 0, tokens: 0, costUsd: 0, ttftWeighted: 0, ttftRuns: 0 },
  ) : null;
  const overallSuccess = stats && stats.totalRuns > 0 && totals ? Math.round((totals.succeeded / stats.totalRuns) * 100) : 0;
  const overallTtft = totals && totals.ttftRuns > 0 ? Math.round(totals.ttftWeighted / totals.ttftRuns) : undefined;
  const overallCachePct = totals && totals.inputTokens > 0 && totals.cachedInputTokens > 0
    ? Math.min(100, Math.round((totals.cachedInputTokens / totals.inputTokens) * 100))
    : 0;

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <Text size="xs" c="dimmed">
          Local speed, token throughput, and effort usage from your SQLite history.
        </Text>
        <SegmentedControl
          size="xs"
          value={days}
          onChange={setDays}
          data={[
            { value: "7", label: "7d" },
            { value: "30", label: "30d" },
            { value: "90", label: "90d" },
          ]}
        />
      </Group>

      {error && <Alert color="red" variant="light">{error}</Alert>}
      {!rpc && !error && <Text size="xs" c="dimmed">Connect to the desktop runtime to view local usage metrics.</Text>}
      {rpc && !stats && !error && <Text size="xs" c="dimmed">Loading metrics…</Text>}
      {stats && (
        <ScrollArea.Autosize mah="46vh" type="auto">
          {!stats.byProvider.length ? (
            <Text size="xs" c="dimmed" py="md">No runs recorded in the last {stats.days} days.</Text>
          ) : (
            <Stack gap="xs">
              <SimpleGrid cols={4} spacing="xs">
                <Paper p="xs" withBorder bg="dark.8">
                  <Text size="10px" c="dimmed" tt="uppercase">Runs</Text>
                  <Text size="md" fw={650} ff="monospace">{stats.totalRuns}</Text>
                </Paper>
                <Paper p="xs" withBorder bg="dark.8">
                  <Text size="10px" c="dimmed" tt="uppercase">Success</Text>
                  <Text size="md" fw={650} ff="monospace" c={overallSuccess >= 90 ? "teal" : "yellow"}>{overallSuccess}%</Text>
                </Paper>
                <Paper p="xs" withBorder bg="dark.8">
                  <Text size="10px" c="dimmed" tt="uppercase">Avg TTFT</Text>
                  <Text size="md" fw={650} ff="monospace">
                    {overallTtft !== undefined
                      ? overallTtft < 1000 ? `${overallTtft} ms` : `${(overallTtft / 1000).toFixed(1)} s`
                      : "—"}
                  </Text>
                </Paper>
                <Paper p="xs" withBorder bg="dark.8">
                  <Text size="10px" c="dimmed" tt="uppercase">
                    {totals && totals.costUsd > 0 ? "Est. Cost" : "Tokens"}
                  </Text>
                  <Text size="md" fw={650} ff="monospace">
                    {totals && totals.costUsd > 0
                      ? `~$${totals.costUsd < 0.01 ? totals.costUsd.toFixed(4) : totals.costUsd.toFixed(2)}`
                      : totals ? totals.tokens.toLocaleString() : 0}
                  </Text>
                  {overallCachePct > 0 && (
                    <Text size="10px" c="teal.3" ff="monospace">{overallCachePct}% cache hit</Text>
                  )}
                </Paper>
              </SimpleGrid>

              {stats.byProvider.map((row) => {
                const rate = row.runs > 0 ? Math.round((row.succeeded / row.runs) * 100) : 0;
                const share = stats.totalRuns > 0 ? Math.round((row.runs / stats.totalRuns) * 100) : 0;
                const rowCachePct = row.inputTokens > 0 && row.cachedInputTokens
                  ? Math.min(100, Math.round((row.cachedInputTokens / row.inputTokens) * 100))
                  : 0;
                const effortEntries = Object.entries(row.efforts);
                return (
                  <Paper key={row.providerId} p="xs" withBorder radius="sm" bg="dark.8">
                    <Group justify="space-between" wrap="nowrap" mb={4}>
                      <Group gap={8} wrap="nowrap">
                        <ProviderIcon providerId={row.providerId} size={14} framed={false} />
                        <Text size="xs" fw={620}>{row.providerName}</Text>
                      </Group>
                      <Group gap={6}>
                        {row.estimatedCostUsd !== undefined && row.estimatedCostUsd > 0 && (
                          <Badge size="xs" variant="outline" color="gray" ff="monospace">
                            ~${row.estimatedCostUsd < 0.01 ? row.estimatedCostUsd.toFixed(4) : row.estimatedCostUsd.toFixed(2)}
                          </Badge>
                        )}
                        <Badge size="xs" variant="light" color="iris">{row.runs} runs</Badge>
                        <Badge size="xs" variant="light" color={rate >= 90 ? "teal" : rate >= 70 ? "yellow" : "red"}>
                          {rate}% ok
                        </Badge>
                      </Group>
                    </Group>
                    <Progress value={share} size={4} color="iris" mb={6} radius="xl" />
                    <Group gap="md" wrap="wrap">
                      <Text size="11px" c="dimmed" ff="monospace">
                        Avg TTFT: {row.avgTtftMs !== undefined
                          ? row.avgTtftMs < 1000 ? `${row.avgTtftMs} ms` : `${(row.avgTtftMs / 1000).toFixed(1)} s`
                          : "—"}
                      </Text>
                      <Text size="11px" c="dimmed" ff="monospace">
                        In: {row.inputTokens.toLocaleString()}{rowCachePct > 0 ? ` (${rowCachePct}% cached)` : ""}
                      </Text>
                      <Text size="11px" c="dimmed" ff="monospace">
                        Out: {row.outputTokens.toLocaleString()} tok
                      </Text>
                    </Group>
                    {effortEntries.length > 0 && (
                      <Group gap={4} mt={6} wrap="wrap">
                        {effortEntries.map(([level, count]) => (
                          <Badge key={level} size="xs" variant="outline" color="gray" radius="sm">
                            {level}: {count}
                          </Badge>
                        ))}
                      </Group>
                    )}
                  </Paper>
                );
              })}
            </Stack>
          )}
        </ScrollArea.Autosize>
      )}
    </Stack>
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
    showUsage: () => open("usage"),
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
        : tab === "usage"
          ? "Usage & Speed Insights"
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
            <Tabs.Tab value="usage" leftSection={<ChartBar size={14} weight="duotone" />}>
              Usage
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
                    <ProviderIcon providerId={provider.id} size={16} />
                    <div className="provider-row-info">
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.detail
                          ? provider.detail
                          : provider.models?.length
                            ? `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}${provider.defaultModel ? ` · default ${provider.defaultModel}` : ""}`
                            : provider.command}
                        {provider.available && provider.supportedModes && provider.supportedModes.length > 1
                          ? ` · ${provider.supportedModes.includes("agent") ? "Explore & Agent" : "Explore"}`
                          : ""}
                        {provider.available && provider.supportsPersistentSession ? " · Live session" : ""}
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

          <Tabs.Panel value="usage">
            <UsagePanel rpc={rpc} active={opened && tab === "usage"} />
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
