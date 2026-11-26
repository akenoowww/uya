import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode, SetStateAction } from "react";
import {
  Alert, Badge, Button, Collapse, Group, Loader, Modal, NumberInput, Paper, PasswordInput,
  ScrollArea, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, Textarea, TextInput,
} from "@mantine/core";
import { useFocusReturn } from "@mantine/hooks";
import { ArrowClockwise, CaretDown, CaretRight, ChartBar, ClipboardText, Play, PlugsConnected } from "@phosphor-icons/react";
import type {
  CapabilityDomain, CapabilityInputField, CapabilityInvokeResult, CapabilityMatrixSnapshot,
  CapabilityOutputKind, CapabilityPack, MissionPlan, ModelCapabilityScore, Provider, RpcCall, RpcParams,
} from "@ide/protocol";
import { errorMessage } from "../bridge";
import { ArtifactCard } from "./ArtifactCard";
import { EFFORT_META } from "./EffortPicker";
import { MissionCard } from "./MissionCard";
import { ProviderIcon } from "./ProviderIcon";

type SynapseTab = "matrix" | "capabilities" | "missions";

interface Props {
  opened: boolean;
  initialTab?: SynapseTab;
  onClose: () => void;
  workspacePath: string | null;
  providers: Provider[];
  rpc: RpcCall | undefined;
}

interface TabProps {
  rpc: RpcCall;
  workspacePath: string | null;
}

const MATRIX_DOMAINS = ["code", "webdev", "text", "vision", "search"] as const;
const DOMAINS: readonly CapabilityDomain[] = [...MATRIX_DOMAINS, "audio", "image", "video"];
const DOMAIN_LABELS: Record<CapabilityDomain, string> = {
  code: "Code", webdev: "Web dev", text: "Text", vision: "Vision", search: "Search",
  audio: "Audio", image: "Image", video: "Video",
};
const OUTPUT_KINDS: readonly CapabilityOutputKind[] = ["text", "json", "audio", "image", "video", "file"];
const PACK_KINDS = [
  { value: "rest", label: "REST Pack" },
  { value: "mcp-stdio", label: "MCP Server (stdio)" },
  { value: "mcp-http", label: "MCP Server (HTTP)" },
] as const;

function useSynapseQuery<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const next = await load();
      if (id === requestId.current) setData(next);
    } catch (cause) {
      if (id === requestId.current) setError(errorMessage(cause));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);

  function update(next: SetStateAction<T | undefined>) {
    requestId.current += 1;
    setData(next);
    setLoading(false);
    setError("");
  }

  return { data, loading, error, refresh, update };
}

function QueryFeedback({ loading, error, refresh }: {
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}) {
  if (error) {
    return (
      <Alert color="red" variant="light" role="alert">
        <Group gap="xs">
          <Text size="xs">{error}</Text>
          <Button size="compact-xs" variant="default" onClick={() => void refresh()}>Retry</Button>
        </Group>
      </Alert>
    );
  }
  return loading ? (
    <Group gap={6} py="xs" role="status">
      <Loader size={14} aria-hidden="true" />
      <Text size="xs" c="dimmed">Loading…</Text>
    </Group>
  ) : null;
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const Caret = expanded ? CaretDown : CaretRight;
  return (
    <div>
      <Button
        type="button"
        size="compact-xs"
        variant="subtle"
        color="iris"
        leftSection={<Caret size={12} aria-hidden="true" />}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
      >
        {label}
      </Button>
      <Collapse id={contentId} expanded={expanded}>
        <Stack gap="xs" pt="xs">{children}</Stack>
      </Collapse>
    </div>
  );
}

function ModelScoresTable({ models }: { models: ModelCapabilityScore[] }) {
  if (models.length === 0) return <Text size="sm" c="dimmed">No installed models in the matrix.</Text>;
  return (
    <Table.ScrollContainer minWidth={660} type="native" tabIndex={0} role="region" aria-label="Model scores table">
      <Table aria-label="Installed model scores" verticalSpacing="xs" horizontalSpacing="xs" striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Model</Table.Th>
            <Table.Th scope="col">arena.ai Elo</Table.Th>
            <Table.Th scope="col">Local Verify</Table.Th>
            <Table.Th scope="col">Arena wins</Table.Th>
            <Table.Th scope="col">Avg TTFT</Table.Th>
            <Table.Th scope="col">Effort</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {models.map((row) => {
            const verifyRate = row.localVerifyTotal > 0
              ? Math.round((100 * row.localVerifyPassed) / row.localVerifyTotal)
              : null;
            return (
              <Table.Tr key={JSON.stringify([row.providerId, row.model])}>
                <Table.Th scope="row">
                  <Group gap={6} wrap="nowrap" align="flex-start">
                    <ProviderIcon providerId={row.providerId} size={14} framed={false} />
                    <Stack gap={2}>
                      <Text size="xs" fw={600}>{row.providerName}</Text>
                      {row.model && <Text size="xs" c="dimmed" ff="monospace" style={{ overflowWrap: "anywhere" }}>{row.model}</Text>}
                    </Stack>
                  </Group>
                </Table.Th>
                <Table.Td>
                  <Group gap={4}>
                    {DOMAINS.map((domain) => {
                      const score = row.domainScores[domain];
                      return score && (
                        <Badge
                          key={domain}
                          size="xs"
                          color="iris"
                          variant="light"
                          title={score.rank === undefined ? undefined : `Rank ${score.rank}`}
                        >
                          {DOMAIN_LABELS[domain]} {Math.round(score.elo)}
                        </Badge>
                      );
                    })}
                    {Object.keys(row.domainScores).length === 0 && <Text size="xs" c="dimmed">—</Text>}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {verifyRate === null ? <Text size="xs" c="dimmed">—</Text> : (
                    <Badge
                      size="xs"
                      color={verifyRate >= 90 ? "teal" : verifyRate >= 70 ? "yellow" : "red"}
                      variant="light"
                      title={`${row.localVerifyPassed}/${row.localVerifyTotal} checks passed`}
                    >
                      {verifyRate}% verify
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td><Text size="xs">{row.localArenaWins}</Text></Table.Td>
                <Table.Td><Text size="xs">{row.avgTtftMs === undefined ? "—" : `${Math.round(row.avgTtftMs)} ms`}</Text></Table.Td>
                <Table.Td><Text size="xs">{EFFORT_META[row.recommendedEffort].label}</Text></Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

interface ModelOption {
  value: string;
  label: string;
  providerId: string;
  model?: string;
}

function modelOption(providerId: string, providerName: string, model?: string): ModelOption {
  return {
    value: JSON.stringify([providerId, model ?? null]),
    label: model ? `${providerName} · ${model}` : providerName,
    providerId,
    model,
  };
}

function MatrixTab({ rpc, workspacePath, providers }: TabProps & { providers: Provider[] }) {
  const load = useCallback(() => rpc("synapse.matrix", { workspacePath }), [rpc, workspacePath]);
  const query = useSynapseQuery(load);
  const [busy, setBusy] = useState<CapabilityDomain | "sync" | null>(null);
  const [error, setError] = useState("");
  const snapshot = query.data;
  const modelOptions = new Map<string, ModelOption>();
  for (const row of snapshot?.models ?? []) {
    const option = modelOption(row.providerId, row.providerName, row.model || undefined);
    modelOptions.set(option.value, option);
  }
  for (const provider of providers) {
    if (!provider.available || !provider.structured) continue;
    const models = provider.models?.length ? provider.models : [provider.defaultModel];
    for (const model of models) {
      const option = modelOption(provider.id, provider.name, model);
      modelOptions.set(option.value, option);
    }
  }
  const options = [{ value: "auto", label: "Auto" }, ...modelOptions.values()];

  async function changeMatrix(action: CapabilityDomain | "sync", request: () => Promise<CapabilityMatrixSnapshot>) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      query.update(await request());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!snapshot) return <QueryFeedback {...query} />;
  const syncedAt = snapshot.syncedAt === null ? null : new Date(snapshot.syncedAt);

  return (
    <Stack gap="sm">
      <Paper withBorder bg="dark.8" radius="sm" p="sm">
        <Stack gap="sm">
          <Group justify="space-between" gap="xs">
            <Stack gap={2}>
              <Text size="sm" fw={650}>Best specialists</Text>
              <Text size="xs" c="dimmed">
                {snapshot.source} · {syncedAt ? (
                  <time dateTime={syncedAt.toISOString()}>{syncedAt.toLocaleString()}</time>
                ) : "Never synced"}
              </Text>
            </Stack>
            <Button
              size="compact-xs"
              variant="light"
              color="iris"
              leftSection={<ArrowClockwise size={12} aria-hidden="true" />}
              loading={busy === "sync"}
              disabled={busy !== null && busy !== "sync"}
              onClick={() => void changeMatrix("sync", () => rpc("synapse.syncArena", {}))}
            >
              Sync Arena Leaderboard
            </Button>
          </Group>
          <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="xs">
            {MATRIX_DOMAINS.map((domain) => {
              const recommended = snapshot.recommendations[domain];
              const override = snapshot.overrides[domain];
              const pinned = override && modelOption(
                override.providerId,
                providers.find((provider) => provider.id === override.providerId)?.name ?? override.providerId,
                override.model,
              );
              return (
                <Stack key={domain} gap={3} miw={0}>
                  <Text size="xs" fw={600}>{DOMAIN_LABELS[domain]}</Text>
                  <Group gap={5} wrap="nowrap">
                    {recommended && <ProviderIcon providerId={recommended.providerId} size={12} framed={false} />}
                    <Text size="xs" c="dimmed" truncate title={recommended?.reason}>
                      {recommended?.providerName ?? "No recommendation"}
                    </Text>
                  </Group>
                  {recommended?.model && <Text size="xs" c="dimmed" truncate title={recommended.model}>{recommended.model}</Text>}
                  <Select
                    size="xs"
                    mt="auto"
                    aria-label={`Pin ${DOMAIN_LABELS[domain]} specialist`}
                    data={pinned && !modelOptions.has(pinned.value) ? [...options, pinned] : options}
                    value={pinned?.value ?? "auto"}
                    searchable
                    nothingFoundMessage="No matching model"
                    allowDeselect={false}
                    disabled={busy !== null}
                    onChange={(value) => {
                      if (value === null) return;
                      const option = modelOptions.get(value);
                      if (value !== "auto" && !option) return;
                      void changeMatrix(domain, () => rpc("synapse.setOverride", {
                        domain, providerId: option?.providerId ?? null, model: option?.model, workspacePath,
                      }));
                    }}
                  />
                </Stack>
              );
            })}
          </SimpleGrid>
        </Stack>
      </Paper>
      {error && <Alert color="red" variant="light" role="alert">{error}</Alert>}
      <ModelScoresTable models={snapshot.models} />
    </Stack>
  );
}

function SecretKeyInput({ name, configured, disabled, onSave }: {
  name: string;
  configured: boolean;
  disabled: boolean;
  onSave: (key: string, value: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [action, setAction] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState("");

  async function save(next: string | null) {
    if (disabled || action) return;
    setAction(next === null ? "clear" : "save");
    setError("");
    try {
      await onSave(name, next);
      setValue("");
    } catch {
      setError(next === null ? "Could not clear the key." : "Could not save the key.");
    } finally {
      setAction(null);
    }
  }

  return (
    <form
      aria-label={`Vault key ${name}`}
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) void save(value);
      }}
    >
      <Group align="flex-end" gap={6}>
        <PasswordInput
          name="value"
          size="xs"
          label={name}
          placeholder={configured ? "Enter a replacement key" : "Enter key"}
          autoComplete="new-password"
          maxLength={8192}
          required
          disabled={disabled}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          visibilityToggleFocusable
          visibilityToggleButtonProps={{ "aria-label": `Toggle visibility for ${name}` }}
          flex="1 1 180px"
        />
        <Group gap={6} mih={30}>
          {configured && <Badge size="xs" color="teal" variant="light">Configured</Badge>}
          <Button
            type="submit"
            size="compact-xs"
            variant="light"
            disabled={disabled || !value.trim()}
            loading={action === "save"}
          >
            Save key
          </Button>
          <Button
            type="button"
            size="compact-xs"
            color="red"
            variant="subtle"
            disabled={disabled || !configured}
            loading={action === "clear"}
            onClick={() => void save(null)}
            aria-label={`Clear ${name} key`}
          >
            Clear
          </Button>
        </Group>
      </Group>
      {error && <Text size="xs" c="red.4" role="alert">{error}</Text>}
    </form>
  );
}

const BOOLEAN_OPTIONS = [{ value: "true", label: "Yes" }, { value: "false", label: "No" }];

function CapabilityArgument({ field, value, disabled, onChange }: {
  field: CapabilityInputField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const props = {
    name: field.name,
    label: field.name,
    description: field.description,
    size: "xs",
    required: field.required,
    disabled,
    value,
  };
  if (field.enum || field.type === "boolean") {
    return (
      <Select
        {...props}
        data={field.enum ?? BOOLEAN_OPTIONS}
        value={value || null}
        onChange={(next) => onChange(next ?? "")}
        allowDeselect={false}
        nothingFoundMessage="No allowed options"
        clearable={!field.required}
        clearButtonProps={{ "aria-label": `Clear ${field.name}` }}
      />
    );
  }
  if (field.type === "number") {
    return <NumberInput {...props} onChange={(next) => onChange(String(next))} />;
  }
  return (
    <Textarea
      {...props}
      autosize
      minRows={2}
      maxRows={5}
      maxLength={65_536}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

function capabilityArgs(fields: CapabilityInputField[], values: Record<string, string>): Record<string, unknown> {
  const entries: [string, string | number | boolean][] = [];
  for (const field of fields) {
    const value = values[field.name];
    if (!value?.trim() && field.required) throw new Error(`Enter a value for ${field.name}.`);
    if (!value) continue;
    if (field.enum && !field.enum.includes(value)) throw new Error(`Select an option for ${field.name}.`);
    if (field.type === "number") {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number)) throw new Error(`Enter a number for ${field.name}.`);
      entries.push([field.name, number]);
    } else if (field.type === "boolean") {
      if (value !== "true" && value !== "false") throw new Error(`Select Yes or No for ${field.name}.`);
      entries.push([field.name, value === "true"]);
    } else {
      entries.push([field.name, value]);
    }
  }
  return Object.fromEntries(entries);
}

function CapabilityTester({ pack, rpc, workspacePath }: TabProps & { pack: CapabilityPack }) {
  const isMcp = pack.kind !== "rest";
  const fields = isMcp ? [] : pack.rest?.inputSchema ?? [];
  const needsKeys = pack.secretKeys.some((key) => !pack.configuredSecrets?.includes(key));
  const disabled = !pack.enabled || needsKeys;
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CapabilityInvokeResult>();
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  function fieldValue(field: CapabilityInputField): string {
    return Object.hasOwn(inputs, field.name) ? inputs[field.name] : String(field.default ?? "");
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || disabled) return;
    setError("");
    let args: Record<string, unknown>;
    try {
      if (fields.length) {
        const values = Object.fromEntries(fields.map((field) => [field.name, fieldValue(field)]));
        args = capabilityArgs(fields, values);
      } else {
        const form = new FormData(event.currentTarget);
        const rawArgs = formText(form, "arguments").trim();
        const parsed = rawArgs ? parseJsonObject(rawArgs, "Enter arguments as a JSON object.") : {};
        if (isMcp) {
          const tool = formText(form, "tool").trim();
          if (!tool) throw new Error("Enter an MCP tool name.");
          args = { tool, arguments: JSON.stringify(parsed) };
        } else {
          if (Object.values(parsed).some((value) => value !== null && !["string", "boolean", "number"].includes(typeof value))) {
            throw new Error("Use text, numbers, booleans or null for REST arguments.");
          }
          args = parsed;
        }
      }
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }

    setRunning(true);
    setResult(undefined);
    try {
      setResult(await rpc("capabilities.invoke", { id: pack.id, args, workspacePath }));
    } catch (cause) {
      setError(errorMessage(cause) || "Could not run the capability. Check its configuration and try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Disclosure label="Try capability">
      <form aria-label={`Try ${pack.name}`} method="post" onSubmit={(event) => void run(event)}>
        <Stack gap="xs" align="stretch">
          {isMcp && (
            <TextInput size="xs" name="tool" label="MCP tool name" required disabled={running || disabled} />
          )}
          {fields.length === 0 && (
            <Textarea size="xs" name="arguments" label="Arguments JSON" placeholder="{}" maxLength={65_536} disabled={running || disabled} />
          )}
          {fields.map((field) => (
            <CapabilityArgument
              key={field.name}
              field={field}
              value={fieldValue(field)}
              disabled={running || disabled}
              onChange={(value) => setInputs((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
          {needsKeys ? <Text size="xs" c="dimmed">Configure the vault keys to run a test.</Text> : (
            !pack.enabled && <Text size="xs" c="dimmed">Enable this capability to run a test.</Text>
          )}
          <Button
            type="submit"
            size="compact-xs"
            variant="light"
            leftSection={<Play size={12} weight="fill" aria-hidden="true" />}
            loading={running}
            disabled={disabled}
            style={{ alignSelf: "flex-start" }}
          >
            Run test
          </Button>
          {error && <Alert color="red" variant="light" role="alert">{error}</Alert>}
        </Stack>
      </form>
      {result?.artifact ? <ArtifactCard artifact={result.artifact} workspacePath={workspacePath} rpc={rpc} /> : (
        result && (
          <ScrollArea.Autosize mah={160}>
            <Text size="xs" role="status" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {result.text || "Test completed."}
            </Text>
          </ScrollArea.Autosize>
        )
      )}
    </Disclosure>
  );
}

function CapabilityCard({ pack, rpc, workspacePath, pending, onSave, onSaveSecret }: TabProps & {
  pack: CapabilityPack;
  pending: string | null;
  onSave: (pack: CapabilityPack) => Promise<void>;
  onSaveSecret: (key: string, value: string | null) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const kind = PACK_KINDS.find(({ value }) => value === pack.kind)?.label;

  async function toggle(enabled: boolean) {
    setError("");
    try {
      await onSave({ ...pack, enabled });
    } catch {
      setError(`Could not ${enabled ? "enable" : "disable"} the capability.`);
    }
  }

  return (
    <Paper withBorder bg="dark.8" radius="sm" p="sm">
      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Group gap={6}>
            <Text size="sm" fw={650} style={{ overflowWrap: "anywhere" }}>{pack.name}</Text>
            <Badge size="xs" color="iris" variant="light">{DOMAIN_LABELS[pack.domain]}</Badge>
            <Badge size="xs" color="gray" variant="outline">{pack.builtin || pack.scope === "builtin" ? "Built-in" : kind}</Badge>
          </Group>
          <Group gap={6}>
            {pending === `pack:${pack.id}` && <Loader size={12} aria-label="Saving capability" />}
            <Switch
              size="xs"
              color="iris"
              label="Enabled"
              aria-label={`Enable ${pack.name}`}
              checked={pack.enabled}
              disabled={pending !== null}
              onChange={(event) => void toggle(event.currentTarget.checked)}
            />
          </Group>
        </Group>
        {pack.description !== pack.name && <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{pack.description}</Text>}
        {error && <Text size="xs" c="red.4" role="alert">{error}</Text>}
        {pack.secretKeys.map((key) => (
          <SecretKeyInput
            key={key}
            name={key}
            configured={pack.configuredSecrets?.includes(key) ?? false}
            disabled={pending !== null}
            onSave={onSaveSecret}
          />
        ))}
        <CapabilityTester pack={pack} workspacePath={workspacePath} rpc={rpc} />
      </Stack>
    </Paper>
  );
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(message);
  }
}

function parseJsonObject(value: string, message: string): Record<string, unknown> {
  const parsed = parseJson(value, message);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(message);
  return Object.fromEntries(Object.entries(parsed));
}

function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined;
  const message = "Enter headers as a JSON object with string values.";
  const entries = Object.entries(parseJsonObject(value, message)).map(([name, header]) => {
    if (typeof header !== "string") throw new Error(message);
    return [name, header] as const;
  });
  return Object.fromEntries(entries);
}

function parseMcpArgs(value: string): string[] {
  if (!value.trim()) return [];
  const message = "Enter MCP arguments as a JSON array of strings.";
  const parsed = parseJson(value, message);
  if (!Array.isArray(parsed) || !parsed.every((arg): arg is string => typeof arg === "string")) throw new Error(message);
  return parsed;
}

function httpUrl(value: string, secretKeys: string[]): string {
  const vaultKey = /^\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}(?=\/|$)/.exec(value)?.[1];
  if (vaultKey && secretKeys.includes(vaultKey)) return value;
  const message = "Enter an HTTP(S) URL or reference a vault key listed for the pack.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(message);
  return value;
}

function customPack(form: FormData, kind: CapabilityPack["kind"]): CapabilityPack {
  const name = formText(form, "name").trim();
  const domain = DOMAINS.find((value) => value === formText(form, "domain"));
  if (!name || !domain) throw new Error("Enter a name and select a domain.");
  const secretKeys = [...new Set(formText(form, "secretKeys").split(/[\s,]+/).filter(Boolean))];
  if (secretKeys.length > 16 || secretKeys.some((key) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(key))) {
    throw new Error("Enter up to 16 vault key names in UPPER_SNAKE_CASE.");
  }
  const pack: CapabilityPack = {
    id: `custom-${crypto.randomUUID()}`,
    name,
    description: formText(form, "description").trim() || name,
    domain,
    kind,
    scope: "global",
    enabled: true,
    requiresApproval: true,
    secretKeys,
  };
  if (kind === "mcp-stdio") {
    const command = formText(form, "command").trim();
    if (!command) throw new Error("Enter an MCP command.");
    return { ...pack, mcp: { command, args: parseMcpArgs(formText(form, "args")) } };
  }
  const url = httpUrl(formText(form, "url").trim(), secretKeys);
  if (kind === "mcp-http") return { ...pack, mcp: { url } };

  const method = formText(form, "method");
  const outputKind = OUTPUT_KINDS.find((value) => value === formText(form, "outputKind"));
  if ((method !== "GET" && method !== "POST") || !outputKind) throw new Error("Select a method and output kind.");
  return {
    ...pack,
    rest: {
      method,
      url,
      headers: parseHeaders(formText(form, "headers")),
      bodyTemplate: formText(form, "bodyTemplate") || undefined,
      inputSchema: [],
      outputKind,
      outputPathTemplate: formText(form, "outputPathTemplate").trim() || undefined,
    },
  };
}

function AddCapabilityForm({ disabled, onSave }: { disabled: boolean; onSave: (pack: CapabilityPack) => Promise<void> }) {
  const [kind, setKind] = useState<CapabilityPack["kind"]>("rest");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<{ id: string; name: string }>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || saving) return;
    setError("");
    let pack: CapabilityPack;
    try {
      pack = customPack(new FormData(event.currentTarget), kind);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }

    setSaving(true);
    try {
      await onSave(pack);
      setAdded({ id: pack.id, name: pack.name });
      setKind("rest");
    } catch {
      setError("Could not save the capability.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper withBorder bg="dark.8" radius="sm" p="sm">
      <Disclosure label="Add Custom Capability">
        <form key={added?.id ?? "new"} aria-label="Custom capability details" method="post" onSubmit={(event) => void submit(event)}>
          <Stack gap="xs">
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
              <Select<CapabilityPack["kind"]>
                name="kind"
                size="xs"
                label="Pack type"
                data={[...PACK_KINDS]}
                value={kind}
                onChange={(value) => { if (value) setKind(value); }}
                allowDeselect={false}
                disabled={disabled}
              />
              <TextInput size="xs" name="name" label="Name" required maxLength={100} disabled={disabled} />
              <Select
                size="xs"
                name="domain"
                label="Domain"
                data={DOMAINS.map((value) => ({ value, label: DOMAIN_LABELS[value] }))}
                defaultValue="text"
                allowDeselect={false}
                required
                disabled={disabled}
              />
              <TextInput size="xs" name="description" label="Description" maxLength={1024} disabled={disabled} />
            </SimpleGrid>
            {kind === "mcp-stdio" ? (
              <>
                <TextInput size="xs" name="command" label="Command" required maxLength={4096} disabled={disabled} />
                <Textarea size="xs" name="args" label="Arguments JSON" description="JSON array of strings" placeholder='["server.js", "--stdio"]' disabled={disabled} />
              </>
            ) : (
              <TextInput
                size="xs"
                name="url"
                label="URL"
                inputMode="url"
                description={kind === "rest" ? "HTTP(S) URL or {{VAULT_KEY}}/path" : undefined}
                required
                maxLength={2048}
                disabled={disabled}
              />
            )}
            {kind === "rest" && (
              <>
                <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
                  <Select size="xs" name="method" label="Method" data={["GET", "POST"]} defaultValue="POST" allowDeselect={false} required disabled={disabled} />
                  <Select size="xs" name="outputKind" label="Output kind" data={[...OUTPUT_KINDS]} defaultValue="text" allowDeselect={false} required disabled={disabled} />
                </SimpleGrid>
                <Textarea size="xs" name="headers" label="Headers JSON" placeholder='{"Content-Type": "application/json"}' disabled={disabled} />
                <Textarea size="xs" name="bodyTemplate" label="Body template" maxLength={65_536} disabled={disabled} />
                <TextInput size="xs" name="outputPathTemplate" label="Output path template" maxLength={4096} disabled={disabled} />
              </>
            )}
            <TextInput size="xs" name="secretKeys" label="Vault key names" description="Comma-separated UPPER_SNAKE_CASE names" disabled={disabled} />
            {error && <Alert color="red" variant="light" role="alert">{error}</Alert>}
            {added && !saving && !error && <Text size="xs" c="teal.4" role="status">Added {added.name}.</Text>}
            <Button type="submit" size="compact-xs" variant="light" color="iris" loading={saving} disabled={disabled} style={{ alignSelf: "flex-start" }}>
              Add capability
            </Button>
          </Stack>
        </form>
      </Disclosure>
    </Paper>
  );
}

function CapabilitiesTab({ rpc, workspacePath }: TabProps) {
  const load = useCallback(() => rpc("capabilities.list", { workspacePath }), [rpc, workspacePath]);
  const query = useSynapseQuery(load);
  const [pending, setPending] = useState<string | null>(null);
  const saving = useRef(false);

  async function changeConfiguration(target: string, request: () => Promise<void>) {
    if (saving.current) throw new Error("A capability change is already in progress.");
    saving.current = true;
    setPending(target);
    try {
      await request();
    } finally {
      saving.current = false;
      setPending(null);
    }
  }

  function savePack(pack: CapabilityPack) {
    return changeConfiguration(`pack:${pack.id}`, async () => {
      const { configuredSecrets, ...configuration } = pack;
      const saved = await rpc("capabilities.save", { pack: configuration });
      query.update((current = []) => {
        const configuredKeys = new Set(current.flatMap((item) => item.configuredSecrets ?? []));
        const updated = {
          ...saved,
          configuredSecrets: saved.configuredSecrets ?? configuredSecrets ?? saved.secretKeys.filter((key) => configuredKeys.has(key)),
        };
        return current.some((item) => item.id === updated.id)
          ? current.map((item) => item.id === updated.id ? updated : item)
          : [...current, updated];
      });
    });
  }

  function saveSecret(key: string, value: string | null) {
    return changeConfiguration(`secret:${key}`, async () => {
      const { configuredKeys } = await rpc("capabilities.setSecret", { key, value });
      const configured = new Set(configuredKeys);
      query.update((current) => current?.map((pack) => ({
        ...pack,
        configuredSecrets: pack.secretKeys.filter((name) => configured.has(name)),
      })));
      await query.refresh();
    });
  }

  return (
    <Stack gap="sm">
      <QueryFeedback {...query} />
      {query.data?.length === 0 && <Text size="sm" c="dimmed">No capabilities configured.</Text>}
      {query.data?.map((pack) => (
        <CapabilityCard
          key={pack.id}
          pack={pack}
          rpc={rpc}
          workspacePath={workspacePath}
          pending={pending}
          onSave={savePack}
          onSaveSecret={saveSecret}
        />
      ))}
      {query.data && <AddCapabilityForm disabled={pending !== null} onSave={savePack} />}
    </Stack>
  );
}

function MissionsTab({ rpc, workspacePath, providers }: TabProps & { providers: Provider[] }) {
  const load = useCallback(() => rpc("missions.list", { workspacePath, limit: 15 }), [rpc, workspacePath]);
  const { data: missions, refresh, update, loading, error } = useSynapseQuery(load);
  const running = missions?.some((mission) => mission.status === "running") ?? false;

  useEffect(() => {
    if (!running || loading || error) return;
    const timer = window.setTimeout(() => void refresh(), 4000);
    return () => window.clearTimeout(timer);
  }, [running, loading, error, refresh]);

  function updateMission(next: MissionPlan) {
    update((current) => current?.map((mission) => (
      mission.id === next.id && mission.updatedAt <= next.updatedAt ? next : mission
    )));
  }

  async function approve(id: string, options: Omit<RpcParams<"missions.approve">, "id">) {
    updateMission(await rpc("missions.approve", { id, ...options }));
  }

  async function cancel(id: string) {
    updateMission(await rpc("missions.cancel", { id }));
  }

  return (
    <Stack gap={4}>
      {missions && (
        <Group justify="flex-end">
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<ArrowClockwise size={12} aria-hidden="true" />}
            loading={loading}
            onClick={() => void refresh()}
          >
            Refresh missions
          </Button>
        </Group>
      )}
      <QueryFeedback loading={loading && !missions} error={error} refresh={refresh} />
      {missions?.length === 0 && <Text size="sm" c="dimmed">No saved missions.</Text>}
      {missions?.map((mission) => (
        <MissionCard key={mission.id} mission={mission} providers={providers} onApprove={approve} onCancel={cancel} />
      ))}
    </Stack>
  );
}

export function SynapseModal({ opened, initialTab = "matrix", onClose, workspacePath, providers, rpc }: Props) {
  useFocusReturn({ opened });
  const unavailable = <Text size="sm" c="dimmed">Connect to the local runtime to use Synapse.</Text>;

  return (
    <Modal.Stack key={JSON.stringify([opened, workspacePath, initialTab, Boolean(rpc)])}>
      <Modal
        stackId="synapse"
        opened={opened}
        onClose={onClose}
        size={760}
        returnFocus={false}
        title="Uya Synapse — Intelligence & Capabilities"
        closeButtonProps={{ "aria-label": "Close Uya Synapse" }}
      >
        <Tabs defaultValue={initialTab} keepMounted={false}>
          <Tabs.List aria-label="Synapse views">
            <Tabs.Tab value="matrix" leftSection={<ChartBar size={14} weight="duotone" aria-hidden="true" />}>
              Living Capability Matrix
            </Tabs.Tab>
            <Tabs.Tab value="capabilities" leftSection={<PlugsConnected size={14} weight="duotone" aria-hidden="true" />}>
              Capability Hub &amp; Vault
            </Tabs.Tab>
            <Tabs.Tab value="missions" leftSection={<ClipboardText size={14} weight="duotone" aria-hidden="true" />}>
              Active &amp; Saved Missions
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="matrix" pt="sm">
            {rpc ? <MatrixTab rpc={rpc} workspacePath={workspacePath} providers={providers} /> : unavailable}
          </Tabs.Panel>
          <Tabs.Panel value="capabilities" pt="sm">
            {rpc ? <CapabilitiesTab rpc={rpc} workspacePath={workspacePath} /> : unavailable}
          </Tabs.Panel>
          <Tabs.Panel value="missions" pt="sm">
            {rpc ? <MissionsTab rpc={rpc} workspacePath={workspacePath} providers={providers} /> : unavailable}
          </Tabs.Panel>
        </Tabs>
      </Modal>
    </Modal.Stack>
  );
}
