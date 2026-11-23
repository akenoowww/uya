import { expect, test } from "bun:test";
import type { Provider } from "@ide/protocol";
import { matchSlashSuggestions, parseSlashInvocation } from "./slashCommands";
import { paneDisplayTitle, resolveModel, routingTargets } from "./workbenchStore";
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
  expect(matchSlashSuggestions("/mo").map((c) => c.name)).toEqual(["model"]);
  expect(parseSlashInvocation("/clear")).toEqual({
    command: expect.objectContaining({ name: "new" }),
    arg: "",
  });
  expect(parseSlashInvocation("/model claude-opus-4-6")).toEqual({
    command: expect.objectContaining({ name: "model" }),
    arg: "claude-opus-4-6",
  });
  expect(parseSlashInvocation("/unknown-prompt")).toBeNull();
});
