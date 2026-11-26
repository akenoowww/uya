import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaBenchmarkEntry, CapabilityDomain, Provider, RunSummary } from "@ide/protocol";
import { BUILTIN_ARENA_SEED, CapabilityMatrixEngine, matchArenaEntries, syncArenaLeaderboards } from "./capability-matrix";
import { History } from "./history";
import { RpcError } from "./validation";

const date = "2026-11-26";
const arenaHost = "https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/data";
const fixtureHost = "http://arena-feed.test/data";
const project = "/synthetic/project";
const otherProject = "/synthetic/other";
const maxResponseBytes = 4 * 1024 * 1024;

function benchmark(modelSlug: string, domain: CapabilityDomain, elo: number, rank = 1): ArenaBenchmarkEntry {
  return { modelSlug, displayName: modelSlug, domain, elo, rank, updatedAt: Date.parse(date) };
}

function provider(id: string, fields: Partial<Provider> = {}): Provider {
  return { id, name: id, kind: "cli", structured: true, available: true, terminal: true, ...fields };
}

function addRun(history: History, providerId: string, fields: Partial<RunSummary> = {}, workspace = project): void {
  const run: RunSummary = {
    id: crypto.randomUUID(), providerId, prompt: "Synthetic request", status: "succeeded", startedAt: Date.now(), ...fields,
  };
  history.create(run, { prompt: run.prompt, workspacePath: workspace }, workspace);
}

type FetchInit = Parameters<typeof fetch>[1];

function mockFetch(handler: (url: string, init: FetchInit) => Response | Promise<Response>): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0], init?: FetchInit) =>
    handler(input instanceof Request ? input.url : String(input), init), { preconnect: fetch.preconnect });
}

function mockFeed(
  files: Readonly<Record<string, unknown>>, latest: unknown = { date },
  expectedBase = arenaHost, requests: string[] = [],
): typeof fetch {
  return mockFetch((url, init) => {
    requests.push(url);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url === `${expectedBase}/latest.json`) return Response.json(latest);
    expect(url.startsWith(`${expectedBase}/${date}/`)).toBe(true);
    const filename = url.slice(`${expectedBase}/${date}/`.length);
    if (filename === "webdev.json" && !Object.hasOwn(files, filename)) return new Response(null, { status: 404 });
    const file = files[filename];
    return file instanceof Response ? file : Response.json(file ?? []);
  });
}

test("the offline seed covers model families and ranks every required domain", () => {
  const models = new Set(BUILTIN_ARENA_SEED.map(({ modelSlug }) => modelSlug));
  for (const model of [
    "claude-opus-4-6", "claude-sonnet-4-6", "gpt-6.2-sol", "gpt-6.2-astra", "gpt-5.4", "o3", "gemini-4-neon",
    "gemini-3.1-pro", "gemini-2.5-pro", "gemini-2.5-flash", "qwen3-coder", "qwen2.5-coder", "deepseek-r1",
    "deepseek-v3", "llama-3.3-70b", "llama3.2",
  ]) expect(models.has(model)).toBe(true);
  for (const domain of ["code", "webdev", "text", "vision", "search", "image", "video"]) {
    const rows = BUILTIN_ARENA_SEED.filter((entry) => entry.domain === domain);
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map(({ modelSlug }) => modelSlug)).size).toBe(rows.length);
    expect(rows.map(({ rank }) => rank)).toEqual(rows.map((_, index) => index + 1));
    const elos = rows.map(({ elo }) => elo);
    expect(elos.every((elo) => elo >= 1220 && elo <= 1485)).toBe(true);
    expect(elos).toEqual(elos.toSorted((a, b) => b - a));
  }
});

test("normalizes provider prefixes, dates, previews, and local model tags", () => {
  const ratings = [
    benchmark("claude-opus-4-6", "code", 1455, 2),
    benchmark("gemini-3.1-pro-preview", "vision", 1460),
    benchmark("gpt-5.4", "text", 1425),
    benchmark("qwen2.5-coder", "code", 1320, 8),
    benchmark("llama-3.3-70b", "text", 1310, 9),
  ];
  expect(matchArenaEntries(" Anthropic/Claude-Opus-4-6-20250514:latest ", ratings)).toEqual({ code: { elo: 1455, rank: 2 } });
  expect(matchArenaEntries("claude-opus-4-6", [benchmark("Claude Opus 4.6", "code", 1455, 2)]).code).toEqual({ elo: 1455, rank: 2 });
  expect(matchArenaEntries("google/models/gemini-3.1-pro-preview-02-19", ratings)).toEqual({ vision: { elo: 1460, rank: 1 } });
  expect(matchArenaEntries("openai/gpt-5.4-2025-05-14", ratings)).toEqual({ text: { elo: 1425, rank: 1 } });
  expect(matchArenaEntries("qwen2.5-coder:7b", ratings)).toEqual({ code: { elo: 1320, rank: 8 } });
  expect(matchArenaEntries("llama3.3:70b", ratings)).toEqual({ text: { elo: 1310, rank: 9 } });
});

test("prefers exact matches, then the most specific family per domain", () => {
  const ratings = [
    benchmark("claude-opus", "code", 1480),
    benchmark("claude-opus-4-6", "code", 1455, 2),
    benchmark("anthropic/claude-opus-4-6-preview", "code", 1451, 3),
    benchmark("claude-opus-4-6-thinking", "code", 1450, 4),
    benchmark("claude-opus", "text", 1440),
    benchmark("o3", "code", 1400),
  ];
  expect(matchArenaEntries("claude-opus-4-6", ratings)).toEqual({ code: { elo: 1455, rank: 2 }, text: { elo: 1440, rank: 1 } });
  expect(matchArenaEntries("proxy/claude-opus-4-6-high", ratings).code).toEqual({ elo: 1455, rank: 2 });
  expect(matchArenaEntries("claude-opus-4-6-thinking", ratings).code).toEqual({ elo: 1450, rank: 4 });
  expect(matchArenaEntries("claude-opus-4-60", ratings).code).toEqual({ elo: 1480, rank: 1 });
  expect(matchArenaEntries("gizmo3", ratings)).toEqual({});
  expect(matchArenaEntries("gpt-5.4", [benchmark("gpt-5.4-high", "code", 1410)]).code?.elo).toBe(1410);
});

describe("Arena feed", () => {
  test("parses dated boards and derives webdev using coding and text ratings", async () => {
    const requests: string[] = [];
    const fetcher = mockFeed({
      "code.json": { leaderboard: [
        { model: "openai/gpt-5.4", elo: "1430", rank: 3, organization: "OpenAI" },
        { name: "gpt-5.4-preview", score: 1450, rank: "1", org: "OpenAI" },
        { model: "qwen3-coder", score: 1425.5, rank: 2 },
        { model: "missing-elo" }, null, { model: "invalid", score: "Infinity" },
      ] },
      "text.json": { models: [{ model_name: "gpt-5.4", rating: 1400, vendor: "OpenAI" }] },
      "vision.json": { data: [{ name: "Gemini 4 Neon", arena_score: 1470, rank: 2, org: "Google" }] },
      "search.json": [{ model: "search-fixture", elo: 1360 }],
      "text-to-image.json": [{ model: "image-fixture", rating: 1380 }],
      "text-to-video.json": [{ model: "video-fixture", score: 1370 }],
    }, date, fixtureHost, requests);

    const result = await syncArenaLeaderboards(fetcher, `${fixtureHost}/`);
    expect(result.date).toBe(date);
    expect(requests[0]).toBe(`${fixtureHost}/latest.json`);
    expect(requests.slice(1).map((url) => url.split("/").at(-1)).sort()).toEqual([
      "code.json", "search.json", "text-to-image.json", "text-to-video.json", "text.json", "vision.json", "webdev.json",
    ]);
    expect(result.entries).toHaveLength(9);
    expect(result.entries.find((entry) => entry.domain === "code" && entry.modelSlug === "gpt-5.4")).toEqual({
      ...benchmark("gpt-5.4", "code", 1450), displayName: "gpt-5.4-preview", organization: "OpenAI",
    });
    expect(result.entries.find((entry) => entry.domain === "text")).toEqual({
      ...benchmark("gpt-5.4", "text", 1400), organization: "OpenAI",
    });
    expect(result.entries.find((entry) => entry.domain === "vision")).toMatchObject({
      modelSlug: "gemini-4-neon", rank: 2, organization: "Google", elo: 1470,
    });
    expect(result.entries.filter((entry) => entry.domain === "webdev").map(({ modelSlug, elo, rank }) => ({ modelSlug, elo, rank }))).toEqual([
      { modelSlug: "gpt-5.4", elo: 1435, rank: 1 }, { modelSlug: "qwen3-coder", elo: 1425.5, rank: 2 },
    ]);
  });

  test("uses the explicit webdev board when published", async () => {
    const { entries } = await syncArenaLeaderboards(mockFeed({
      "code.json": [{ model: "coding-model", score: 1400 }],
      "webdev.json": { leaderboard: [{ name: "web-model", elo: 1440, rank: 2 }] },
    }, { date, path: "ignored" }));
    expect(entries.filter(({ domain }) => domain === "webdev")).toEqual([benchmark("web-model", "webdev", 1440, 2)]);
  });

  test.each(["../unexpected", "2026-02-30", { date: 20261126 }])("rejects an invalid latest date %p", async (latest) => {
    const requests: string[] = [];
    await expect(syncArenaLeaderboards(mockFeed({}, latest, arenaHost, requests))).rejects.toThrow("invalid snapshot date");
    expect(requests).toEqual([`${arenaHost}/latest.json`]);
  });

  test("requires HTTPS with the default fetcher", async () => {
    await expect(syncArenaLeaderboards(undefined, fixtureHost)).rejects.toThrow("requires HTTPS");
  });

  test("cancels a response whose declared size exceeds 4 MiB", async () => {
    const cancel = { called: false };
    const body = new ReadableStream<Uint8Array>({ cancel() { cancel.called = true; } });
    const fetcher = mockFetch(() => new Response(body, { headers: { "content-length": String(maxResponseBytes + 1) } }));
    await expect(syncArenaLeaderboards(fetcher)).rejects.toThrow("unusable response");
    expect(cancel.called).toBe(true);
  });

  test("caps actual UTF-8 bytes for streamed responses without a size header", async () => {
    const chunk = new TextEncoder().encode("é".repeat(maxResponseBytes / 4 + 1));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    await expect(syncArenaLeaderboards(mockFetch(() => new Response(body)))).rejects.toThrow("exceeds 4 MiB");
    expect(cancelled).toBe(true);
  });

  test("enforces the 8-second deadline even while waiting for response headers", async () => {
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const fetcher = mockFetch((_url, init) => {
        expect(init?.signal).toBe(controller.signal);
        return new Promise<Response>(() => {});
      });
      const request = syncArenaLeaderboards(fetcher);
      expect(timeout).toHaveBeenCalledWith(8_000);
      controller.abort();
      await expect(request).rejects.toThrow("timed out");
    } finally {
      timeout.mockRestore();
    }
  });

  test("applies the request deadline to a stalled body and cancels the stream", async () => {
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let cancelled = false;
    try {
      const pull = Promise.withResolvers<void>();
      const body = new ReadableStream<Uint8Array>({
        pull() { pull.resolve(); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const request = syncArenaLeaderboards(mockFetch(() => new Response(body)));
      await pull.promise;
      controller.abort();
      await expect(request).rejects.toThrow("timed out");
      expect(cancelled).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("CapabilityMatrixEngine with SQLite history", () => {
  let directory: string;
  let history: History;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "uya-capability-matrix-"));
    history = new History(directory);
  });

  afterEach(() => {
    history.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("seeds once and immediately recommends installed specialists offline", () => {
    const fetcher = mockFetch(() => { throw new Error("Unexpected network request"); });
    const engine = new CapabilityMatrixEngine(history, fetcher);
    const installed = [
      provider("codex", { models: ["gpt-6.2-astra"], supportedEfforts: ["medium", "high"] }),
      provider("gemini", { defaultModel: "gemini-4-neon" }),
      provider("claude", { models: ["claude-opus-4-6"] }),
    ];
    const snapshot = engine.snapshot(installed);
    expect(snapshot.source).toBe("builtin-seed");
    expect(snapshot.entriesCount).toBe(BUILTIN_ARENA_SEED.length);
    expect(Object.keys(snapshot.recommendations)).toEqual(["code", "webdev", "text", "vision", "search"]);
    expect(snapshot.recommendations.code).toMatchObject({ providerId: "codex", model: "gpt-6.2-astra", elo: 1485, effort: "high" });
    expect(snapshot.recommendations.webdev?.providerId).toBe("claude");
    expect(snapshot.recommendations.vision?.providerId).toBe("gemini");
    const cache = history.listArenaRatings();
    new CapabilityMatrixEngine(history, fetcher);
    expect(history.listArenaRatings()).toEqual(cache);
  });

  test("filters unavailable and terminal-only providers, with usable default selections", () => {
    const engine = new CapabilityMatrixEngine(history);
    const codex = provider("codex");
    const runtime = provider("ollama", { kind: "runtime", models: [], defaultModel: "unrated-local", supportedEfforts: ["low", "medium"] });
    const unavailable = provider("hidden", { available: false, models: ["gpt-6.2-astra"] });
    const terminalOnly = provider("terminal", { structured: false, models: ["gpt-6.2-astra"] });
    expect(engine.snapshot([codex, runtime, unavailable, terminalOnly]).models).toMatchObject([
      { providerId: "codex", model: "codex", domainScores: {}, compositeScore: 1340, recommendedEffort: "medium" },
      { providerId: "ollama", model: "unrated-local", domainScores: {}, compositeScore: 1260, recommendedEffort: "low" },
    ]);
    expect(engine.recommend([codex], "code")).not.toHaveProperty("model");
    expect(engine.recommend([unavailable, terminalOnly], "code")).toBeNull();
    expect(engine.recommend([codex], "video")).toBeNull();
    expect(engine.recommend([provider("video-provider", { models: ["sora-2-pro"] })], "video")).toMatchObject({ model: "sora-2-pro", elo: 1445 });
  });

  test("uses model-specific effort choices and supported provider fallbacks", () => {
    const engine = new CapabilityMatrixEngine(history);
    const codex = provider("codex", {
      models: ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.2-sol", "gpt-5.4-mini"],
      supportedEfforts: ["low", "high"], defaultEffort: "low",
      modelEfforts: { "gpt-6.2-astra": ["xhigh"], "gpt-5.4-mini": [] },
    });
    const gemini = provider("gemini", { models: ["gemini-2.5-flash"], supportedEfforts: ["low", "medium", "high"] });
    const runtime = provider("ollama", { kind: "runtime", models: ["deepseek-r1"], supportedEfforts: ["minimal", "low", "high"] });
    const limited = provider("limited", { models: ["o3"], supportedEfforts: ["low", "medium"], defaultEffort: "low" });
    expect(engine.snapshot([codex, gemini, runtime, limited]).models.map(({ model, recommendedEffort }) => [model, recommendedEffort])).toEqual([
      ["gpt-6.2-astra", "xhigh"], ["gpt-6.2-sol", "high"], ["gpt-5.4-mini", "medium"],
      ["gemini-2.5-flash", "medium"], ["deepseek-r1", "low"], ["o3", "low"],
    ]);
  });

  test("joins scoped outcomes with recent per-model run, latency, and token telemetry", () => {
    const engine = new CapabilityMatrixEngine(history);
    const model = "gpt-6.2-sol";
    const codex = provider("codex", { models: [model, "gpt-6.2-astra"], defaultModel: model });
    history.recordModelOutcome(project, codex.id, model, { verifyPassed: 3, verifyTotal: 4, arenaWins: 3 });
    history.recordModelOutcome(null, codex.id, undefined, { verifyPassed: 1, verifyTotal: 1, arenaWins: 1 });
    history.recordModelOutcome(otherProject, codex.id, model, { verifyTotal: 3, arenaWins: 4 });
    history.recordModelOutcome(project, "someone-else", model, { verifyTotal: 10, arenaWins: 5 });
    addRun(history, codex.id, { model, ttftMs: 200, inputTokens: 1000, cachedInputTokens: 200 });
    addRun(history, codex.id, { ttftMs: 400, inputTokens: 3000, cachedInputTokens: 900 }, otherProject);
    addRun(history, codex.id, { model, status: "failed" });
    addRun(history, "someone-else", { model, ttftMs: 5 });
    const runs = spyOn(history, "recentRuns");

    const scoped = engine.snapshot([codex], project);
    expect(runs).toHaveBeenCalledWith(400);
    expect(scoped.models[0]).toMatchObject({
      localRuns: 3, avgTtftMs: 300, cacheHitRate: 0.275, localVerifyPassed: 4, localVerifyTotal: 5,
      localArenaWins: 4, compositeScore: 1471 + 18 + 45,
    });
    expect(scoped.models[1]).toMatchObject({ localRuns: 0, localVerifyTotal: 0, localArenaWins: 0 });
    expect(scoped.models[1]).not.toHaveProperty("avgTtftMs");
    expect(scoped.models[1]).not.toHaveProperty("cacheHitRate");
    expect(scoped.recommendations.code).toMatchObject({ model, elo: 1469, localWinRate: 0.8 });
    expect(scoped.recommendations.code?.reason).toContain("80% local verify pass");
    expect(engine.snapshot([codex], null).models[0]).toMatchObject({ localVerifyTotal: 8, localArenaWins: 8 });
    runs.mockRestore();
  });

  test("keeps local tag telemetry distinct and applies verify bonuses only from two samples", () => {
    const engine = new CapabilityMatrixEngine(history);
    const small = "qwen2.5-coder:7b";
    const large = "qwen2.5-coder:32b";
    const ollama = provider("ollama", { kind: "runtime", models: [small, large] });
    history.recordModelOutcome(project, ollama.id, small, { verifyPassed: 1, verifyTotal: 1, arenaWins: 1 });
    history.recordModelOutcome(project, ollama.id, large, { verifyTotal: 2 });
    addRun(history, ollama.id, { model: large, ttftMs: 0, inputTokens: 100, cachedInputTokens: 0 });
    const [smallScore, largeScore] = engine.snapshot([ollama], project).models;
    expect(smallScore).toMatchObject({ model: small, localRuns: 0, localVerifyTotal: 1, localArenaWins: 1, compositeScore: 1316 + 12 });
    expect(largeScore).toMatchObject({ model: large, localRuns: 1, localVerifyTotal: 2, avgTtftMs: 0, cacheHitRate: 0, compositeScore: 1316 - 30 });
  });

  test("uses uncached plus cached input for Claude's token cache rate", () => {
    const engine = new CapabilityMatrixEngine(history);
    const claude = provider("claude", { defaultModel: "claude-opus-4-6" });
    addRun(history, claude.id, { inputTokens: 25, cachedInputTokens: 75 });
    expect(engine.snapshot([claude]).models[0]?.cacheHitRate).toBe(0.75);
  });

  test("ranks on the requested domain and keeps a warm provider within 28 points", () => {
    history.replaceArenaRatings([
      benchmark("code-specialist", "code", 1450),
      benchmark("code-specialist", "text", 1300, 2),
      benchmark("warm-model", "code", 1432, 2),
      benchmark("warm-model", "text", 1490),
      benchmark("border-model", "code", 1422, 3),
      benchmark("far-model", "code", 1421, 4),
    ], 42, "fixture");
    const engine = new CapabilityMatrixEngine(history);
    const installed = [
      provider("top", { models: ["code-specialist"] }), provider("warm", { models: ["warm-model"] }),
      provider("boundary", { models: ["border-model"] }), provider("far", { models: ["far-model"] }),
    ];
    const snapshot = engine.snapshot(installed);
    expect(snapshot.source).toBe("fixture");
    expect(snapshot.syncedAt).toBe(42);
    expect(snapshot.recommendations.code?.providerId).toBe("top");
    expect(snapshot.recommendations.text?.providerId).toBe("warm");
    expect(engine.recommend(installed, "code", { preferWarmProviderId: "warm" })).toMatchObject({
      providerId: "warm", elo: 1432, reason: expect.stringContaining("Kept warm session within 18 points"),
    });
    expect(engine.recommend(installed, "code", { preferWarmProviderId: "boundary" })?.providerId).toBe("boundary");
    expect(engine.recommend(installed, "code", { preferWarmProviderId: "far" })?.providerId).toBe("top");
  });

  test("persists and clears user overrides while falling back when a provider is unavailable", () => {
    const engine = new CapabilityMatrixEngine(history);
    const codex = provider("codex", { models: ["gpt-6.2-astra"] });
    const claude = provider("claude", { models: ["claude-opus-4-6", "claude-sonnet-4-6"], supportedEfforts: ["medium", "high"] });
    const override = { providerId: claude.id, model: "claude-sonnet-4-6", effort: "high" } as const;
    const installed = [codex, claude];
    const saved = engine.setOverride(installed, "code", override, project);
    expect(history.synapseOverrides().code).toEqual(override);
    expect(saved.overrides.code).toEqual(override);
    expect(saved.recommendations.code).toMatchObject({ ...override, reason: expect.stringContaining("User override") });
    expect(engine.recommend(installed, "code", { preferWarmProviderId: codex.id })).toEqual(saved.recommendations.code ?? null);
    expect(engine.recommend([codex, { ...claude, available: false }], "code")?.providerId).toBe(codex.id);
    expect(engine.recommend([codex, { ...claude, structured: false }], "code")?.providerId).toBe(codex.id);
    const cleared = engine.setOverride(installed, "code", null, project);
    expect(cleared.overrides.code).toBeUndefined();
    expect(cleared.recommendations.code?.providerId).toBe(codex.id);
  });

  test("chooses the provider's domain specialist for provider-only overrides", () => {
    const engine = new CapabilityMatrixEngine(history);
    const providerId = "gemini";
    const installed = [provider(providerId, { models: ["gemini-2.5-flash", "gemini-4-neon"], defaultModel: "gemini-2.5-flash" })];
    expect(engine.setOverride(installed, "vision", { providerId }).recommendations.vision).toMatchObject({
      providerId, model: "gemini-4-neon", elo: 1485, reason: expect.stringContaining("User override"),
    });
  });

  test("keeps cached entries on network and partial-board failures, then retries successfully", async () => {
    const cached = benchmark("cached-fixture", "code", 1430);
    history.replaceArenaRatings([cached], 42, "previous-feed");
    let status: "network-error" | "board-error" | "empty" | "success" = "network-error";
    const fetcher = mockFetch((url) => {
      if (status === "network-error") throw new Error("Synthetic internal network diagnostic");
      if (url.endsWith("/latest.json")) return Response.json({ date });
      if (url.endsWith("/webdev.json")) return new Response(null, { status: 404 });
      if (url.endsWith("/search.json") && status === "board-error") return new Response(null, { status: 503 });
      if (url.endsWith("/code.json") && status !== "empty") return Response.json([{ model: "fresh-fixture", score: 1470 }]);
      return Response.json({ models: [{ model: "missing-score" }] });
    });
    const engine = new CapabilityMatrixEngine(history, fetcher);
    const error = new RpcError(-32011, "Could not sync Arena leaderboard feed. Local ratings remain active.");
    for (const failure of ["network-error", "board-error", "empty"] as const) {
      status = failure;
      const result = await engine.sync([]).catch((reason: unknown) => reason);
      expect(result).toBeInstanceOf(RpcError);
      expect(result).toMatchObject({ code: error.code, message: error.message });
      expect(history.listArenaRatings()).toEqual({ syncedAt: 42, source: "previous-feed", entries: [cached] });
    }
    status = "success";
    const snapshot = await engine.sync([provider("fresh", { defaultModel: "fresh-fixture" })]);
    expect(snapshot.source).toBe(`arena-ai:${date}`);
    expect(snapshot.entriesCount).toBe(2);
    expect(snapshot.syncedAt).toBeGreaterThan(42);
    expect(snapshot.recommendations.code?.elo).toBe(1470);
    expect(history.listArenaRatings().entries).toEqual([
      benchmark("fresh-fixture", "code", 1470), benchmark("fresh-fixture", "webdev", 1470),
    ]);
  });

  test("restores the offline seed if a sync cannot reach the feed and the cache is empty", async () => {
    const engine = new CapabilityMatrixEngine(history, mockFetch(() => { throw new Error("Offline fixture"); }));
    history.replaceArenaRatings([], 42, "empty-fixture");
    await expect(engine.sync([])).rejects.toMatchObject({ code: -32011 });
    expect(history.listArenaRatings().source).toBe("builtin-seed");
    expect(history.listArenaRatings().entries).toHaveLength(BUILTIN_ARENA_SEED.length);
  });

  test("shares a concurrent download and prepares a snapshot for each caller", async () => {
    const requests: string[] = [];
    const fetcher = mockFeed({ "code.json": [{ model: "sync-fixture", score: 1400 }] }, { date }, arenaHost, requests);
    const engine = new CapabilityMatrixEngine(history, fetcher);
    const installed = [provider("fixture", { models: ["sync-fixture"] })];
    history.recordModelOutcome(project, "fixture", "sync-fixture", { verifyPassed: 2, verifyTotal: 2 });
    const [first, second] = await Promise.all([engine.sync(installed, project), engine.sync(installed, otherProject)]);
    expect(requests.filter((url) => url.endsWith("/latest.json"))).toHaveLength(1);
    expect(first.syncedAt).toBe(second.syncedAt);
    expect(first.models[0]?.localVerifyTotal).toBe(2);
    expect(second.models[0]?.localVerifyTotal).toBe(0);
  });

  test("renders complete Markdown lines within the UTF-8 budget", () => {
    const engine = new CapabilityMatrixEngine(history);
    const installed = [provider("codex", { name: "模型✨\n*Lab*", models: ["gpt-6.2-sol"] })];
    const snapshot = engine.snapshot(installed);
    const summary = engine.formatPromptSummary(snapshot);
    expect(summary).toContain("**code** · 模型✨ \\*Lab\\* / gpt-6.2-sol (medium, 1469 Elo)");
    expect(summary).toContain("**search**");
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1200);
    const first = summary.split("\n").slice(0, 2).join("\n");
    const budget = Buffer.byteLength(first);
    expect(engine.formatPromptSummary(snapshot, budget)).toBe(first);
    expect(Buffer.byteLength(engine.formatPromptSummary(snapshot, budget - 1))).toBeLessThan(budget);
    expect(engine.formatPromptSummary(snapshot, 0)).toBe("");
    expect(engine.formatPromptSummary(engine.snapshot([]))).toBe("");
  });
});
