import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Provider, RoutingRule, RunDetail, RunEvent, RunInput, RunSummary } from "@ide/protocol";
import { migrateHistory } from "./history-migrations";

export type RunEventPayload =
  | { type: "text" | "thinking" | "tool"; text: string }
  | { type: "status"; run: RunSummary };

type StoredValue = { value: string };

export class History {
  private readonly db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "history.sqlite");
    closeSync(openSync(path, "a", 0o600));
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      migrateHistory(this.db);
      this.db.exec("PRAGMA journal_mode = WAL");
      for (const row of this.db.query<StoredValue, []>(
        "SELECT value FROM runs WHERE status = 'running'",
      ).all()) {
        const run = JSON.parse(row.value) as RunSummary;
        this.append(run.id, { type: "status", run: {
          ...run,
          status: "failed",
          finishedAt: Date.now(),
          error: "The orchestrator shut down before this run finished.",
        } });
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  create(run: RunSummary, input: RunInput, workspace: string | undefined) {
    return this.db.transaction(() => {
      this.db.run(
        "INSERT INTO runs (id, started_at, status, input, value) VALUES (?, ?, ?, ?, ?)",
        [run.id, run.startedAt, run.status, JSON.stringify(input), JSON.stringify(run)],
      );
      if (run.conversationId) {
        this.db.run("INSERT INTO conversation_runs (run_id, workspace, conversation_id) VALUES (?, ?, ?)",
          [run.id, workspace ?? "", run.conversationId]);
      }
      return this.append(run.id, { type: "status", run });
    })();
  }

  append(runId: string, payload: RunEventPayload): RunEvent {
    return this.db.transaction(() => {
      const row = this.db.query<{ seq: number }, [string]>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
      ).get(runId)!;
      const event = { ...payload, runId, seq: row.seq } satisfies RunEvent;
      this.db.run("INSERT INTO run_events (run_id, seq, value) VALUES (?, ?, ?)", [
        runId, event.seq, JSON.stringify(event),
      ]);
      if (payload.type === "status") {
        this.db.run("UPDATE runs SET status = ?, value = ? WHERE id = ?", [
          payload.run.status, JSON.stringify(payload.run), runId,
        ]);
      }
      return event;
    })();
  }

  raw(runId: string, providerId: string, line: string) {
    this.db.run("INSERT INTO raw_events (run_id, provider_id, line) VALUES (?, ?, ?)", [
      runId, providerId, line,
    ]);
  }

  summary(id: string): RunSummary | undefined {
    const row = this.db.query<StoredValue, [string]>("SELECT value FROM runs WHERE id = ?").get(id);
    return row && JSON.parse(row.value);
  }

  events(id: string, after = 0): RunEvent[] {
    return this.db.query<StoredValue, [string, number]>(
      "SELECT value FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq",
    ).all(id, after).map(({ value }) => JSON.parse(value));
  }

  get(id: string): RunDetail | undefined {
    const run = this.summary(id);
    return run && { run, events: this.events(id) };
  }

  list(limit: number): RunSummary[] {
    return this.db.query<StoredValue, [number]>(
      "SELECT value FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?",
    ).all(limit).map(({ value }) => JSON.parse(value));
  }

  hasActiveConversation(id: string, workspace: string | undefined): boolean {
    return this.db.query<{ run_id: string }, [string, string]>(`
      SELECT c.run_id FROM conversation_runs AS c JOIN runs AS r ON r.id = c.run_id
      WHERE c.workspace = ? AND c.conversation_id = ? AND r.status = 'running' LIMIT 1
    `).get(workspace ?? "", id) !== null;
  }

  conversation(id: string, workspace: string | undefined, limit: number, completedOnly = false): RunDetail[] {
    const rows = this.db.query<StoredValue, [string, string, number, number]>(`
      SELECT r.value FROM conversation_runs AS c JOIN runs AS r ON r.id = c.run_id
      WHERE c.workspace = ? AND c.conversation_id = ? AND (? = 0 OR r.status = 'succeeded')
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?
    `).all(workspace ?? "", id, completedOnly ? 1 : 0, limit);
    return rows.reverse().map(({ value }) => {
      const run = JSON.parse(value) as RunSummary;
      return { run, events: this.events(run.id) };
    });
  }

  rules(): RoutingRule[] {
    return this.setting("routingRules");
  }

  setRules(rules: RoutingRule[]): RoutingRule[] {
    this.saveSetting("routingRules", rules);
    return rules;
  }

  customProviders(): Provider[] {
    return this.setting("customProviders");
  }

  saveCustomProvider(provider: Provider) {
    const providers = this.customProviders();
    const index = providers.findIndex((item) => item.id === provider.id);
    if (index < 0) providers.push(provider);
    else providers[index] = provider;
    this.saveSetting("customProviders", providers);
  }

  removeCustomProvider(id: string): boolean {
    const providers = this.customProviders();
    const remaining = providers.filter((provider) => provider.id !== id);
    if (remaining.length === providers.length) return false;
    this.db.transaction(() => {
      this.saveSetting("customProviders", remaining);
      this.setRules(this.rules().filter((rule) => rule.providerId !== id));
    })();
    return true;
  }

  close() {
    this.db.close();
  }

  private setting<T>(key: string): T[] {
    const row = this.db.query<StoredValue, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : [];
  }

  private saveSetting<T>(key: string, value: T[]) {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, JSON.stringify(value)],
    );
  }
}
