import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon, Badge, Button, Collapse, Group, Kbd, Loader, Paper, Stack, Text, UnstyledButton,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import {
  ArrowClockwise, ArrowCounterClockwise, ArrowDown, ArrowUp, CaretDown, CaretRight, Check, Copy,
  Files, FileText, FolderOpen, GitFork, Globe, Lightning, MagnifyingGlass, NotePencil, PencilSimple,
  Play, ShieldCheck, Stop, StopCircle, Terminal, TerminalWindow, Wrench, X,
} from "@phosphor-icons/react";
import type {
  ApprovalDecision, ApprovalRequest, EffortLevel, Provider, RpcCall, RunDetail, RunEvent,
  RunSummary, ToolKind, ToolMeta,
} from "@ide/protocol";
import type { Bridge } from "./bridge";
import { ACCESS_MODE_META, AccessModePicker } from "./components/AccessModePicker";
import { EFFORT_META, EffortPicker } from "./components/EffortPicker";
import { MarkdownView } from "./components/MarkdownView";
import type { ApplyPreviewRequest } from "./components/MarkdownView";
import { MentionMenu } from "./components/MentionMenu";
import { ModelPicker } from "./components/ModelPicker";
import { ProviderIcon } from "./components/ProviderIcon";
import { ProviderPicker } from "./components/ProviderPicker";
import { SlashMenu } from "./components/SlashMenu";
import { HintTooltip } from "./components/Tooltip";
import { useMentionInput } from "./hooks/useMentionInput";
import { useSlashInput } from "./hooks/useSlashInput";
import { formatShortcut } from "./shortcuts";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalControls, TerminalStateSnapshot } from "./TerminalPanel";
import {
  formatDurationCompact, resolveAccessMode, resolveModel, shortModelName, workspaceLabel,
} from "./workbenchStore";
import type { PaneConfig } from "./workbenchStore";

export type { PaneConfig };

export function RunStatus({ run }: { run: RunSummary | undefined }) {
  if (!run) return <span className="run-state"><span className="state-dot" /> Ready</span>;
  const label = { running: "Streaming", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled" }[run.status];
  return <span className={`run-state ${run.status}`}><span className="state-dot" />{label}</span>;
}

type GroupedEvent =
  | { seq: number; type: "text" | "thinking"; text: string }
  | { seq: number; type: "tool"; text: string; meta?: ToolMeta };

function groupEvents(events: RunEvent[]): GroupedEvent[] {
  const groups: GroupedEvent[] = [];
  const toolIndexById = new Map<string, number>();

  for (const event of events) {
    if (event.type === "text" || event.type === "thinking") {
      const last = groups.at(-1);
      if (last?.type === event.type) last.text += event.text;
      else groups.push({ seq: event.seq, type: event.type, text: event.text });
      continue;
    }
    if (event.type === "tool") {
      const toolId = event.meta?.id;
      if (toolId && toolIndexById.has(toolId)) {
        const idx = toolIndexById.get(toolId)!;
        const existing = groups[idx];
        if (existing?.type === "tool") {
          existing.text = event.text || existing.text;
          existing.meta = { ...existing.meta, ...event.meta } as ToolMeta;
          continue;
        }
      }
      if (toolId) toolIndexById.set(toolId, groups.length);
      groups.push({ seq: event.seq, type: "tool", text: event.text, meta: event.meta });
    }
  }
  return groups;
}

function ToolKindIcon({ kind }: { kind: ToolKind }) {
  switch (kind) {
    case "read": return <FileText size={12} weight="duotone" color="var(--accent)" aria-hidden="true" />;
    case "search": return <MagnifyingGlass size={12} weight="duotone" color="var(--accent)" aria-hidden="true" />;
    case "edit":
    case "write": return <PencilSimple size={12} weight="duotone" color="var(--positive)" aria-hidden="true" />;
    case "shell": return <Terminal size={12} weight="duotone" color="var(--warning)" aria-hidden="true" />;
    case "fetch": return <Globe size={12} weight="duotone" color="var(--accent)" aria-hidden="true" />;
    default: return <Wrench size={12} weight="duotone" color="var(--muted)" aria-hidden="true" />;
  }
}

function DisclosureBlock({ type, text }: { type: "thinking" | "tool"; text: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <Paper withBorder bg="dark.9" radius="sm" my={6} className="disclosure-card">
      <UnstyledButton
        w="100%"
        px={8}
        py={5}
        onClick={() => setOpened((current) => !current)}
        aria-expanded={opened}
      >
        <Group gap={6} wrap="nowrap">
          {opened ? <CaretDown size={11} weight="bold" color="var(--muted)" /> : <CaretRight size={11} weight="bold" color="var(--muted)" />}
          <Lightning size={12} weight="duotone" color="var(--accent)" aria-hidden="true" />
          <Text size="11px" c="dimmed" fw={550}>
            {type === "thinking" ? "Reasoning" : "Activity"}
          </Text>
          {!opened && (
            <Text size="10px" c="dimmed" truncate="end" style={{ opacity: 0.7 }}>
              {text.split("\n")[0]}
            </Text>
          )}
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <pre className="disclosure-pre">{text}</pre>
      </Collapse>
    </Paper>
  );
}

function ToolCard({
  text,
  meta,
  onOpenFile,
}: {
  text: string;
  meta: ToolMeta;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const [opened, setOpened] = useState(false);
  const detailText = (meta.output ?? (text !== meta.summary && text !== meta.name ? text : "")).trim();
  const hasDetail = detailText.length > 0;
  const label = meta.summary?.trim() || meta.command?.trim() || meta.name;
  const statusColor = meta.status === "error" ? "red" : meta.status === "done" ? "teal" : "iris";

  return (
    <Paper withBorder bg="dark.9" radius="sm" my={5} className="tool-card">
      <Group gap={6} px={8} py={5} wrap="nowrap" justify="space-between">
        <UnstyledButton
          style={{ flex: 1, minWidth: 0, cursor: hasDetail ? "pointer" : "default" }}
          onClick={() => { if (hasDetail) setOpened((v) => !v); }}
          aria-expanded={hasDetail ? opened : undefined}
        >
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            {hasDetail ? (
              opened ? <CaretDown size={10} weight="bold" color="var(--muted)" /> : <CaretRight size={10} weight="bold" color="var(--muted)" />
            ) : (
              <span style={{ width: 10 }} />
            )}
            <ToolKindIcon kind={meta.kind} />
            <Text size="11px" fw={550} c="gray.2" truncate="end" title={label}>
              {label}
            </Text>
          </Group>
        </UnstyledButton>
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
          {meta.path && onOpenFile ? (
            <UnstyledButton
              className="file-ref-link"
              onClick={() => onOpenFile(meta.path!)}
              title={`Open ${meta.path}`}
            >
              {workspaceLabel(meta.path)}
            </UnstyledButton>
          ) : meta.path ? (
            <Text size="10px" c="dimmed" ff="monospace">{workspaceLabel(meta.path)}</Text>
          ) : null}
          <Badge
            size="xs"
            variant="dot"
            color={statusColor}
            styles={{ label: { textTransform: "none", fontWeight: 500 } }}
          >
            {meta.status === "running" ? "running" : meta.status === "error" ? "error" : "done"}
          </Badge>
        </Group>
      </Group>
      {hasDetail && (
        <Collapse expanded={opened}>
          <pre className="disclosure-pre">{detailText}</pre>
        </Collapse>
      )}
    </Paper>
  );
}

function ApprovalCard({
  request,
  onRespond,
}: {
  request: ApprovalRequest;
  onRespond: (requestId: string, decision: ApprovalDecision) => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);

  async function decide(decision: ApprovalDecision) {
    if (submitting) return;
    setSubmitting(decision);
    try {
      await onRespond(request.requestId, decision);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Paper withBorder radius="sm" p="8px 10px" my={8} className="approval-card" role="alert">
      <Group justify="space-between" gap={8} wrap="nowrap" mb={4}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <ShieldCheck size={15} weight="duotone" color="var(--warning)" aria-hidden="true" />
          <Text size="xs" fw={650} truncate="end">{request.title || `Approve ${request.toolName}`}</Text>
        </Group>
        <Badge size="xs" variant="light" color="yellow">{request.toolKind}</Badge>
      </Group>
      {(request.command || request.path || request.detail) && (
        <pre className="approval-detail">
          {request.command ?? request.path ?? request.detail}
        </pre>
      )}
      <Group gap={6} mt={7} wrap="wrap">
        <Button
          size="compact-xs"
          color="teal"
          variant="light"
          loading={submitting === "allow_once"}
          disabled={submitting !== null}
          leftSection={<Check size={12} weight="bold" />}
          onClick={() => void decide("allow_once")}
        >
          Allow once
        </Button>
        <Button
          size="compact-xs"
          color="iris"
          variant="light"
          loading={submitting === "allow_session"}
          disabled={submitting !== null}
          onClick={() => void decide("allow_session")}
        >
          Allow session
        </Button>
        <Button
          size="compact-xs"
          color="red"
          variant="subtle"
          loading={submitting === "reject"}
          disabled={submitting !== null}
          leftSection={<X size={12} weight="bold" />}
          onClick={() => void decide("reject")}
        >
          Deny
        </Button>
      </Group>
    </Paper>
  );
}

function terminalArgsFor(provider: Provider | undefined, model: string | undefined, effort: EffortLevel | undefined): string[] | undefined {
  if (!provider) return undefined;
  if (provider.id === "ollama" && model) return ["run", model];
  if (provider.kind === "cli") {
    const args = [...(provider.terminalArgs ?? [])];
    if (provider.id === "codex" && effort) {
      const mapped = effort === "minimal" ? "low" : effort;
      const quote = /\.(?:cmd|bat)$/i.test(provider.command ?? "") ? "'" : '"';
      args.push("-c", `model_reasoning_effort=${quote}${mapped}${quote}`);
    }
    if (provider.id === "claude" && effort) {
      const mapped = effort === "minimal" ? "low" : effort === "xhigh" ? "high" : effort;
      args.push("--effort", mapped);
    }
    if (provider.id === "antigravity" && effort) {
      const mapped = effort === "minimal" ? "low" : effort;
      args.push("--effort", mapped);
    }
    if (model && ["codex", "claude", "antigravity", "gemini", "qwen", "opencode", "kimi"].includes(provider.id)) {
      args.push("--model", model);
    }
    return args.length ? args : provider.terminalArgs;
  }
  return provider.terminalArgs;
}

export function Transcript({
  detail,
  providers,
  onRetry,
  onFork,
  onOpenUrl,
  onOpenFile,
  onPreviewDiff,
  onRunCommand,
  onRespondApproval,
  onRestoreCheckpoint,
}: {
  detail: RunDetail;
  providers: Provider[];
  onRetry?: (prompt: string) => void;
  onFork?: (runId: string) => void;
  onOpenUrl?: (url: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onPreviewDiff?: (request: ApplyPreviewRequest) => void;
  onRunCommand?: (command: string) => void;
  onRespondApproval?: (runId: string, requestId: string, decision: ApprovalDecision) => Promise<void> | void;
  onRestoreCheckpoint?: (checkpointId: string) => Promise<void> | void;
}) {
  const clipboard = useClipboard({ timeout: 1600 });
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const { run, events } = detail;
  const start = events.find((event) => event.type === "status");
  const attempts = [{ run: start?.type === "status" ? start.run : run, events: [] as RunEvent[] }];
  for (const event of events) {
    const attempt = attempts[attempts.length - 1];
    if (event.type === "status" && event.run.providerId !== attempt.run.providerId) {
      attempts.push({ run: event.run, events: [] });
    } else if (event.type !== "status") {
      attempt.events.push(event);
    }
  }

  const pendingApprovals = useMemo(() => {
    if (run.status !== "running") return [];
    const resolved = new Set<string>();
    const pending: ApprovalRequest[] = [];
    for (const event of events) {
      if (event.type === "approval_resolved") resolved.add(event.requestId);
    }
    for (const event of events) {
      if (event.type === "approval_request" && !resolved.has(event.request.requestId)) {
        pending.push(event.request);
      }
    }
    return pending;
  }, [events, run.status]);

  const fullReplyText = useMemo(() => {
    const lastAttempt = attempts.at(-1);
    return (lastAttempt?.events ?? [])
      .flatMap((event) => event.type === "text" ? [event.text] : [])
      .join("");
  }, [detail]);

  const elapsedMs = run.finishedAt ? Math.max(1, run.finishedAt - run.startedAt) : 0;
  const tokPerSec = run.outputTokens && elapsedMs > 0
    ? Math.round((run.outputTokens * 1000) / elapsedMs)
    : undefined;
  const cachePct = run.inputTokens && run.cachedInputTokens && run.inputTokens > 0
    ? Math.min(100, Math.round((run.cachedInputTokens / run.inputTokens) * 100))
    : 0;

  return (
    <article className="transcript">
      <Paper p="8px 11px" withBorder radius="md" className="prompt-turn">
        <Text size="11px" fw={630} c="iris.3" mb={3}>You</Text>
        <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.55 }}>
          {run.prompt}
        </Text>
      </Paper>
      <div className="response-turn">
        {attempts.map(({ run: attempt, events: output }, index) => {
          const providerName = attempt.providerName ?? providers.find((item) => item.id === attempt.providerId)?.name ?? attempt.providerId;
          const displayModel = (index === attempts.length - 1 ? run.model : undefined) ?? attempt.model;
          const displayEffort = (index === attempts.length - 1 ? run.effort : undefined) ?? attempt.effort;
          const displayMode = (index === attempts.length - 1 ? run.accessMode : undefined) ?? attempt.accessMode;
          const groups = groupEvents(output);
          const hasText = groups.some((group) => group.type === "text");
          return (
            <section className="response-attempt" key={`${attempt.providerId}-${index}`}>
              <Group gap={7} align="center" wrap="nowrap">
                <ProviderIcon providerId={attempt.providerId} size={14} framed={false} />
                <Text size="xs" fw={620}>{providerName}</Text>
                {displayModel && (
                  <Badge size="xs" variant="outline" color="gray" ff="monospace">
                    {shortModelName(displayModel)}
                  </Badge>
                )}
                {displayEffort && (
                  <Badge size="xs" variant="light" color="iris">
                    {EFFORT_META[displayEffort].short}
                  </Badge>
                )}
                {displayMode && displayMode !== "isolated" && (
                  <Badge size="xs" variant="outline" color={displayMode === "agent" ? "teal" : "gray"}>
                    {ACCESS_MODE_META[displayMode].short}
                  </Badge>
                )}
              </Group>
              {groups.map((group) => group.type === "text" ? (
                <MarkdownView
                  key={group.seq}
                  text={group.text}
                  onOpenUrl={onOpenUrl}
                  onOpenFile={onOpenFile}
                  onPreviewDiff={onPreviewDiff}
                  onRunCommand={onRunCommand}
                />
              ) : group.type === "tool" && group.meta ? (
                <ToolCard key={group.seq} text={group.text} meta={group.meta} onOpenFile={onOpenFile} />
              ) : (
                <DisclosureBlock key={group.seq} type={group.type} text={group.text} />
              ))}
              {index === attempts.length - 1 && pendingApprovals.length > 0 && onRespondApproval && (
                pendingApprovals.map((req) => (
                  <ApprovalCard
                    key={req.requestId}
                    request={req}
                    onRespond={(requestId, decision) => onRespondApproval(run.id, requestId, decision)}
                  />
                ))
              )}
              {!hasText && pendingApprovals.length === 0 && run.status === "running" && (
                <Group gap={8} mt={10} mb={4}>
                  <Loader size="xs" type="dots" color="iris" />
                  <Text size="xs" c="dimmed">{groups.length ? "Working…" : "Waiting for response…"}</Text>
                </Group>
              )}
            </section>
          );
        })}
        {run.error && <Text size="xs" c="red.3" mt={8} role="status">{run.error}</Text>}
        {run.checkpointId && run.status !== "running" && onRestoreCheckpoint && (
          <Group gap={6} mt={6} px={8} py={4} className="checkpoint-banner">
            <ArrowCounterClockwise size={12} weight="bold" color="var(--muted)" aria-hidden="true" />
            <Text size="11px" c="dimmed">Pre-run checkpoint saved</Text>
            <span className="toolbar-spacer" />
            {confirmUndo ? (
              <Group gap={4} wrap="nowrap">
                <Button
                  size="compact-xs"
                  variant="light"
                  color="red"
                  loading={restoring}
                  onClick={async () => {
                    setRestoring(true);
                    try {
                      await onRestoreCheckpoint(run.checkpointId!);
                      setConfirmUndo(false);
                    } finally {
                      setRestoring(false);
                    }
                  }}
                >
                  Confirm undo
                </Button>
                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setConfirmUndo(false)}>
                  Cancel
                </Button>
              </Group>
            ) : (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<ArrowCounterClockwise size={11} />}
                onClick={() => setConfirmUndo(true)}
              >
                Undo turn
              </Button>
            )}
          </Group>
        )}
        <Group gap={8} pt={8} wrap="wrap" className="run-metadata">
          <RunStatus run={run} />
          {run.ttftMs !== undefined && <Text size="11px" c="dimmed" ff="monospace">TTFT {formatDurationCompact(run.ttftMs)}</Text>}
          {run.finishedAt && <Text size="11px" c="dimmed" ff="monospace">{formatDurationCompact(run.finishedAt - run.startedAt)}</Text>}
          {run.inputTokens !== undefined && (
            <Text size="11px" c="dimmed" ff="monospace">
              {run.inputTokens.toLocaleString()} in{cachePct > 0 ? ` (${cachePct}% cached)` : ""}
            </Text>
          )}
          {run.outputTokens !== undefined && <Text size="11px" c="dimmed" ff="monospace">{run.outputTokens.toLocaleString()} out</Text>}
          {tokPerSec !== undefined && tokPerSec > 0 && <Text size="11px" c="dimmed" ff="monospace">{tokPerSec} tok/s</Text>}
          {run.estimatedCostUsd !== undefined && run.estimatedCostUsd > 0 && (
            <Text size="11px" c="dimmed" ff="monospace">
              ~${run.estimatedCostUsd < 0.01 ? run.estimatedCostUsd.toFixed(4) : run.estimatedCostUsd.toFixed(3)}
            </Text>
          )}
          <span className="toolbar-spacer" />
          <Group gap={4} wrap="nowrap">
            {fullReplyText && (
              <Button
                size="compact-xs"
                variant="subtle"
                color={clipboard.copied ? "teal" : "gray"}
                leftSection={clipboard.copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
                onClick={() => clipboard.copy(fullReplyText)}
                aria-label="Copy response"
              >
                {clipboard.copied ? "Copied" : "Copy"}
              </Button>
            )}
            {onFork && run.conversationId && run.status === "succeeded" && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<GitFork size={12} />}
                onClick={() => onFork(run.id)}
                aria-label="Fork thread from this turn"
              >
                Fork
              </Button>
            )}
            {onRetry && run.status !== "running" && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<ArrowClockwise size={12} />}
                onClick={() => onRetry(run.prompt)}
                aria-label="Retry prompt"
              >
                Retry
              </Button>
            )}
          </Group>
        </Group>
      </div>
    </article>
  );
}

interface Props {
  id: string;
  provider: Provider | undefined;
  providers: Provider[];
  config: PaneConfig;
  details: RunDetail[];
  draft: string;
  promptHistory: string[];
  busy: boolean;
  connected: boolean;
  choosingProject: boolean;
  contextCount: number;
  hasSelection: boolean;
  bridge: Bridge | null;
  rpc: RpcCall | undefined;
  cwd: string | null;
  recentWorkspaces?: string[];
  onPickProject?: (recentPath?: string) => void;
  onDraftChange: (value: string) => void;
  onSend: (override?: string) => void;
  onConfig: (patch: PaneConfig) => void;
  onCancel: (id: string) => void;
  onRespondApproval?: (runId: string, requestId: string, decision: ApprovalDecision) => Promise<void> | void;
  onRestoreCheckpoint?: (checkpointId: string) => Promise<void> | void;
  onNewConversation: () => void;
  onOpenProviders: () => void;
  onRefreshProviders?: () => Promise<void> | void;
  onAttachFile: (path: string) => void;
  onAttachGitDiff: (staged: boolean) => void;
  onAttachTerminal: () => void;
  onForkFromRun?: (runId: string) => void;
  onOpenUrl?: (url: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onPreviewDiff?: (request: ApplyPreviewRequest) => void;
  onRunCommand?: (command: string) => void;
}

export function RunPane({
  id, provider, providers, config, details, draft, promptHistory, busy, connected, choosingProject,
  contextCount, hasSelection, bridge, rpc, cwd, recentWorkspaces = [], onPickProject,
  onDraftChange, onSend, onConfig, onCancel, onRespondApproval, onRestoreCheckpoint,
  onNewConversation, onOpenProviders, onRefreshProviders, onAttachFile, onAttachGitDiff, onAttachTerminal,
  onForkFromRun, onOpenUrl, onOpenFile, onPreviewDiff, onRunCommand,
}: Props) {
  const transcript = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const terminalControls = useRef<TerminalControls | null>(null);
  const stickToEnd = useRef(true);
  const [cursor, setCursor] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [terminalState, setTerminalState] = useState<TerminalStateSnapshot>({ running: false, hasStarted: false, status: "" });

  const last = details.at(-1);
  const lastRun = last?.run;
  const isRunning = lastRun?.status === "running";
  const mode = provider && !provider.structured && provider.terminal ? "terminal" : config.mode ?? "structured";
  const model = resolveModel(provider, config.model);
  const effectiveAccessMode = resolveAccessMode(provider, config.accessMode, Boolean(cwd));
  const terminalArgs = terminalArgsFor(provider, model, config.effort);
  const availableProviders = useMemo(() => providers.filter((item) => item.available), [providers]);

  const slashInput = useSlashInput({
    value: draft,
    onChange: onDraftChange,
    onRunCommand: (commandText) => onSend(commandText),
    onFocusInput: () => inputRef.current?.focus(),
    history: promptHistory,
  });

  const mentionInput = useMentionInput({
    value: draft,
    cursor,
    root: cwd,
    rpc,
    onChange: onDraftChange,
    onAttachFile,
    onAttachGitDiff,
    onAttachTerminal,
    onFocusInput: () => inputRef.current?.focus(),
  });

  const handleTerminalState = useCallback((next: TerminalStateSnapshot) => {
    setTerminalState(next);
  }, []);

  useEffect(() => {
    stickToEnd.current = true;
    setShowJump(false);
  }, [config.conversationId, cwd]);

  useEffect(() => {
    if (stickToEnd.current && transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }, [details]);

  function scrollToBottom() {
    stickToEnd.current = true;
    setShowJump(false);
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  const canSend = Boolean(
    draft.trim() && (draft.trim().startsWith("/") || (connected && provider?.structured && !busy && !choosingProject)),
  );
  const attachedCount = contextCount + (hasSelection ? 1 : 0);

  return (
    <div className="run-pane">
      <div className="panel-toolbar">
        <ProviderPicker
          value={provider?.id}
          providers={providers}
          onChange={(providerId) => onConfig({ providerId, model: undefined, effort: undefined, mode: "structured" })}
        />
        <ModelPicker
          paneId={id}
          provider={provider}
          configuredModel={config.model}
          onChange={(nextModel) => onConfig({ model: nextModel })}
          onRefresh={connected ? onRefreshProviders : undefined}
        />
        <EffortPicker
          paneId={id}
          provider={provider}
          model={model}
          effort={config.effort}
          onChange={(effort) => onConfig({ effort })}
        />
        {mode === "structured" && (
          <AccessModePicker
            paneId={id}
            provider={provider}
            accessMode={config.accessMode}
            hasWorkspace={Boolean(cwd)}
            onChange={(accessMode) => onConfig({ accessMode })}
          />
        )}
        {mode === "structured" && provider?.supportsPersistentSession && details.length > 0 && (
          <Badge
            size="xs"
            variant="dot"
            color="teal"
            title="Persistent session active — reuses warm context and prompt cache across turns"
            styles={{ label: { textTransform: "none", fontWeight: 500 } }}
          >
            Live
          </Badge>
        )}
        <span className="toolbar-spacer" />

        {mode === "terminal" && provider?.terminal && (
          <Group gap={5} wrap="nowrap">
            {terminalState.status && <span className="terminal-status-inline">{terminalState.status}</span>}
            {terminalState.running ? (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<Stop size={11} weight="fill" />}
                onClick={() => terminalControls.current?.stop()}
              >
                Stop
              </Button>
            ) : (
              <Button
                size="compact-xs"
                variant="subtle"
                color="iris"
                disabled={!bridge}
                leftSection={<Play size={11} weight="fill" />}
                onClick={() => terminalControls.current?.start()}
              >
                {terminalState.hasStarted ? "Restart" : "Start"}
              </Button>
            )}
          </Group>
        )}

        {mode === "structured" && details.length > 0 && !isRunning && (
          <HintTooltip label="New conversation" shortcut={formatShortcut("new-conversation")}>
            <ActionIcon aria-label="New conversation" onClick={onNewConversation}>
              <NotePencil size={15} weight="duotone" />
            </ActionIcon>
          </HintTooltip>
        )}

        {provider?.terminal && (
          <HintTooltip
            label={provider.structured ? "Toggle interactive terminal" : "Interactive terminal"}
            shortcut={provider.structured ? formatShortcut("toggle-terminal") : undefined}
          >
            <ActionIcon
              variant={mode === "terminal" ? "light" : "subtle"}
              color={mode === "terminal" ? "iris" : "gray"}
              aria-label="Interactive terminal mode"
              aria-pressed={mode === "terminal"}
              disabled={!provider.structured}
              onClick={() => onConfig({ mode: mode === "terminal" ? "structured" : "terminal" })}
            >
              <TerminalWindow size={15} weight="duotone" />
            </ActionIcon>
          </HintTooltip>
        )}
      </div>

      {mode === "terminal" && provider?.terminal && (
        <TerminalPanel
          key={JSON.stringify([id, provider.id, provider.command, terminalArgs, cwd])}
          bridge={bridge}
          cwd={cwd}
          program={provider.command}
          args={terminalArgs}
          title={model ? `${provider.name} · ${shortModelName(model)}` : provider.name}
          embedded
          autoStart
          controlsRef={terminalControls}
          onStateChange={handleTerminalState}
        />
      )}

      {(mode === "structured" || !provider?.terminal) && (
        <>
          <div className="transcript-wrap">
            <div
              className="transcript-scroll"
              ref={transcript}
              onScroll={(event) => {
                const node = event.currentTarget;
                const nearEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                stickToEnd.current = nearEnd;
                setShowJump(!nearEnd && details.length > 0);
              }}
            >
              {details.length ? details.map((detail) => (
                <Transcript
                  key={detail.run.id}
                  detail={detail}
                  providers={providers}
                  onRetry={provider?.structured && !busy ? (prompt) => onSend(prompt) : undefined}
                  onFork={onForkFromRun}
                  onOpenUrl={onOpenUrl}
                  onOpenFile={onOpenFile}
                  onPreviewDiff={onPreviewDiff}
                  onRunCommand={onRunCommand}
                  onRespondApproval={onRespondApproval}
                  onRestoreCheckpoint={onRestoreCheckpoint}
                />
              )) : !cwd ? (
                <Stack align="center" justify="center" gap="sm" flex={1} p="lg" ta="center">
                  <Paper withBorder radius="md" p="md" bg="dark.8" className="welcome-card" maw={400} w="100%">
                    <Stack align="center" gap="xs">
                      <div className="empty-emblem">
                        <ProviderIcon providerId={provider?.id} size={32} framed />
                      </div>
                      <Text size="sm" fw={650}>
                        {provider?.structured ? `${provider.name} is ready` : "Open a project to start"}
                      </Text>
                      <Text size="xs" c="dimmed" lh={1.45}>
                        Open a folder to unlock live Explore & Agent modes, ripgrep search, reversible checkpoints, and parallel Worktree Arena.
                      </Text>
                      {onPickProject && (
                        <Button
                          size="xs"
                          color="iris"
                          mt={4}
                          leftSection={<FolderOpen size={14} weight="duotone" />}
                          onClick={() => onPickProject()}
                        >
                          Open project folder
                        </Button>
                      )}
                      {recentWorkspaces.length > 0 && onPickProject && (
                        <Group gap={5} justify="center" mt={4} wrap="wrap">
                          {recentWorkspaces.slice(0, 4).map((path) => (
                            <Button
                              key={path}
                              size="compact-xs"
                              variant="default"
                              leftSection={<FolderOpen size={11} />}
                              title={path}
                              onClick={() => onPickProject(path)}
                            >
                              {workspaceLabel(path)}
                            </Button>
                          ))}
                        </Group>
                      )}
                      <Group gap="sm" mt={6} justify="center">
                        <Badge size="xs" variant="light" color="gray">
                          {availableProviders.length} {availableProviders.length === 1 ? "provider" : "providers"} ready
                        </Badge>
                        {!provider && (
                          <Button variant="subtle" color="iris" size="compact-xs" onClick={onOpenProviders}>
                            Manage providers
                          </Button>
                        )}
                      </Group>
                    </Stack>
                  </Paper>
                </Stack>
              ) : (
                <Stack align="center" justify="center" gap="xs" flex={1} p="lg" ta="center">
                  <div className="empty-emblem">
                    <ProviderIcon providerId={provider?.id} size={36} framed />
                  </div>
                  <Text size="sm" fw={600}>
                    {provider?.structured ? `${provider.name} is ready` : "Connect a provider"}
                  </Text>
                  <Text size="xs" c="dimmed" maw={360}>
                    {provider?.structured
                      ? `${ACCESS_MODE_META[effectiveAccessMode].label} mode — ${ACCESS_MODE_META[effectiveAccessMode].hint}.`
                      : "Discover installed CLIs and local runtimes in Providers."}
                  </Text>
                  {provider?.structured && (
                    <Group gap="sm" mt={4} justify="center">
                      <Group gap={5}><Kbd>↵</Kbd><Text size="11px" c="dimmed">Send</Text></Group>
                      <Group gap={5}><Kbd>@</Kbd><Text size="11px" c="dimmed">Context</Text></Group>
                      <Group gap={5}><Kbd>/</Kbd><Text size="11px" c="dimmed">Commands</Text></Group>
                    </Group>
                  )}
                  {!provider && (
                    <Button variant="subtle" color="iris" size="compact-xs" onClick={onOpenProviders}>
                      Manage providers
                    </Button>
                  )}
                </Stack>
              )}
            </div>
            {showJump && (
              <Button
                size="compact-xs"
                radius="xl"
                variant="light"
                color="iris"
                className="jump-latest"
                leftSection={<ArrowDown size={12} weight="bold" />}
                onClick={scrollToBottom}
              >
                Latest
              </Button>
            )}
          </div>

          <div className="pane-composer-wrap">
            <SlashMenu
              commands={slashInput.slashMatches}
              selectedIndex={slashInput.activeSlashIndex}
              onSelect={slashInput.applySlashCommand}
            />
            {!slashInput.slashMatches.length && (
              <MentionMenu
                items={mentionInput.mentionItems}
                selectedIndex={mentionInput.activeMentionIndex}
                onSelect={mentionInput.applyMention}
              />
            )}
            <Paper withBorder radius="md" bg="dark.8" className="pane-composer-card">
              <form
                className="pane-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!canSend) return;
                  slashInput.resetHistory();
                  onSend();
                }}
              >
                <div className="growable-textarea" data-replicated-value={draft}>
                  <textarea
                    ref={inputRef}
                    rows={1}
                    className="pane-input"
                    data-pane-input={id}
                    aria-label={provider ? `Message ${provider.name}` : "Message split"}
                    value={draft}
                    onChange={(event) => {
                      setCursor(event.target.selectionStart ?? event.target.value.length);
                      slashInput.handleChange(event.target.value);
                    }}
                    onClick={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
                    onKeyUp={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
                    onKeyDown={(event) => {
                      if (mentionInput.handleMentionKeyDown(event)) return;
                      slashInput.handleKeyDown(event);
                    }}
                    placeholder={
                      provider?.structured
                        ? `Message ${provider.name} (${ACCESS_MODE_META[effectiveAccessMode].short})… (@ context, / commands)`
                        : "Choose a structured provider…"
                    }
                  />
                </div>
                <Group gap={5} wrap="nowrap" pb={1}>
                  {attachedCount > 0 && (
                    <Badge
                      size="xs"
                      variant="light"
                      color="iris"
                      leftSection={<Files size={11} weight="duotone" />}
                      title="Workspace context attached to next prompt"
                    >
                      {attachedCount}
                    </Badge>
                  )}
                  {isRunning && lastRun ? (
                    <HintTooltip label="Cancel run" shortcut={formatShortcut("cancel-run")}>
                      <ActionIcon
                        size="sm"
                        variant="light"
                        color="red"
                        aria-label="Cancel run"
                        disabled={cancelPending}
                        onClick={async () => {
                          setCancelPending(true);
                          try {
                            await onCancel(lastRun.id);
                          } finally {
                            setCancelPending(false);
                          }
                        }}
                      >
                        <StopCircle size={15} weight="fill" />
                      </ActionIcon>
                    </HintTooltip>
                  ) : (
                    <ActionIcon
                      type="submit"
                      size="sm"
                      variant="filled"
                      color="iris"
                      aria-label={provider ? `Send to ${provider.name}` : "Send"}
                      disabled={!canSend}
                    >
                      <ArrowUp size={13} weight="bold" color={canSend ? "#161025" : "currentColor"} />
                    </ActionIcon>
                  )}
                </Group>
              </form>
            </Paper>
          </div>
        </>
      )}
    </div>
  );
}
