import { useEffect, useState } from "react";
import {
  ActionIcon, Button, Group, Paper, ScrollArea, SegmentedControl, Stack, Text, TextInput, UnstyledButton,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { Copy, GitFork, MagnifyingGlass, Trash } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { extractRunReplyText } from "./components/JudgeModal";
import { ProviderIcon } from "./components/ProviderIcon";
import { RunStatus } from "./RunPane";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";
import { shortModelName, workspaceLabel } from "./workbenchStore";

export function HistoryPanel() {
  const { core, openHistory, resumeConversation, forkConversationToSplit } = useWorkbench();
  const clipboard = useClipboard({ timeout: 1500 });
  const [view, setView] = useState<"threads" | "runs">("threads");
  const [scope, setScope] = useState<"all" | "project">("all");
  const [filter, setFilter] = useState("");
  const { history, conversations, providers, workspace, bridge } = useWorkbenchState(useShallow((state) => ({
    history: state.history,
    conversations: state.conversations,
    providers: state.providers,
    workspace: state.workspace,
    bridge: state.bridge,
  })));

  useEffect(() => {
    if (!bridge) return;
    const timer = setTimeout(() => {
      void core.setHistoryFilter({
        query: filter.trim() || undefined,
        workspacePath: scope === "project" ? (workspace?.path ?? null) : undefined,
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [bridge, core, filter, scope, workspace?.path]);

  async function exportThreadMarkdown(id: string, workspacePath: string | null) {
    if (!bridge) return;
    try {
      const rows = await bridge.rpc("runs.conversation", { id, workspacePath });
      const md = rows.map((detail) => {
        const provider = detail.run.providerName ?? detail.run.providerId;
        const reply = extractRunReplyText(detail);
        return `## User\n\n${detail.run.prompt}\n\n## ${provider}${detail.run.model ? ` (${detail.run.model})` : ""}\n\n${reply}`;
      }).join("\n\n---\n\n");
      clipboard.copy(md);
    } catch {
      // Ignore export errors cleanly.
    }
  }

  return (
    <section className="tool-pane" aria-label="History and threads">
      <header className="tool-heading">
        <h2>History</h2>
        {workspace && (
          <Button
            size="compact-xs"
            variant={scope === "project" ? "light" : "subtle"}
            color={scope === "project" ? "iris" : "gray"}
            onClick={() => setScope((current) => current === "project" ? "all" : "project")}
          >
            {scope === "project" ? "This project" : "All"}
          </Button>
        )}
      </header>
      <Stack gap={6} p={8} style={{ borderBottom: "1px solid var(--line)" }}>
        <SegmentedControl
          fullWidth
          size="xs"
          value={view}
          onChange={(value) => setView(value as "threads" | "runs")}
          data={[
            { value: "threads", label: "Threads" },
            { value: "runs", label: "Runs" },
          ]}
        />
        <TextInput
          size="xs"
          placeholder="Search prompts & replies…"
          leftSection={<MagnifyingGlass size={13} />}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          aria-label="Search run history"
        />
      </Stack>

      <ScrollArea className="tool-scroll" type="auto">
        <Stack gap={6} p={8}>
          {view === "threads" ? (
            conversations.length ? conversations.map((conv) => {
              const provider = conv.providerName ?? providers.find((entry) => entry.id === conv.providerId)?.name ?? conv.providerId;
              const currentRoot = workspace?.path ?? null;
              const sameWorkspace = conv.workspacePath === currentRoot;
              const otherWorkspaceHint = !sameWorkspace
                ? `Open ${conv.workspacePath ? workspaceLabel(conv.workspacePath) : "without a project"} to access this thread`
                : undefined;
              return (
                <Paper
                  key={`${conv.workspacePath ?? ""}:${conv.id}`}
                  p={8}
                  withBorder
                  bg="dark.8"
                  className="history-card"
                >
                  <Group align="flex-start" gap={6} wrap="nowrap">
                    <UnstyledButton
                      style={{ flex: 1, minWidth: 0 }}
                      onClick={() => void resumeConversation(conv)}
                      title={otherWorkspaceHint ?? "Resume conversation in split"}
                    >
                      <Text size="xs" fw={550} truncate="end">{conv.title}</Text>
                      <Group gap={5} mt={4} wrap="nowrap">
                        <ProviderIcon providerId={conv.providerId} size={11} framed={false} />
                        <Text size="11px" c="iris.3" truncate="end">
                          {provider}{conv.model ? ` · ${shortModelName(conv.model)}` : ""}
                        </Text>
                      </Group>
                      <Group justify="space-between" gap={6} mt={4} wrap="nowrap">
                        <Text size="10px" c="dimmed" truncate="end">
                          {conv.turnCount} {conv.turnCount === 1 ? "turn" : "turns"}
                          {!sameWorkspace && conv.workspacePath ? ` · ${workspaceLabel(conv.workspacePath)}` : ""}
                        </Text>
                        <Text size="10px" c="dimmed">
                          {new Date(conv.lastRunAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </Text>
                      </Group>
                    </UnstyledButton>
                    <Stack gap={2} className="history-item-actions">
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="iris"
                        disabled={!sameWorkspace}
                        aria-label="Fork conversation into new split"
                        title={otherWorkspaceHint ?? "Fork to new split"}
                        onClick={() => void forkConversationToSplit(conv.id, conv.workspacePath)}
                      >
                        <GitFork size={12} />
                      </ActionIcon>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color={clipboard.copied ? "teal" : "gray"}
                        disabled={!sameWorkspace}
                        aria-label="Copy thread as Markdown"
                        title={otherWorkspaceHint ?? "Copy thread as Markdown"}
                        onClick={() => void exportThreadMarkdown(conv.id, conv.workspacePath)}
                      >
                        <Copy size={12} />
                      </ActionIcon>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="red"
                        disabled={!sameWorkspace}
                        aria-label="Delete thread"
                        title={otherWorkspaceHint ?? "Delete thread"}
                        onClick={() => void core.deleteConversation(conv.id, conv.workspacePath)}
                      >
                        <Trash size={12} />
                      </ActionIcon>
                    </Stack>
                  </Group>
                </Paper>
              );
            }) : (
              <Text size="xs" c="dimmed" ta="center" py="lg">
                {filter.trim() ? "No matching threads." : "Conversations appear here."}
              </Text>
            )
          ) : (
            history.length ? history.map((run) => {
              const provider = run.providerName ?? providers.find((entry) => entry.id === run.providerId)?.name ?? run.providerId;
              return (
                <Paper key={run.id} p={8} withBorder bg="dark.8" className="history-card">
                  <Group align="flex-start" gap={6} wrap="nowrap">
                    <UnstyledButton style={{ flex: 1, minWidth: 0 }} onClick={() => void openHistory(run.id)}>
                      <Text size="xs" fw={520} truncate="end">{run.prompt}</Text>
                      <Group gap={5} mt={4} wrap="nowrap">
                        <ProviderIcon providerId={run.providerId} size={11} framed={false} />
                        <Text size="11px" c="iris.3" truncate="end">
                          {provider}{run.model ? ` · ${shortModelName(run.model)}` : ""}
                        </Text>
                      </Group>
                      <Group justify="space-between" gap={6} mt={4} wrap="nowrap">
                        <RunStatus run={run} />
                        <Text size="10px" c="dimmed">
                          {new Date(run.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </Text>
                      </Group>
                    </UnstyledButton>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="red"
                      className="history-item-actions"
                      aria-label="Delete run"
                      title="Delete run"
                      onClick={() => void core.deleteRun(run.id)}
                    >
                      <Trash size={12} />
                    </ActionIcon>
                  </Group>
                </Paper>
              );
            }) : (
              <Text size="xs" c="dimmed" ta="center" py="lg">
                {filter.trim() ? "No runs match that query." : "Completed and active runs appear here."}
              </Text>
            )
          )}
        </Stack>
      </ScrollArea>
    </section>
  );
}
