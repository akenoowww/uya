import { useEffect, useState } from "react";
import {
  ActionIcon, Alert, Badge, Button, Collapse, Divider, Group, Menu, Modal, ScrollArea, Stack, Text, Textarea,
  TextInput, UnstyledButton,
} from "@mantine/core";
import {
  ArrowClockwise, ArrowCounterClockwise, CaretDown, CaretRight, Check, ClockCounterClockwise, GitBranch,
  GitDiff, Minus, Paperclip, Plus, Sparkle,
} from "@phosphor-icons/react";
import type { GitBranch as GitBranchInfo, GitCommit, GitFileChange, GitStatus, RpcCall } from "@ide/protocol";
import "./editor.css";

interface Props {
  root: string | null;
  api: RpcCall;
  refreshKey: number;
  onOpenDiff: (path: string, staged: boolean) => void;
  onAttachDiff: (staged: boolean) => void;
  onChooseProject: () => void;
  onGenerateCommitMessage?: (staged: boolean) => Promise<string | null>;
  onGitChanged?: () => void;
}

const STATUS_BADGE: Readonly<Record<GitFileChange["status"], { code: string; color: string }>> = {
  modified: { code: "M", color: "yellow" },
  added: { code: "A", color: "teal" },
  deleted: { code: "D", color: "red" },
  renamed: { code: "R", color: "iris" },
  untracked: { code: "U", color: "gray" },
};

function ChangeSection({
  title,
  items,
  staged,
  busy,
  onOpenDiff,
  onStage,
  onUnstage,
  onRequestDiscard,
  onStageAll,
  onUnstageAll,
}: {
  title: string;
  items: GitFileChange[];
  staged: boolean;
  busy: boolean;
  onOpenDiff: (path: string, staged: boolean) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onRequestDiscard: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
}) {
  if (!items.length) return null;
  return (
    <Stack gap={2}>
      <Group justify="space-between" px={8} pt={4} wrap="nowrap">
        <Text size="10px" fw={650} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
          {title} ({items.length})
        </Text>
        {staged ? (
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            disabled={busy}
            aria-label="Unstage all changes"
            title="Unstage all"
            onClick={onUnstageAll}
          >
            <Minus size={11} weight="bold" />
          </ActionIcon>
        ) : (
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            disabled={busy}
            aria-label="Stage all changes"
            title="Stage all"
            onClick={onStageAll}
          >
            <Plus size={11} weight="bold" />
          </ActionIcon>
        )}
      </Group>
      {items.map((item) => {
        const badge = STATUS_BADGE[item.status];
        const name = item.path.split("/").at(-1) ?? item.path;
        return (
          <div key={`${staged ? "s" : "u"}:${item.path}`} className="git-row-wrap">
            <UnstyledButton
              className="file-row git-file-row"
              title={item.path}
              style={{ flex: 1, minWidth: 0 }}
              onClick={() => onOpenDiff(item.path, staged)}
            >
              <Group gap={7} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                <Badge size="xs" variant="light" color={badge.color} radius="xs" px={5} w={20}>
                  {badge.code}
                </Badge>
                <Text size="xs" truncate="end">{name}</Text>
              </Group>
            </UnstyledButton>
            <Group gap={2} wrap="nowrap" className="git-row-actions">
              {staged ? (
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  disabled={busy}
                  aria-label={`Unstage ${item.path}`}
                  title="Unstage"
                  onClick={() => onUnstage(item.path)}
                >
                  <Minus size={11} weight="bold" />
                </ActionIcon>
              ) : (
                <>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    disabled={busy}
                    aria-label={`Discard changes in ${item.path}`}
                    title="Discard changes"
                    onClick={() => onRequestDiscard(item.path)}
                  >
                    <ArrowCounterClockwise size={11} />
                  </ActionIcon>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="teal"
                    disabled={busy}
                    aria-label={`Stage ${item.path}`}
                    title="Stage"
                    onClick={() => onStage(item.path)}
                  >
                    <Plus size={11} weight="bold" />
                  </ActionIcon>
                </>
              )}
            </Group>
          </div>
        );
      })}
    </Stack>
  );
}

export function GitPanel({
  root, api, refreshKey, onOpenDiff, onAttachDiff, onChooseProject, onGenerateCommitMessage, onGitChanged,
}: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!root) {
      setStatus(null);
      setBranches([]);
      setCommits([]);
      setError("");
      setNotice("");
      return;
    }
    let current = true;
    setError("");
    void Promise.all([
      api("git.status", { workspacePath: root }),
      api("git.branches", { workspacePath: root }).catch(() => []),
      api("git.log", { limit: 15, workspacePath: root }).catch(() => []),
    ]).then(([nextStatus, nextBranches, nextLog]) => {
      if (!current) return;
      setStatus(nextStatus);
      setBranches(nextBranches);
      setCommits(nextLog);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Could not read Git status.");
    });
    return () => { current = false; };
  }, [api, root, refreshKey, tick]);

  const staged = (status?.changes ?? []).filter((entry) => entry.staged);
  const unstaged = (status?.changes ?? []).filter((entry) => !entry.staged);

  async function mutate(operation: () => Promise<GitStatus | void>, successNote?: string) {
    if (!root || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await operation();
      if (next) setStatus(next);
      if (successNote) setNotice(successNote);
      setTick((value) => value + 1);
      onGitChanged?.();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Git operation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCommit() {
    if (!root || !commitMessage.trim() || !staged.length || busy) return;
    await mutate(async () => {
      const committed = await api("git.commit", { message: commitMessage.trim(), workspacePath: root });
      setCommitMessage("");
      setNotice(`Committed ${committed.shortHash} on ${committed.branch}`);
    });
  }

  async function handleGenerateMessage() {
    if (!onGenerateCommitMessage || generating || (!staged.length && !unstaged.length)) return;
    setGenerating(true);
    setError("");
    try {
      const suggestion = await onGenerateCommitMessage(staged.length > 0);
      if (suggestion) setCommitMessage(suggestion);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not generate commit message.");
    } finally {
      setGenerating(false);
    }
  }

  async function submitNewBranch() {
    if (!root || !newBranchName.trim() || busy) return;
    await mutate(async () => {
      const next = await api("git.createBranch", { name: newBranchName.trim(), checkout: true, workspacePath: root });
      setNewBranchName("");
      setNewBranchOpen(false);
      return next;
    }, `Switched to new branch ${newBranchName.trim()}`);
  }

  return (
    <section className="tool-pane" aria-label="Source control">
      <header className="tool-heading">
        <h2>Git</h2>
        {root && (
          <ActionIcon
            size="sm"
            aria-label="Refresh Git status"
            title="Refresh Git status"
            onClick={() => setTick((value) => value + 1)}
          >
            <ArrowClockwise size={13} />
          </ActionIcon>
        )}
      </header>

      {!root ? (
        <Stack align="center" justify="center" gap="xs" flex={1} p="md">
          <GitBranch size={22} weight="duotone" color="var(--muted)" aria-hidden="true" />
          <Button variant="default" size="compact-xs" onClick={onChooseProject}>Open folder</Button>
        </Stack>
      ) : !status && error ? (
        <Alert color="red" variant="light" m="xs">{error}</Alert>
      ) : !status ? (
        <Text size="xs" c="dimmed" p="sm" role="status">Reading repository…</Text>
      ) : !status.isRepo ? (
        <Stack align="center" justify="center" gap="xs" flex={1} p="md">
          <GitBranch size={20} weight="duotone" color="var(--muted)" aria-hidden="true" />
          <Text size="xs" c="dimmed" ta="center">This folder is not a Git repository.</Text>
        </Stack>
      ) : (
        <ScrollArea className="tool-scroll" type="auto">
          <Stack gap="xs" p={8}>
            <Group justify="space-between" wrap="nowrap" px={2}>
              <Menu position="bottom-start" width={230}>
                <Menu.Target>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    disabled={busy}
                    leftSection={<GitBranch size={13} weight="duotone" color="var(--accent)" />}
                    rightSection={<CaretDown size={10} weight="bold" />}
                  >
                    <Text size="xs" fw={620} truncate="end" maw={120}>{status.branch ?? "HEAD"}</Text>
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Local branches</Menu.Label>
                  {branches.map((branch) => (
                    <Menu.Item
                      key={branch.name}
                      leftSection={branch.current ? <Check size={12} weight="bold" color="var(--accent)" /> : <GitBranch size={12} />}
                      rightSection={branch.commit ? <Text size="10px" c="dimmed" ff="monospace">{branch.commit}</Text> : undefined}
                      onClick={() => {
                        if (!branch.current) {
                          void mutate(() => api("git.checkout", { branch: branch.name, workspacePath: root }));
                        }
                      }}
                    >
                      <Text size="xs" truncate="end" maw={140}>{branch.name}</Text>
                    </Menu.Item>
                  ))}
                  <Menu.Divider />
                  <Menu.Item leftSection={<Plus size={12} />} onClick={() => setNewBranchOpen((v) => !v)}>
                    Create branch…
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>

              {(status.ahead || status.behind) ? (
                <Badge size="xs" variant="outline" color="gray" ff="monospace">
                  {status.ahead ? `↑${status.ahead}` : ""}{status.ahead && status.behind ? " " : ""}{status.behind ? `↓${status.behind}` : ""}
                </Badge>
              ) : null}
            </Group>

            <Collapse expanded={newBranchOpen}>
              <Group gap={4} wrap="nowrap">
                <TextInput
                  size="xs"
                  style={{ flex: 1 }}
                  aria-label="New branch name"
                  placeholder="feat/branch-name"
                  value={newBranchName}
                  onChange={(event) => setNewBranchName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitNewBranch();
                    }
                  }}
                />
                <Button size="compact-xs" color="iris" loading={busy} disabled={!newBranchName.trim()} onClick={() => void submitNewBranch()}>
                  Create
                </Button>
              </Group>
            </Collapse>

            {error && <Alert color="red" variant="light" py={5} px={8}>{error}</Alert>}
            {notice && <Alert color="teal" variant="light" py={5} px={8}>{notice}</Alert>}

            <Stack gap={5}>
              <Textarea
                size="xs"
                minRows={2}
                maxRows={4}
                autosize
                aria-label="Commit message"
                placeholder={staged.length ? "Commit message…" : "Stage changes to commit…"}
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.currentTarget.value)}
              />
              <Group gap={5} wrap="nowrap">
                <Button
                  size="compact-xs"
                  color="iris"
                  variant="filled"
                  style={{ flex: 1 }}
                  loading={busy}
                  disabled={!staged.length || !commitMessage.trim()}
                  onClick={() => void submitCommit()}
                >
                  Commit ({staged.length})
                </Button>
                {onGenerateCommitMessage && (
                  <ActionIcon
                    size="sm"
                    variant="light"
                    color="iris"
                    loading={generating}
                    disabled={busy || (!staged.length && !unstaged.length)}
                    aria-label="Generate commit message with AI"
                    title="Generate commit message with AI"
                    onClick={() => void handleGenerateMessage()}
                  >
                    <Sparkle size={13} weight="duotone" />
                  </ActionIcon>
                )}
              </Group>
            </Stack>

            <Group gap={5} wrap="nowrap">
              <Button
                size="compact-xs"
                variant="light"
                color="iris"
                style={{ flex: 1 }}
                disabled={!unstaged.length}
                leftSection={<Paperclip size={11} />}
                onClick={() => onAttachDiff(false)}
              >
                @git-diff ({unstaged.length})
              </Button>
              {staged.length > 0 && (
                <Button
                  size="compact-xs"
                  variant="default"
                  style={{ flex: 1 }}
                  leftSection={<GitDiff size={11} />}
                  onClick={() => onAttachDiff(true)}
                >
                  @git-staged ({staged.length})
                </Button>
              )}
            </Group>

            <Divider color="dark.5" />

            {!status.changes.length ? (
              <Text size="xs" c="dimmed" ta="center" py="sm">Working tree clean.</Text>
            ) : (
              <Stack gap="xs">
                <ChangeSection
                  title="Staged"
                  items={staged}
                  staged
                  busy={busy}
                  onOpenDiff={onOpenDiff}
                  onStage={(path) => void mutate(() => api("git.stage", { paths: [path], workspacePath: root }))}
                  onUnstage={(path) => void mutate(() => api("git.unstage", { paths: [path], workspacePath: root }))}
                  onRequestDiscard={(path) => setDiscardTarget(path)}
                  onStageAll={() => void mutate(() => api("git.stage", { all: true, workspacePath: root }))}
                  onUnstageAll={() => void mutate(() => api("git.unstage", { all: true, workspacePath: root }))}
                />
                <ChangeSection
                  title="Changes"
                  items={unstaged}
                  staged={false}
                  busy={busy}
                  onOpenDiff={onOpenDiff}
                  onStage={(path) => void mutate(() => api("git.stage", { paths: [path], workspacePath: root }))}
                  onUnstage={(path) => void mutate(() => api("git.unstage", { paths: [path], workspacePath: root }))}
                  onRequestDiscard={(path) => setDiscardTarget(path)}
                  onStageAll={() => void mutate(() => api("git.stage", { all: true, workspacePath: root }))}
                  onUnstageAll={() => void mutate(() => api("git.unstage", { all: true, workspacePath: root }))}
                />
              </Stack>
            )}

            {commits.length > 0 && (
              <>
                <Divider color="dark.5" />
                <UnstyledButton
                  w="100%"
                  px={4}
                  py={2}
                  aria-expanded={commitsOpen}
                  onClick={() => setCommitsOpen((v) => !v)}
                >
                  <Group gap={6} wrap="nowrap">
                    {commitsOpen ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
                    <ClockCounterClockwise size={12} color="var(--muted)" aria-hidden="true" />
                    <Text size="10px" fw={650} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
                      Recent commits ({commits.length})
                    </Text>
                  </Group>
                </UnstyledButton>
                <Collapse expanded={commitsOpen}>
                  <Stack gap={4} pt={2}>
                    {commits.map((commit) => (
                      <div key={commit.hash} className="git-commit-row" title={`${commit.hash}\n${commit.author} · ${commit.date}`}>
                        <Group gap={6} wrap="nowrap">
                          <Text size="10px" c="iris.3" ff="monospace" style={{ flexShrink: 0 }}>{commit.shortHash}</Text>
                          <Text size="11px" truncate="end" style={{ flex: 1 }}>{commit.subject}</Text>
                        </Group>
                      </div>
                    ))}
                  </Stack>
                </Collapse>
              </>
            )}
          </Stack>
        </ScrollArea>
      )}

      <Modal
        opened={discardTarget !== null}
        onClose={() => setDiscardTarget(null)}
        title="Discard local changes?"
        size="sm"
      >
        <Text size="xs" c="dimmed" mb="md">
          This permanently discards uncommitted edits in <strong>{discardTarget}</strong> (untracked files will be deleted).
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={() => setDiscardTarget(null)}>Cancel</Button>
          <Button
            color="red"
            loading={busy}
            onClick={() => {
              if (!discardTarget || !root) return;
              const target = discardTarget;
              setDiscardTarget(null);
              void mutate(() => api("git.discard", { paths: [target], workspacePath: root }));
            }}
          >
            Discard changes
          </Button>
        </Group>
      </Modal>
    </section>
  );
}
