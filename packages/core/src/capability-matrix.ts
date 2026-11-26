import type {
  ArenaBenchmarkEntry, CapabilityDomain, CapabilityMatrixSnapshot, DomainPreferenceOverride,
  EffortLevel, ModelCapabilityScore, Provider, RunSummary, SpecialistRecommendation,
} from "@ide/protocol";
import type { History, ModelOutcomeRow } from "./history";
import { effortLevels } from "./provider-adapter";
import { RpcError } from "./validation";

const DOMAIN_FILES = {
  code: "code",
  webdev: "webdev",
  text: "text",
  vision: "vision",
  search: "search",
  image: "text-to-image",
  video: "text-to-video",
} as const;
type ArenaDomain = keyof typeof DOMAIN_FILES;
const ARENA_DOMAINS = Object.keys(DOMAIN_FILES) as ArenaDomain[];
const SPECIALIST_DOMAINS = ["code", "webdev", "text", "vision", "search"] as const;
const PROMPT_DOMAINS = [...SPECIALIST_DOMAINS, "audio", "image", "video"] as const;
const BUILTIN_SOURCE = "builtin-seed";
const BUILTIN_UPDATED_AT = Date.UTC(2026, 10, 27);
const ARENA_BASE_URL = "https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/data";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const WARM_SESSION_BONUS = 28;
const MODEL_ALIAS_SUFFIX = /(?::(?:latest|\d+(?:\.\d+)?b)|-(?:\d{8}|\d{4}-\d{2}-\d{2}|preview(?:-\d{2}-\d{2})?)){1,3}$/u;
const BALANCED_MODEL = /(?:^|[-/])(?:flash|haiku|mini|nano|carbon|hydrogen)(?:[-/]|$)/u;
const REASONING_MODEL = /(?:^|[-/])(?:opus|reasoning|thinking|o[134]|coder|codex|neon|astra|deepseek-r1|gemini-\d+(?:\.\d+)?-pro|gpt-[56](?:\.\d+)?)(?:[-/]|$)/u;

type SeedModel = readonly [
  slug: string, name: string, organization: string, ratings: Partial<Record<ArenaDomain, number>>,
];

// Curated offline estimates for Uya v0.5.0.
const SEED_MODELS: readonly SeedModel[] = [
  ["claude-opus-4-6", "Claude Opus 4.6", "Anthropic", { code: 1481, webdev: 1485, text: 1484, vision: 1438 }],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", "Anthropic", { code: 1455, webdev: 1466, text: 1461, vision: 1414 }],
  ["gpt-6.2-astra", "GPT-6.2 Astra", "OpenAI", { code: 1485, webdev: 1477, text: 1482, vision: 1465, search: 1467 }],
  ["gpt-6.2-sol", "GPT-6.2 Sol", "OpenAI", { code: 1469, webdev: 1456, text: 1471, vision: 1452, search: 1454 }],
  ["gpt-5.4", "GPT-5.4", "OpenAI", { code: 1450, webdev: 1439, text: 1463, vision: 1437, search: 1434 }],
  ["o3", "OpenAI o3", "OpenAI", { code: 1408, webdev: 1394, text: 1418, vision: 1404 }],
  ["gemini-4-neon", "Gemini 4 Neon", "Google", { code: 1471, webdev: 1474, text: 1479, vision: 1485, search: 1480 }],
  ["gemini-3.1-pro", "Gemini 3.1 Pro", "Google", { code: 1460, webdev: 1451, text: 1468, vision: 1472, search: 1458 }],
  ["gemini-2.5-pro", "Gemini 2.5 Pro", "Google", { code: 1418, webdev: 1409, text: 1448, vision: 1445, search: 1422 }],
  ["gemini-2.5-flash", "Gemini 2.5 Flash", "Google", { code: 1375, webdev: 1367, text: 1388, vision: 1396, search: 1383 }],
  ["qwen3-coder", "Qwen3 Coder", "Alibaba", { code: 1403, webdev: 1397, text: 1360 }],
  ["qwen2.5-coder", "Qwen2.5 Coder", "Alibaba", { code: 1316, webdev: 1301, text: 1289 }],
  ["deepseek-r1", "DeepSeek R1", "DeepSeek", { code: 1390, webdev: 1372, text: 1414 }],
  ["deepseek-v3", "DeepSeek V3", "DeepSeek", { code: 1368, webdev: 1363, text: 1391 }],
  ["llama-3.3-70b", "Llama 3.3 70B", "Meta", { code: 1282, webdev: 1273, text: 1324 }],
  ["llama3.2", "Llama 3.2", "Meta", { code: 1220, webdev: 1224, text: 1248 }],
  ["gpt-image-1", "GPT Image 1", "OpenAI", { image: 1458 }],
  ["imagen-4.0-generate-001", "Imagen 4", "Google", { image: 1441 }],
  ["flux-1.1-pro", "FLUX1.1 Pro", "Black Forest Labs", { image: 1392 }],
  ["recraft-v3", "Recraft V3", "Recraft", { image: 1377 }],
  ["veo-3.1-audio-1080p", "Veo 3.1", "Google", { video: 1458 }],
  ["sora-2-pro", "Sora 2 Pro", "OpenAI", { video: 1445 }],
  ["kling-v2.5-turbo", "Kling 2.5 Turbo", "Kuaishou", { video: 1406 }],
  ["runway-gen-4.5", "Runway Gen-4.5", "Runway", { video: 1428 }],
];

export const BUILTIN_ARENA_SEED: readonly ArenaBenchmarkEntry[] = ARENA_DOMAINS.flatMap((domain) =>
  SEED_MODELS.flatMap(([modelSlug, displayName, organization, ratings]) => {
    const elo = ratings[domain];
    return elo === undefined ? [] : [{ modelSlug, displayName, organization, domain, elo, updatedAt: BUILTIN_UPDATED_AT }];
  }).sort((a, b) => b.elo - a.elo).map((entry, index) => ({ ...entry, rank: index + 1 })),
);

function normalizeModelSlug(modelId: string): string {
  return modelId.trim().toLowerCase()
    .replace(/^(?:(?:anthropic|openai|google|models)\/)+/u, "")
    .replace(/[\s_]+/gu, "-")
    .replace(/\b(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)(?=[-/:]|$)/u, "$1-$2")
    .replace(/\bllama(?=\d)/gu, "llama-")
    .replace(MODEL_ALIAS_SUFFIX, "");
}

type ArenaMatch = { elo: number; rank: number };
type DomainMatches = Partial<Record<CapabilityDomain, ArenaMatch>>;
type IndexedRating = { slug: string; entry: ArenaBenchmarkEntry };

function indexRatings(entries: readonly ArenaBenchmarkEntry[]): IndexedRating[] {
  return entries.map((entry) => ({ slug: normalizeModelSlug(entry.modelSlug), entry }));
}

function containsModelSlug(model: string, slug: string): boolean {
  const wordCharacter = /[\p{L}\p{N}]/u;
  for (let index = model.indexOf(slug); index >= 0; index = model.indexOf(slug, index + 1)) {
    if (!wordCharacter.test(model.charAt(index - 1)) && !wordCharacter.test(model.charAt(index + slug.length))) {
      return true;
    }
  }
  return false;
}

function matchLength(model: string, slug: string): number {
  if (!slug || !model) return 0;
  if (slug === model) return Infinity;
  if (containsModelSlug(model, slug)) return slug.length;
  // Some boards publish only suffixed variants of a provider's base model.
  return containsModelSlug(slug, model) ? model.length : 0;
}

function betterRank(candidate: ArenaMatch, current: ArenaMatch): boolean {
  return candidate.rank < current.rank || (candidate.rank === current.rank && candidate.elo > current.elo);
}

function matchRatings(modelId: string, ratings: readonly IndexedRating[]): DomainMatches {
  const model = normalizeModelSlug(modelId);
  const matches: DomainMatches = {};
  const lengths: Partial<Record<CapabilityDomain, number>> = {};
  for (const { slug, entry } of ratings) {
    const length = matchLength(model, slug);
    if (!length) continue;
    const previous = matches[entry.domain];
    const previousLength = lengths[entry.domain] ?? 0;
    if (length > previousLength || (length === previousLength && previous && betterRank(entry, previous))) {
      matches[entry.domain] = { elo: entry.elo, rank: entry.rank };
      lengths[entry.domain] = length;
    }
  }
  return matches;
}

export function matchArenaEntries(modelId: string, entries: readonly ArenaBenchmarkEntry[]): DomainMatches {
  return matchRatings(modelId, indexRatings(entries));
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonemptyText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function feedDate(payload: unknown): string {
  const date = typeof payload === "string" ? payload : jsonObject(payload)?.date;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    const timestamp = Date.parse(date);
    if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date) return date;
  }
  throw new Error("Arena feed contains an invalid snapshot date.");
}

function arenaEntries(payload: unknown, domain: ArenaDomain, updatedAt: number): ArenaBenchmarkEntry[] {
  const object = jsonObject(payload);
  const rows: unknown[] | undefined = [payload, object?.leaderboard, object?.models, object?.data].find(Array.isArray);
  const bySlug = new Map<string, ArenaBenchmarkEntry>();
  for (const [index, value] of (rows ?? []).entries()) {
    const row = jsonObject(value);
    if (!row) continue;
    const displayName = nonemptyText(row.model) ?? nonemptyText(row.name) ?? nonemptyText(row.model_name);
    const elo = positiveNumber(row.elo) ?? positiveNumber(row.score) ?? positiveNumber(row.rating) ?? positiveNumber(row.arena_score);
    if (!displayName || elo === undefined) continue;
    const modelSlug = normalizeModelSlug(displayName);
    if (!modelSlug) continue;
    const organization = nonemptyText(row.organization) ?? nonemptyText(row.org) ?? nonemptyText(row.vendor);
    const rank = positiveNumber(row.rank);
    const entry = {
      modelSlug, displayName, domain, elo, updatedAt,
      rank: rank !== undefined && Number.isSafeInteger(rank) ? rank : index + 1,
      ...(organization ? { organization } : {}),
    };
    const existing = bySlug.get(modelSlug);
    if (!existing || betterRank(entry, existing)) bySlug.set(modelSlug, entry);
  }
  return [...bySlug.values()];
}

async function readArenaResponse(
  fetcher: typeof fetch, url: string, signal: AbortSignal, optional: boolean,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetcher(url, { signal, redirect: "error" });
  const body = response.body;
  const missing = optional && response.status === 404;
  if (signal.aborted || !response.ok || response.redirected || !body
    || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
    if (missing) return undefined;
    throw new Error("Arena feed returned an unusable response.");
  }

  const reader = body.getReader();
  const stopReading = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", stopReading, { once: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Arena response exceeds 4 MiB.");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", stopReading);
    stopReading();
    reader.releaseLock();
  }
}

async function fetchArenaJson(fetcher: typeof fetch, url: string, optional = false): Promise<unknown> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Arena request timed out."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([deadline, readArenaResponse(fetcher, url, signal, optional)]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function deriveWebdev(code: readonly ArenaBenchmarkEntry[], text: readonly ArenaBenchmarkEntry[]): ArenaBenchmarkEntry[] {
  const textRatings = indexRatings(text);
  return (code.length ? code : text).map((entry) => {
    const textElo = code.length ? matchRatings(entry.modelSlug, textRatings).text?.elo : undefined;
    const elo = textElo === undefined ? entry.elo : Math.round(entry.elo * 0.7 + textElo * 0.3);
    return { ...entry, domain: "webdev" as const, elo };
  }).sort((a, b) => b.elo - a.elo || a.rank - b.rank).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export async function syncArenaLeaderboards(
  fetcher: typeof fetch = fetch, baseUrl = ARENA_BASE_URL,
): Promise<{ date: string; entries: ArenaBenchmarkEntry[] }> {
  if (fetcher === fetch && new URL(baseUrl).protocol !== "https:") throw new Error("Arena feed requires HTTPS.");
  const base = baseUrl.replace(/\/+$/u, "");
  const date = feedDate(await fetchArenaJson(fetcher, `${base}/latest.json`));
  const updatedAt = Date.parse(date);
  const boards = await Promise.all(ARENA_DOMAINS.map(async (domain) => {
    const payload = await fetchArenaJson(fetcher, `${base}/${date}/${DOMAIN_FILES[domain]}.json`, domain === "webdev");
    return [domain, arenaEntries(payload, domain, updatedAt)] as const;
  }));
  const byDomain = new Map(boards);
  const entries = boards.flatMap(([, rows]) => rows);
  if (entries.length === 0) throw new Error("Arena feed contains no usable ratings.");
  if (!byDomain.get("webdev")?.length) entries.push(...deriveWebdev(byDomain.get("code") ?? [], byDomain.get("text") ?? []));
  return { date, entries };
}

type ModelTelemetry = {
  runs: number;
  verifyPassed: number;
  verifyTotal: number;
  arenaWins: number;
  ttftMs: number;
  ttftSamples: number;
  inputTokens: number;
  cachedTokens: number;
};

function modelKey(providerId: string, model: string): string {
  return `${providerId}\0${model}`;
}

function collectTelemetry(
  providers: readonly Provider[], outcomes: readonly ModelOutcomeRow[], runs: readonly RunSummary[],
): Map<string, ModelTelemetry> {
  const defaults = new Map(providers.map((provider) => [provider.id, provider.defaultModel ?? provider.models?.[0] ?? provider.id]));
  const byModel = new Map<string, ModelTelemetry>();
  function totalsFor(providerId: string, model: string | undefined): ModelTelemetry | undefined {
    const defaultModel = defaults.get(providerId);
    if (defaultModel === undefined) return undefined;
    const key = modelKey(providerId, model || defaultModel);
    let totals = byModel.get(key);
    if (!totals) {
      totals = { runs: 0, verifyPassed: 0, verifyTotal: 0, arenaWins: 0, ttftMs: 0, ttftSamples: 0, inputTokens: 0, cachedTokens: 0 };
      byModel.set(key, totals);
    }
    return totals;
  }

  for (const outcome of outcomes) {
    const totals = totalsFor(outcome.providerId, outcome.model);
    if (!totals) continue;
    totals.verifyPassed += outcome.verifyPassed;
    totals.verifyTotal += outcome.verifyTotal;
    totals.arenaWins += outcome.arenaWins;
  }
  for (const run of runs) {
    const totals = totalsFor(run.providerId, run.model);
    if (!totals) continue;
    totals.runs++;
    if (run.ttftMs !== undefined && Number.isFinite(run.ttftMs) && run.ttftMs >= 0) {
      totals.ttftMs += run.ttftMs;
      totals.ttftSamples++;
    }
    const input = run.inputTokens;
    if (input !== undefined && Number.isSafeInteger(input) && input >= 0) {
      const cached = Number.isSafeInteger(run.cachedInputTokens) ? Math.max(0, run.cachedInputTokens ?? 0) : 0;
      // Claude reports uncached input and cache reads separately.
      const totalInput = run.providerId === "claude" || run.providerId === "anthropic" ? input + cached : input;
      totals.inputTokens += totalInput;
      totals.cachedTokens += Math.min(totalInput, cached);
    }
  }
  return byModel;
}

function preferredEffort(provider: Provider, model: string): EffortLevel {
  if (provider.kind === "runtime") return "low";
  const slug = normalizeModelSlug(model);
  return !BALANCED_MODEL.test(slug) && REASONING_MODEL.test(slug) ? "high" : "medium";
}

function recommendedEffort(provider: Provider, model: string): EffortLevel {
  const supported = provider.modelEfforts?.[model] ?? provider.supportedEfforts;
  if (!supported?.length) return "medium";
  const desired = preferredEffort(provider, model);
  if (supported.includes(desired)) return desired;
  if (provider.defaultEffort && supported.includes(provider.defaultEffort)) return provider.defaultEffort;
  const desiredIndex = effortLevels.indexOf(desired);
  const distance = (level: EffortLevel) => Math.abs(effortLevels.indexOf(level) - desiredIndex);
  return supported.reduce((best, level) => distance(level) < distance(best) ? level : best);
}

type Candidate = {
  provider: Provider;
  score: ModelCapabilityScore;
  fallbackElo: number;
  outcomeBonus: number;
};

function verifyPassRate(score: ModelCapabilityScore): number | undefined {
  return score.localVerifyTotal > 0 ? score.localVerifyPassed / score.localVerifyTotal : undefined;
}

function scoreModel(
  provider: Provider, model: string, ratings: readonly IndexedRating[], telemetry: ModelTelemetry | undefined,
): Candidate {
  const providerDefault = model === provider.id && !provider.models?.length && provider.defaultModel === undefined;
  const domainScores = providerDefault ? {} : matchRatings(model, ratings);
  const eloScores = Object.values(domainScores).map(({ elo }) => elo);
  const fallbackElo = provider.kind === "cli" ? 1340 : 1260;
  const bestElo = eloScores.length ? Math.max(...eloScores) : fallbackElo;
  const localVerifyPassed = telemetry?.verifyPassed ?? 0;
  const localVerifyTotal = telemetry?.verifyTotal ?? 0;
  const localArenaWins = telemetry?.arenaWins ?? 0;
  const verifyBonus = localVerifyTotal >= 2 ? (localVerifyPassed / localVerifyTotal - 0.5) * 60 : 0;
  const outcomeBonus = verifyBonus + Math.min(45, localArenaWins * 12);
  return {
    provider, fallbackElo, outcomeBonus,
    score: {
      providerId: provider.id, providerName: provider.name, model, domainScores,
      localRuns: telemetry?.runs ?? 0, localVerifyPassed, localVerifyTotal, localArenaWins,
      ...(telemetry?.ttftSamples ? { avgTtftMs: telemetry.ttftMs / telemetry.ttftSamples } : {}),
      ...(telemetry?.inputTokens ? { cacheHitRate: telemetry.cachedTokens / telemetry.inputTokens } : {}),
      compositeScore: bestElo + outcomeBonus,
      recommendedEffort: recommendedEffort(provider, model),
    },
  };
}

type RankedCandidate = { candidate: Candidate; points: number };

function rankCandidate(
  candidates: readonly Candidate[], domain: CapabilityDomain, providerId?: string, requireRating = false,
): RankedCandidate | undefined {
  let best: RankedCandidate | undefined;
  for (const candidate of candidates) {
    if (providerId !== undefined && candidate.provider.id !== providerId) continue;
    const elo = candidate.score.domainScores[domain]?.elo;
    if (elo === undefined && requireRating) continue;
    const points = (elo ?? candidate.fallbackElo) + candidate.outcomeBonus;
    if (!best || points > best.points) best = { candidate, points };
  }
  return best;
}

function toRecommendation(
  candidate: Candidate, domain: CapabilityDomain, reason: string, override?: DomainPreferenceOverride,
): SpecialistRecommendation {
  const { provider, score } = candidate;
  const model = override?.model ?? (provider.models?.length || provider.defaultModel ? score.model : undefined);
  const elo = score.domainScores[domain]?.elo;
  const localWinRate = verifyPassRate(score);
  const evidence = [elo === undefined ? `${candidate.fallbackElo} estimated Elo` : `${elo} Elo`];
  if (localWinRate !== undefined) evidence.push(`${Math.round(localWinRate * 100)}% local verify pass`);
  return {
    domain, providerId: provider.id, providerName: provider.name,
    ...(model !== undefined ? { model } : {}),
    effort: override?.effort ?? score.recommendedEffort,
    ...(elo !== undefined ? { elo } : {}),
    ...(localWinRate !== undefined ? { localWinRate } : {}),
    reason: `${reason} (${evidence.join(", ")})`,
  };
}

type MatrixCandidates = {
  candidates: readonly Candidate[];
  overrides: CapabilityMatrixSnapshot["overrides"];
  score: (provider: Provider, model: string) => Candidate;
};

function selectSpecialist(
  matrix: MatrixCandidates, domain: CapabilityDomain, warmProviderId?: string,
): SpecialistRecommendation | null {
  const override = matrix.overrides[domain];
  if (override) {
    const ranked = rankCandidate(matrix.candidates, domain, override.providerId);
    if (ranked) {
      const candidate = override.model === undefined || override.model === ranked.candidate.score.model
        ? ranked.candidate : matrix.score(ranked.candidate.provider, override.model);
      return toRecommendation(candidate, domain, `User override for ${domain}`, override);
    }
  }

  const requireRating = domain === "audio" || domain === "image" || domain === "video";
  const top = rankCandidate(matrix.candidates, domain, undefined, requireRating);
  if (!top) return null;
  if (warmProviderId !== undefined && warmProviderId !== top.candidate.provider.id) {
    const warm = rankCandidate(matrix.candidates, domain, warmProviderId, requireRating);
    if (warm && warm.points + WARM_SESSION_BONUS >= top.points) {
      const gap = Math.ceil(top.points - warm.points);
      return toRecommendation(warm.candidate, domain, `Kept warm session within ${gap} points of top specialist`);
    }
  }
  return toRecommendation(top.candidate, domain, `#1 installed for ${domain}`);
}

function ensureSeed(history: History): void {
  if (history.listArenaRatings().entries.length === 0) {
    history.replaceArenaRatings(BUILTIN_ARENA_SEED, Date.now(), BUILTIN_SOURCE);
  }
}

function markdownLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/[\\`*_\[\]<>]/gu, "\\$&");
}

export class CapabilityMatrixEngine {
  private syncing: Promise<void> | undefined;

  constructor(private readonly history: History, private readonly fetcher: typeof fetch = fetch) {
    ensureSeed(history);
  }

  snapshot(providers: readonly Provider[], workspacePath?: string | null): CapabilityMatrixSnapshot {
    const matrix = this.prepare(providers, workspacePath);
    const recommendations: CapabilityMatrixSnapshot["recommendations"] = {};
    for (const domain of SPECIALIST_DOMAINS) {
      const specialist = selectSpecialist(matrix, domain);
      if (specialist) recommendations[domain] = specialist;
    }
    return {
      syncedAt: matrix.ratings.syncedAt, source: matrix.ratings.source, entriesCount: matrix.ratings.entries.length,
      models: matrix.candidates.map(({ score }) => score), recommendations, overrides: matrix.overrides,
    };
  }

  recommend(
    providers: readonly Provider[], domain: CapabilityDomain,
    options?: { workspacePath?: string | null; preferWarmProviderId?: string },
  ): SpecialistRecommendation | null {
    return selectSpecialist(this.prepare(providers, options?.workspacePath), domain, options?.preferWarmProviderId);
  }

  setOverride(
    providers: readonly Provider[], domain: CapabilityDomain, override: DomainPreferenceOverride | null,
    workspacePath?: string | null,
  ): CapabilityMatrixSnapshot {
    this.history.setSynapseOverride(domain, override);
    return this.snapshot(providers, workspacePath);
  }

  async sync(providers: readonly Provider[], workspacePath?: string | null): Promise<CapabilityMatrixSnapshot> {
    const pending = this.syncing ??= this.refreshRatings();
    try {
      await pending;
    } finally {
      if (this.syncing === pending) this.syncing = undefined;
    }
    return this.snapshot(providers, workspacePath);
  }

  formatPromptSummary(snapshot: CapabilityMatrixSnapshot, maxBytes = 1200): string {
    if (!(maxBytes > 0)) return "";
    const heading = "### Domain specialists";
    const lines: string[] = [];
    let bytes = Buffer.byteLength(heading);
    for (const domain of PROMPT_DOMAINS) {
      const item = snapshot.recommendations[domain];
      if (!item) continue;
      const model = item.model ? ` / ${markdownLabel(item.model)}` : "";
      const elo = item.elo === undefined ? "" : `, ${item.elo} Elo`;
      const line = `- **${domain}** · ${markdownLabel(item.providerName)}${model} (${item.effort}${elo})`;
      const nextBytes = bytes + 1 + Buffer.byteLength(line);
      if (nextBytes > maxBytes) continue;
      lines.push(line);
      bytes = nextBytes;
    }
    return lines.length ? [heading, ...lines].join("\n") : "";
  }

  private prepare(providers: readonly Provider[], workspacePath?: string | null) {
    const available = providers.filter((provider) => provider.available && provider.structured);
    const ratings = this.history.listArenaRatings();
    const indexed = indexRatings(ratings.entries);
    const scopedOutcomes = this.history.listModelOutcomes(workspacePath);
    const telemetry = collectTelemetry(available, scopedOutcomes, this.history.recentRuns(400));
    const score = (provider: Provider, model: string) => scoreModel(provider, model, indexed, telemetry.get(modelKey(provider.id, model)));
    const candidates = available.flatMap((provider) => {
      const models = provider.models?.length ? provider.models : [provider.defaultModel ?? provider.id];
      return Array.from(new Set(models), (model) => score(provider, model));
    });
    return { ratings, candidates, score, overrides: this.history.synapseOverrides() };
  }

  private async refreshRatings(): Promise<void> {
    let feed: Awaited<ReturnType<typeof syncArenaLeaderboards>>;
    try {
      feed = await syncArenaLeaderboards(this.fetcher);
    } catch {
      ensureSeed(this.history);
      throw new RpcError(-32011, "Could not sync Arena leaderboard feed. Local ratings remain active.");
    }
    this.history.replaceArenaRatings(feed.entries, Date.now(), `arena-ai:${feed.date}`);
  }
}
