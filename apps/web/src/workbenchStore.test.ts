import { expect, test } from "bun:test";
import type { Provider, RunDetail } from "@ide/protocol";
import { parseAccessModeArg } from "./components/AccessModePicker";
import { parseEffortArg, resolveSupportedEfforts } from "./components/EffortPicker";
import { buildJudgePrompt, extractRunReplyText } from "./components/JudgeModal";
import { extractMentionQuery } from "./components/MentionMenu";
import { matchSlashSuggestions, parseSlashInvocation } from "./slashCommands";
import { clearTerminalSession, readLatestTerminalOutput, recordTerminalOutput, stripAnsi } from "./terminalBuffer";
import {
  estimateContextBudget, formatDurationCompact, paneDisplayTitle, resolveAccessMode,
  resolveModel, routingTargets,
} from "./workbenchStore";
import type { DockSnapshot } from "./workbenchStore";

const codex: Provider = {
  id: "codex", name: "Codex", kind: "cli", structured: true, terminal: true, available: true,
  models: ["gpt-6.2-sol", "gpt-6.2-astra"], defaultModel: "gpt-6.2-sol",
};
const claude: Provider = {
  id: "claude", name: "Claude Code", kind: "cli", structured: true, terminal: true, available: true,
  models: ["claude-sonnet-4-6", "claude-opus-4-6"],
};
const ollama: Provider = {
  id: "ollama", name: "Ollama", kind: "runtime", structured: true, terminal: true, available: true,
  models: ["llama3.2:latest", "qwen2.5-coder:7b"],
};

test("resolveModel allows CLI default, presets, and custom model IDs while confining local runtimes", () => {
  expect(resolveModel(codex, undefined)).toBeUndefined();
  expect(resolveModel(codex, "gpt-6.2-astra")).toBe("gpt-6.2-astra");
  expect(resolveModel(codex, "custom-model-v9")).toBe("custom-model-v9");
  expect(resolveModel(ollama, undefined)).toBe("llama3.2:latest");
  expect(resolveModel(ollama, "qwen2.5-coder:7b")).toBe("qwen2.5-coder:7b");
  expect(resolveModel(ollama, "deleted-model")).toBe("llama3.2:latest");
});

test("paneDisplayTitle reflects provider, model version, and terminal mode", () => {
  expect(paneDisplayTitle(codex, {}, 0)).toBe("Codex");
  expect(paneDisplayTitle(codex, { model: "gpt-6.2-sol" }, 0)).toBe("Codex · gpt-6.2-sol");
  expect(paneDisplayTitle(claude, { model: "anthropic/claude-opus-4-6" }, 1)).toBe("Claude Code · claude-opus-4-6");
  expect(paneDisplayTitle(codex, { mode: "terminal" }, 0)).toBe("Codex (TUI)");
});

test("routingTargets remembers lastChatPaneId and respects broadcast target subsets", () => {
  const dock: DockSnapshot = {
    chatPanes: [
      { id: "run-1", config: { providerId: "codex" } },
      { id: "run-2", config: { providerId: "claude" } },
    ],
    activePaneId: "editor:README.md",
    lastChatPaneId: "run-2",
  };
  const single = routingTargets([codex, claude], dock, false);
  expect(single.selected?.id).toBe("run-2");
  expect(single.destinations.map((p) => p.id)).toEqual(["run-2"]);

  const all = routingTargets([codex, claude], dock, true, []);
  expect(all.destinations.map((p) => p.id)).toEqual(["run-1", "run-2"]);

  const subset = routingTargets([codex, claude], dock, true, ["run-2"]);
  expect(subset.destinations.map((p) => p.id)).toEqual(["run-2"]);
});

test("slash command matching and parsing handles aliases and arguments", () => {
  expect(matchSlashSuggestions("/mo").map((c) => c.name)).toEqual(["mode", "model"]);
  expect(parseSlashInvocation("/clear")).toEqual({
    command: expect.objectContaining({ name: "new" }),
    arg: "",
  });
  expect(parseSlashInvocation("/model claude-opus-4-6")).toEqual({
    command: expect.objectContaining({ name: "model" }),
    arg: "claude-opus-4-6",
  });
  expect(parseSlashInvocation("/effort max")).toEqual({
    command: expect.objectContaining({ name: "effort" }),
    arg: "max",
  });
  expect(parseSlashInvocation("/judge")).toEqual({
    command: expect.objectContaining({ name: "judge" }),
    arg: "",
  });
  expect(parseSlashInvocation("/unknown-prompt")).toBeNull();
});

test("EffortPicker helpers resolve per-model efforts and parse user aliases", () => {
  const provider: Provider = {
    ...codex,
    supportedEfforts: ["low", "medium", "high"],
    modelEfforts: { "gpt-6.2-sol": ["low", "medium", "high", "xhigh", "max"] },
  };
  expect(resolveSupportedEfforts(provider, "gpt-6.2-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(resolveSupportedEfforts(provider, "other")).toEqual(["low", "medium", "high"]);
  expect(parseEffortArg("auto")).toBe("auto");
  expect(parseEffortArg("med")).toBe("medium");
  expect(parseEffortArg("min")).toBe("minimal");
  expect(parseEffortArg("xhigh")).toBe("xhigh");
  expect(parseEffortArg("invalid")).toBeNull();
});

test("extractMentionQuery detects @ mentions at start or after whitespace", () => {
  expect(extractMentionQuery("@git", 4)).toEqual({ start: 0, query: "git" });
  expect(extractMentionQuery("fix @src/App", 12)).toEqual({ start: 4, query: "src/App" });
  expect(extractMentionQuery("email user@example.com", 22)).toBeNull();
});

test("estimateContextBudget sums files, attachments, selection, and optional project rules", () => {
  const budget = estimateContextBudget({
    contextPaths: ["src/a.ts"],
    contextSizes: { "src/a.ts": 4000 },
    attachments: [{ path: "@git-diff", text: "a".repeat(2000) }],
    selection: { path: "src/a.ts", text: "b".repeat(1000), revision: "r1" },
    projectRules: [{ path: "AGENTS.md", bytes: 1000 }],
    includeProjectRules: true,
  });
  expect(budget.bytes).toBe(8000);
  expect(budget.approxTokens).toBe(2000);

  const withoutRules = estimateContextBudget({
    contextPaths: ["src/a.ts"],
    contextSizes: { "src/a.ts": 4000 },
    attachments: [],
    selection: null,
    projectRules: [{ path: "AGENTS.md", bytes: 1000 }],
    includeProjectRules: false,
  });
  expect(withoutRules.bytes).toBe(4000);
});

test("Judge helpers extract latest attempt text and format cross-review prompt", () => {
  const detail: RunDetail = {
    run: {
      id: "r1",
      providerId: "claude",
      providerName: "Claude Code",
      prompt: "Explain race condition",
      status: "succeeded",
      startedAt: 1000,
    },
    events: [
      { runId: "r1", seq: 1, type: "status", run: { id: "r1", providerId: "codex", prompt: "Explain race condition", status: "running", startedAt: 1000 } },
      { runId: "r1", seq: 2, type: "text", text: "stale attempt" },
      { runId: "r1", seq: 3, type: "status", run: { id: "r1", providerId: "claude", prompt: "Explain race condition", status: "running", startedAt: 1000 } },
      { runId: "r1", seq: 4, type: "text", text: "Final " },
      { runId: "r1", seq: 5, type: "text", text: "answer" },
    ],
  };
  expect(extractRunReplyText(detail)).toBe("Final answer");
  const prompt = buildJudgePrompt("review", "Explain race condition", [
    { label: "Claude Code", text: "Final answer" },
    { label: "Codex", text: "Second answer" },
  ]);
  expect(prompt).toContain("Original Request");
  expect(prompt).toContain("### Candidate 1: Claude Code");
  expect(prompt).toContain("### Candidate 2: Codex");

  const hugePrompt = buildJudgePrompt("synthesize", "Summarize", [
    { label: "A", text: "x".repeat(180_000) },
    { label: "B", text: "y".repeat(180_000) },
  ]);
  expect(hugePrompt.length).toBeLessThan(256_000);
  expect(hugePrompt).toContain("[...truncated for review budget...]");
});

test("terminalBuffer strips ANSI escape codes and tracks latest session output", () => {
  expect(stripAnsi("\x1b[31mError:\x1b[0m failed")).toBe("Error: failed");
  recordTerminalOutput("term-test-1", "Shell", "\x1b[32mPASS\x1b[0m line 1\r\nline 2\n");
  const snap = readLatestTerminalOutput();
  expect(snap?.title).toBe("Shell");
  expect(snap?.text).toBe("PASS line 1\nline 2");
  clearTerminalSession("term-test-1");
});

test("resolveAccessMode defaults workspace panes to read-only when supported and falls back to isolated", () => {
  const agentProvider: Provider = { ...codex, supportedModes: ["isolated", "read-only", "agent"] };
  const chatOnlyProvider: Provider = { ...ollama, supportedModes: ["isolated"] };

  expect(resolveAccessMode(agentProvider, undefined, true)).toBe("read-only");
  expect(resolveAccessMode(agentProvider, "agent", true)).toBe("agent");
  expect(resolveAccessMode(agentProvider, "agent", false)).toBe("isolated");
  expect(resolveAccessMode(chatOnlyProvider, "agent", true)).toBe("isolated");
  expect(parseAccessModeArg("explore")).toBe("read-only");
  expect(parseAccessModeArg("agent")).toBe("agent");
  expect(parseAccessModeArg("chat")).toBe("isolated");
  expect(parseAccessModeArg("invalid")).toBeUndefined();
});

test("formatDurationCompact formats sub-second ms and multi-second durations cleanly", () => {
  expect(formatDurationCompact(420)).toBe("420 ms");
  expect(formatDurationCompact(6686)).toBe("6.7 s");
});

test("v0.4.0 slash commands parse cleanly", () => {
  expect(parseSlashInvocation("/mode agent")).toEqual({
    command: expect.objectContaining({ name: "mode" }),
    arg: "agent",
  });
  expect(parseSlashInvocation("/arena on")).toEqual({
    command: expect.objectContaining({ name: "arena" }),
    arg: "on",
  });
  expect(parseSlashInvocation("/search worktree")).toEqual({
    command: expect.objectContaining({ name: "search" }),
    arg: "worktree",
  });
  expect(parseSlashInvocation("/verify bun test")).toEqual({
    command: expect.objectContaining({ name: "verify" }),
    arg: "bun test",
  });
  expect(parseSlashInvocation("/undo")).toEqual({
    command: expect.objectContaining({ name: "undo" }),
    arg: "",
  });
});
