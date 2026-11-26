import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcMethod, RpcParams, RpcResult, RunEvent } from "@ide/protocol";
import { startServer } from "./src/server";

const fixture = await mkdtemp(join(tmpdir(), "uya-smoke-"));
const bin = join(fixture, "bin");
const otherProject = join(fixture, "other-project");
await mkdir(bin);
await mkdir(otherProject);
await writeFile(join(bin, "codex"), `#!/bin/sh
set -eu
test -z "\${IDE_SESSION_TOKEN:-}"
test -z "\${IDE_DATA_DIR:-}"
input=$(/bin/cat)
case "$input" in
  *cancel*) exec /bin/sleep 30;;
  *fallback*)
    printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Discarded partial attempt"}}'
    /bin/sleep 0.5
    exit 3;;
esac
case " $* " in *" --sandbox read-only "*) ;; *) exit 5;; esac
case "$input" in
  *"follow up"*)
    case "$input" in *'"role":"assistant","content":"fixture Codex"'*'follow up'*) ;; *) exit 6;; esac
    case "$input" in *"attached context"*) exit 7;; esac;;
  *"attached context"*) ;;
  *) exit 8;;
esac
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"fixture Codex"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":21,"output_tokens":5}}'
`, { mode: 0o700 });
await writeFile(join(bin, "claude"), `#!/bin/sh
set -eu
input=$(/bin/cat)
case "$input" in
  *"after recovery"*)
    case "$input" in *'"role":"assistant","content":"fixture Claude"'*'after recovery'*) ;; *) exit 6;; esac
    case "$input" in *"Discarded partial attempt"*) exit 7;; esac;;
esac
case " $* " in *" --setting-sources user "*" --strict-mcp-config "*) ;; *) exit 5;; esac
printf '%s\n' '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"fixture "}}}'
printf '%s\n' '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Claude"}}}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"fixture Claude"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","usage":{"input_tokens":8,"output_tokens":3}}'
`, { mode: 0o700 });
await writeFile(join(fixture, "main.ts"), "const fixture = 'attached context';\n");

process.env.PATH = bin;
process.env.NO_PROXY = "127.0.0.1";
process.env.no_proxy = "127.0.0.1";
const token = crypto.randomUUID().replaceAll("-", "");
const options = {
  token,
  dataDir: join(fixture, "history"),
  globalPromptsDir: join(fixture, "prompts"),
  discoverRuntimeModels: async () => [],
  discoverLocalRuntimeModels: async () => [],
  discoverCliModels: async () => ({ models: [] }),
};
let server: ReturnType<typeof startServer> | undefined;

function request(method: string, params: unknown, auth = token, origin = "http://localhost:1420") {
  return fetch(`http://127.0.0.1:${server!.port}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
}

async function rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  const response = await request(method, params);
  assert.equal(response.status, 200);
  const result = await response.json() as { result: RpcResult<M>; error?: { message: string } };
  if (result.error) throw new Error(result.error.message);
  return result.result;
}

function stream(runId: string, after = 0): Promise<RunEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RunEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/stream`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for stream."));
    }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ token, runId, after }));
    ws.onmessage = (event) => events.push(JSON.parse(event.data));
    ws.onclose = (event) => {
      clearTimeout(timer);
      if (event.code === 1000 || event.code === 1005) resolve(events);
      else reject(new Error(`Stream closed with status ${event.code}.`));
    };
  });
}

try {
  server = startServer(options);
  assert.equal((await request("providers.list", {}, "fixture-invalid-token")).status, 401);
  assert.equal((await request("providers.list", {}, token, "https://fixture.invalid")).status, 403);
  assert.equal((await request("providers.list", {})).headers.get("Access-Control-Allow-Origin"), "http://localhost:1420");
  const providers = await rpc("providers.list", {});
  assert.deepEqual(providers.filter(({ structured }) => structured).map(({ id }) => id), ["codex", "claude"]);
  assert.equal(providers.find(({ id }) => id === "codex")?.command, join(bin, "codex"));
  assert.equal(providers.find(({ id }) => id === "claude")?.command, join(bin, "claude"));
  const terminal = await rpc("providers.add", { name: "Fixture terminal", command: "codex", args: ["some; literal argument"] });
  assert.equal(terminal.structured, false);
  assert.deepEqual(terminal.terminalArgs, ["some; literal argument"]);

  const project = await rpc("workspace.open", { path: fixture });
  const conversationId = "fixture-conversation";
  await rpc("runs.setRules", { rules: [{ extension: "ts", minContextChars: 10, tag: "review", providerId: "codex" }] });
  const selected = await rpc("workspace.read", { path: "main.ts" });
  const routed = await rpc("runs.start", {
    mode: "rule", providerId: "claude", tags: ["review"], prompt: "review",
    conversationId, workspacePath: project.path,
    selection: { ...selected, text: "attached context" }, promptVersion: "fixture-v1",
  });
  assert.equal(routed.providerId, "codex");
  const routedEvents = await stream(routed.id);
  assert.deepEqual(routedEvents.map(({ seq }) => seq), [1, 2, 3]);
  assert.equal(routedEvents[1]!.type, "text");
  const routedRun = await rpc("runs.get", { id: routed.id });
  assert.equal(routedRun.run.status, "succeeded");
  assert.equal(routedRun.run.promptVersion, "fixture-v1");
  assert.equal(routedRun.run.inputTokens, 21);
  assert.equal(typeof routedRun.run.ttftMs, "number");
  assert.deepEqual(await stream(routed.id, 2), [routedEvents[2]]);
  const followup = await rpc("runs.start", { providerId: "codex", conversationId, workspacePath: project.path, prompt: "follow up" });
  await stream(followup.id);
  assert.equal((await rpc("runs.get", { id: followup.id })).run.status, "succeeded");

  const switched = await rpc("workspace.open", { path: otherProject });
  assert.deepEqual(await rpc("runs.conversation", { id: conversationId, workspacePath: switched.path }), []);
  await assert.rejects(rpc("workspace.read", { path: "main.ts", workspacePath: project.path }), /workspace changed/);
  await assert.rejects(rpc("runs.start", { conversationId, workspacePath: project.path, prompt: "stale project" }), /workspace changed/);
  await rpc("workspace.open", { path: fixture });

  const fallbackConversation = "fixture-fallback";
  const fallback = await rpc("runs.start", { providerId: "codex", mode: "fallback", fallbackIds: ["claude"], prompt: "fallback", conversationId: fallbackConversation });
  const fallbackEvents = await stream(fallback.id);
  assert.equal(fallbackEvents.filter(({ type }) => type === "tool").length, 2);
  assert.deepEqual(fallbackEvents.flatMap((event) => event.type === "text" ? [event.text] : []), ["Discarded partial attempt", "fixture ", "Claude"]);
  const fallbackRun = await rpc("runs.get", { id: fallback.id });
  assert.equal(fallbackRun.run.providerId, "claude");
  assert.equal(fallbackRun.run.exitCode, 0);
  assert.ok(fallbackRun.run.finishedAt! - fallbackRun.run.startedAt - fallbackRun.run.ttftMs! >= 450,
    "TTFT must exclude the failed primary attempt");
  const recovered = await rpc("runs.start", { providerId: "claude", conversationId: fallbackConversation, prompt: "after recovery" });
  await stream(recovered.id);
  assert.equal((await rpc("runs.get", { id: recovered.id })).run.status, "succeeded");

  const cancel = await rpc("runs.start", { providerId: "codex", prompt: "cancel", conversationId });
  await assert.rejects(rpc("runs.start", { providerId: "codex", prompt: "second", conversationId }), /current turn/);
  const cancelledEvents = stream(cancel.id);
  await rpc("runs.cancel", { id: cancel.id });
  await cancelledEvents;
  assert.equal((await rpc("runs.get", { id: cancel.id })).run.status, "cancelled");

  await server.close();
  server = startServer(options);
  assert.equal((await rpc("runs.list", {})).length, 5);
  assert.deepEqual(await rpc("runs.conversation", { id: conversationId, workspacePath: null }), []);
  await rpc("workspace.open", { path: fixture });
  assert.deepEqual((await rpc("runs.conversation", { id: conversationId, workspacePath: project.path })).map(({ run }) => run.id),
    [routed.id, followup.id, cancel.id]);
  assert.equal((await rpc("runs.getRules", {}))[0]?.providerId, "codex");
  assert.equal((await rpc("providers.list", {})).find(({ id }) => id === terminal.id)?.available, true);
  const edited = await rpc("providers.update", { id: terminal.id, name: "Renamed terminal", command: "claude", args: [] });
  assert.equal(edited.id, terminal.id);
  assert.equal((await rpc("providers.list", { refresh: true })).find(({ id }) => id === terminal.id)?.name, "Renamed terminal");
  await rpc("runs.setRules", { rules: [{ providerId: terminal.id }, { providerId: "codex" }] });
  await rpc("providers.remove", { id: terminal.id });
  assert.equal((await rpc("providers.list", {})).some(({ id }) => id === terminal.id), false);
  assert.deepEqual((await rpc("runs.getRules", {})).map(({ providerId }) => providerId), ["codex"]);
  await assert.rejects(rpc("providers.remove", { id: "codex" }), /Custom provider not found/);

  // v0.4.0 end-to-end smoke: code search, verify runner, checkpoints & restore, and session close.
  const searchRes = await rpc("workspace.search", { query: "attached context", glob: "*.ts", workspacePath: project.path });
  assert.equal(searchRes.totalMatches, 1);
  assert.equal(searchRes.files[0]?.path, "main.ts");

  const verifyRun = await rpc("verify.start", { command: "echo smoke-verify-ok", workspacePath: project.path });
  let verified = verifyRun;
  for (let i = 0; i < 40 && verified.status === "running"; i++) {
    await Bun.sleep(25);
    verified = await rpc("verify.get", { id: verifyRun.id });
  }
  assert.equal(verified.status, "passed");
  assert.ok(verified.output.includes("smoke-verify-ok"));

  await rpc("runs.closeSession", { conversationId, workspacePath: project.path });
  assert.deepEqual(await rpc("checkpoints.list", { workspacePath: project.path }), []);

  // v0.5.0 Uya Synapse smoke: Living Capability Matrix, Secret Vault & Hub, Missions, Binary read, and /mcp auth.
  const matrixSnap = await rpc("synapse.matrix", { workspacePath: project.path });
  assert.ok(matrixSnap.entriesCount > 0, "Matrix must seed Arena Elo benchmarks");
  assert.ok(matrixSnap.models.length >= 2, "Matrix must score installed structured providers");
  const rec = await rpc("synapse.recommend", { domain: "code", workspacePath: project.path });
  assert.ok(rec && (rec.providerId === "codex" || rec.providerId === "claude"));

  const caps = await rpc("capabilities.list", { workspacePath: project.path });
  assert.ok(caps.some((pack) => pack.id === "elevenlabs-tts"));
  assert.ok(caps.some((pack) => pack.id === "suno-music"));
  assert.ok(caps.some((pack) => pack.id === "fal-image"));
  const secretState = await rpc("capabilities.setSecret", { key: "ELEVENLABS_API_KEY", value: "sk-smoke-secret-value" });
  assert.deepEqual(secretState.configuredKeys, ["ELEVENLABS_API_KEY"]);
  const capsAfterSecret = await rpc("capabilities.list", { workspacePath: project.path });
  const eleven = capsAfterSecret.find((pack) => pack.id === "elevenlabs-tts");
  assert.equal(eleven?.enabled, true, "Built-in pack auto-enables once its vault secret is configured");
  assert.deepEqual(eleven?.configuredSecrets, ["ELEVENLABS_API_KEY"]);

  assert.deepEqual(await rpc("missions.list", { workspacePath: project.path }), []);
  const binRead = await rpc("workspace.readBinary", { path: "main.ts", workspacePath: project.path });
  assert.ok(Buffer.from(binRead.base64, "base64").toString("utf8").includes("attached context"));

  const unauthMcp = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(unauthMcp.status, 401);

  console.log("Core smoke passed: authentication, scoped conversations, streaming, fallback TTFT, cancellation, persistence, search, verify, Synapse matrix/hub/MCP, and provider CRUD.");
} finally {
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
}
