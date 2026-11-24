import { useMemo, useState } from "react";
import { Badge, Button, Group, Modal, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { Scales } from "@phosphor-icons/react";
import type { EffortLevel, Provider, RunDetail } from "@ide/protocol";
import { EFFORT_META, resolveSupportedEfforts } from "./EffortPicker";

export type JudgePreset = "review" | "synthesize" | "pick-winner";

const PRESET_PROMPTS: Readonly<Record<JudgePreset, { label: string; instruction: string }>> = {
  review: {
    label: "Find bugs & gaps",
    instruction:
      "Cross-review the candidate responses below against the original user request. Identify factual errors, subtle bugs, missing edge cases, contradictions between responses, and false assumptions. Be skeptical and concrete.",
  },
  synthesize: {
    label: "Synthesize best",
    instruction:
      "Synthesize the strongest unified answer to the original user request by combining the best parts of the candidate responses below while correcting any mistakes or gaps.",
  },
  "pick-winner": {
    label: "Pick winner",
    instruction:
      "Evaluate the candidate responses below against the original user request. Rank them from best to worst with concise reasoning, then explain what the winning answer still misses if anything.",
  },
};

export function extractRunReplyText(detail: RunDetail): string {
  const attempts: RunDetail["events"][] = [[]];
  let currentProvider = detail.run.providerId;
  for (const event of detail.events) {
    if (event.type === "status") {
      if (event.run.providerId !== currentProvider) {
        currentProvider = event.run.providerId;
        attempts.push([]);
      }
      continue;
    }
    attempts[attempts.length - 1].push(event);
  }
  return (attempts.at(-1) ?? [])
    .flatMap((event) => (event.type === "text" ? [event.text] : []))
    .join("")
    .trim();
}

const MAX_JUDGE_PROMPT_CHARS = 220_000;

export function buildJudgePrompt(
  preset: JudgePreset,
  originalPrompt: string,
  candidates: Array<{ label: string; text: string }>,
): string {
  const instruction = PRESET_PROMPTS[preset].instruction;
  const boundedOriginal = originalPrompt.length > 40_000
    ? `${originalPrompt.slice(0, 40_000)}\n[...truncated...]`
    : originalPrompt;
  const remaining = Math.max(4_000, MAX_JUDGE_PROMPT_CHARS - instruction.length - boundedOriginal.length - 512);
  const perCandidateLimit = Math.max(1_000, Math.floor(remaining / Math.max(1, candidates.length)));
  const sections = candidates.map(({ label, text }, index) => {
    const body = text.length > perCandidateLimit
      ? `${text.slice(0, perCandidateLimit)}\n[...truncated for review budget...]`
      : text;
    return `### Candidate ${index + 1}: ${label}\n${body}`;
  });
  return [
    instruction,
    "## Original Request",
    boundedOriginal,
    "## Candidate Responses",
    ...sections,
  ].join("\n\n");
}

interface Props {
  opened: boolean;
  onClose: () => void;
  providers: Provider[];
  candidates: RunDetail[];
  onRunJudge: (options: {
    providerId: string;
    model?: string;
    effort?: EffortLevel;
    preset: JudgePreset;
  }) => void;
}

export function JudgeModal({ opened, onClose, providers, candidates, onRunJudge }: Props) {
  const structured = useMemo(
    () => providers.filter((provider) => provider.available && provider.structured),
    [providers],
  );
  const [providerId, setProviderId] = useState<string>(() => structured[0]?.id ?? "");
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<string>("auto");
  const [preset, setPreset] = useState<JudgePreset>("review");

  const activeProvider = structured.find((provider) => provider.id === providerId) ?? structured[0];
  const models = activeProvider?.models ?? [];
  const resolvedModel = model || (activeProvider?.kind === "runtime" ? models[0] : undefined);
  const efforts = resolveSupportedEfforts(activeProvider, resolvedModel);

  return (
    <Modal opened={opened} onClose={onClose} title="Cross-Model Review & Synthesis" size={480}>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Send {candidates.length} broadcast responses to an arbiter model to verify claims, catch hidden bugs, or synthesize one unified answer.
        </Text>

        <Group gap={6} wrap="wrap">
          {candidates.map((detail) => (
            <Badge key={detail.run.id} size="xs" variant="light" color="iris">
              {detail.run.providerName ?? detail.run.providerId}
              {detail.run.model ? ` · ${detail.run.model.split("/").at(-1)}` : ""}
            </Badge>
          ))}
        </Group>

        <div>
          <Text size="xs" fw={550} mb={4}>Review mode</Text>
          <SegmentedControl
            fullWidth
            size="xs"
            value={preset}
            onChange={(value) => setPreset(value as JudgePreset)}
            data={[
              { value: "review", label: PRESET_PROMPTS.review.label },
              { value: "synthesize", label: PRESET_PROMPTS.synthesize.label },
              { value: "pick-winner", label: PRESET_PROMPTS["pick-winner"].label },
            ]}
          />
        </div>

        <Select
          label="Arbiter provider"
          size="xs"
          value={activeProvider?.id ?? null}
          data={structured.map((provider) => ({ value: provider.id, label: provider.name }))}
          onChange={(value) => {
            if (value) {
              setProviderId(value);
              setModel("");
              setEffort("auto");
            }
          }}
        />

        {models.length > 0 && (
          <Select
            label="Model"
            size="xs"
            placeholder={activeProvider?.defaultModel ? `Default (${activeProvider.defaultModel})` : "Provider default"}
            clearable={activeProvider?.kind === "cli"}
            value={model || null}
            data={models.map((item) => ({ value: item, label: item }))}
            onChange={(value) => setModel(value ?? "")}
          />
        )}

        {efforts.length > 0 && (
          <Select
            label="Reasoning effort"
            size="xs"
            value={effort}
            data={[
              { value: "auto", label: "Auto (provider default)" },
              ...efforts.map((level) => ({ value: level, label: EFFORT_META[level].label })),
            ]}
            onChange={(value) => setEffort(value ?? "auto")}
          />
        )}

        <Group justify="flex-end" gap="xs" pt="xs">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button
            color="iris"
            disabled={!activeProvider || candidates.length < 2}
            leftSection={<Scales size={14} weight="duotone" />}
            onClick={() => {
              if (!activeProvider) return;
              onRunJudge({
                providerId: activeProvider.id,
                model: resolvedModel,
                effort: effort === "auto" ? undefined : (effort as EffortLevel),
                preset,
              });
              onClose();
            }}
          >
            Run in new split
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
