import { useRef, useState } from "react";
import { Alert, Badge, Box, Button, Group, Loader, Paper, Select, Stack, Text } from "@mantine/core";
import { ClipboardText, Play, Stop } from "@phosphor-icons/react";
import type { EffortLevel, MissionPlan, MissionStep, Provider, RpcParams } from "@ide/protocol";
import { errorMessage } from "../bridge";
import { EFFORT_META, resolveSupportedEfforts } from "./EffortPicker";
import { ProviderIcon } from "./ProviderIcon";

type StepOverride = NonNullable<RpcParams<"missions.approve">["stepOverrides"]>[number];

interface Props {
  mission: MissionPlan;
  providers: Provider[];
  onApprove?: (missionId: string, options: { autonomous: boolean; stepOverrides: StepOverride[] }) => Promise<void> | void;
  onCancel?: (missionId: string) => Promise<void> | void;
}

const MISSION_COLORS: Record<MissionPlan["status"], string> = {
  proposed: "iris",
  running: "blue",
  completed: "teal",
  failed: "red",
  cancelled: "gray",
};

const STEP_COLORS: Record<MissionStep["status"], string> = {
  proposed: "gray",
  running: "blue",
  succeeded: "teal",
  failed: "red",
  skipped: "gray",
};

function StepSelectors({ step, override, providers, candidates, disabled, onChange }: {
  step: MissionStep;
  override: StepOverride | undefined;
  providers: Provider[];
  candidates: Provider[];
  disabled: boolean;
  onChange: (override: StepOverride) => void;
}) {
  const providerId = override?.providerId ?? step.providerId;
  const provider = providers.find((candidate) => candidate.id === providerId);
  const model = (override?.providerId ? override.model : step.model) ?? provider?.defaultModel;
  const supportedEfforts = resolveSupportedEfforts(provider, model);
  const plannedEffort = override?.providerId ? undefined : step.effort;
  const effort = override?.effort ?? plannedEffort;
  const effortOptions = [...new Set([...supportedEfforts, ...(effort ? [effort] : [])])];
  const providerOptions = candidates.map((candidate) => ({ value: candidate.id, label: candidate.name }));
  if (step.providerId && !providerOptions.some((option) => option.value === step.providerId)) {
    providerOptions.push({ value: step.providerId, label: step.providerName ?? step.providerId });
  }

  function changeProvider(id: string | null) {
    if (!id || id === step.providerId) {
      onChange({ stepId: step.id });
      return;
    }
    const nextProvider = candidates.find((candidate) => candidate.id === id);
    if (!nextProvider) return;
    const nextModel = nextProvider.defaultModel ?? nextProvider.models?.[0];
    const nextEfforts = resolveSupportedEfforts(nextProvider, nextModel);
    const nextEffort = effort && nextEfforts.includes(effort) ? effort : nextProvider.defaultEffort;
    onChange({
      stepId: step.id,
      providerId: id,
      model: nextModel,
      effort: nextEffort && nextEfforts.includes(nextEffort) ? nextEffort : undefined,
    });
  }

  return (
    <Group gap={6}>
      <Select
        size="xs"
        w={170}
        aria-label={`Provider for ${step.title}`}
        placeholder="Select provider"
        data={providerOptions}
        value={providerId ?? null}
        onChange={changeProvider}
        allowDeselect={false}
        clearable={!step.providerId}
        clearButtonProps={{ "aria-label": `Clear provider override for ${step.title}` }}
        disabled={disabled || candidates.length === 0}
        leftSection={providerId && <ProviderIcon providerId={providerId} size={12} framed={false} />}
      />
      <Select<EffortLevel>
        size="xs"
        w={135}
        aria-label={`Reasoning effort for ${step.title}`}
        placeholder={provider?.defaultEffort ? EFFORT_META[provider.defaultEffort].label : "Auto effort"}
        data={effortOptions.map((level) => ({ value: level, label: EFFORT_META[level].label }))}
        value={effort ?? null}
        onChange={(level) => onChange({
          stepId: step.id,
          providerId: override?.providerId,
          model: override?.model,
          effort: level !== plannedEffort ? level ?? undefined : undefined,
        })}
        allowDeselect={false}
        clearable={!plannedEffort}
        clearButtonProps={{ "aria-label": `Clear effort override for ${step.title}` }}
        disabled={disabled || supportedEfforts.length === 0}
      />
    </Group>
  );
}

export function MissionCard(props: Props) {
  return <MissionCardContent key={props.mission.id} {...props} />;
}

function MissionCardContent({ mission, providers, onApprove, onCancel }: Props) {
  const [overrides, setOverrides] = useState(() => new Map<string, StepOverride>());
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const actionInFlight = useRef(false);
  const proposed = mission.status === "proposed";
  const running = mission.status === "running";
  const finishedSteps = mission.steps.filter((step) => step.status !== "proposed" && step.status !== "running").length;
  const candidates = providers.filter((provider) => provider.available && provider.structured);

  function updateStep(override: StepOverride) {
    setOverrides((current) => {
      const next = new Map(current);
      if (override.providerId || override.effort) next.set(override.stepId, override);
      else next.delete(override.stepId);
      return next;
    });
  }

  async function act(action: "approve" | "cancel") {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(action);
    setError("");
    try {
      if (action === "approve") {
        const stepOverrides = mission.steps.flatMap((step) => {
          const override = overrides.get(step.id);
          return step.kind === "agent" && override ? [override] : [];
        });
        await onApprove?.(mission.id, { autonomous: mission.autonomous, stepOverrides });
      } else {
        await onCancel?.(mission.id);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <Paper component="article" withBorder bg="dark.8" p="sm" radius="sm" my={6} aria-label={`Mission ${mission.title}`}>
      <Stack gap="xs">
        <Group gap={7}>
          <ClipboardText size={17} weight="duotone" color="var(--mantine-color-iris-4)" aria-hidden="true" />
          <Text size="sm" fw={650} style={{ overflowWrap: "anywhere" }}>{mission.title}</Text>
          <Badge size="xs" variant="light" color={MISSION_COLORS[mission.status]}>{mission.status}</Badge>
          <Text size="xs" c="dimmed">{finishedSteps}/{mission.steps.length} steps</Text>
          {proposed && mission.autonomous && <Badge size="xs" variant="outline" color="iris">Autonomous</Badge>}
        </Group>
        <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{mission.objective}</Text>

        <Box component="ol" m={0} pl={22} style={{ display: "grid", gap: 6 }}>
          {mission.steps.map((step) => (
            <Box component="li" key={step.id} bg="dark.9" p="xs" style={{ borderRadius: "var(--mantine-radius-sm)" }}>
              <Stack gap={5}>
                <Group gap={6}>
                  <Badge size="xs" variant="light" color="iris">{step.domain}</Badge>
                  <Text size="xs" fw={600} style={{ overflowWrap: "anywhere" }}>{step.title}</Text>
                  <Badge
                    size="xs"
                    variant="light"
                    color={STEP_COLORS[step.status]}
                    leftSection={step.status === "running" && <Loader size={8} aria-hidden="true" />}
                  >
                    {step.status}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{step.contract}</Text>
                {step.summary && (
                  <Text
                    size="xs"
                    c={step.status === "failed" ? "red.3" : "teal.3"}
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {step.summary}
                  </Text>
                )}
                {proposed && step.kind === "agent" && (
                  <StepSelectors
                    step={step}
                    override={overrides.get(step.id)}
                    providers={providers}
                    candidates={candidates}
                    disabled={busy !== null || !onApprove}
                    onChange={updateStep}
                  />
                )}
              </Stack>
            </Box>
          ))}
        </Box>

        {error && <Alert color="red" variant="light" role="alert">{error}</Alert>}
        {(proposed || running) && (
          <Group gap={6}>
            {proposed && (
              <Button
                size="compact-xs"
                variant="light"
                color="teal"
                leftSection={<Play size={12} weight="fill" aria-hidden="true" />}
                disabled={!onApprove || busy === "cancel"}
                loading={busy === "approve"}
                onClick={() => void act("approve")}
              >
                Approve &amp; Execute Mission
              </Button>
            )}
            <Button
              size="compact-xs"
              variant={running ? "light" : "subtle"}
              color={running ? "red" : "gray"}
              leftSection={running && <Stop size={12} weight="fill" aria-hidden="true" />}
              disabled={!onCancel || busy === "approve"}
              loading={busy === "cancel"}
              onClick={() => void act("cancel")}
            >
              {running ? "Stop Mission" : "Dismiss"}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
