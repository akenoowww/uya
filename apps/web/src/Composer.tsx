import { useMemo, useRef, useState } from "react";
import {
  ActionIcon, Alert, Badge, Button, Checkbox, Code, Group, Kbd, Menu, Paper, Pill, Progress, Select, Text, TextInput,
} from "@mantine/core";
import {
  ArrowUp, BookOpen, Broadcast, CaretDown, CaretUp, Files, GitBranch, GitDiff, GitFork, Paperclip,
  Scales, Scroll, TerminalWindow, TreeStructure,
} from "@phosphor-icons/react";
import type { RoutingMode } from "@ide/protocol";
import { useShallow } from "zustand/react/shallow";
import { ArenaBar } from "./components/ArenaBar";
import { MentionMenu } from "./components/MentionMenu";
import { ProviderIcon } from "./components/ProviderIcon";
import { SlashMenu } from "./components/SlashMenu";
import { useMentionInput } from "./hooks/useMentionInput";
import { useSlashInput } from "./hooks/useSlashInput";
import { formatShortcut } from "./shortcuts";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";
import {
  estimateContextBudget, formatDurationCompact, hasBusyDestination, resolveModel, routingTargets,
  shortModelName, workspaceLabel,
} from "./workbenchStore";

function formatKiB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes >= 10_240 ? 0 : 1)} KiB`;
}

export function Composer() {
  const workbench = useWorkbench();
  const {
    store, dock: dockLayout, sendPrompt, toggleContext, attachFile, attachGitDiff, attachTerminal,
    removeAttachment, toggleProjectRules, toggleWorkspaceMap, toggleArena, retryConnection, core,
    toggleBroadcastCollapsed, toggleBroadcastTarget, selectAllBroadcastTargets, judgeDialog,
  } = workbench;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);

  const {
    bridge, workspace, gitBranch, providers, dock, broadcast, broadcastCollapsed, broadcastTargets,
    lastBroadcastRunIds, details, routing, tags, fallbackIds, contextPaths, contextSizes,
    attachments, selection, projectRules, includeProjectRules, includeWorkspaceMap, arenaEnabled,
    activeArena, verifyPresets, template, composer, choosing, submitting, connectionError, error,
  } = useWorkbenchState(useShallow((state) => ({
    bridge: state.bridge,
    workspace: state.workspace,
    gitBranch: state.gitBranch,
    providers: state.providers,
    dock: state.dock,
    broadcast: state.broadcast,
    broadcastCollapsed: state.broadcastCollapsed,
    broadcastTargets: state.broadcastTargets,
    lastBroadcastRunIds: state.lastBroadcastRunIds,
    details: state.details,
    routing: state.routing,
    tags: state.tags,
    fallbackIds: state.fallbackIds,
    contextPaths: state.contextPaths,
    contextSizes: state.contextSizes,
    attachments: state.attachments,
    selection: state.selection,
    projectRules: state.projectRules,
    includeProjectRules: state.includeProjectRules,
    includeWorkspaceMap: state.includeWorkspaceMap,
    arenaEnabled: state.arenaEnabled,
    activeArena: state.activeArena,
    verifyPresets: state.verifyPresets,
    template: state.template,
    composer: state.composer,
    choosing: state.choosingProject,
    submitting: state.submitting,
    connectionError: state.connectionError,
    error: state.error,
  })));

  const { targets, useBroadcast, selected, destinations } = useMemo(
    () => routingTargets(providers, dock, broadcast, broadcastTargets),
    [providers, dock, broadcast, broadcastTargets],
  );
  const structured = useMemo(() => providers.filter((provider) => provider.available && provider.structured), [providers]);
  const destinationBusy = useWorkbenchState((state) => hasBusyDestination(state, destinations));

  const slashInput = useSlashInput({
    value: composer,
    onChange: (next) => store.setState({ composer: next }),
    onRunCommand: (commandText) => { workbench.executeSlashCommand(commandText); },
    onFocusInput: () => inputRef.current?.focus(),
  });

  const mentionInput = useMentionInput({
    value: composer,
    cursor,
    root: workspace?.path ?? null,
    rpc: bridge?.rpc,
    onChange: (next) => store.setState({ composer: next }),
    onAttachFile: attachFile,
    onAttachGitDiff: attachGitDiff,
    onAttachTerminal: attachTerminal,
    onFocusInput: () => inputRef.current?.focus(),
  });

  const budget = useMemo(
    () => estimateContextBudget({ contextPaths, contextSizes, attachments, selection, projectRules, includeProjectRules }),
    [attachments, contextPaths, contextSizes, includeProjectRules, projectRules, selection],
  );

  const completedBroadcast = useMemo(
    () => lastBroadcastRunIds
      .map((id) => details[id])
      .filter((detail): detail is NonNullable<typeof detail> => Boolean(detail && detail.run.status === "succeeded")),
    [details, lastBroadcastRunIds],
  );

  const allSelected = broadcastTargets.length === 0 || broadcastTargets.length >= targets.length;
  const canSend = Boolean(
    composer.trim() && (
      composer.trim().startsWith("/")
      || (bridge && destinations.length > 0 && !choosing && !submitting && !destinationBusy)
    ),
  );
  const budgetColor = budget.ratio > 0.95 ? "red" : budget.ratio > 0.7 ? "yellow" : "iris";
  const budgetPercent = Math.min(100, Math.round(budget.ratio * 100));

  const contextMenu = (
    <Menu position="top-start" width={275}>
      <Menu.Target>
        <Button size="compact-xs" variant="subtle" color="gray" leftSection={<Paperclip size={12} />}>
          Context
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Attach to next prompt</Menu.Label>
        <Menu.Item
          leftSection={<GitDiff size={13} color="var(--accent)" />}
          rightSection={<Code bg="dark.8" c="iris.2" fz="10px">@git-diff</Code>}
          disabled={!workspace}
          onClick={() => void attachGitDiff(false)}
        >
          Unstaged Git diff
        </Menu.Item>
        <Menu.Item
          leftSection={<GitDiff size={13} color="var(--positive)" />}
          rightSection={<Code bg="dark.8" c="iris.2" fz="10px">@git-staged</Code>}
          disabled={!workspace}
          onClick={() => void attachGitDiff(true)}
        >
          Staged Git diff
        </Menu.Item>
        <Menu.Item
          leftSection={<TerminalWindow size={13} color="var(--positive)" />}
          rightSection={<Code bg="dark.8" c="iris.2" fz="10px">@terminal</Code>}
          onClick={attachTerminal}
        >
          Latest terminal output
        </Menu.Item>
        {workspace && (
          <>
            <Menu.Divider />
            <Menu.Item
              leftSection={<TreeStructure size={13} color={includeWorkspaceMap ? "var(--positive)" : "var(--muted)"} />}
              onClick={toggleWorkspaceMap}
            >
              {includeWorkspaceMap ? "Disable" : "Enable"} workspace file map
            </Menu.Item>
          </>
        )}
        {projectRules.length > 0 && (
          <>
            {!workspace && <Menu.Divider />}
            <Menu.Item
              leftSection={<Scroll size={13} />}
              onClick={toggleProjectRules}
            >
              {includeProjectRules ? "Disable" : "Enable"} {projectRules[0].path}
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );

  const contextPills = (
    <>
      {projectRules.length > 0 && (
        <Button
          size="compact-xs"
          radius="xl"
          variant={includeProjectRules ? "light" : "default"}
          color={includeProjectRules ? "teal" : "gray"}
          leftSection={<Scroll size={11} weight="duotone" />}
          title={`Project instructions: ${projectRules.map((rule) => rule.path).join(", ")}`}
          onClick={toggleProjectRules}
        >
          {projectRules[0].path}{projectRules.length > 1 ? ` +${projectRules.length - 1}` : ""}
        </Button>
      )}
      <Pill.Group gap={5}>
        {contextPaths.map((path) => (
          <Pill
            key={path}
            size="xs"
            withRemoveButton
            className="context-pill"
            title={path}
            removeButtonProps={{ "aria-label": `Remove ${path} from prompt context` }}
            onRemove={() => toggleContext(path)}
          >
            <span className="pill-inner"><Files size={11} weight="duotone" />{workspaceLabel(path)}</span>
          </Pill>
        ))}
        {attachments.map((item) => (
          <Pill
            key={item.path}
            size="xs"
            withRemoveButton
            className="context-pill"
            title={item.path}
            removeButtonProps={{ "aria-label": `Remove ${item.path} from prompt context` }}
            onRemove={() => removeAttachment(item.path)}
          >
            <span className="pill-inner">
              {item.path.startsWith("@terminal") ? <TerminalWindow size={11} weight="duotone" /> : <GitDiff size={11} weight="duotone" />}
              {item.path}
            </span>
          </Pill>
        ))}
        {selection && (
          <Pill
            size="xs"
            withRemoveButton
            className="context-pill"
            removeButtonProps={{ "aria-label": "Remove code selection from prompt" }}
            onRemove={() => store.setState({ selection: null })}
          >
            <span className="pill-inner"><Files size={11} weight="duotone" />Selected code</span>
          </Pill>
        )}
        {template && (
          <Pill
            size="xs"
            withRemoveButton
            className="context-pill"
            removeButtonProps={{ "aria-label": "Remove prompt template revision" }}
            onRemove={() => store.setState({ template: null })}
          >
            <span className="pill-inner"><BookOpen size={11} weight="duotone" />Prompt template</span>
          </Pill>
        )}
      </Pill.Group>
      {budget.bytes > 0 && (
        <Group gap={6} wrap="nowrap" title={`Context budget: ${formatKiB(budget.bytes)} / 256 KiB (~${budget.approxTokens.toLocaleString()} tokens)`}>
          <Progress value={budgetPercent} size={4} w={44} color={budgetColor} radius="xl" />
          <Text size="10px" ff="monospace" c={budgetColor === "iris" ? "dimmed" : budgetColor}>
            {formatKiB(budget.bytes)} · ~{budget.approxTokens >= 1000 ? `${(budget.approxTokens / 1000).toFixed(1)}k` : budget.approxTokens}t
          </Text>
        </Group>
      )}
    </>
  );

  return (
    <div className={`composer-area ${broadcastCollapsed ? "collapsed" : ""}`}>
      {connectionError && (
        <Alert color="red" variant="light" className="workbench-alert" py={6} px={10} mb={6} radius="sm">
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="xs" c="red.2">{connectionError}</Text>
            <Button size="compact-xs" variant="subtle" color="iris" onClick={retryConnection}>
              Retry connection
            </Button>
          </Group>
        </Alert>
      )}
      {error && (
        <Alert
          color="red"
          variant="light"
          className="workbench-alert"
          py={6}
          px={10}
          mb={6}
          radius="sm"
          withCloseButton
          closeButtonLabel="Dismiss error"
          onClose={() => core.reportError("")}
        >
          <Text size="xs" c="red.2">{error}</Text>
        </Alert>
      )}

      {activeArena && activeArena.status === "active" && (
        <ArenaBar
          arena={activeArena}
          verifyPresets={verifyPresets}
          onInspectFile={(arenaId, slotId, path, label) => {
            dockLayout.openDiff({ mode: "arena", arenaId, arenaSlotId: slotId, arenaLabel: label, path });
          }}
          onVerifySlot={(arenaId, slotId, command) => {
            void core.startVerify(command, { arenaId, arenaSlotId: slotId });
          }}
          onApplySlot={core.applyArenaSlot}
          onDiscard={core.discardArena}
          onJudgePatches={() => judgeDialog.current?.()}
        />
      )}

      {completedBroadcast.length >= 2 && (
        <Paper p="5px 8px" mb={6} withBorder radius="sm" className="broadcast-summary-bar">
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Group gap={6} wrap="wrap" style={{ minWidth: 0, flex: 1 }}>
              <Badge size="xs" variant="light" color="iris">Broadcast ({completedBroadcast.length})</Badge>
              {completedBroadcast.map((detail) => {
                const ms = detail.run.finishedAt ? detail.run.finishedAt - detail.run.startedAt : 0;
                return (
                  <Badge
                    key={detail.run.id}
                    size="xs"
                    variant="default"
                    leftSection={<ProviderIcon providerId={detail.run.providerId} size={11} framed={false} />}
                    styles={{ label: { fontWeight: 500, textTransform: "none" } }}
                  >
                    {detail.run.providerName ?? detail.run.providerId}
                    {detail.run.ttftMs !== undefined ? ` · ${formatDurationCompact(detail.run.ttftMs)}` : ""}
                    {ms > 0 ? ` / ${formatDurationCompact(ms)}` : ""}
                    {detail.run.outputTokens !== undefined ? ` · ${detail.run.outputTokens}t` : ""}
                  </Badge>
                );
              })}
            </Group>
            <Button
              size="compact-xs"
              variant="light"
              color="iris"
              leftSection={<Scales size={12} weight="duotone" />}
              onClick={() => judgeDialog.current?.()}
            >
              Cross-review / Synthesize
            </Button>
          </Group>
        </Paper>
      )}

      {broadcastCollapsed ? (
        <Paper px={8} py={4} withBorder radius="sm" bg="dark.7">
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Group gap={6} wrap="wrap" style={{ minWidth: 0, flex: 1 }}>
              {contextMenu}
              {contextPills}
            </Group>
            <Button
              size="compact-xs"
              variant="subtle"
              color="iris"
              leftSection={<Broadcast size={13} weight="duotone" />}
              rightSection={<Group gap={5}><Kbd>{formatShortcut("toggle-broadcast")}</Kbd><CaretUp size={10} weight="bold" /></Group>}
              onClick={toggleBroadcastCollapsed}
            >
              Broadcast ({targets.length})
            </Button>
          </Group>
        </Paper>
      ) : (
        <div className="composer-shell">
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
          <Paper withBorder radius="md" p="7px 8px" bg="dark.7" className="composer">
            <form onSubmit={(event) => { event.preventDefault(); void sendPrompt(); }}>
              <Group gap={5} wrap="wrap" pb={6} mb={4} style={{ borderBottom: "1px solid var(--line)" }}>
                <Button
                  size="compact-xs"
                  radius="xl"
                  variant={useBroadcast && allSelected ? "light" : "default"}
                  color={useBroadcast && allSelected ? "iris" : "gray"}
                  disabled={targets.length < 2}
                  leftSection={<Broadcast size={13} weight="duotone" />}
                  onClick={selectAllBroadcastTargets}
                >
                  All ({targets.length})
                </Button>
                {targets.length > 1 && targets.map((pane) => {
                  const isSelected = useBroadcast && !allSelected && broadcastTargets.includes(pane.id);
                  const model = resolveModel(pane.provider, pane.config.model);
                  return (
                    <Button
                      key={pane.id}
                      size="compact-xs"
                      radius="xl"
                      variant={isSelected ? "light" : "default"}
                      color={isSelected ? "iris" : "gray"}
                      leftSection={<ProviderIcon providerId={pane.provider.id} size={12} framed={false} />}
                      onClick={() => toggleBroadcastTarget(pane.id)}
                    >
                      {pane.provider.name}{model ? ` · ${shortModelName(model)}` : ""}
                    </Button>
                  );
                })}
                <Button
                  size="compact-xs"
                  radius="xl"
                  variant={!useBroadcast ? "light" : "default"}
                  color={!useBroadcast ? "iris" : "gray"}
                  leftSection={<GitFork size={12} weight="duotone" />}
                  onClick={() => store.setState({ broadcast: false })}
                >
                  Routed
                </Button>
                {useBroadcast && targets.length >= 2 && (
                  <Button
                    size="compact-xs"
                    radius="xl"
                    variant={arenaEnabled && workspace && gitBranch ? "light" : "default"}
                    color={arenaEnabled && workspace && gitBranch ? "teal" : "gray"}
                    disabled={!workspace || !gitBranch}
                    leftSection={<GitBranch size={12} weight="duotone" />}
                    title={
                      workspace && gitBranch
                        ? "Worktree Arena: run each model in its own isolated git worktree, verify diffs, and apply the winner"
                        : "Open a Git repository to enable Worktree Arena"
                    }
                    onClick={toggleArena}
                  >
                    Worktree Arena
                  </Button>
                )}
                <span className="toolbar-spacer" />
                <ActionIcon
                  size="xs"
                  aria-label="Collapse broadcast bar"
                  title="Collapse broadcast bar"
                  onClick={toggleBroadcastCollapsed}
                >
                  <CaretDown size={13} weight="bold" />
                </ActionIcon>
              </Group>

              <Group gap={6} wrap="wrap" mb={4}>
                {contextMenu}
                {contextPills}
              </Group>

              <div className="growable-textarea composer-growable" data-replicated-value={composer}>
                <textarea
                  ref={inputRef}
                  id="prompt-input"
                  rows={2}
                  aria-label="Multi-model prompt"
                  value={composer}
                  onChange={(event) => {
                    setCursor(event.target.selectionStart ?? event.target.value.length);
                    slashInput.handleChange(event.target.value);
                  }}
                  onClick={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
                  onKeyUp={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
                  placeholder={
                    useBroadcast && arenaEnabled && workspace && gitBranch && destinations.length >= 2
                      ? `Launch Worktree Arena across ${destinations.length} isolated branches… (@ context, ↵ send)`
                      : useBroadcast
                        ? `Broadcast to ${destinations.length} splits… (@ context, / commands, ↵ send)`
                        : `Send routed prompt to ${selected?.provider.name ?? "selected split"}… (@ context, ↵ send)`
                  }
                  onKeyDown={(event) => {
                    if (mentionInput.handleMentionKeyDown(event)) return;
                    slashInput.handleKeyDown(event);
                  }}
                />
              </div>

              {!useBroadcast && routing === "rule" && (
                <Group gap={6} mb={6}>
                  <TextInput
                    size="xs"
                    placeholder="Tags (e.g. review, tests)"
                    aria-label="Routing tags"
                    value={tags}
                    onChange={(event) => store.setState({ tags: event.currentTarget.value })}
                    w={220}
                  />
                </Group>
              )}

              {!useBroadcast && routing === "fallback" && (
                <Paper p="6px 8px" mb={6} withBorder bg="dark.8">
                  <Text size="10px" c="dimmed" mb={4}>Fallback providers in selection order</Text>
                  <Group gap="sm" wrap="wrap">
                    {structured.filter((provider) => provider.id !== selected?.provider.id).map((provider) => (
                      <Checkbox
                        key={provider.id}
                        size="xs"
                        checked={fallbackIds.includes(provider.id)}
                        label={`${provider.name}${fallbackIds.includes(provider.id) ? ` (${fallbackIds.indexOf(provider.id) + 1})` : ""}`}
                        onChange={() => store.setState((state) => ({
                          fallbackIds: state.fallbackIds.includes(provider.id)
                            ? state.fallbackIds.filter((id) => id !== provider.id)
                            : [...state.fallbackIds, provider.id],
                        }))}
                      />
                    ))}
                    {structured.length < 2 && <Text size="xs" c="dimmed">Connect a second structured provider.</Text>}
                  </Group>
                </Paper>
              )}

              <Group gap={7} pt={4} wrap="nowrap">
                {!useBroadcast && (
                  <Select
                    aria-label="Routing mode"
                    size="xs"
                    w={136}
                    leftSection={<GitFork size={13} weight="duotone" />}
                    value={routing}
                    data={[
                      { value: "manual", label: "Manual" },
                      { value: "rule", label: "Rule-based" },
                      { value: "fallback", label: "Fallback" },
                    ]}
                    onChange={(value) => { if (value) store.setState({ routing: value as RoutingMode }); }}
                  />
                )}
                <span className="toolbar-spacer" />
                <Text size="11px" c="dimmed" truncate="end" className="composer-target">
                  {destinationBusy
                    ? "Waiting for current turn"
                    : useBroadcast && arenaEnabled && workspace && gitBranch && destinations.length >= 2
                      ? `${destinations.length} isolated git worktrees`
                      : useBroadcast
                        ? `${destinations.length} structured ${destinations.length === 1 ? "split" : "splits"}`
                        : selected?.provider.name ?? "No structured provider"}
                </Text>
                <Button
                  type="submit"
                  size="compact-xs"
                  color={useBroadcast && arenaEnabled && workspace && gitBranch && destinations.length >= 2 ? "teal" : "iris"}
                  variant="filled"
                  className="send-primary-btn"
                  leftSection={<ArrowUp size={13} weight="bold" />}
                  disabled={!canSend}
                >
                  {useBroadcast && arenaEnabled && workspace && gitBranch && destinations.length >= 2
                    ? `Arena (${destinations.length})`
                    : useBroadcast
                      ? `Broadcast (${destinations.length})`
                      : "Send"}
                </Button>
              </Group>
            </form>
          </Paper>
        </div>
      )}
    </div>
  );
}
