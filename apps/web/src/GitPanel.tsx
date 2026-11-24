import {
  ActionIcon, Alert, Badge, Button, Divider, Group, ScrollArea, Stack, Text, UnstyledButton,
} from "@mantine/core";
import { ArrowClockwise, GitBranch, GitDiff, Paperclip } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { GitFileChange, GitStatus, RpcCall } from "@ide/protocol";
import "./editor.css";

interface Props {
  root: string | null;
  api: RpcCall;
  refreshKey: number;
  onOpenDiff: (path: string, staged: boolean) => void;
  onAttachDiff: (staged: boolean) => void;
  onChooseProject: () => void;
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
  onOpenDiff,
}: {
  title: string;
  items: GitFileChange[];
  staged: boolean;
  onOpenDiff: (path: string, staged: boolean) => void;
}) {
  if (!items.length) return null;
  return (
    <Stack gap={2}>
      <Text size="10px" fw={650} tt="uppercase" c="dimmed" px={8} pt={4} style={{ letterSpacing: "0.05em" }}>
        {title} ({items.length})
      </Text>
      {items.map((item) => {
        const badge = STATUS_BADGE[item.status];
        const name = item.path.split("/").at(-1) ?? item.path;
        return (
          <UnstyledButton
            key={`${staged ? "s" : "u"}:${item.path}`}
            className="file-row git-file-row"
            title={item.path}
            onClick={() => onOpenDiff(item.path, staged)}
          >
            <Group gap={7} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              <Badge size="xs" variant="light" color={badge.color} radius="xs" px={5} w={20}>
                {badge.code}
              </Badge>
              <Text size="xs" truncate="end">{name}</Text>
            </Group>
          </UnstyledButton>
        );
      })}
    </Stack>
  );
}

export function GitPanel({ root, api, refreshKey, onOpenDiff, onAttachDiff, onChooseProject }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!root) {
      setStatus(null);
      setError("");
      return;
    }
    let current = true;
    setError("");
    void api("git.status", { workspacePath: root }).then((result) => {
      if (current) setStatus(result);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Could not read Git status.");
    });
    return () => { current = false; };
  }, [api, root, refreshKey, tick]);

  const staged = (status?.changes ?? []).filter((entry) => entry.staged);
  const unstaged = (status?.changes ?? []).filter((entry) => !entry.staged);

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
          <GitBranch size={22} weight="duotone" color="var(--muted)" />
          <Button variant="default" size="compact-xs" onClick={onChooseProject}>Open folder</Button>
        </Stack>
      ) : error ? (
        <Alert color="red" variant="light" m="xs">{error}</Alert>
      ) : !status ? (
        <Text size="xs" c="dimmed" p="sm" role="status">Reading repository…</Text>
      ) : !status.isRepo ? (
        <Stack align="center" justify="center" gap="xs" flex={1} p="md">
          <GitBranch size={20} weight="duotone" color="var(--muted)" />
          <Text size="xs" c="dimmed" ta="center">This folder is not a Git repository.</Text>
        </Stack>
      ) : (
        <ScrollArea className="tool-scroll" type="auto">
          <Stack gap="xs" p={8}>
            <Group justify="space-between" wrap="nowrap" px={4}>
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <GitBranch size={14} weight="duotone" color="var(--accent)" />
                <Text size="xs" fw={620} truncate="end">{status.branch ?? "HEAD"}</Text>
              </Group>
              {(status.ahead || status.behind) ? (
                <Badge size="xs" variant="outline" color="gray" ff="monospace">
                  {status.ahead ? `↑${status.ahead}` : ""}{status.ahead && status.behind ? " " : ""}{status.behind ? `↓${status.behind}` : ""}
                </Badge>
              ) : null}
            </Group>

            <Stack gap={5}>
              <Button
                size="compact-xs"
                variant="light"
                color="iris"
                fullWidth
                disabled={!unstaged.length}
                leftSection={<Paperclip size={12} />}
                onClick={() => onAttachDiff(false)}
              >
                Attach diff ({unstaged.length})
              </Button>
              {staged.length > 0 && (
                <Button
                  size="compact-xs"
                  variant="default"
                  fullWidth
                  leftSection={<GitDiff size={12} />}
                  onClick={() => onAttachDiff(true)}
                >
                  Attach staged ({staged.length})
                </Button>
              )}
            </Stack>

            <Divider color="dark.5" />

            {!status.changes.length ? (
              <Text size="xs" c="dimmed" ta="center" py="md">Working tree clean.</Text>
            ) : (
              <Stack gap="xs">
                <ChangeSection title="Staged" items={staged} staged onOpenDiff={onOpenDiff} />
                <ChangeSection title="Changes" items={unstaged} staged={false} onOpenDiff={onOpenDiff} />
              </Stack>
            )}
          </Stack>
        </ScrollArea>
      )}
    </section>
  );
}
