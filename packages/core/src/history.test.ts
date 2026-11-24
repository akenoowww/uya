import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSummary } from "@ide/protocol";
import { History } from "./history";

const project = "/synthetic/project";
const otherProject = "/synthetic/other";

function withHistory(check: (history: History, filepath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "uya-history-"));
  try {
    const history = new History(dir);
    try {
      check(history, join(dir, "history.sqlite"));
    } finally {
      history.close();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function addRun(history: History, fields: Partial<RunSummary> & { id: string }, workspace?: string): RunSummary {
  const run: RunSummary = { providerId: "fixture", prompt: "Synthetic prompt", status: "succeeded", startedAt: 1, ...fields };
  history.create(run, { prompt: run.prompt, conversationId: run.conversationId, broadcastGroupId: run.broadcastGroupId }, workspace);
  return run;
}

test("searches prompts immediately and indexes completed response chunks in sequence", () => {
  withHistory((history) => {
    const run = addRun(history, {
      id: "cafe", conversationId: "discussion", prompt: "Café optimization", status: "running", startedAt: 3,
    }, project);
    const unscoped = addRun(history, {
      id: "no-workspace", conversationId: "discussion", prompt: "Optimization elsewhere", startedAt: 4,
    });
    const noConversation = addRun(history, { id: "standalone", prompt: "Standalone optimization", startedAt: 2 });

    expect(history.list(1)).toEqual([unscoped]);
    expect(history.list(10, { query: "  " })).toEqual([unscoped, run, noConversation]);
    expect(history.list(10, { query: '  "CAFE"*: (opti)  ' })).toEqual([run]);
    expect(history.list(10, { query: "opti", workspacePath: project })).toEqual([run]);
    expect(history.list(10, { query: "opti", workspacePath: null })).toEqual([unscoped]);
    expect(history.list(10, { query: "optimization OR elsewhere" })).toEqual([]);

    history.append(run.id, { type: "text", text: "An implemen" });
    history.append(run.id, { type: "thinking", text: "private thought" });
    history.append(run.id, { type: "tool", text: "tool output" });
    history.append(run.id, { type: "text", text: "tation with literal %_\\ tokens" });
    expect(history.list(10, { query: "implementation" })).toEqual([]);
    const completed: RunSummary = { ...run, status: "succeeded", finishedAt: 5 };
    history.append(run.id, { type: "status", run: completed });
    history.append(run.id, { type: "status", run: completed });
    expect(history.list(10, { query: "implemen cafe" })).toEqual([completed]);
    for (const query of ["%", "_", "\\", "%_\\"]) {
      expect(history.list(10, { query })).toEqual([completed]);
    }
    for (const query of ["*", '"', "):-", "private thought", "tool output"]) {
      expect(history.list(10, { query })).toEqual([]);
    }
  });
});

test("summarizes complete conversations by workspace and filters by any matching turn", () => {
  withHistory((history) => {
    const id = "shared-id";
    addRun(history, { id: "first", conversationId: id, prompt: "  Plan\n   the migration  ", startedAt: 1 }, project);
    addRun(history, {
      id: "latest", conversationId: id, providerId: "next", providerName: "Next Provider", prompt: "Continue",
      model: "fixture-model", effort: "high", status: "failed", startedAt: 3,
    }, project);
    addRun(history, {
      id: "other", conversationId: id, prompt: `${"a".repeat(78)}😀 with more text`, startedAt: 2,
    }, otherProject);
    addRun(history, { id: "global", conversationId: id, prompt: "Global planning", startedAt: 4 });
    addRun(history, { id: "unmapped", prompt: "Migration", startedAt: 5 }, project);

    expect(history.conversations(10).map(({ workspacePath }) => workspacePath)).toEqual([null, project, otherProject]);
    expect(history.conversations(1).map(({ title }) => title)).toEqual(["Global planning"]);
    expect(history.conversations(10, { workspacePath: null }).map(({ title }) => title)).toEqual(["Global planning"]);
    expect(history.conversations(10, { workspacePath: otherProject }).map(({ title }) => title)).toEqual([`${"a".repeat(78)}…`]);
    expect(history.conversations(10, { query: "migrat" })).toEqual([{
      id, workspacePath: project, title: "Plan the migration", providerId: "next", providerName: "Next Provider",
      model: "fixture-model", effort: "high", turnCount: 2, lastRunAt: 3, lastStatus: "failed",
    }]);
    expect(history.conversations(10, { query: "migrat", workspacePath: otherProject })).toEqual([]);
    expect(history.conversations(10, { query: "?*" })).toEqual([]);
  });
});

test("forks through the selected run and rewrites run IDs in persisted events", () => {
  withHistory((history, filepath) => {
    const conversationId = "source";
    const later = addRun(history, { id: "later", conversationId, startedAt: 30 }, project);
    const first = addRun(history, { id: "first", conversationId, broadcastGroupId: "broadcast", startedAt: 10 }, project);
    const second = addRun(history, { id: "second", conversationId, status: "running", startedAt: 20 }, project);
    const other = addRun(history, { id: "other", conversationId, startedAt: 5 }, otherProject);
    history.append(second.id, { type: "text", text: "Forkable response" });
    history.append(second.id, { type: "status", run: { ...second, status: "succeeded", finishedAt: 21 } });
    history.raw(second.id, second.providerId, "synthetic raw response");

    expect(() => history.forkConversation(conversationId, undefined)).toThrow(expect.objectContaining({ code: -32004 }));
    expect(() => history.forkConversation(conversationId, project, other.id)).toThrow(expect.objectContaining({ code: -32004 }));
    expect(history.list(10)).toHaveLength(4);

    const fork = history.forkConversation(conversationId, project, second.id);
    expect(fork.conversationId).toMatch(/^[a-f0-9]{32}$/);
    expect(fork.runs).toHaveLength(2);
    for (const [index, original] of [first, second].entries()) {
      const copy = fork.runs[index]!;
      expect(copy.run.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(copy.run.id).not.toBe(original.id);
      expect(copy.run).toEqual({ ...history.summary(original.id)!, id: copy.run.id, conversationId: fork.conversationId });
      expect(copy.events).toEqual(history.events(original.id).map((event) => event.type === "status"
        ? { ...event, runId: copy.run.id, run: { ...event.run, id: copy.run.id, conversationId: fork.conversationId } }
        : { ...event, runId: copy.run.id }));
    }
    expect(history.conversation(fork.conversationId, project, 10)).toEqual(fork.runs);
    expect(history.conversation(fork.conversationId, otherProject, 10)).toEqual([]);
    expect(history.conversation(conversationId, project, 10).map(({ run }) => run.id)).toEqual([first.id, second.id, later.id]);
    expect(history.list(10, { query: "forkable response" }).map(({ id }) => id)).toEqual([fork.runs[1]!.run.id, second.id]);

    using db = new Database(filepath, { readonly: true });
    const firstCloneId = fork.runs[0]!.run.id;
    expect(db.query("SELECT group_id FROM broadcast_runs WHERE run_id = ?").get(firstCloneId)).toEqual({ group_id: "broadcast" });
    expect(db.query("SELECT json_extract(input, '$.conversationId') AS conversationId FROM runs WHERE id = ?").get(firstCloneId))
      .toEqual({ conversationId: fork.conversationId });
    expect(db.query("SELECT run_id FROM raw_events").all()).toEqual([{ run_id: second.id }]);
  });
});

test("forks a running turn as a searchable snapshot and leaves the source running", () => {
  withHistory((history) => {
    const run = addRun(history, { id: "live", conversationId: "live-thread", status: "running" });
    history.append(run.id, { type: "text", text: "Captured progress" });

    const fork = history.forkConversation("live-thread", undefined);
    const copy = fork.runs[0]!;
    expect(copy.run.status).toBe("cancelled");
    expect(copy.events.map(({ type }) => type)).toEqual(["status", "text", "status"]);
    expect(history.hasActiveConversation(fork.conversationId, undefined)).toBe(false);
    expect(history.hasActiveConversation("live-thread", undefined)).toBe(true);
    expect(history.list(10, { query: "progress" })).toEqual([copy.run]);
  });
});

test("deletes runs, their related rows, and only the requested workspace's conversation", () => {
  withHistory((history, filepath) => {
    const conversationId = "thread";
    const broadcastGroupId = "broadcast";
    const first = addRun(history, { id: "first", conversationId, broadcastGroupId, prompt: "Remove one" }, project);
    const second = addRun(history, { id: "second", conversationId, broadcastGroupId, prompt: "Remove conversation" }, project);
    const third = addRun(history, { id: "third", conversationId, broadcastGroupId, prompt: "Remove conversation too" }, project);
    const other = addRun(history, { id: "other", conversationId, broadcastGroupId, prompt: "Keep this" }, otherProject);
    for (const run of [first, second, third, other]) history.raw(run.id, run.providerId, "fixture raw frame");

    expect(history.deleteRun(first.id)).toBe(true);
    expect(history.deleteRun(first.id)).toBe(false);
    expect(history.get(first.id)).toBeUndefined();
    expect(history.list(10, { query: "remove one" })).toEqual([]);
    expect(history.conversation(conversationId, project, 10).map(({ run }) => run)).toEqual([second, third]);
    expect(history.deleteConversation(conversationId, undefined)).toBe(false);
    expect(history.deleteConversation(conversationId, project)).toBe(true);
    expect(history.deleteConversation(conversationId, project)).toBe(false);
    expect(history.conversations(10).map(({ workspacePath }) => workspacePath)).toEqual([otherProject]);
    expect(history.list(10)).toEqual([other]);

    using db = new Database(filepath, { readonly: true });
    for (const table of ["run_events", "raw_events", "conversation_runs", "broadcast_runs", "run_search"]) {
      expect(db.query(`SELECT run_id FROM ${table}`).all()).toEqual([{ run_id: other.id }]);
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

test("rolls back conversation deletion when deleting a run fails", () => {
  withHistory((history, filepath) => {
    const first = addRun(history, { id: "first", conversationId: "atomic", prompt: "Fixture atomic" }, project);
    const second = addRun(history, { id: "second", conversationId: "atomic", prompt: "Fixture atomic" }, project);
    using db = new Database(filepath);
    db.exec(`
      CREATE TRIGGER fixture_prevent_delete BEFORE DELETE ON runs
      WHEN OLD.id = 'second' BEGIN SELECT RAISE(ABORT, 'fixture deletion blocked'); END;
    `);
    expect(() => history.deleteConversation("atomic", project)).toThrow("fixture deletion blocked");
    expect(history.conversation("atomic", project, 10).map(({ run }) => run)).toEqual([first, second]);
    expect(history.events(first.id)).toHaveLength(1);
    expect(history.list(10, { query: "atomic" })).toEqual([second, first]);
  });
});

test("aggregates usage by provider over the requested window", () => {
  withHistory((history) => {
    const now = Date.now();
    const day = 86_400_000;
    addRun(history, {
      id: "success", providerId: "alpha", providerName: "Alpha", startedAt: now - day, ttftMs: 0,
      effort: "high", inputTokens: 13, outputTokens: 5,
    });
    addRun(history, {
      id: "failure", providerId: "alpha", providerName: "Old Alpha", startedAt: now - 2 * day,
      status: "failed", ttftMs: 9, effort: "low", inputTokens: 3,
    });
    addRun(history, { id: "cancelled", providerId: "alpha", startedAt: now, status: "cancelled", effort: "high" });
    addRun(history, { id: "no-metrics", providerId: "beta", startedAt: now - 10 * day });
    addRun(history, { id: "outside-window", providerId: "alpha", startedAt: now - 31 * day, ttftMs: 1000 });

    const alpha = {
      providerId: "alpha", providerName: "Alpha", runs: 3, succeeded: 1, failed: 1,
      avgTtftMs: 5, inputTokens: 16, outputTokens: 5, efforts: { high: 2, low: 1 },
    };
    expect(history.usage()).toEqual({
      days: 30, totalRuns: 4, byProvider: [alpha, {
        providerId: "beta", providerName: "beta", runs: 1, succeeded: 1, failed: 0,
        inputTokens: 0, outputTokens: 0, efforts: {},
      }],
    });
    expect(history.usage(7)).toEqual({ days: 7, totalRuns: 3, byProvider: [alpha] });
  });
});
