import { useId, useState } from "react";
import { ActionIcon, Badge, Collapse, Group, Loader, Paper, Text } from "@mantine/core";
import { CaretDown, CaretRight, ChatCircleDots, Circle, GitBranch, PlugsConnected, Scales, ShieldCheck } from "@phosphor-icons/react";
import type { SynapseCallInfo } from "@ide/protocol";

const CALL_KINDS = {
  consult: { title: "Consulted specialist", icon: ChatCircleDots },
  red_team: { title: "Red-team audit", icon: Scales },
  capability: { title: "Capability", icon: PlugsConnected },
  verify: { title: "Verify", icon: ShieldCheck },
  handoff: { title: "Handoff", icon: GitBranch },
};

export function SynapseCallCard({ call }: { call: SynapseCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const { title, icon: Icon } = CALL_KINDS[call.kind];
  const action = call.kind === "consult" && call.status === "running" ? "Consulting specialist" : title;
  const disclosure = expanded ? "Collapse" : "Expand";

  return (
    <Paper withBorder bg="dark.8" radius="sm" px={8} py={5} my={5}>
      <Group gap={6}>
        <Icon size={14} weight="duotone" color="var(--mantine-color-iris-4)" aria-hidden="true" />
        <Text size="xs" fw={600} style={{ overflowWrap: "anywhere" }}>{action} · {call.target}</Text>
        {call.domain && <Badge size="xs" color="iris" variant="light">{call.domain}</Badge>}
        {call.status === "running" ? (
          <Loader size={10} role="img" aria-label="Running" />
        ) : (
          <Text component="span" c={call.status === "done" ? "teal.4" : "red.4"} lh={0} title={call.status === "done" ? "Done" : "Error"}>
            <Circle size={8} weight="fill" role="img" aria-label={call.status} />
          </Text>
        )}
        {call.summary && (
          <ActionIcon
            type="button"
            size="xs"
            color="gray"
            variant="subtle"
            aria-label={`${disclosure} ${call.target} summary`}
            aria-expanded={expanded}
            aria-controls={summaryId}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <CaretDown size={11} aria-hidden="true" /> : <CaretRight size={11} aria-hidden="true" />}
          </ActionIcon>
        )}
      </Group>
      {call.summary && (
        <Collapse id={summaryId} expanded={expanded}>
          <Text pt={5} size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {call.summary}
          </Text>
        </Collapse>
      )}
    </Paper>
  );
}
