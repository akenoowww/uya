import { useMemo, useRef } from "react";
import { ActionIcon, Alert, Button, Checkbox, Group, Kbd, Pill, Select, TextInput } from "@mantine/core";
import {
  ArrowUp, BookOpen, Broadcast, CaretDown, CaretUp, Files, GitFork,
} from "@phosphor-icons/react";
import type { RoutingMode } from "@ide/protocol";
import { useShallow } from "zustand/react/shallow";
import { ProviderIcon } from "./components/ProviderIcon";
import { SlashMenu } from "./components/SlashMenu";
import { useSlashInput } from "./hooks/useSlashInput";
import { formatShortcut } from "./shortcuts";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";
import { hasBusyDestination, resolveModel, routingTargets, shortModelName, workspaceLabel } from "./workbenchStore";

export function Composer() {
  const workbench = useWorkbench();
  const {
    store, sendPrompt, toggleContext, retryConnection, core,
    toggleBroadcastCollapsed, toggleBroadcastTarget, selectAllBroadcastTargets,
  } = workbench;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    bridge, providers, dock, broadcast, broadcastCollapsed, broadcastTargets,
    routing, tags, fallbackIds, contextPaths, selection, template, composer,
    choosing, submitting, connectionError, error,
  } = useWorkbenchState(useShallow((state) => ({
    bridge: state.bridge,
    providers: state.providers,
    dock: state.dock,
    broadcast: state.broadcast,
    broadcastCollapsed: state.broadcastCollapsed,
    broadcastTargets: state.broadcastTargets,
    routing: state.routing,
    tags: state.tags,
    fallbackIds: state.fallbackIds,
    contextPaths: state.contextPaths,
    selection: state.selection,
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

  const allSelected = broadcastTargets.length === 0 || broadcastTargets.length >= targets.length;
  const canSend = Boolean(
    composer.trim() && (
      composer.trim().startsWith("/")
      || (bridge && destinations.length > 0 && !choosing && !submitting && !destinationBusy)
    ),
  );

  return (
    <div className={`composer-area ${broadcastCollapsed ? "collapsed" : ""}`}>
      {connectionError && (
        <Alert color="red" variant="light" className="workbench-alert" py={6} px={10} mb={6} radius="sm">
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <span className="notice-text">{connectionError}</span>
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
          <span className="notice-text">{error}</span>
        </Alert>
      )}

      {(contextPaths.length > 0 || selection || template) && (
        <Group gap={6} mb={6} wrap="wrap">
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
        </Group>
      )}

      {broadcastCollapsed ? (
        <div className="composer-collapsed-bar">
          <Button
            size="compact-xs"
            variant="default"
            radius="xl"
            leftSection={<Broadcast size={14} weight="duotone" />}
            rightSection={<Group gap={5}><Kbd>{formatShortcut("toggle-broadcast")}</Kbd><CaretUp size={11} weight="bold" /></Group>}
            onClick={toggleBroadcastCollapsed}
          >
            Broadcast & Routing bar
          </Button>
        </div>
      ) : (
        <div className="composer-shell">
          <SlashMenu
            commands={slashInput.slashMatches}
            selectedIndex={slashInput.activeSlashIndex}
            onSelect={slashInput.applySlashCommand}
          />
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendPrompt(); }}>
            <div className="composer-head">
              <Button
                size="compact-xs"
                radius="xl"
                variant={useBroadcast && allSelected ? "light" : "default"}
                color={useBroadcast && allSelected ? "iris" : "gray"}
                disabled={targets.length < 2}
                leftSection={<Broadcast size={13} weight="duotone" />}
                onClick={selectAllBroadcastTargets}
              >
                All splits ({targets.length})
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
                    leftSection={<ProviderIcon providerId={pane.provider.id} size={11} framed={false} />}
                    onClick={() => toggleBroadcastTarget(pane.id)}
                  >
                    {pane.provider.name}{model ? ` · ${shortModelName(model)}` : ""}
                  </Button>
                );
              })}
              <span className="toolbar-spacer" />
              <ActionIcon
                size="xs"
                aria-label="Collapse broadcast bar"
                title="Collapse broadcast bar"
                onClick={toggleBroadcastCollapsed}
              >
                <CaretDown size={13} weight="bold" />
              </ActionIcon>
            </div>

            <textarea
              ref={inputRef}
              id="prompt-input"
              rows={2}
              aria-label="Multi-model prompt"
              value={composer}
              onChange={(event) => slashInput.handleChange(event.target.value)}
              placeholder={
                useBroadcast
                  ? `Broadcast to ${destinations.length} splits simultaneously… (↵ to send, ⇧↵ newline)`
                  : `Send routed prompt to ${selected?.provider.name ?? "selected split"}… (↵ to send, ⇧↵ newline)`
              }
              onKeyDown={slashInput.handleKeyDown}
            />

            {!useBroadcast && routing === "rule" && (
              <div className="routing-options">
                <TextInput
                  size="xs"
                  placeholder="Tags (e.g. review, tests)"
                  aria-label="Routing tags"
                  value={tags}
                  onChange={(event) => store.setState({ tags: event.currentTarget.value })}
                  w={220}
                />
              </div>
            )}

            {!useBroadcast && routing === "fallback" && (
              <fieldset className="routing-options fallback-options">
                <legend>Fallback providers in selection order</legend>
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
                  {structured.length < 2 && <span>Connect a second structured provider.</span>}
                </Group>
              </fieldset>
            )}

            <div className="composer-toolbar">
              <Button
                size="compact-xs"
                variant={useBroadcast ? "light" : "default"}
                color={useBroadcast ? "iris" : "gray"}
                aria-pressed={useBroadcast}
                disabled={targets.length < 2}
                leftSection={<Broadcast size={14} weight="duotone" />}
                onClick={() => store.setState({ broadcast: !useBroadcast })}
              >
                Broadcast
              </Button>
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
              <span className="composer-target">
                {destinationBusy
                  ? "Waiting for current turn"
                  : useBroadcast
                    ? `${destinations.length} structured ${destinations.length === 1 ? "split" : "splits"}`
                    : selected?.provider.name ?? "No structured provider"}
              </span>
              <Button
                type="submit"
                size="compact-xs"
                color="iris"
                variant="filled"
                className="send-primary-btn"
                leftSection={<ArrowUp size={13} weight="bold" />}
                disabled={!canSend}
              >
                {useBroadcast ? `Broadcast (${destinations.length})` : "Send"}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
