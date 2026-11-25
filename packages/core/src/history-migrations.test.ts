import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, RoutingRule, RunEvent, RunSummary } from "@ide/protocol";
import { History } from "./history";

const legacySchema = `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, value TEXT NOT NULL
  );
  CREATE INDEX runs_started_at ON runs (started_at DESC);
  CREATE TABLE run_events (
    run_id TEXT NOT NULL REFERENCES runs (id), seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE raw_events (
    run_id TEXT NOT NULL REFERENCES runs (id), provider_id TEXT NOT NULL, line TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const legacyRun: RunSummary = {
  id: "legacy-run",
  providerId: "codex",
  status: "succeeded",
  prompt: "Synthetic legacy prompt",
  startedAt: 1,
  finishedAt: 3,
};
const interruptedRun: RunSummary = {
  id: "interrupted-run",
  providerId: "codex",
  status: "running",
  prompt: "Synthetic interrupted prompt",
  startedAt: 2,
};
const legacyEvent: RunEvent = { runId: legacyRun.id, seq: 1, type: "text", text: "Synthetic legacy response" };
const customProvider: Provider = {
  id: "custom-legacy", name: "Legacy CLI", kind: "cli", available: true, structured: false,
  terminal: true, command: "legacy-cli", terminalArgs: ["--synthetic"],
};
const rules: RoutingRule[] = [{ providerId: customProvider.id, tag: "synthetic" }];
const diskTestTimeoutMs = 30_000;

function withFixture(check: (dir: string, filepath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "uya-history-migrations-"));
  try {
    check(dir, join(dir, "history.sqlite"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedLegacy(db: Database) {
  // Commit the fixture once to avoid a disk sync per schema or seed statement.
  db.transaction(() => {
    db.exec(legacySchema);
    for (const run of [legacyRun, interruptedRun]) {
      db.run("INSERT INTO runs VALUES (?, ?, ?, ?, ?)", [
        run.id, run.startedAt, run.status, JSON.stringify({ prompt: run.prompt }), JSON.stringify(run),
      ]);
    }
    db.run("INSERT INTO run_events VALUES (?, ?, ?)", [legacyEvent.runId, legacyEvent.seq, JSON.stringify(legacyEvent)]);
    db.run("INSERT INTO raw_events VALUES (?, ?, ?)", [legacyRun.id, legacyRun.providerId, "synthetic raw frame"]);
    db.run("INSERT INTO settings VALUES (?, ?), (?, ?)", [
      "routingRules", JSON.stringify(rules), "customProviders", JSON.stringify([customProvider]),
    ]);
  })();
}

function readVersion(db: Database) {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
}

test("upgrades v0.1 history, preserves rows and settings, and reopens the same history", () => {
  withFixture((dir, filepath) => {
    {
      using db = new Database(filepath);
      seedLegacy(db);
      expect(readVersion(db)).toBe(0);
    }
    const newRun: RunSummary = {
      ...legacyRun,
      id: "conversation-run",
      startedAt: 4,
      finishedAt: 5,
      conversationId: "conversation",
    };
    const history = new History(dir);
    try {
      expect(history.get(legacyRun.id)).toEqual({ run: legacyRun, events: [legacyEvent] });
      expect(history.get(interruptedRun.id)?.run.status).toBe("failed");
      expect(history.get(interruptedRun.id)?.events.length).toBe(1);
      expect(history.rules()).toEqual(rules);
      expect(history.customProviders()).toEqual([customProvider]);
      history.create(newRun, { prompt: newRun.prompt, conversationId: newRun.conversationId }, "/synthetic/project");
    } finally {
      history.close();
    }
    const reopened = new History(dir);
    try {
      expect(reopened.conversation("conversation", "/synthetic/project", 10).map(({ run }) => run)).toEqual([newRun]);
      expect(reopened.conversation("conversation", "/synthetic/other", 10)).toEqual([]);
      expect(reopened.get(interruptedRun.id)?.events.length).toBe(1);
      expect(reopened.get(legacyRun.id)?.events).toEqual([legacyEvent]);
      using db = new Database(filepath, { readonly: true });
      expect(readVersion(db)).toBe(4);
      expect(db.query("SELECT line FROM raw_events").get()).toEqual({ line: "synthetic raw frame" });
    } finally {
      reopened.close();
    }
  });
}, diskTestTimeoutMs);

test("adopts an unversioned preview that already contains scoped conversation rows", () => {
  withFixture((dir, filepath) => {
    {
      using db = new Database(filepath);
      seedLegacy(db);
      db.exec(`
        CREATE TABLE conversation_runs (
          run_id TEXT PRIMARY KEY REFERENCES runs (id), workspace TEXT NOT NULL, conversation_id TEXT NOT NULL
        );
      `);
      db.run("INSERT INTO conversation_runs VALUES (?, ?, ?)", [legacyRun.id, "/synthetic/project", "legacy-thread"]);
    }
    const history = new History(dir);
    try {
      expect(history.conversation("legacy-thread", "/synthetic/project", 10)).toEqual([
        { run: legacyRun, events: [legacyEvent] },
      ]);
      using db = new Database(filepath, { readonly: true });
      expect(readVersion(db)).toBe(4);
    } finally {
      history.close();
    }
  });
});

test("upgrades v0.2.1 history and backfills searchable prompts and ordered text events", () => {
  withFixture((dir, filepath) => {
    {
      using db = new Database(filepath);
      seedLegacy(db);
      db.exec(`
        CREATE TABLE conversation_runs (
          run_id TEXT PRIMARY KEY REFERENCES runs (id), workspace TEXT NOT NULL, conversation_id TEXT NOT NULL
        );
        CREATE INDEX conversation_scope ON conversation_runs (workspace, conversation_id);
        PRAGMA user_version = 2;
      `);
      db.run("INSERT INTO conversation_runs VALUES (?, ?, ?)", [legacyRun.id, "/synthetic/project", "legacy-thread"]);
      const extra: RunEvent[] = [
        { runId: legacyRun.id, seq: 4, type: "text", text: "fill" },
        { runId: legacyRun.id, seq: 3, type: "text", text: " back" },
        { runId: legacyRun.id, seq: 2, type: "thinking", text: "unsearchable" },
      ];
      for (const event of extra) {
        db.run("INSERT INTO run_events VALUES (?, ?, ?)", [event.runId, event.seq, JSON.stringify(event)]);
      }
    }
    const history = new History(dir);
    try {
      expect(history.list(10, { query: "legacy prompt" })).toEqual([legacyRun]);
      expect(history.list(10, { query: "response backfill", workspacePath: "/synthetic/project" })).toEqual([legacyRun]);
      expect(history.list(10, { query: "unsearchable" })).toEqual([]);
      expect(history.conversations(10, { query: "backfill" }).map(({ id }) => id)).toEqual(["legacy-thread"]);
      using db = new Database(filepath, { readonly: true });
      expect(readVersion(db)).toBe(4);
      expect(db.query("SELECT run_id, prompt, response FROM run_search ORDER BY run_id").all()).toEqual([
        { run_id: interruptedRun.id, prompt: interruptedRun.prompt, response: "" },
        { run_id: legacyRun.id, prompt: legacyRun.prompt, response: "Synthetic legacy response backfill" },
      ]);
    } finally {
      history.close();
    }
  });
});

test("refuses newer and unsupported versions before changing history or journal mode", () => {
  for (const [version, code] of [[99, "history_schema_newer"], [-1, "history_schema_unsupported"]] as const) {
    withFixture((dir, filepath) => {
      {
        using db = new Database(filepath);
        seedLegacy(db);
        db.exec(`PRAGMA user_version = ${version}`);
      }
      expect(() => new History(dir)).toThrow(expect.objectContaining({ code }));
      using db = new Database(filepath);
      expect(readVersion(db)).toBe(version);
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(db.query("SELECT status FROM runs WHERE id = ?").get(interruptedRun.id)).toEqual({ status: "running" });
      expect(db.query("SELECT name FROM sqlite_schema WHERE name = 'conversation_runs'").get()).toBeNull();
    });
  }
}, diskTestTimeoutMs);

test("rolls back schema changes and the version when a later migration fails", () => {
  withFixture((dir, filepath) => {
    {
      using db = new Database(filepath);
      db.exec("CREATE TABLE conversation_runs (run_id TEXT PRIMARY KEY)");
    }
    expect(() => new History(dir)).toThrow("Uya could not upgrade the local run history database.");
    using db = new Database(filepath);
    expect(readVersion(db)).toBe(0);
    expect(db.query("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([{ name: "conversation_runs" }]);
  });
});
