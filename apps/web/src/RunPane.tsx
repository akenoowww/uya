import { useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, Badge, Button, Group, Kbd } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import {
  ArrowClockwise, ArrowDown, ArrowUp, Check, Copy, Files, Lightning,
  NotePencil, StopCircle, TerminalWindow,
} from "@phosphor-icons/react";
import type { Provider, RunDetail, RunEvent, RunSummary } from "@ide/protocol";
import type { Bridge } from "./bridge";
import { MarkdownView } from "./components/MarkdownView";
import { ModelPicker } from "./components/ModelPicker";
import { ProviderIcon } from "./components/ProviderIcon";
import { ProviderPicker } from "./components/ProviderPicker";
import { SlashMenu } from "./components/SlashMenu";
import { HintTooltip } from "./components/Tooltip";
import { useSlashInput } from "./hooks/useSlashInput";
import { formatShortcut } from "./shortcuts";
import { TerminalPanel } from "./TerminalPanel";
import { resolveModel, shortModelName } from "./workbenchStore";

export interface PaneConfig {
  conversationId?: string;
  providerId?: string;
  model?: string;
  mode?: "structured" | "terminal";
}

function duration(milliseconds: number) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

export function RunStatus({ run }: { run: RunSummary | undefined }) {
  if (!run) return <span className="run-state"><span className="state-dot" /> Ready</span>;
  const label = { running: "Streaming", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled" }[run.status];
  return <span className={`run-state ${run.status}`}><span className="state-dot" />{label}</span>;
}

function groupEvents(events: RunEvent[]) {
  const groups: { seq: number; type: "text" | "thinking" | "tool"; text: string }[] = [];
  for (const event of events) {
    if (event.type === "status") continue;
    const last = groups.at(-1);
    if (last?.type === event.type && event.type !== "tool") last.text += event.text;
    else groups.push({ seq: event.seq, type: event.type, text: event.text });
  }
  return groups;
}

function terminalArgsFor(provider: Provider | undefined, model: string | undefined): string[] | undefined {
  if (!provider) return undefined;
  if (provider.id === "ollama" && model) return ["run", model];
  if (provider.kind === "cli" && model && ["codex", "claude", "gemini", "qwen", "opencode"].includes(provider.id)) {
    return [...(provider.terminalArgs ?? []), "--model", model];
  }
  return provider.terminalArgs;
}

export function Transcript({
  detail,
  providers,
  onRetry,
}: {
  detail: RunDetail;
  providers: Provider[];
  onRetry?: (prompt: string) => void;
}) {
  const clipboard = useClipboard({ timeout: 1600 });
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

  const fullReplyText = useMemo(() => {
    const lastAttempt = attempts.at(-1);
    return (lastAttempt?.events ?? [])
      .flatMap((event) => event.type === "text" ? [event.text] : [])
      .join("");
  }, [detail]);

  return (
    <article className="transcript">
      <div className="prompt-turn">
        <span className="turn-role">You</span>
        <p>{run.prompt}</p>
      </div>
      <div className="response-turn">
        {attempts.map(({ run: attempt, events: output }, index) => {
          const providerName = attempt.providerName ?? providers.find((item) => item.id === attempt.providerId)?.name ?? attempt.providerId;
          const displayModel = (index === attempts.length - 1 ? run.model : undefined) ?? attempt.model;
          const groups = groupEvents(output);
          const hasText = groups.some((group) => group.type === "text");
          return (
            <section className="response-attempt" key={`${attempt.providerId}-${index}`}>
              <div className="response-byline">
                <ProviderIcon providerId={attempt.providerId} size={13} />
                <strong>{providerName}</strong>
                {displayModel && (
                  <Badge size="xs" variant="outline" color="gray" radius="sm" ff="monospace">
                    {shortModelName(displayModel)}
                  </Badge>
                )}
              </div>
              {groups.map((group) => group.type === "text" ? (
                <MarkdownView key={group.seq} text={group.text} />
              ) : (
                <details className="run-disclosure" key={group.seq}>
                  <summary>
                    <Lightning size={12} weight="duotone" aria-hidden="true" />
                    <span>{group.type === "thinking" ? "Reasoning" : "Activity"}</span>
                  </summary>
                  <pre>{group.text}</pre>
                </details>
              ))}
              {!hasText && run.status === "running" && (
                <p className="run-pending">
                  <span className="pending-pulse" aria-hidden="true" />
                  {groups.length ? "Thinking…" : "Waiting for response…"}
                </p>
              )}
            </section>
          );
        })}
        {run.error && <p className="run-error" role="status">{run.error}</p>}
        <div className="run-metadata">
          <RunStatus run={run} />
          {run.ttftMs !== undefined && <span>TTFT {duration(run.ttftMs)}</span>}
          {run.finishedAt && <span>{duration(run.finishedAt - run.startedAt)}</span>}
          {run.inputTokens !== undefined && <span>{run.inputTokens} in</span>}
          {run.outputTokens !== undefined && <span>{run.outputTokens} out</span>}
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
        </div>
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
  cwd: string | null;
  onDraftChange: (value: string) => void;
  onSend: (override?: string) => void;
  onConfig: (patch: PaneConfig) => void;
  onCancel: (id: string) => void;
  onNewConversation: () => void;
  onOpenProviders: () => void;
}

export function RunPane({
  id, provider, providers, config, details, draft, promptHistory, busy, connected, choosingProject,
  contextCount, hasSelection, bridge, cwd, onDraftChange, onSend, onConfig, onCancel,
  onNewConversation, onOpenProviders,
}: Props) {
  const transcript = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToEnd = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

  const last = details.at(-1);
  const lastRun = last?.run;
  const isRunning = lastRun?.status === "running";
  const mode = provider && !provider.structured && provider.terminal ? "terminal" : config.mode ?? "structured";
  const model = resolveModel(provider, config.model);
  const terminalArgs = terminalArgsFor(provider, model);
  const slashInput = useSlashInput({
    value: draft,
    onChange: onDraftChange,
    onRunCommand: (commandText) => onSend(commandText),
    onFocusInput: () => inputRef.current?.focus(),
    history: promptHistory,
  });

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
          onChange={(providerId) => onConfig({ providerId, model: undefined, mode: "structured" })}
        />
        <ModelPicker
          paneId={id}
          provider={provider}
          configuredModel={config.model}
          onChange={(nextModel) => onConfig({ model: nextModel })}
        />
        <span className="toolbar-spacer" />
        {mode === "structured" && details.length > 0 && !isRunning && (
          <HintTooltip label="New conversation" shortcut={formatShortcut("new-conversation")}>
            <ActionIcon aria-label="New conversation" onClick={onNewConversation}>
              <NotePencil size={15} weight="duotone" />
            </ActionIcon>
          </HintTooltip>
        )}
        {isRunning && lastRun && (
          <HintTooltip label="Cancel run" shortcut={formatShortcut("cancel-run")}>
            <ActionIcon
              color="red"
              variant="light"
              aria-label="Cancel run"
              disabled={cancelPending}
              onClick={async () => {
                setCancelPending(true);
                await onCancel(lastRun.id);
                setCancelPending(false);
              }}
            >
              <StopCircle size={16} weight="duotone" />
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
                />
              )) : (
                <div className="pane-empty">
                  <div className="empty-emblem">
                    <ProviderIcon providerId={provider?.id} size={22} />
                  </div>
                  <strong>{provider?.structured ? `${provider.name} is ready` : "Connect a provider"}</strong>
                  <span>
                    {provider?.structured
                      ? `Message ${provider.name}${model ? ` (${shortModelName(model)})` : ""} directly below, or use Broadcast.`
                      : "Discover installed CLIs and local runtimes in Providers."}
                  </span>
                  {provider?.structured && (
                    <div className="empty-hints">
                      <span><Kbd>↵</Kbd> Send</span>
                      <span><Kbd>/</Kbd> Commands</span>
                      <span><Kbd>{formatShortcut("palette")}</Kbd> Palette</span>
                    </div>
                  )}
                  {!provider && (
                    <Button variant="subtle" color="iris" size="compact-xs" onClick={onOpenProviders}>
                      Manage providers
                    </Button>
                  )}
                </div>
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
            <form
              className="pane-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSend) return;
                slashInput.resetHistory();
                onSend();
              }}
            >
              <textarea
                ref={inputRef}
                rows={1}
                className="pane-input"
                data-pane-input={id}
                aria-label={provider ? `Message ${provider.name}` : "Message split"}
                value={draft}
                onChange={(event) => slashInput.handleChange(event.target.value)}
                onKeyDown={slashInput.handleKeyDown}
                placeholder={
                  provider?.structured
                    ? `Message ${provider.name}${model ? ` (${shortModelName(model)})` : ""}… (↵ to send, / for commands)`
                    : "Choose a structured provider…"
                }
              />
              <div className="pane-composer-actions">
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
                  <ActionIcon
                    size="sm"
                    variant="light"
                    color="red"
                    aria-label="Cancel run"
                    disabled={cancelPending}
                    onClick={async () => {
                      setCancelPending(true);
                      await onCancel(lastRun.id);
                      setCancelPending(false);
                    }}
                  >
                    <StopCircle size={15} weight="fill" />
                  </ActionIcon>
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
              </div>
            </form>
            <div className="pane-footer">
              <RunStatus run={lastRun} />
              <span className="pane-footer-right">
                {model ? <span className="footer-model">{shortModelName(model)}</span> : null}
                <span>Read-only</span>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
