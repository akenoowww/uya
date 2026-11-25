import { useState } from "react";
import { ActionIcon, Badge, Button, Collapse, Group, Loader, Menu, Paper, Stack, Text, TextInput } from "@mantine/core";
import {
  CaretDown, CaretRight, CheckCircle, GitBranch, GitDiff, Play, Scales, Trash, WarningCircle, XCircle,
} from "@phosphor-icons/react";
import type { ArenaSlot, ArenaSummary, VerifyPreset } from "@ide/protocol";
import { ProviderIcon } from "./ProviderIcon";

function slotStatusColor(status: ArenaSlot["status"]): string {
  switch (status) {
    case "running": return "iris";
    case "succeeded": case "applied": return "teal";
    case "failed": return "red";
    default: return "gray";
  }
}

export function ArenaBar({
  arena,
  verifyPresets,
  onInspectFile,
  onVerifySlot,
  onApplySlot,
  onDiscard,
  onJudgePatches,
}: {
  arena: ArenaSummary;
  verifyPresets: VerifyPreset[];
  onInspectFile: (arenaId: string, slotId: string, path: string, label: string) => void;
  onVerifySlot: (arenaId: string, slotId: string, command: string) => void;
  onApplySlot: (arenaId: string, slotId: string, mode: "workspace" | "branch", branchName?: string) => Promise<void>;
  onDiscard: (arenaId: string) => Promise<void>;
  onJudgePatches: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [verifyCmd, setVerifyCmd] = useState(() => verifyPresets[0]?.command ?? "bun run typecheck");
  const defaultVerifyCommand = verifyCmd.trim() || verifyPresets[0]?.command || "bun run typecheck";
  const slotsWithChanges = arena.slots.filter((slot) => slot.filesChanged > 0);

  return (
    <Paper p="6px 9px" mb={6} withBorder radius="sm" className="arena-bar">
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            aria-label={expanded ? "Collapse Worktree Arena" : "Expand Worktree Arena"}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
          </ActionIcon>
          <Badge size="xs" variant="light" color="teal" leftSection={<GitBranch size={11} weight="duotone" />}>
            Worktree Arena ({arena.slots.length})
          </Badge>
          <Text size="11px" c="dimmed" truncate="end" maw={260} title={arena.prompt}>
            base {arena.baseBranch} · {arena.baseCommit.slice(0, 7)}
          </Text>
        </Group>

        <Group gap={6} wrap="wrap">
          <Button
            size="compact-xs"
            variant="light"
            color="iris"
            disabled={slotsWithChanges.length < 2}
            leftSection={<Scales size={12} weight="duotone" />}
            onClick={onJudgePatches}
          >
            Review patches
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            loading={busyAction === "discard"}
            leftSection={<Trash size={12} />}
            onClick={() => {
              setBusyAction("discard");
              void onDiscard(arena.id).finally(() => setBusyAction(null));
            }}
          >
            Discard arena
          </Button>
        </Group>
      </Group>

      <Collapse expanded={expanded}>
        <Stack gap={6} mt={7} pt={7} style={{ borderTop: "1px solid var(--line)" }}>
          <Group gap={6} wrap="wrap">
            <TextInput
              size="xs"
              w={240}
              aria-label="Arena verification command"
              placeholder="Verify command (e.g. bun test)"
              value={verifyCmd}
              onChange={(event) => setVerifyCmd(event.currentTarget.value)}
            />
            {verifyPresets.slice(0, 3).map((preset) => (
              <Button
                key={preset.id}
                size="compact-xs"
                variant={verifyCmd === preset.command ? "light" : "default"}
                color={verifyCmd === preset.command ? "iris" : "gray"}
                onClick={() => setVerifyCmd(preset.command)}
              >
                {preset.label}
              </Button>
            ))}
            <Button
              size="compact-xs"
              variant="subtle"
              color="teal"
              leftSection={<Play size={11} weight="fill" />}
              onClick={() => {
                for (const slot of arena.slots) {
                  if (slot.status !== "running") onVerifySlot(arena.id, slot.id, defaultVerifyCommand);
                }
              }}
            >
              Verify all slots
            </Button>
          </Group>

          <div className="arena-slots-grid">
            {arena.slots.map((slot) => {
              const verifyStatus = slot.verify?.status;
              const isApplying = busyAction === `apply-${slot.id}`;
              return (
                <Paper key={slot.id} p="7px 9px" withBorder radius="sm" bg="dark.8" className="arena-slot-card">
                  <Group justify="space-between" gap={6} wrap="nowrap" mb={4}>
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                      <ProviderIcon providerId={slot.providerId} size={13} framed={false} />
                      <Text size="xs" fw={620} truncate="end">{slot.providerName}</Text>
                      {slot.model && (
                        <Text size="10px" c="dimmed" ff="monospace" truncate="end">
                          {slot.model.split("/").at(-1)}
                        </Text>
                      )}
                    </Group>
                    <Badge
                      size="xs"
                      variant="light"
                      color={slotStatusColor(slot.status)}
                      leftSection={slot.status === "running" ? <Loader size={8} color="iris" /> : undefined}
                    >
                      {slot.status}
                    </Badge>
                  </Group>

                  <Group gap={6} wrap="wrap" mb={6}>
                    <Text size="11px" ff="monospace" c="dimmed">
                      {slot.filesChanged} {slot.filesChanged === 1 ? "file" : "files"}
                    </Text>
                    {slot.filesChanged > 0 && (
                      <Text size="11px" ff="monospace">
                        <span style={{ color: "var(--positive)" }}>+{slot.additions}</span>{" "}
                        <span style={{ color: "var(--danger)" }}>-{slot.deletions}</span>
                      </Text>
                    )}
                    {verifyStatus && verifyStatus !== "idle" && (
                      <Badge
                        size="xs"
                        variant="light"
                        color={verifyStatus === "passed" ? "teal" : verifyStatus === "running" ? "iris" : "red"}
                        leftSection={
                          verifyStatus === "running" ? <Loader size={8} color="iris" />
                            : verifyStatus === "passed" ? <CheckCircle size={11} weight="fill" />
                              : verifyStatus === "failed" ? <XCircle size={11} weight="fill" />
                                : <WarningCircle size={11} />
                        }
                        title={slot.verify?.output?.slice(0, 500) || slot.verify?.command}
                      >
                        {verifyStatus === "passed" ? "Verify passed" : verifyStatus === "running" ? "Verifying…" : "Verify failed"}
                      </Badge>
                    )}
                  </Group>

                  <Group gap={4} wrap="wrap">
                    <Menu position="top-start" width={260}>
                      <Menu.Target>
                        <Button
                          size="compact-xs"
                          variant="default"
                          disabled={slot.files.length === 0}
                          leftSection={<GitDiff size={12} />}
                        >
                          Diff ({slot.files.length})
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Label>Changed files in {slot.providerName}</Menu.Label>
                        {slot.files.map((file) => (
                          <Menu.Item
                            key={file.path}
                            onClick={() => onInspectFile(arena.id, slot.id, file.path, slot.providerName)}
                            rightSection={
                              <Text size="10px" ff="monospace" c="dimmed">
                                +{file.additions}/-{file.deletions}
                              </Text>
                            }
                          >
                            <Text size="xs" truncate="end" maw={180}>{file.path}</Text>
                          </Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>

                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      disabled={slot.status === "running" || verifyStatus === "running"}
                      leftSection={<Play size={11} weight="fill" />}
                      onClick={() => onVerifySlot(arena.id, slot.id, defaultVerifyCommand)}
                    >
                      Verify
                    </Button>

                    <Menu position="top-end" width={220}>
                      <Menu.Target>
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="teal"
                          loading={isApplying}
                          disabled={slot.filesChanged === 0 || slot.status === "running"}
                        >
                          Apply winner
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          onClick={() => {
                            setBusyAction(`apply-${slot.id}`);
                            void onApplySlot(arena.id, slot.id, "workspace").finally(() => setBusyAction(null));
                          }}
                        >
                          Apply to main workspace (with checkpoint)
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<GitBranch size={12} />}
                          onClick={() => {
                            setBusyAction(`apply-${slot.id}`);
                            void onApplySlot(arena.id, slot.id, "branch").finally(() => setBusyAction(null));
                          }}
                        >
                          Save as new Git branch
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Paper>
              );
            })}
          </div>
        </Stack>
      </Collapse>
    </Paper>
  );
}
