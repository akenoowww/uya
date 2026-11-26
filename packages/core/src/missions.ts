import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CapabilityDomain, CapabilityInvokeResult, EffortLevel, ExecutionMode, MissionPlan, MissionStep,
  SpecialistRecommendation, VerifyRun,
} from "@ide/protocol";
import type { History } from "./history";
import { RpcError } from "./validation";

const MAX_STEPS = 12;
const DEFAULT_MAX_HOPS = 8;
const CONTEXT_VALUE_LIMIT = 800;
const VERIFY_OUTPUT_LIMIT = 1_200;

type Release = () => void;
type Grant = (release: Release) => void;

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

function workspaceKey(workspacePath: string): string {
  // Synchronous lookup preserves arrival order even when callers use different aliases.
  if (process.platform === "win32") return canonicalPath(resolve(workspacePath));
  let path = isAbsolute(workspacePath) ? "/" : process.cwd();
  for (const part of workspacePath.split("/")) {
    // Resolve a symlink before traversing to its parent.
    path = part === ".." ? dirname(canonicalPath(path)) : join(path, part);
  }
  return canonicalPath(path);
}

export class WorkspaceTurnLock {
  private readonly queues = new Map<string, Set<Grant>>();

  async acquire(workspacePath: string, signal?: AbortSignal): Promise<Release> {
    signal?.throwIfAborted();
    const key = workspaceKey(workspacePath);
    const queue = this.queues.get(key);
    if (queue === undefined) {
      const waiters = new Set<Grant>();
      this.queues.set(key, waiters);
      return this.makeRelease(key, waiters);
    }

    // A listener on the caller's signal can stop event propagation.
    const queuedSignal = signal && AbortSignal.any([signal]);
    return new Promise<Release>((resolve, reject) => {
      const grant: Grant = (release) => {
        queuedSignal?.removeEventListener("abort", abort);
        resolve(release);
      };
      const abort = () => {
        queue.delete(grant);
        reject(queuedSignal?.reason);
      };
      queue.add(grant);
      queuedSignal?.addEventListener("abort", abort, { once: true });
    });
  }

  private makeRelease(key: string, waiters: Set<Grant>): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.values().next();
      if (next.done) {
        this.queues.delete(key);
      } else {
        waiters.delete(next.value);
        next.value(this.makeRelease(key, waiters));
      }
    };
  }
}

export interface MissionRunnerDeps {
  recommendSpecialist: (domain: CapabilityDomain, workspacePath: string | null) =>
    Promise<SpecialistRecommendation | null> | SpecialistRecommendation | null;
  executeAgentStep: (input: {
    mission: MissionPlan; step: MissionStep; prompt: string; signal: AbortSignal;
  }) => Promise<{ runId: string; summary: string; status: "succeeded" | "failed" | "cancelled" }>;
  executeCapabilityStep: (input: {
    capabilityId: string; args: Record<string, unknown>; workspacePath: string | null; signal: AbortSignal;
  }) => Promise<CapabilityInvokeResult>;
  executeVerifyStep: (input: { command: string; workspacePath: string; signal: AbortSignal }) => Promise<VerifyRun>;
  onMissionUpdated?: (mission: MissionPlan) => void;
}

interface MissionProposal {
  workspacePath: string | null;
  createdByRunId?: string;
  title: string;
  objective: string;
  maxHops?: number;
  steps: Array<{
    title: string;
    domain: CapabilityDomain;
    kind?: MissionStep["kind"];
    providerId?: string;
    providerName?: string;
    model?: string;
    effort?: EffortLevel;
    accessMode?: ExecutionMode;
    capabilityId?: string;
    capabilityArgs?: Record<string, unknown>;
    contract: string;
    verifyCommand?: string;
  }>;
}

interface StepOverride {
  stepId: string;
  providerId?: string;
  providerName?: string;
  model?: string;
  effort?: EffortLevel;
}

interface MissionApproval {
  autonomous?: boolean;
  stepOverrides?: StepOverride[];
}

interface ActiveMission {
  controller: AbortController;
  done: Promise<MissionPlan>;
}

type StepResult = Pick<MissionStep, "runId" | "summary" | "artifact"> & {
  status: "succeeded" | "failed" | "skipped";
};

function prepareStep(step: MissionStep, override: StepOverride | undefined, canRetry: boolean): MissionStep {
  const retrying = step.status === "failed" && canRetry;
  if (step.status !== "proposed" && !retrying) return step;
  const ready: MissionStep = { ...step, status: "proposed" };
  if (retrying) {
    delete ready.runId;
    delete ready.summary;
    delete ready.artifact;
  }
  if (!override) return ready;

  if (override.providerId !== undefined && override.providerId !== step.providerId) {
    ready.providerId = override.providerId;
    delete ready.providerName;
    delete ready.model;
    delete ready.effort;
  }
  if (override.providerName !== undefined) ready.providerName = override.providerName;
  if (override.model !== undefined) ready.model = override.model;
  if (override.effort !== undefined) ready.effort = override.effort;
  return ready;
}

function compact(text: string): string {
  const line = text.trim().replace(/\s+/gu, " ");
  return line.length > CONTEXT_VALUE_LIMIT ? `${line.slice(0, CONTEXT_VALUE_LIMIT - 1)}…` : line;
}

function agentPrompt(mission: MissionPlan, stepIndex: number): string {
  const step = mission.steps[stepIndex];
  const sections = [
    `# ${mission.title}`,
    `## Mission objective\n${mission.objective}`,
    `## Step contract for ${step.title}\n${step.contract}`,
  ];
  const completed = mission.steps.slice(0, stepIndex).filter(({ status }) => status === "succeeded");
  if (completed.length > 0) {
    const lines = completed.map(({ title, summary, artifact }) => {
      const details = [`- ${compact(title)}`];
      if (summary?.trim()) details.push(`  ${compact(summary)}`);
      if (artifact) details.push(`  Artifact ${compact(artifact.label)} (${artifact.path})`);
      return details.join("\n");
    });
    sections.push(`## Completed steps\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The step could not be completed.";
}

export class MissionCoordinator {
  private readonly active = new Map<string, ActiveMission>();
  private closing = false;

  constructor(
    private readonly history: History,
    private readonly deps: MissionRunnerDeps,
    public readonly workspaceLock = new WorkspaceTurnLock(),
  ) {}

  async propose(input: MissionProposal): Promise<MissionPlan> {
    const { workspacePath, title, objective, createdByRunId, maxHops: requestedHops = DEFAULT_MAX_HOPS } = input;
    const steps = await Promise.all(input.steps.slice(0, MAX_STEPS).map(async (fields): Promise<MissionStep> => {
      const step: MissionStep = { ...fields, id: randomUUID(), kind: fields.kind ?? "agent", status: "proposed" };
      if (step.kind !== "agent") return step;

      step.accessMode ??= workspacePath ? "agent" : "isolated";
      if (!step.providerId) {
        const specialist = await this.deps.recommendSpecialist(step.domain, workspacePath);
        if (specialist) {
          step.providerId = specialist.providerId;
          step.providerName = specialist.providerName;
          step.model ??= specialist.model;
          step.effort ??= specialist.effort;
        }
      }
      return step;
    }));
    const maxHops = Number.isNaN(requestedHops) ? DEFAULT_MAX_HOPS
      : Math.min(MAX_STEPS, Math.max(1, Math.trunc(requestedHops)));
    const now = Date.now();
    const plan: MissionPlan = {
      id: randomUUID(), workspacePath, title, objective, createdByRunId,
      status: "proposed", autonomous: false, maxHops, hopsUsed: 0, steps, createdAt: now, updatedAt: now,
    };
    this.history.saveMission(plan);
    this.notify(plan);
    return plan;
  }

  get(id: string): MissionPlan {
    const mission = this.history.getMission(id);
    if (!mission) throw new RpcError(-32004, "Mission not found.");
    return mission;
  }

  list(workspacePath?: string | null, limit = 20): MissionPlan[] {
    return this.history.listMissions(workspacePath, limit);
  }

  approve(id: string, options?: MissionApproval): MissionPlan {
    const mission = this.get(id);
    if (this.closing) throw new RpcError(-32005, "Mission coordinator is shutting down.");
    if (mission.status !== "proposed" && mission.status !== "failed") {
      throw new RpcError(-32009, "Only proposed or failed missions can be approved.");
    }
    const overrides = new Map(options?.stepOverrides?.map((override) => [override.stepId, override]));
    const canRetry = mission.hopsUsed < mission.maxHops;
    const approved: MissionPlan = {
      ...mission,
      status: "running",
      autonomous: options?.autonomous ?? mission.autonomous,
      steps: mission.steps.map((step) => prepareStep(step, overrides.get(step.id), canRetry)),
      updatedAt: Date.now(),
    };
    this.history.saveMission(approved);

    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.runLoop(id, controller.signal))
      .finally(() => {
        if (this.active.get(id)?.controller === controller) this.active.delete(id);
      });
    this.active.set(id, { controller, done });
    // Callers that wait can still observe a persistence error from the original promise.
    void done.catch(() => undefined);
    this.notify(approved);
    return approved;
  }

  async waitForCompletion(id: string): Promise<MissionPlan> {
    return this.active.get(id)?.done ?? this.get(id);
  }

  cancel(id: string): MissionPlan {
    const mission = this.get(id);
    if (mission.status === "cancelled") return mission;
    const cancelled: MissionPlan = {
      ...mission,
      status: "cancelled",
      steps: mission.steps.map((step) => step.status === "running" ? { ...step, status: "skipped" } : step),
      updatedAt: Date.now(),
    };
    const controller = this.active.get(id)?.controller;
    try {
      this.history.saveMission(cancelled);
    } finally {
      controller?.abort();
    }
    this.notify(cancelled);
    return cancelled;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const active = [...this.active];
    const outcomes = await Promise.allSettled(active.map(async ([id, { controller, done }]) => {
      try {
        if (this.get(id).status === "running") this.cancel(id);
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        await done;
      }
    }));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async runLoop(id: string, signal: AbortSignal): Promise<MissionPlan> {
    let mission = this.get(id);
    for (const [index, step] of mission.steps.entries()) {
      if (signal.aborted) return this.get(id);
      if (step.status !== "proposed" && step.status !== "failed") continue;
      if (mission.hopsUsed >= mission.maxHops) return this.update({ ...mission, status: "failed" });

      let release: Release | undefined;
      let result: StepResult;
      try {
        if (step.kind === "agent" && step.accessMode === "agent" && mission.workspacePath) {
          release = await this.workspaceLock.acquire(mission.workspacePath, signal);
        }
        signal.throwIfAborted();
        const runningStep: MissionStep = { ...step, status: "running" };
        mission = this.update({
          ...mission,
          hopsUsed: mission.hopsUsed + 1,
          steps: mission.steps.with(index, runningStep),
        });
        signal.throwIfAborted();
        result = await this.executeStep(mission, index, signal);
      } catch (error) {
        if (signal.aborted) return this.get(id);
        result = { status: "failed", summary: errorSummary(error) };
      } finally {
        release?.();
      }

      if (signal.aborted) return this.get(id);
      let status: MissionPlan["status"] = "running";
      if (result.status === "failed") status = "failed";
      if (result.status === "skipped") status = "cancelled";
      mission = this.update({ ...mission, status, steps: mission.steps.with(index, { ...step, ...result }) });
      if (status !== "running") return mission;
    }
    if (signal.aborted) return this.get(id);
    return this.update({ ...mission, status: "completed" });
  }

  private async executeStep(mission: MissionPlan, index: number, signal: AbortSignal): Promise<StepResult> {
    const step = mission.steps[index];
    const { workspacePath } = mission;
    switch (step.kind) {
      case "capability": {
        if (!step.capabilityId) throw new Error("A capability step requires a capability ID.");
        const { text, artifact } = await this.deps.executeCapabilityStep({
          capabilityId: step.capabilityId, args: structuredClone(step.capabilityArgs ?? {}), workspacePath, signal,
        });
        return { status: "succeeded", summary: text, ...(artifact && { artifact: { ...artifact } }) };
      }
      case "verify": {
        if (!step.verifyCommand || !workspacePath) throw new Error("A verify step requires a command and a workspace.");
        return this.verify(step.verifyCommand, workspacePath, signal);
      }
      case "agent": {
        const snapshot = structuredClone(mission);
        const prompt = agentPrompt(mission, index);
        const { runId, status, summary } = await this.deps.executeAgentStep({
          mission: snapshot, step: snapshot.steps[index], prompt, signal,
        });
        signal.throwIfAborted();
        if (status === "cancelled") return { runId, summary, status: "skipped" };
        if (step.verifyCommand && workspacePath) {
          const verification = await this.verify(step.verifyCommand, workspacePath, signal);
          if (verification.status !== "succeeded") return { ...verification, runId };
        }
        return { runId, summary, status };
      }
    }
  }

  private async verify(command: string, workspacePath: string, signal: AbortSignal): Promise<StepResult> {
    try {
      const run = await this.deps.executeVerifyStep({ command, workspacePath, signal });
      const exit = run.exitCode == null ? "" : ` (exit code ${run.exitCode})`;
      const passed = run.status === "passed" && (run.exitCode == null || run.exitCode === 0);
      const cancelled = run.status === "cancelled";
      let summary = passed ? "Verification passed." : `Verification failed${exit}.`;
      if (cancelled) summary = "Verification cancelled.";
      const output = run.output.trim();
      if (output) {
        const excerpt = output.length > VERIFY_OUTPUT_LIMIT ? `…${output.slice(-(VERIFY_OUTPUT_LIMIT - 1))}` : output;
        summary += `\n${excerpt}`;
      }
      return { status: cancelled ? "skipped" : passed ? "succeeded" : "failed", summary };
    } catch (error) {
      return { status: "failed", summary: `Verification failed. ${errorSummary(error)}` };
    }
  }

  private update(mission: MissionPlan): MissionPlan {
    const updated = { ...mission, updatedAt: Date.now() };
    this.history.saveMission(updated);
    this.notify(updated);
    return updated;
  }

  private notify(mission: MissionPlan): void {
    try {
      this.deps.onMissionUpdated?.(structuredClone(mission));
    } catch {
      // Notification failures must leave the persisted transition and runner intact.
    }
  }
}
