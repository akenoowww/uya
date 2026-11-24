import type { Database } from "bun:sqlite";

// Keep earlier migrations immutable so unversioned installs can adopt them in order.
const migrations = [
  `
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at DESC);
    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL REFERENCES runs (id),
      seq INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS raw_events (
      run_id TEXT NOT NULL REFERENCES runs (id),
      provider_id TEXT NOT NULL,
      line TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    SELECT id, started_at, status, input, value FROM runs LIMIT 0;
    SELECT run_id, seq, value FROM run_events LIMIT 0;
    SELECT run_id, provider_id, line FROM raw_events LIMIT 0;
    SELECT key, value FROM settings LIMIT 0;
  `,
  `
    CREATE TABLE IF NOT EXISTS conversation_runs (
      run_id TEXT PRIMARY KEY REFERENCES runs (id),
      workspace TEXT NOT NULL,
      conversation_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_scope ON conversation_runs (workspace, conversation_id);
    SELECT run_id, workspace, conversation_id FROM conversation_runs LIMIT 0;
  `,
  `
    CREATE TABLE IF NOT EXISTS broadcast_runs (
      run_id TEXT PRIMARY KEY REFERENCES runs (id),
      group_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS broadcast_group_idx ON broadcast_runs (group_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS run_search USING fts5(run_id UNINDEXED, prompt, response);
    DELETE FROM run_search;
    INSERT INTO run_search (run_id, prompt, response)
    SELECT r.id, COALESCE(json_extract(r.value, '$.prompt'), ''), COALESCE((
      SELECT group_concat(text, '') FROM (
        SELECT json_extract(e.value, '$.text') AS text FROM run_events AS e
        WHERE e.run_id = r.id AND json_extract(e.value, '$.type') = 'text'
        ORDER BY e.seq
      )
    ), '') FROM runs AS r;
  `,
] as const;

const errorMessages = {
  history_schema_newer: "The local run history was created by a newer Uya. Update Uya to open it.",
  history_schema_unsupported: "This Uya version does not support the local run history schema.",
  history_schema_migration_failed: "Uya could not upgrade the local run history database.",
} as const;

export class HistorySchemaError extends Error {
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
    this.name = "HistorySchemaError";
  }
}

function version(db: Database): number {
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  if (current === undefined || !Number.isSafeInteger(current) || current < 0) {
    throw new HistorySchemaError("history_schema_unsupported");
  }
  if (current > migrations.length) throw new HistorySchemaError("history_schema_newer");
  return current;
}

export function migrateHistory(db: Database) {
  try {
    if (version(db) === migrations.length) return;

    db.transaction(() => {
      // Recheck under the write lock in case another connection migrated first.
      const current = version(db);
      for (const [index, migration] of migrations.entries()) {
        if (index < current) continue;
        db.exec(migration);
        db.exec(`PRAGMA user_version = ${index + 1}`);
      }
    }).immediate();
  } catch (error) {
    if (error instanceof HistorySchemaError) throw error;
    throw new HistorySchemaError("history_schema_migration_failed");
  }
}
