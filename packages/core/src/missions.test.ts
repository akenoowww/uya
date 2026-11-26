import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactItem, CapabilityDomain, MissionPlan, SpecialistRecommendation, VerifyRun } from "@ide/protocol";
import { History } from "./history";
import { MissionCoordinator, WorkspaceTurnLock, type MissionRunnerDeps } from "./missions";
import { RpcError } from "./validation";

type Proposal = Parameters<MissionCoordinator["propose"]>[0];
type StepInput = Proposal["steps"][number];
type AgentInput = Parameters<MissionRunnerDeps["executeAgentStep"]>[0];
type VerifyInput = Parameters<MissionRunnerDeps["executeVerifyStep"]>[0];

let fixture: string;
let workspace: string;
let otherWorkspace: string;
let history: History;
let coordinators: MissionCoordinator[];

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "uya-missions-")));
  workspace = join(fixture, "workspace");
  otherWorkspace = join(fixture, "other-workspace");
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  history = new History(join(fixture, "history"));
  coordinators = [];
});

afterEach(async () => {
  try {
    await Promise.all(coordinators.map((coordinator) => coordinator.shutdown()));
  } finally {
    history.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

function makeCoordinator(deps: Partial<MissionRunnerDeps> = {}, lock?: WorkspaceTurnLock): MissionCoordinator {
  const coordinator = new MissionCoordinator(history, {
    recommendSpecialist: () => null,
    executeAgentStep: async ({ step }) => agentSuccess(`run-${step.title}`),
    executeCapabilityStep: async () => ({ text: "Capability result" }),
    executeVerifyStep: async (input) => verifyResult(input),
    ...deps,
  }, lock);
  coordinators.push(coordinator);
  return coordinator;
}

function step(title: string, options: Partial<StepInput> = {}): StepInput {
  return { title, domain: "code", providerId: "fixture-provider", contract: `Deliver ${title}.`, ...options };
}

function propose(coordinator: MissionCoordinator, steps: StepInput[], options: Partial<Omit<Proposal, "steps">> = {}) {
  return coordinator.propose({ workspacePath: workspace, title: "Fixture mission", objective: "Publish a checked report.", steps, ...options });
}

function agentSuccess(runId: string, summary = "Agent result") {
  return { runId, summary, status: "succeeded" as const };
}

function verifyResult({ workspacePath, command }: VerifyInput, fields: Partial<VerifyRun> = {}): VerifyRun {
  return {
    id: "verify-fixture", workspacePath, cwd: workspacePath, command,
    status: "passed", startedAt: 1, finishedAt: 2, exitCode: 0, output: "Checks passed.", truncated: false, ...fields,
  };
}

function workspaceAlias(): string {
  const alias = join(fixture, "workspace-alias");
  symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  return alias;
}

describe("WorkspaceTurnLock", () => {
  test("grants canonical workspace aliases in arrival order and releases other workspaces independently", async () => {
    const lock = new WorkspaceTurnLock();
    const alias = workspaceAlias();
    const first = await lock.acquire(workspace);
    const granted: string[] = [];
    const second = lock.acquire(alias).then((release) => { granted.push("second"); return release; });
    const third = lock.acquire(`${workspace}/../workspace/.`).then((release) => { granted.push("third"); return release; });

    (await lock.acquire(otherWorkspace))();
    expect(granted).toEqual([]);
    first();
    const releaseSecond = await second;
    expect(granted).toEqual(["second"]);
    first();
    (await lock.acquire(otherWorkspace))();
    expect(granted).toEqual(["second"]);

    releaseSecond();
    (await third)();
    expect(granted).toEqual(["second", "third"]);
    (await lock.acquire(alias))();
  });

  test.skipIf(process.platform === "win32")("resolves a symlink before traversing to its parent", async () => {
    const child = join(workspace, "child");
    const alias = join(otherWorkspace, "to-child");
    mkdirSync(child);
    symlinkSync(child, alias, "dir");

    const lock = new WorkspaceTurnLock();
    const release = await lock.acquire(workspace);
    let granted = false;
    const waiting = lock.acquire(`${alias}/..`).then((unlock) => { granted = true; return unlock; });
    (await lock.acquire(otherWorkspace))();
    expect(granted).toBe(false);
    release();
    (await waiting)();
  });

  test("keeps the same lock key when a workspace is created under an aliased directory", async () => {
    const lock = new WorkspaceTurnLock();
    const alias = workspaceAlias();
    const release = await lock.acquire(join(alias, "new-folder"));
    const newWorkspace = join(workspace, "new-folder");
    mkdirSync(newWorkspace);

    let granted = false;
    const waiting = lock.acquire(newWorkspace).then((unlock) => { granted = true; return unlock; });
    (await lock.acquire(otherWorkspace))();
    expect(granted).toBe(false);
    release();
    (await waiting)();
  });

  test("removes aborted waiters and leaves the current holder in control of release", async () => {
    const lock = new WorkspaceTurnLock();
    const owner = new AbortController();
    const release = await lock.acquire(workspace, owner.signal);
    const head = new AbortController();
    const middle = new AbortController();
    head.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const granted: number[] = [];
    const atHead = lock.acquire(workspace, head.signal);
    const second = lock.acquire(workspace).then((unlock) => { granted.push(2); return unlock; });
    const inMiddle = lock.acquire(workspace, middle.signal);
    const last = lock.acquire(workspace).then((unlock) => { granted.push(4); return unlock; });

    const outcomes = Promise.allSettled([atHead, inMiddle]);
    head.abort();
    middle.abort();
    owner.abort();
    expect(await outcomes).toMatchObject([
      { status: "rejected", reason: { name: "AbortError" } },
      { status: "rejected", reason: { name: "AbortError" } },
    ]);
    await expect(lock.acquire(workspace, head.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(granted).toEqual([]);

    release();
    (await second)();
    (await last)();
    expect(granted).toEqual([2, 4]);
    (await lock.acquire(workspace))();
  });
});

describe("MissionCoordinator", () => {
  test("caps proposals, routes unassigned agent steps, and persists workspace-scoped plans", async () => {
    const recommendations: Array<[CapabilityDomain, string | null]> = [];
    const coordinator = makeCoordinator({
      recommendSpecialist(domain, path) {
        recommendations.push([domain, path]);
        const specialist: SpecialistRecommendation = {
          domain, providerId: `auto-${domain}`, providerName: `Specialist ${domain}`,
          model: `model-${domain}`, effort: "high", reason: "Fixture recommendation",
        };
        return domain === "vision" ? Promise.resolve(specialist) : specialist;
      },
    });
    const proposed = await propose(coordinator, [
      step("Plan", { providerId: undefined }),
      step("Inspect", { providerName: "Manual", model: "manual", effort: "low", accessMode: "read-only" }),
      step("Gather", { kind: "capability", domain: "search", providerId: undefined, capabilityId: "gather" }),
      step("Check", { kind: "verify", providerId: undefined, verifyCommand: "check" }),
      ...Array.from({ length: 10 }, (_, index) => step(`Planned ${index}`)),
    ], { maxHops: 50, createdByRunId: "parent-run" });
    const isolated = await propose(coordinator, [
      step("Draw", { domain: "vision", providerId: undefined }),
    ], { workspacePath: null });

    expect(proposed).toMatchObject({ status: "proposed", autonomous: false, maxHops: 12, hopsUsed: 0, createdByRunId: "parent-run" });
    expect(proposed.steps).toHaveLength(12);
    expect(new Set(proposed.steps.map(({ id }) => id)).size).toBe(12);
    expect(proposed.steps.every(({ status }) => status === "proposed")).toBe(true);
    expect(proposed.steps[0]).toMatchObject({
      kind: "agent", accessMode: "agent", providerId: "auto-code", providerName: "Specialist code", model: "model-code", effort: "high",
    });
    expect(proposed.steps[1]).toMatchObject({
      providerId: "fixture-provider", providerName: "Manual", model: "manual", effort: "low", accessMode: "read-only",
    });
    expect(proposed.steps[2].accessMode).toBeUndefined();
    expect(proposed.steps[3].accessMode).toBeUndefined();
    expect(isolated.maxHops).toBe(8);
    expect(isolated.steps[0]).toMatchObject({ accessMode: "isolated", providerId: "auto-vision" });
    expect(recommendations).toEqual([["code", workspace], ["vision", null]]);
    expect(coordinator.get(proposed.id)).toEqual(proposed);
    expect(coordinator.list(workspace)).toEqual([proposed]);
    expect(coordinator.list(null)).toEqual([isolated]);
    expect(coordinator.list(undefined, 1)).toEqual([isolated]);
    expect(coordinator.list()).toHaveLength(2);
  });

  test("uses an integer hop budget with bounds and handles missing mission IDs", async () => {
    const coordinator = makeCoordinator();
    for (const [requested, expected] of [[-10, 1], [2.9, 2], [Infinity, 12], [NaN, 8]]) {
      const proposal = await propose(coordinator, [], { maxHops: requested });
      expect(coordinator.get(proposal.id).maxHops).toBe(expected);
    }
    const notFound = { code: -32004, message: "Mission not found." };
    expect(() => coordinator.get("missing")).toThrow(RpcError);
    expect(() => coordinator.get("missing")).toThrow(expect.objectContaining(notFound));
    expect(() => coordinator.approve("missing")).toThrow(expect.objectContaining(notFound));
    expect(() => coordinator.cancel("missing")).toThrow(expect.objectContaining(notFound));
    await expect(coordinator.waitForCompletion("missing")).rejects.toMatchObject(notFound);
  });

  test("approves synchronously and executes all step kinds with prior results in later prompts", async () => {
    const calls: string[] = [];
    const agentInputs: AgentInput[] = [];
    const updates: MissionPlan[] = [];
    const artifact: ArtifactItem = {
      id: "survey", kind: "file", label: "Survey data", path: "reports/annual  survey.json", createdAt: 1,
    };
    const capabilityText = `Collected survey data. ${"verbose data ".repeat(200)}END OF CAPABILITY OUTPUT`;
    const coordinator = makeCoordinator({
      async executeCapabilityStep({ capabilityId, args, workspacePath, signal }) {
        calls.push(`capability ${capabilityId}`);
        expect(args).toEqual({ query: "sample" });
        expect(workspacePath).toBe(workspace);
        expect(signal.aborted).toBe(false);
        return { text: capabilityText, artifact };
      },
      async executeAgentStep(input) {
        calls.push(`agent ${input.step.title}`);
        agentInputs.push(input);
        return agentSuccess(`run-${input.step.title}`, `${input.step.title} finished.`);
      },
      async executeVerifyStep(input) {
        calls.push(`verify ${input.command}`);
        return verifyResult(input);
      },
      onMissionUpdated: (mission) => updates.push(mission),
    });
    const proposal = await propose(coordinator, [
      step("Survey", { kind: "capability", capabilityId: "survey", capabilityArgs: { query: "sample" } }),
      step("Draft", { verifyCommand: "verify draft" }),
      step("Check", { kind: "verify", verifyCommand: "verify report" }),
      step("Publish", { accessMode: "read-only" }),
    ], { maxHops: 4 });

    const approved = coordinator.approve(proposal.id, {
      autonomous: true,
      stepOverrides: [{ stepId: proposal.steps[1].id, providerId: "writer", providerName: "Writer", model: "draft-v2", effort: "medium" }],
    });
    expect(approved).toMatchObject({ status: "running", autonomous: true, hopsUsed: 0 });
    expect(history.getMission(proposal.id)).toEqual(approved);
    expect(calls).toEqual([]);
    expect(() => coordinator.approve(proposal.id)).toThrow(expect.objectContaining({ code: -32009 }));

    const finished = await coordinator.waitForCompletion(proposal.id);
    expect(calls).toEqual(["capability survey", "agent Draft", "verify verify draft", "verify verify report", "agent Publish"]);
    expect(finished).toMatchObject({ status: "completed", hopsUsed: 4 });
    expect(finished.steps.map(({ status }) => status)).toEqual(Array(4).fill("succeeded"));
    expect(finished.steps[0]).toMatchObject({ summary: capabilityText, artifact });
    expect(finished.steps[2].summary).toContain("Checks passed.");
    expect(agentInputs[0].step).toMatchObject({
      providerId: "writer", providerName: "Writer", model: "draft-v2", effort: "medium", status: "running",
    });
    expect(agentInputs[0].mission).toMatchObject({ autonomous: true, hopsUsed: 2 });
    expect(agentInputs[0].prompt).toContain("Publish a checked report.");
    expect(agentInputs[0].prompt).toContain("Deliver Draft.");
    expect(agentInputs[0].prompt).toContain("Collected survey data.");
    expect(agentInputs[0].prompt).toContain("Survey data (reports/annual  survey.json)");
    expect(agentInputs[0].prompt).not.toContain("END OF CAPABILITY OUTPUT");
    expect(agentInputs[0].prompt).not.toContain("Deliver Publish.");
    expect(agentInputs[1].prompt).toContain("Draft finished.");
    expect(agentInputs[1].prompt).toContain("Checks passed.");
    expect(updates.map(({ status }) => status).at(0)).toBe("proposed");
    expect(updates.filter((mission) => mission.steps.some(({ status }) => status === "running"))).toHaveLength(4);
    expect(updates.at(-1)).toEqual(finished);
    expect(coordinator.get(proposal.id)).toEqual(finished);
    expect(() => coordinator.approve(proposal.id)).toThrow(expect.objectContaining({ code: -32009 }));
  });

  test("records inline verification failure and retries only unfinished work within the same budget", async () => {
    const calls: string[] = [];
    let checks = 0;
    const coordinator = makeCoordinator({
      async executeAgentStep({ step }) {
        calls.push(`${step.title}/${step.providerId}`);
        return agentSuccess(`run-${calls.length}`);
      },
      async executeVerifyStep(input) {
        return ++checks === 1 ? verifyResult(input, {
          status: "failed", exitCode: 7, output: `VERBOSE START ${"detail ".repeat(2000)}\nInvalid report header.`,
        }) : verifyResult(input);
      },
    });
    const proposal = await propose(coordinator, [
      step("Prepare"),
      step("Patch", { providerName: "Original", model: "original-model", effort: "high", verifyCommand: "check patch" }),
      step("Finish"),
    ], { maxHops: 4 });
    coordinator.approve(proposal.id);
    const failed = await coordinator.waitForCompletion(proposal.id);
    expect(failed).toMatchObject({ status: "failed", hopsUsed: 2 });
    expect(failed.steps.map(({ status }) => status)).toEqual(["succeeded", "failed", "proposed"]);
    expect(failed.steps[1].runId).toBe("run-2");
    expect(failed.steps[1].summary).toContain("exit code 7");
    expect(failed.steps[1].summary).toContain("Invalid report header.");
    expect(failed.steps[1].summary).not.toContain("VERBOSE START");

    const retry = coordinator.approve(proposal.id, { stepOverrides: [
      { stepId: proposal.steps[0].id, providerId: "should-not-relabel" },
      { stepId: proposal.steps[1].id, providerId: "replacement" },
    ] });
    expect(retry.hopsUsed).toBe(2);
    expect(retry.steps[0]).toEqual(failed.steps[0]);
    expect(retry.steps[1]).toMatchObject({ status: "proposed", providerId: "replacement" });
    expect(retry.steps[1].providerName).toBeUndefined();
    expect(retry.steps[1].model).toBeUndefined();
    expect(retry.steps[1].effort).toBeUndefined();
    expect(retry.steps[1].runId).toBeUndefined();
    expect(retry.steps[1].summary).toBeUndefined();

    const finished = await coordinator.waitForCompletion(proposal.id);
    expect(finished).toMatchObject({ status: "completed", hopsUsed: 4 });
    expect(finished.steps[1].runId).toBe("run-3");
    expect(calls).toEqual(["Prepare/fixture-provider", "Patch/fixture-provider", "Patch/replacement", "Finish/fixture-provider"]);
  });

  test("fails without starting a further step once the hop budget is exhausted", async () => {
    const executed: string[] = [];
    const coordinator = makeCoordinator({
      async executeAgentStep({ step }) { executed.push(step.title); return agentSuccess(step.id); },
    });
    const proposal = await propose(coordinator, [step("One"), step("Two")], { maxHops: 1 });
    coordinator.approve(proposal.id);
    const failed = await coordinator.waitForCompletion(proposal.id);
    expect(failed).toMatchObject({ status: "failed", hopsUsed: 1 });
    expect(failed.steps.map(({ status }) => status)).toEqual(["succeeded", "proposed"]);
    coordinator.approve(proposal.id);
    expect(await coordinator.waitForCompletion(proposal.id)).toMatchObject({ status: "failed", hopsUsed: 1 });
    expect(executed).toEqual(["One"]);
  });

  test("preserves the last failure when approval has no hops left for a retry", async () => {
    let attempts = 0;
    const coordinator = makeCoordinator({
      async executeAgentStep() {
        attempts++;
        return { runId: "last-run", status: "failed", summary: "The report could not be written." };
      },
    });
    const proposal = await propose(coordinator, [step("Write")], { maxHops: 1 });
    coordinator.approve(proposal.id);
    const failed = await coordinator.waitForCompletion(proposal.id);
    expect(failed.steps[0]).toMatchObject({ status: "failed", runId: "last-run", summary: "The report could not be written." });

    coordinator.approve(proposal.id);
    const exhausted = await coordinator.waitForCompletion(proposal.id);
    expect(exhausted).toMatchObject({ status: "failed", hopsUsed: 1, steps: failed.steps });
    expect(attempts).toBe(1);
  });

  test("keeps execution errors and standalone verify outcomes in persisted step summaries", async () => {
    const coordinator = makeCoordinator({
      async executeCapabilityStep({ args }) {
        expect(args).toEqual({});
        throw new Error("Capability is unavailable.");
      },
      async executeVerifyStep(input) {
        return verifyResult(input, { exitCode: 2, output: "Standalone check failed." });
      },
    });
    const capability = await propose(coordinator, [step("Gather", { kind: "capability", capabilityId: "gather" })]);
    const verify = await propose(coordinator, [step("Check", { kind: "verify", verifyCommand: "check" })]);
    coordinator.approve(capability.id);
    coordinator.approve(verify.id);
    await Promise.all([coordinator.waitForCompletion(capability.id), coordinator.waitForCompletion(verify.id)]);
    expect(coordinator.get(capability.id)).toMatchObject({
      status: "failed", steps: [{ status: "failed", summary: "Capability is unavailable." }],
    });
    expect(coordinator.get(verify.id)).toMatchObject({
      status: "failed", steps: [{ status: "failed", summary: "Verification failed (exit code 2).\nStandalone check failed." }],
    });
  });

  test("skips inline verification without a workspace and handles cancelled executor results", async () => {
    let verifyCalls = 0;
    const coordinator = makeCoordinator({
      async executeAgentStep({ step }) {
        if (step.title === "Stop") return { runId: step.id, status: "cancelled", summary: "Executor cancelled." };
        return agentSuccess(step.id);
      },
      async executeVerifyStep(input) { verifyCalls++; return verifyResult(input); },
    });
    const isolated = await propose(coordinator, [step("Draft", { verifyCommand: "check" })], { workspacePath: null });
    coordinator.approve(isolated.id);
    expect(await coordinator.waitForCompletion(isolated.id)).toMatchObject({ status: "completed", hopsUsed: 1 });
    const aborted = await propose(coordinator, [step("Stop", { verifyCommand: "check" }), step("Remaining")]);
    coordinator.approve(aborted.id);
    expect(await coordinator.waitForCompletion(aborted.id)).toMatchObject({
      status: "cancelled", hopsUsed: 1,
      steps: [{ status: "skipped", summary: "Executor cancelled." }, { status: "proposed" }],
    });
    expect(verifyCalls).toBe(0);
  });

  test("holds a shared writer lock through verification while other modes and workspaces execute", async () => {
    const lock = new WorkspaceTurnLock();
    const checking = Promise.withResolvers<void>();
    const finishCheck = Promise.withResolvers<void>();
    const events: string[] = [];
    const deps: Partial<MissionRunnerDeps> = {
      async executeAgentStep({ step }) {
        events.push(step.title);
        return agentSuccess(step.id);
      },
      async executeVerifyStep(input) {
        checking.resolve();
        await finishCheck.promise;
        events.push("verification finished");
        return verifyResult(input);
      },
    };
    const owner = makeCoordinator(deps, lock);
    const contender = makeCoordinator(deps, lock);
    const writer = await propose(owner, [step("Writer", { verifyCommand: "check" })]);
    const nextWriter = await propose(contender, [step("Next writer")], { workspacePath: workspaceAlias() });
    const reader = await propose(contender, [step("Reader", { accessMode: "read-only" })]);
    const isolated = await propose(contender, [step("Isolated", { accessMode: "isolated" })]);
    const other = await propose(contender, [step("Other workspace")], { workspacePath: otherWorkspace });

    owner.approve(writer.id);
    try {
      await checking.promise;
      for (const plan of [nextWriter, reader, isolated, other]) contender.approve(plan.id);
      await Promise.all([reader, isolated, other].map(({ id }) => contender.waitForCompletion(id)));
      expect(events).toEqual(["Writer", "Reader", "Isolated", "Other workspace"]);
      expect(contender.get(nextWriter.id)).toMatchObject({ status: "running", hopsUsed: 0, steps: [{ status: "proposed" }] });

      finishCheck.resolve();
      expect(await owner.waitForCompletion(writer.id)).toMatchObject({ status: "completed" });
      expect(await contender.waitForCompletion(nextWriter.id)).toMatchObject({ status: "completed" });
      expect(events.slice(-2)).toEqual(["verification finished", "Next writer"]);
    } finally {
      finishCheck.resolve();
    }
  });

  test("cancels a mission queued behind a workspace turn without consuming a hop or blocking its successor", async () => {
    const lock = new WorkspaceTurnLock();
    const coordinator = makeCoordinator({}, lock);
    const queued = await propose(coordinator, [step("Queued")]);
    const next = await propose(coordinator, [step("Next")]);
    const release = await lock.acquire(workspace);
    try {
      coordinator.approve(queued.id);
      coordinator.approve(next.id);
      await Promise.resolve();
      const cancelled = coordinator.cancel(queued.id);
      expect(cancelled).toMatchObject({ status: "cancelled", hopsUsed: 0, steps: [{ status: "proposed" }] });
      expect(await coordinator.waitForCompletion(queued.id)).toEqual(cancelled);
    } finally {
      release();
    }
    expect(await coordinator.waitForCompletion(next.id)).toMatchObject({ status: "completed" });
  });

  test("cancels running work immediately and releases its lock only after the executor exits", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<void>();
    const calls: string[] = [];
    const coordinator = makeCoordinator({
      async executeAgentStep({ step, signal }) {
        calls.push(step.title);
        if (step.title === "Writer") {
          started.resolve(signal);
          await finish.promise;
          calls.push("writer exited");
        }
        return agentSuccess(step.id);
      },
      async executeVerifyStep(input) { calls.push("verify"); return verifyResult(input); },
    });
    const running = await propose(coordinator, [step("Writer", { verifyCommand: "check" }), step("Remaining")]);
    const next = await propose(coordinator, [step("Next")]);
    coordinator.approve(running.id);
    try {
      const signal = await started.promise;
      let drained = false;
      const completion = coordinator.waitForCompletion(running.id).then((result) => { drained = true; return result; });
      const cancelled = coordinator.cancel(running.id);
      expect(signal.aborted).toBe(true);
      expect(cancelled).toMatchObject({ status: "cancelled", hopsUsed: 1, steps: [{ status: "skipped" }, { status: "proposed" }] });
      expect(coordinator.get(running.id)).toEqual(cancelled);
      expect(coordinator.cancel(running.id)).toEqual(cancelled);
      expect(() => coordinator.approve(running.id)).toThrow(expect.objectContaining({ code: -32009 }));
      coordinator.approve(next.id);
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(calls).toEqual(["Writer"]);

      finish.resolve();
      expect(await completion).toEqual(cancelled);
      expect(await coordinator.waitForCompletion(next.id)).toMatchObject({ status: "completed" });
      expect(calls).toEqual(["Writer", "writer exited", "Next"]);
    } finally {
      finish.resolve();
    }
  });

  test("shutdown cancels running and queued missions and waits for executor cleanup", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const cleanup = Promise.withResolvers<void>();
    const executed: string[] = [];
    const coordinator = makeCoordinator({
      async executeAgentStep({ step, signal }) {
        executed.push(step.title);
        started.resolve(signal);
        await cleanup.promise;
        signal.throwIfAborted();
        return agentSuccess(step.id);
      },
    });
    const writer = await propose(coordinator, [step("Active")]);
    const queued = await propose(coordinator, [step("Queued")]);
    const unapproved = await propose(coordinator, [step("Unapproved")]);
    coordinator.approve(writer.id);
    try {
      const signal = await started.promise;
      coordinator.approve(queued.id);
      await Promise.resolve();
      let stopped = false;
      const shutdown = coordinator.shutdown().then(() => { stopped = true; });
      expect(signal.aborted).toBe(true);
      expect(coordinator.get(writer.id)).toMatchObject({ status: "cancelled", steps: [{ status: "skipped" }] });
      expect(await coordinator.waitForCompletion(queued.id)).toMatchObject({ status: "cancelled", hopsUsed: 0 });
      expect(stopped).toBe(false);
      expect(() => coordinator.approve(unapproved.id)).toThrow(expect.objectContaining({ code: -32005 }));

      cleanup.resolve();
      await shutdown;
      expect(stopped).toBe(true);
      expect(executed).toEqual(["Active"]);
      expect(coordinator.get(unapproved.id).status).toBe("proposed");
      (await coordinator.workspaceLock.acquire(workspace))();
    } finally {
      cleanup.resolve();
    }
  });

  test("keeps a reentrant retry active even when its update observer mutates the snapshot or throws", async () => {
    const retryStarted = Promise.withResolvers<AbortSignal>();
    const finishRetry = Promise.withResolvers<void>();
    let attempts = 0;
    const coordinator = makeCoordinator({
      async executeAgentStep({ signal }) {
        if (++attempts === 1) return { runId: "first", status: "failed", summary: "Retry this step." };
        retryStarted.resolve(signal);
        await finishRetry.promise;
        return agentSuccess("retry");
      },
      onMissionUpdated(mission) {
        if (mission.status === "failed") coordinator.approve(mission.id);
        mission.steps.length = 0;
        throw new Error("Observer failed.");
      },
    });
    const proposal = await propose(coordinator, [step("Retryable")]);
    coordinator.approve(proposal.id);
    try {
      expect(await coordinator.waitForCompletion(proposal.id)).toMatchObject({ status: "failed", hopsUsed: 1 });
      const signal = await retryStarted.promise;
      const cancelled = coordinator.cancel(proposal.id);
      expect(signal.aborted).toBe(true);
      expect(cancelled).toMatchObject({ status: "cancelled", hopsUsed: 2, steps: [{ status: "skipped" }] });
      finishRetry.resolve();
      expect(await coordinator.waitForCompletion(proposal.id)).toEqual(cancelled);
    } finally {
      finishRetry.resolve();
    }
  });
});
