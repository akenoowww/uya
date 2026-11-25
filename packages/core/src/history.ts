import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type {
  ApprovalDecision, ApprovalRequest, ArenaSummary, CheckpointSummary, ConversationSummary,
  ExecutionMode, Provider, ProviderUsageStats,
  RoutingRule, RunDetail, RunEvent, RunInput, RunSummary, ToolMeta, UsageStats,
} from "@ide/protocol";
import { migrateHistory } from "./history-migrations";
import { RpcError } from "./validation";

export type RunEventPayload =
  | { type: "text" | "thinking"; text: string }
  | { type: "tool"; text: string; meta?: ToolMeta }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; requestId: string; decision: ApprovalDecision }
  | { type: "status"; run: RunSummary };

type StoredValue = { value: string };
type HistoryFilters = { query?: string; workspacePath?: string | null };
type StoredConversation = StoredValue & {
  conversation_id: string;
  workspace: string;
  first_prompt: string;
  turn_count: number;
};
export type StoredCheckpoint = { summary: CheckpointSummary; metadata: string };
type CheckpointSummaryRow = {
  id: string;
  workspace: string;
  run_id: string | null;
  created_at: number;
  restored_at: number | null;
  label: string;
  files_count: number;
};
type CheckpointRow = CheckpointSummaryRow & { metadata: string };
type UsageTotals = Omit<ProviderUsageStats, "providerName" | "avgTtftMs" | "cachedInputTokens" | "estimatedCostUsd"> & {
  providerName?: string;
  cachedInputTokens: number;
  estimatedCostUsd: number;
  ttftSum: number;
  ttftCount: number;
};
const CONVERSATION_TITLE_LIMIT = 80;

type TokenRates = readonly [input: number, cachedInput: number, output: number];
type ReferenceRates = { fallback: TokenRates; models: readonly (readonly [RegExp, TokenRates])[] };

// Standard text API reference rates in USD per million tokens. Subscriptions,
// cache storage, and varying region or context tiers are outside this estimate.
const openAiRates: ReferenceRates = {
  fallback: [1.25, 0.125, 10],
  models: [
    [/^gpt-6\.2-astra(?:-|$)/u, [8, 0.4, 40]],
    [/^gpt-6-astra(?:-|$)/u, [10, 1, 50]],
    [/^gpt-6\.[12]-sol(?:-|$)/u, [2, 0.1, 10]],
    [/^gpt-6-sol(?:-|$)/u, [2, 0.2, 10]],
    [/^gpt-5\.(?:5|6(?:-sol)?)(?:-\d{4}-\d{2}-\d{2})?$/u, [5, 0.5, 30]],
    [/^gpt-5(?:\.1-codex)?-mini(?:-|$)/u, [0.25, 0.025, 2]],
    [/^gpt-5-nano(?:-|$)/u, [0.05, 0.005, 0.4]],
    [/^gpt-5\.2(?:-|$)/u, [1.75, 0.175, 14]],
    [/^gpt-5\.4-mini(?:-|$)/u, [0.75, 0.075, 4.5]],
    [/^gpt-5\.4(?:-|$)/u, [2.5, 0.25, 15]],
    [/^gpt-4\.1-mini(?:-|$)/u, [0.4, 0.1, 1.6]],
    [/^gpt-4\.1(?:-|$)/u, [2, 0.5, 8]],
  ],
};
const claudeRates: ReferenceRates = {
  fallback: [3, 0.3, 15],
  models: [
    [/\bopus-4(?:-1)?(?:-\d{8})?$/u, [15, 1.5, 75]],
    [/\bopus\b/u, [5, 0.5, 25]],
    [/\bhaiku\b/u, [1, 0.1, 5]],
  ],
};
const geminiRates: ReferenceRates = {
  fallback: [0.3, 0.03, 2.5],
  models: [
    [/^gemini-2\.5-pro(?:-|$)/u, [1.25, 0.125, 10]],
    [/^gemini-3(?:\.\d+)?-pro(?:-|$)/u, [2, 0.2, 12]],
    [/\bflash-lite\b/u, [0.1, 0.01, 0.4]],
    [/^gemini-3\.8-flash(?:-|$)/u, [1.5, 0.15, 7.5]],
    [/^gemini-3\.5-flash(?:-|$)/u, [1.5, 0.15, 9]],
    [/^gemini-3(?:\.\d+)?-flash(?:-|$)/u, [0.5, 0.05, 3]],
  ],
};
const qwenRates: ReferenceRates = {
  fallback: [0.4, 0.08, 1.2],
  models: [
    [/^qwen3-coder-flash(?:-|$)/u, [0.144, 0.0288, 0.574]],
    [/^qwen3-coder-plus(?:-|$)/u, [1, 0.2, 5]],
  ],
};
const providerRates = new Map<string, ReferenceRates>([
  ["codex", openAiRates], ["openai", openAiRates],
  ["claude", claudeRates], ["anthropic", claudeRates],
  ["gemini", geminiRates], ["gemini-api", geminiRates], ["google", geminiRates], ["antigravity", geminiRates],
  ["qwen", qwenRates],
]);

function validTokenCount(count: number | undefined): number | undefined {
  return count !== undefined && Number.isFinite(count) && count >= 0 ? count : undefined;
}

export function estimateRunCostUsd(
  providerId: string, model: string | undefined, inputTokens?: number, cachedInputTokens?: number, outputTokens?: number,
): number | undefined {
  const id = providerId.toLowerCase();
  const modelId = model?.trim().toLowerCase().split("/").at(-1)?.replace(/[ _]+/gu, "-") ?? "";
  const reference = id === "antigravity" && modelId.includes("claude") ? claudeRates : providerRates.get(id);
  if (!reference) return undefined;
  const input = validTokenCount(inputTokens);
  const cached = validTokenCount(cachedInputTokens);
  const output = validTokenCount(outputTokens);
  if (input === undefined && cached === undefined && output === undefined) return undefined;

  const [inputRate, cachedRate, outputRate] = reference.models.find(([pattern]) => pattern.test(modelId))?.[1]
    ?? reference.fallback;
  // Claude reports uncached input and cache reads as separate counters.
  const separateCache = id === "claude" || id === "anthropic";
  const totalInput = input ?? cached ?? 0;
  const cacheHit = separateCache ? cached ?? 0 : Math.min(totalInput, cached ?? 0);
  const uncachedInput = separateCache ? input ?? 0 : totalInput - cacheHit;
  return (uncachedInput * inputRate + cacheHit * cachedRate + (output ?? 0) * outputRate) / 1_000_000;
}

function checkpointSummary(row: CheckpointSummaryRow): CheckpointSummary {
  return {
    id: row.id, workspacePath: row.workspace, createdAt: row.created_at, label: row.label, filesCount: row.files_count,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.restored_at === null ? {} : { restoredAt: row.restored_at }),
  };
}

function storedCheckpoint(row: CheckpointRow): StoredCheckpoint {
  return { summary: checkpointSummary(row), metadata: row.metadata };
}

function usageSummary({
  providerName, ttftSum, ttftCount, cachedInputTokens, estimatedCostUsd, ...stats
}: UsageTotals): ProviderUsageStats {
  const cost = Number(estimatedCostUsd.toFixed(4));
  return {
    ...stats, providerName: providerName ?? stats.providerId,
    ...(ttftCount > 0 ? { avgTtftMs: Math.round(ttftSum / ttftCount) } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cost > 0 ? { estimatedCostUsd: cost } : {}),
  };
}

function runSearch(query: string | undefined) {
  const search = query?.trim();
  if (!search) return undefined;
  const tokens = search.match(/[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{M}\p{Co}]*/gu);
  if (tokens) {
    return { where: "run_search MATCH ?", bindings: [tokens.map((token) => `"${token}"*`).join(" ")] };
  }
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  return {
    where: "(run_search.prompt LIKE ? ESCAPE '\\' OR run_search.response LIKE ? ESCAPE '\\')",
    bindings: [pattern, pattern],
  };
}

function conversationTitle(prompt: string): string {
  const title = prompt.trim().replace(/\s+/gu, " ");
  if (title.length <= CONVERSATION_TITLE_LIMIT) return title;
  const clipped = title.slice(0, CONVERSATION_TITLE_LIMIT - 1).replace(/[\uD800-\uDBFF]$/u, "").trimEnd();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= CONVERSATION_TITLE_LIMIT / 2 && title[clipped.length] !== " ") {
    return `${clipped.slice(0, lastSpace)}…`;
  }
  return `${clipped}…`;
}

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
      this.insertRun(run, input, workspace);
      this.db.run(
        "INSERT INTO run_search (run_id, prompt, response) VALUES (?, ?, '')", [run.id, run.prompt],
      );
      return this.append(run.id, { type: "status", run });
    })();
  }

  append(runId: string, payload: RunEventPayload): RunEvent {
    return this.db.transaction(() => {
      const row = this.db.query<{ seq: number }, [string]>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
      ).get(runId)!;
      const event = { ...payload, runId, seq: row.seq } satisfies RunEvent;
      this.insertEvent(event);
      if (payload.type === "status") {
        this.db.run("UPDATE runs SET status = ?, value = ? WHERE id = ?", [
          payload.run.status, JSON.stringify(payload.run), runId,
        ]);
        if (payload.run.status !== "running") this.refreshRunSearch(runId, payload.run.prompt);
      }
      return event;
    }).immediate();
  }

  raw(runId: string, providerId: string, line: string) {
    this.db.run("INSERT INTO raw_events (run_id, provider_id, line) VALUES (?, ?, ?)", [
      runId, providerId, line,
    ]);
  }

  summary(id: string): RunSummary | undefined {
    const row = this.db.query<StoredValue, [string]>("SELECT value FROM runs WHERE id = ?").get(id);
    return row ? JSON.parse(row.value) : undefined;
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

  list(limit: number, options?: HistoryFilters): RunSummary[] {
    const workspace = options?.workspacePath;
    const scoped = workspace !== undefined;
    const search = runSearch(options?.query);
    return this.db.query<StoredValue, (string | number)[]>(`
      SELECT r.value FROM runs AS r
      ${scoped ? "JOIN conversation_runs AS c ON c.run_id = r.id" : ""}
      ${search ? "JOIN run_search ON run_search.run_id = r.id" : ""}
      WHERE ${scoped ? "c.workspace = ?" : "1"} ${search ? `AND ${search.where}` : ""}
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?
    `).all(...(scoped ? [workspace ?? ""] : []), ...(search?.bindings ?? []), limit)
      .map(({ value }) => JSON.parse(value));
  }

  conversations(limit: number, options?: HistoryFilters): ConversationSummary[] {
    const workspace = options?.workspacePath;
    const scoped = workspace !== undefined;
    const search = runSearch(options?.query);
    const rows = this.db.query<StoredConversation, (string | number)[]>(`
      WITH turns AS (
        SELECT c.conversation_id, c.workspace, r.started_at, r.rowid AS run_rowid,
          FIRST_VALUE(r.rowid) OVER chronological AS first_run_rowid,
          ROW_NUMBER() OVER chronological AS turn,
          COUNT(*) OVER (PARTITION BY c.workspace, c.conversation_id) AS turn_count
        FROM conversation_runs AS c JOIN runs AS r ON r.id = c.run_id
        WHERE ${scoped ? "c.workspace = ?" : "1"}
        ${search ? `AND (c.workspace, c.conversation_id) IN (
          SELECT matched.workspace, matched.conversation_id FROM run_search
          JOIN conversation_runs AS matched ON matched.run_id = run_search.run_id
          WHERE ${search.where}
        )` : ""}
        WINDOW chronological AS (PARTITION BY c.workspace, c.conversation_id ORDER BY r.started_at, r.rowid)
      )
      SELECT t.conversation_id, t.workspace, t.turn_count, latest.value,
        COALESCE(json_extract(first.value, '$.prompt'), '') AS first_prompt
      FROM turns AS t
      JOIN runs AS first ON first.rowid = t.first_run_rowid
      JOIN runs AS latest ON latest.rowid = t.run_rowid
      WHERE t.turn = t.turn_count
      ORDER BY t.started_at DESC, t.run_rowid DESC LIMIT ?
    `).all(...(scoped ? [workspace ?? ""] : []), ...(search?.bindings ?? []), limit);

    return rows.map((row) => {
      const run = JSON.parse(row.value) as RunSummary;
      return {
        id: row.conversation_id,
        workspacePath: row.workspace || null,
        title: conversationTitle(row.first_prompt),
        providerId: run.providerId,
        providerName: run.providerName,
        model: run.model,
        effort: run.effort,
        turnCount: row.turn_count,
        lastRunAt: run.startedAt,
        lastStatus: run.status,
      };
    });
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

  forkConversation(sourceConversationId: string, workspace: string | undefined, upToRunId?: string): {
    conversationId: string; runs: RunDetail[];
  } {
    return this.db.transaction(() => {
      const rows = this.db.query<StoredValue & { id: string; input: string }, [string, string]>(`
        SELECT r.id, r.input, r.value FROM conversation_runs AS c JOIN runs AS r ON r.id = c.run_id
        WHERE c.workspace = ? AND c.conversation_id = ?
        ORDER BY r.started_at, r.rowid
      `).all(workspace ?? "", sourceConversationId);
      if (rows.length === 0) throw new RpcError(-32004, "Conversation not found.");
      const end = upToRunId === undefined ? rows.length : rows.findIndex((row) => row.id === upToRunId) + 1;
      if (end === 0) throw new RpcError(-32004, "Run not found in this conversation.");

      const conversationId = crypto.randomUUID().replaceAll("-", "");
      const runs = rows.slice(0, end).map(({ id, input, value }) => {
        const source = JSON.parse(value) as RunSummary;
        const sourceInput = JSON.parse(input) as RunInput;
        const run: RunSummary = { ...source, id: crypto.randomUUID(), conversationId };
        this.insertRun(run, { ...sourceInput, conversationId }, workspace);
        const events = this.events(id).map((event): RunEvent => event.type === "status"
          ? { ...event, runId: run.id, run: { ...event.run, id: run.id, conversationId } }
          : { ...event, runId: run.id });
        for (const event of events) this.insertEvent(event);
        if (run.status === "running") {
          // A fork has the source events captured so far and no provider executing that turn.
          const snapshot: RunSummary = { ...run, status: "cancelled", finishedAt: Date.now() };
          events.push(this.append(run.id, { type: "status", run: snapshot }));
          return { run: snapshot, events };
        }
        this.refreshRunSearch(run.id, run.prompt);
        return { run, events };
      });
      return { conversationId, runs };
    }).immediate();
  }

  deleteRun(id: string): boolean {
    return this.db.transaction(() => this.deleteRuns([id])).immediate();
  }

  deleteConversation(id: string, workspace: string | undefined): boolean {
    return this.db.transaction(() => {
      const rows = this.db.query<{ run_id: string }, [string, string]>(
        "SELECT run_id FROM conversation_runs WHERE workspace = ? AND conversation_id = ?",
      ).all(workspace ?? "", id);
      this.clearProviderSessions(workspace, id);
      return rows.length > 0 && this.deleteRuns(rows.map(({ run_id }) => run_id));
    }).immediate();
  }

  getProviderSession(
    workspace: string | undefined, conversationId: string, providerId: string, accessMode: ExecutionMode,
  ): string | undefined {
    return this.db.query<{ session_id: string }, [string, string, string, ExecutionMode]>(`
      SELECT session_id FROM provider_sessions
      WHERE workspace = ? AND conversation_id = ? AND provider_id = ? AND access_mode = ?
    `).get(workspace ?? "", conversationId, providerId, accessMode)?.session_id;
  }

  saveProviderSession(
    workspace: string | undefined, conversationId: string, providerId: string, accessMode: ExecutionMode, sessionId: string,
  ): void {
    this.db.run(`
      INSERT INTO provider_sessions (workspace, conversation_id, provider_id, access_mode, session_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace, conversation_id, provider_id, access_mode) DO UPDATE SET
        session_id = excluded.session_id, updated_at = excluded.updated_at
    `, [workspace ?? "", conversationId, providerId, accessMode, sessionId, Date.now()]);
  }

  clearProviderSessions(workspace: string | undefined, conversationId: string): void {
    this.db.run("DELETE FROM provider_sessions WHERE workspace = ? AND conversation_id = ?", [
      workspace ?? "", conversationId,
    ]);
  }

  saveCheckpoint({ summary, metadata }: StoredCheckpoint): void {
    this.db.run(`
      INSERT INTO checkpoints (id, workspace, run_id, created_at, restored_at, label, files_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET workspace = excluded.workspace, run_id = excluded.run_id,
        created_at = excluded.created_at, restored_at = excluded.restored_at, label = excluded.label,
        files_count = excluded.files_count, metadata = excluded.metadata
    `, [
      summary.id, summary.workspacePath, summary.runId ?? null, summary.createdAt, summary.restoredAt ?? null,
      summary.label, summary.filesCount, metadata,
    ]);
  }

  getCheckpoint(id: string): StoredCheckpoint | undefined {
    const row = this.db.query<CheckpointRow, [string]>("SELECT * FROM checkpoints WHERE id = ?").get(id);
    return row ? storedCheckpoint(row) : undefined;
  }

  listCheckpoints(workspace: string, limit = 20): CheckpointSummary[] {
    return this.db.query<CheckpointSummaryRow, [string, number]>(`
      SELECT id, workspace, run_id, created_at, restored_at, label, files_count FROM checkpoints
      WHERE workspace = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(workspace, limit).map(checkpointSummary);
  }

  markCheckpointRestored(id: string, restoredAt: number): void {
    this.db.run("UPDATE checkpoints SET restored_at = ? WHERE id = ?", [restoredAt, id]);
  }

  deleteOldCheckpoints(workspace: string, keep: number): StoredCheckpoint[] {
    if (!Number.isSafeInteger(keep) || keep < 0) throw new RangeError("Keep must be a nonnegative integer.");
    return this.db.transaction(() => {
      const rows = this.db.query<CheckpointRow, [string, number]>(`
        SELECT * FROM checkpoints WHERE workspace = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      `).all(workspace, keep);
      if (rows.length > 0) {
        this.db.run("DELETE FROM checkpoints WHERE id IN (SELECT value FROM json_each(?))", [
          JSON.stringify(rows.map(({ id }) => id)),
        ]);
      }
      return rows.map(storedCheckpoint);
    }).immediate();
  }

  saveArena(arena: ArenaSummary): void {
    this.db.run(`
      INSERT INTO arenas (id, workspace, created_at, status, value) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET workspace = excluded.workspace, created_at = excluded.created_at,
        status = excluded.status, value = excluded.value
    `, [arena.id, arena.workspacePath, arena.createdAt, arena.status, JSON.stringify(arena)]);
  }

  getArena(id: string): ArenaSummary | undefined {
    const row = this.db.query<StoredValue, [string]>("SELECT value FROM arenas WHERE id = ?").get(id);
    return row ? JSON.parse(row.value) as ArenaSummary : undefined;
  }

  listArenas(workspacePath?: string, limit = 20): ArenaSummary[] {
    return this.db.query<StoredValue, (string | number)[]>(`
      SELECT value FROM arenas ${workspacePath === undefined ? "" : "WHERE workspace = ?"}
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...(workspacePath === undefined ? [] : [workspacePath]), limit)
      .map(({ value }) => JSON.parse(value) as ArenaSummary);
  }

  usage(days = 30): UsageStats {
    const providers = new Map<string, UsageTotals>();
    const rows = this.db.query<StoredValue, [number]>(`
      SELECT value FROM runs WHERE started_at >= ? ORDER BY started_at DESC, rowid DESC
    `).iterate(Date.now() - days * 86_400_000);
    let totalRuns = 0;
    for (const { value } of rows) {
      const run = JSON.parse(value) as RunSummary;
      let totals = providers.get(run.providerId);
      if (!totals) {
        totals = {
          providerId: run.providerId, runs: 0, succeeded: 0, failed: 0,
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
          ttftSum: 0, ttftCount: 0, efforts: {},
        };
        providers.set(run.providerId, totals);
      }
      totalRuns += 1;
      totals.providerName ??= run.providerName;
      totals.runs += 1;
      if (run.status === "succeeded") totals.succeeded += 1;
      if (run.status === "failed") totals.failed += 1;
      if (typeof run.ttftMs === "number") {
        totals.ttftSum += run.ttftMs;
        totals.ttftCount += 1;
      }
      totals.inputTokens += run.inputTokens ?? 0;
      totals.cachedInputTokens += run.cachedInputTokens ?? 0;
      totals.outputTokens += run.outputTokens ?? 0;
      totals.estimatedCostUsd += run.estimatedCostUsd ?? estimateRunCostUsd(
        run.providerId, run.model, run.inputTokens, run.cachedInputTokens, run.outputTokens,
      ) ?? 0;
      if (run.effort) totals.efforts[run.effort] = (totals.efforts[run.effort] ?? 0) + 1;
    }
    const byProvider = [...providers.values()].sort((a, b) => b.runs - a.runs).map(usageSummary);
    return { days, totalRuns, byProvider };
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

  private insertRun(run: RunSummary, input: RunInput, workspace: string | undefined) {
    this.db.run(
      "INSERT INTO runs (id, started_at, status, input, value) VALUES (?, ?, ?, ?, ?)",
      [run.id, run.startedAt, run.status, JSON.stringify(input), JSON.stringify(run)],
    );
    if (run.conversationId) {
      this.db.run("INSERT INTO conversation_runs (run_id, workspace, conversation_id) VALUES (?, ?, ?)",
        [run.id, workspace ?? "", run.conversationId]);
    }
    if (run.broadcastGroupId) {
      this.db.run("INSERT INTO broadcast_runs (run_id, group_id) VALUES (?, ?)", [run.id, run.broadcastGroupId]);
    }
  }

  private insertEvent(event: RunEvent) {
    this.db.run("INSERT INTO run_events (run_id, seq, value) VALUES (?, ?, ?)", [
      event.runId, event.seq, JSON.stringify(event),
    ]);
  }

  private refreshRunSearch(runId: string, prompt: string) {
    this.db.run("DELETE FROM run_search WHERE run_id = ?", [runId]);
    this.db.run(`
      INSERT INTO run_search (run_id, prompt, response)
      SELECT ?, ?, COALESCE(group_concat(text, ''), '') FROM (
        SELECT json_extract(value, '$.text') AS text FROM run_events
        WHERE run_id = ? AND json_extract(value, '$.type') = 'text'
        ORDER BY seq
      )
    `, [runId, prompt, runId]);
  }

  private deleteRuns(ids: string[]): boolean {
    const bindings = [JSON.stringify(ids)];
    for (const table of ["run_events", "raw_events", "conversation_runs", "broadcast_runs", "run_search"]) {
      this.db.run(`DELETE FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?))`, bindings);
    }
    return this.db.run("DELETE FROM runs WHERE id IN (SELECT value FROM json_each(?))", bindings).changes > 0;
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
