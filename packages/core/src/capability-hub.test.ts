import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityPack, CapabilityRestSpec } from "@ide/protocol";
import { BUILTIN_CAPABILITIES, CapabilityHub, SecretVault, validateCapabilityUrl } from "./capability-hub";
import { History } from "./history";
import type { AdapterApprovalPrompt } from "./provider-adapter";
import { RpcError } from "./validation";
import { MAX_BINARY_BYTES, readBinary, writeBinaryFile } from "./workspace-files";

const TOKEN = "synthetic-capability-token";
const REQUEST_URL = "https://capabilities.example.com/generate";
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temporaryDirectory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "uya-capability-test-")));
  cleanups.push(() => rmSync(path, { force: true, recursive: true }));
  return path;
}

function controlledDeadline(expectedMs: number) {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === expectedMs ? controller.signal : timeout(ms));
  cleanups.push(() => spy.mockRestore());
  return { controller, spy };
}

type SeenRequest = {
  url: string;
  method: string;
  body: string | undefined;
  headers: Headers;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | null | undefined;
};

function setup(handle?: (request: SeenRequest, index: number) => Response | Promise<Response>) {
  const root = temporaryDirectory();
  const dataDir = join(root, "data");
  const workspacePath = join(root, "project");
  mkdirSync(workspacePath);
  const history = new History(dataDir);
  cleanups.push(() => history.close());
  const requests: SeenRequest[] = [];
  const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!handle) throw new Error("Unexpected network request");
    const request = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      signal: init?.signal,
    };
    requests.push(request);
    return handle(request, requests.length - 1);
  }, { preconnect: () => undefined });
  const hub = new CapabilityHub(dataDir, history, fetcher);
  const fileContext = { workspacePath, writeWorkspaceBinary: (path: string, data: Uint8Array) => writeBinaryFile(workspacePath, path, data) };
  return { hub, dataDir, workspacePath, history, requests, fileContext };
}

function builtin(id: string): CapabilityPack {
  const pack = BUILTIN_CAPABILITIES.find((entry) => entry.id === id);
  if (!pack) throw new Error(`Missing builtin fixture ${id}`);
  return structuredClone(pack);
}

function restPack(rest: Partial<CapabilityRestSpec> = {}, pack: Partial<CapabilityPack> = {}): CapabilityPack {
  return {
    id: "custom-rest", name: "Custom REST", description: "Synthetic REST capability.", domain: "text",
    kind: "rest", enabled: true, requiresApproval: false, secretKeys: [],
    rest: { url: REQUEST_URL, method: "POST", inputSchema: [], outputKind: "text", ...rest },
    ...pack,
  };
}

function mcpPack(kind: "mcp-http" | "mcp-stdio", mcp: NonNullable<CapabilityPack["mcp"]>): CapabilityPack {
  return { id: kind, name: "Fixture MCP", description: "Synthetic MCP capability.", domain: "text", kind, mcp,
    enabled: true, requiresApproval: true, secretKeys: [],
  };
}

function reply(id: number, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

describe("SecretVault", () => {
  test("persists key names and atomically replaces an owner-only file on every write", async () => {
    const dataDir = join(temporaryDirectory(), "data");
    const path = join(dataDir, "capability-secrets.json");
    const vault = new SecretVault(dataDir);
    expect(vault.configuredKeys()).toEqual([]);
    expect(vault.get("MISSING_KEY")).toBeUndefined();
    expect(await vault.set("Z_KEY", `quote "\n${TOKEN}`)).toEqual(["Z_KEY"]);
    const first = statSync(path);
    expect(await vault.set("A_KEY", "other-fixture-token")).toEqual(["A_KEY", "Z_KEY"]);
    const second = statSync(path);
    if (process.platform !== "win32") {
      expect(first.mode & 0o777).toBe(0o600);
      expect(second.mode & 0o777).toBe(0o600);
      expect(second.ino).not.toBe(first.ino);
    }
    const reopened = new SecretVault(dataDir);
    expect(reopened.configuredKeys()).toEqual(["A_KEY", "Z_KEY"]);
    expect(reopened.get("Z_KEY")).toBe(`quote "\n${TOKEN}`);
    expect(await reopened.set("Z_KEY", "")).toEqual(["A_KEY"]);
    expect(await vault.set("A_KEY", null)).toEqual([]);
    expect(reopened.get("A_KEY")).toBeUndefined();
    expect(readdirSync(dataDir)).toEqual(["capability-secrets.json"]);
  });

  test("serializes simultaneous writes across vault instances and rejects invalid key names", async () => {
    const dataDir = temporaryDirectory();
    const vault = new SecretVault(dataDir);
    const concurrent = new SecretVault(dataDir);
    await Promise.all([vault.set("SECOND_KEY", TOKEN), concurrent.set("FIRST_KEY", "another-fixture-token")]);
    expect(vault.configuredKeys()).toEqual(["FIRST_KEY", "SECOND_KEY"]);
    for (const key of ["x", "X", "1_TOKEN", "KEY-NAME", "BAD_KEY\n", "X".repeat(65)]) {
      await expect(vault.set(key, TOKEN)).rejects.toMatchObject({ code: -32602, message: "Secret key must use UPPER_SNAKE_CASE." });
    }
    expect(vault.configuredKeys()).toEqual(["FIRST_KEY", "SECOND_KEY"]);
  });

  test.skipIf(process.platform === "win32")("fails closed for broad permissions, symlinks and malformed vault data", async () => {
    const dir = temporaryDirectory();
    const path = join(dir, "capability-secrets.json");
    const vault = new SecretVault(dir);
    await vault.set("FIXTURE_KEY", TOKEN);
    chmodSync(path, 0o644);
    expect(() => vault.configuredKeys()).toThrow("Could not read the capability secret vault.");
    await expect(vault.set("FIXTURE_KEY", "new-test-token")).rejects.toMatchObject({ code: -32011 });

    rmSync(path);
    const fixture = join(dir, "synthetic.json");
    writeFileSync(fixture, `invalid JSON with ${TOKEN}`, { mode: 0o600 });
    symlinkSync(fixture, path);
    expect(() => vault.get("FIXTURE_KEY")).toThrow("Could not read the capability secret vault.");
    rmSync(path);
    writeFileSync(path, `invalid JSON with ${TOKEN}`, { mode: 0o600 });
    expect(() => vault.get("FIXTURE_KEY")).toThrow("Could not read the capability secret vault.");
  });
});

describe("pack discovery and approval", () => {
  test("lists four disabled builtins, activates fully configured defaults and preserves explicit disables", async () => {
    const { hub } = setup();
    const packs = await hub.list();
    expect(packs.map(({ id, name, rest }) => [id, name, rest?.outputKind])).toEqual([
      ["elevenlabs-tts", "ElevenLabs Voiceover", "audio"], ["suno-music", "Suno Music Generator", "audio"],
      ["fal-image", "fal.ai FLUX Image", "image"], ["openai-speech", "OpenAI Speech TTS", "audio"],
    ]);
    expect(packs.every((pack) => pack.builtin && pack.scope === "builtin" && pack.requiresApproval && !pack.enabled &&
      pack.configuredSecrets?.length === 0)).toBe(true);
    expect(await hub.setSecret("SUNO_API_KEY", TOKEN)).toEqual({ configuredKeys: ["SUNO_API_KEY"] });
    expect((await hub.list()).find((pack) => pack.id === "suno-music")).toMatchObject({ enabled: false, configuredSecrets: ["SUNO_API_KEY"] });
    await hub.setSecret("SUNO_BASE_URL", "http://localhost:3001");
    const enabled = (await hub.list()).find((pack) => pack.id === "suno-music");
    expect(enabled).toMatchObject({ enabled: true, configuredSecrets: ["SUNO_API_KEY", "SUNO_BASE_URL"] });
    expect(JSON.stringify(enabled)).not.toContain(TOKEN);
    await hub.save({ ...builtin("suno-music"), enabled: false });
    await hub.setSecret("SUNO_API_KEY", "rotated-fixture-token");
    expect((await hub.list()).find((pack) => pack.id === "suno-music")?.enabled).toBe(false);
    await hub.remove("suno-music");
    expect((await hub.list()).find((pack) => pack.id === "suno-music")?.enabled).toBe(true);
    await hub.setSecret("SUNO_API_KEY", null);
    expect((await hub.list()).find((pack) => pack.id === "suno-music")?.enabled).toBe(false);
  });

  test("merges only builtin overrides, saves global packs and removes both kinds correctly", async () => {
    const { hub, history } = setup();
    const original = builtin("openai-speech");
    const override = restPack({ url: "https://override.example.com/speak", outputKind: "audio" }).rest;
    const saved = await hub.save({ ...original, name: "Spoofed", enabled: true, builtin: false, scope: "global", domain: "text",
      requiresApproval: false, secretKeys: [], configuredSecrets: ["FAKE_KEY"], rest: override, mcp: { url: REQUEST_URL },
    });
    expect(saved).toMatchObject({ name: original.name, enabled: true, builtin: true, scope: "builtin", domain: "audio",
      requiresApproval: true, secretKeys: ["OPENAI_API_KEY"], configuredSecrets: [], rest: override, mcp: { url: REQUEST_URL },
    });
    expect(history.listSavedCapabilities()[0]?.configuredSecrets).toBeUndefined();
    const global = await hub.save(restPack({}, { builtin: true, scope: "project", configuredSecrets: ["FAKE_KEY"] }));
    expect(global).toMatchObject({ builtin: false, scope: "global", configuredSecrets: [] });
    if (saved.rest) saved.rest.url = "https://changed.example.com/";
    expect((await hub.list()).find((pack) => pack.id === saved.id)?.rest).toEqual(override);
    await hub.remove(original.id);
    expect((await hub.list()).find((pack) => pack.id === original.id)).toEqual({ ...original, configuredSecrets: [] });
    await hub.remove(global.id);
    expect((await hub.list()).some((pack) => pack.id === global.id)).toBe(false);
    await expect(hub.remove(global.id)).rejects.toMatchObject({ code: -32004 });
  });

  test("loads confined project JSON, ignores invalid files and keeps trusted IDs and approval requirements", async () => {
    const { hub, workspacePath, requests } = setup(() => new Response(`ok ${TOKEN}`));
    const directory = join(workspacePath, ".uya", "capabilities");
    mkdirSync(directory, { recursive: true });
    await hub.save(restPack());
    await hub.setSecret("PROJECT_TOKEN", TOKEN);
    const project = restPack({ headers: { Authorization: "Bearer {{PROJECT_TOKEN}}" } }, {
      id: "project-pack", builtin: true, scope: "global", requiresApproval: false, secretKeys: ["PROJECT_TOKEN"],
    });
    writeFileSync(join(directory, "project.json"), JSON.stringify(project));
    writeFileSync(join(directory, "malformed.json"), "{");
    writeFileSync(join(directory, "invalid.json"), JSON.stringify({ ...project, id: "invalid", rest: null }));
    writeFileSync(join(directory, "userinfo.json"), JSON.stringify(restPack({ url: `https://user:${TOKEN}@example.com` }, { id: "bad-url" })));
    writeFileSync(join(directory, "builtin.json"), JSON.stringify({ ...project, id: "openai-speech" }));
    writeFileSync(join(directory, "collision.json"), JSON.stringify({ ...project, id: "custom-rest" }));
    if (process.platform !== "win32") {
      const outside = join(temporaryDirectory(), "outside.json");
      writeFileSync(outside, JSON.stringify({ ...project, id: "symlink-pack" }));
      symlinkSync(outside, join(directory, "linked.json"));
    }
    const packs = await hub.list(workspacePath);
    expect(packs).toHaveLength(6);
    expect(packs.find((pack) => pack.id === "openai-speech")?.scope).toBe("builtin");
    expect(packs.find((pack) => pack.id === "custom-rest")?.scope).toBe("global");
    expect(packs.find((pack) => pack.id === project.id)).toMatchObject({
      scope: "project", builtin: false, requiresApproval: true, configuredSecrets: ["PROJECT_TOKEN"],
    });
    expect((await hub.list()).some((pack) => pack.id === project.id)).toBe(false);
    await expect(hub.invoke(project.id, {}, {})).rejects.toMatchObject({ code: -32004 });
    await expect(hub.invoke(project.id, {}, { workspacePath })).rejects.toThrow("Approval is required");
    expect(requests).toHaveLength(0);
    const result = await hub.invoke(project.id, {}, { workspacePath, requestApproval: async () => "allow_once" });
    expect(result.text).toBe("ok [redacted]");
  });

  test("requires enabled packs, configured keys and a positive approval before any I/O", async () => {
    const { hub, requests } = setup(() => new Response("approved"));
    await expect(hub.invoke("unknown", {}, {})).rejects.toMatchObject({ code: -32004 });
    await expect(hub.invoke("openai-speech", { text: "Hello" }, {})).rejects.toThrow("Enable the capability");
    await expect(hub.invoke("openai-speech", { text: "Hello" }, { bypassApproval: true })).rejects.toMatchObject({
      code: -32004, message: "Configure secret OPENAI_API_KEY in Capability Hub before running OpenAI Speech TTS.",
    });
    await hub.save(restPack({}, { requiresApproval: true }));
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("Approval is required");
    await expect(hub.invoke("custom-rest", {}, { requestApproval: async () => "reject" })).rejects.toThrow("approval was denied");
    await expect(hub.invoke("custom-rest", {}, { requestApproval: async () => { throw new RpcError(-32603, TOKEN); } }))
      .rejects.toThrow("Capability approval failed.");
    expect(requests).toHaveLength(0);
    expect(await hub.invoke("custom-rest", {}, { requestApproval: async () => "allow_session" })).toEqual({ text: "approved" });
    await hub.save(restPack({}, { enabled: false, requiresApproval: true }));
    expect(await hub.invoke("custom-rest", {}, { bypassApproval: true })).toEqual({ text: "approved" });
    expect(requests).toHaveLength(2);
  });

  test("cancels during approval without dispatching the call", async () => {
    const { hub, requests } = setup(() => new Response("unexpected"));
    await hub.save(restPack({}, { requiresApproval: true }));
    const controller = new AbortController();
    const result = hub.invoke("custom-rest", {}, {
      signal: controller.signal,
      requestApproval: async () => {
        controller.abort(TOKEN);
        return "allow_once";
      },
    });
    await expect(result).rejects.toThrow("Capability invocation was cancelled.");
    expect(requests).toHaveLength(0);
  });

  test("requires a new invocation when a credential changes during approval", async () => {
    const { hub, requests } = setup(() => new Response("unexpected"));
    await hub.setSecret("FIXTURE_KEY", TOKEN);
    await hub.save(restPack({ headers: { "X-Token": "{{FIXTURE_KEY}}" } }, { requiresApproval: true, secretKeys: ["FIXTURE_KEY"] }));
    await expect(hub.invoke("custom-rest", {}, {
      requestApproval: async () => {
        await hub.setSecret("FIXTURE_KEY", "synthetic-rotated-token");
        return "allow_once";
      },
    })).rejects.toThrow("Capability credentials changed. Run the capability again.");
    expect(requests).toHaveLength(0);
  });
});

describe("HTTP destination and template safety", () => {
  test("allows public HTTPS and explicitly configured localhost HTTP, rejecting unsafe destinations", () => {
    expect(validateCapabilityUrl("https://www.example.com/action?a=1", false).hostname).toBe("www.example.com");
    expect(validateCapabilityUrl("https://1.1.1.1/", false).hostname).toBe("1.1.1.1");
    expect(validateCapabilityUrl("https://[2606:4700:4700::1111]/", false).protocol).toBe("https:");
    expect(validateCapabilityUrl("http://localhost:3001/generate", true).hostname).toBe("localhost");
    expect(validateCapabilityUrl("http://127.0.0.1:3001/generate", true).hostname).toBe("127.0.0.1");
    expect(validateCapabilityUrl("https://10.0.0.1/", true).hostname).toBe("10.0.0.1");
    for (const url of [
      "https://LOCALHOST./", "https://a.localhost/", "https://127.5.3.1/", "https://0.0.0.0", "https://10.0.0.9/",
      "https://192.168.0.1/", "https://169.254.169.254/", "https://172.16.0.1/", "https://172.31.255.255/",
      "https://printer.local/", "https://host.INTERNAL./", "https://[::1]/", "https://[::ffff:127.0.0.1]/",
      "https://[fc00::1]/", "https://[fe80::1]/", "https://2130706433/", "http://localhost", "file:///tmp/fixture",
    ]) expect(() => validateCapabilityUrl(url, false)).toThrow(RpcError);
    for (const url of ["http://public.example.com", "http://127.0.0.2", "http://[::1]", "http://192.168.0.1"]) {
      expect(() => validateCapabilityUrl(url, true)).toThrow(RpcError);
    }
    expect(() => validateCapabilityUrl(`https://user:${TOKEN}@example.com`, true))
      .toThrow("Capability URL must be an absolute HTTP(S) URL without credentials.");
  });

  test("quotes body values, applies typed defaults, and percent-encodes URL segments and query values", async () => {
    const { hub, requests } = setup(() => Response.json({ text: `echo ${TOKEN}` }));
    await hub.setSecret("FIXTURE_KEY", TOKEN);
    const pack = restPack({
      url: "https://example.com/items/{{slug}}?key={{FIXTURE_KEY}}&prompt={{prompt}}",
      headers: { "X-Api-Key": "{{FIXTURE_KEY}}" },
      bodyTemplate: '{"prompt":{{prompt}},"speed":{{speed}},"active":{{active}},"mode":{{mode}},"note":{{note}}}',
      inputSchema: [
        { name: "prompt", description: "Fixture prompt", type: "string", required: true },
        { name: "speed", description: "Fixture speed", type: "number", default: 2 },
        { name: "active", description: "Fixture switch", type: "boolean", default: false },
        { name: "mode", description: "Fixture mode", type: "string", default: "fast", enum: ["fast", "slow"] },
      ],
      outputKind: "json", responsePath: "text",
    }, { secretKeys: ["FIXTURE_KEY"] });
    await hub.save(pack);
    const prompt = 'Value "\n, "injected":true, {{FIXTURE_KEY}}';
    await expect(hub.invoke(pack.id, {}, {})).rejects.toThrow("Capability input prompt is required.");
    await expect(hub.invoke(pack.id, { prompt, speed: "2" }, {})).rejects.toThrow("Capability input speed must be a number.");
    await expect(hub.invoke(pack.id, { prompt, mode: "wrong" }, {})).rejects.toThrow("Capability input mode is not an allowed option.");
    expect(requests).toHaveLength(0);
    expect(await hub.invoke(pack.id, { prompt, slug: "route/other?test=1" }, {})).toEqual({ text: "echo [redacted]" });
    expect(requests[0]).toMatchObject({ method: "POST", redirect: "error" });
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/items/route%2Fother%3Ftest%3D1");
    expect(url.searchParams.get("key")).toBe(TOKEN);
    expect(url.searchParams.get("prompt")).toBe(prompt);
    expect(requests[0].headers.get("x-api-key")).toBe(TOKEN);
    expect(JSON.parse(requests[0].body ?? "")).toEqual({ prompt, speed: 2, active: false, mode: "fast", note: null });
  });

  test("rejects undeclared secrets, templated authority, restricted headers and secret-bearing bodies", async () => {
    const { hub, requests } = setup(() => new Response("unexpected"));
    await hub.setSecret("FIXTURE_KEY", TOKEN);
    const specs: Partial<CapabilityRestSpec>[] = [
      { headers: { Authorization: "Bearer {{FIXTURE_KEY}}" } },
      { url: "https://{{host}}/" },
      { headers: { Host: "example.com" } },
      { bodyTemplate: '{"key":{{FIXTURE_KEY}}}' },
      { bodyTemplate: '{"value":"{{prompt}}"}' },
    ];
    for (const [index, spec] of specs.entries()) {
      const pack = restPack(spec, { secretKeys: index === 3 ? ["FIXTURE_KEY"] : [] });
      await hub.save(pack);
      await expect(hub.invoke(pack.id, { host: "example.com", prompt: "quote\"" }, {})).rejects.toMatchObject({ code: -32602 });
    }
    expect(requests).toHaveLength(0);
  });

  test("blocks local endpoints from project packs even with a configured credential", async () => {
    const { hub, workspacePath, requests } = setup(() => new Response("unexpected"));
    const directory = join(workspacePath, ".uya", "capabilities");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "local-pack.json"), JSON.stringify(restPack({ url: "{{FIXTURE_BASE_URL}}/run" }, {
      secretKeys: ["FIXTURE_BASE_URL"],
    })));
    await hub.setSecret("FIXTURE_BASE_URL", "http://localhost:8000");
    await expect(hub.invoke("custom-rest", {}, { workspacePath, requestApproval: async () => "allow_once" })).rejects.toThrow("public HTTPS");
    expect(requests).toHaveLength(0);
  });

  test("redacts raw and URL-encoded credentials from text and clips at 32 KiB of whole UTF-8", async () => {
    const secret = "sample-value &+ /?";
    const payload = `A ${secret} ${encodeURIComponent(secret)} ${"🙂".repeat(20_000)}`;
    const { hub } = setup(() => new Response(payload));
    await hub.setSecret("FIXTURE_KEY", secret);
    await hub.save(restPack());
    const { text } = await hub.invoke("custom-rest", {}, {});
    expect(text.startsWith("A [redacted] [redacted] ")).toBe(true);
    expect(text).not.toContain("\uFFFD");
    expect(Buffer.byteLength(text)).toBeGreaterThan(32 * 1024 - 4);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024);
  });

  test("does not expose provider errors, rejected URLs or interpolated headers", async () => {
    const { hub, requests } = setup(() => { throw new RpcError(-32603, `Provider failed with ${TOKEN}`); });
    await hub.setSecret("FIXTURE_KEY", TOKEN);
    await hub.save(restPack({ url: "https://example.com/{{FIXTURE_KEY}}", headers: { Authorization: "Bearer {{FIXTURE_KEY}}" } }, {
      secretKeys: ["FIXTURE_KEY"],
    }));
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("Capability network request failed.");
    expect(requests[0].url).toContain(TOKEN);
    await expect(hub.save(restPack({ url: `https://user:${TOKEN}@example.com` })))
      .rejects.toThrow("Capability URL must be an absolute HTTP(S) URL without credentials.");
    await hub.setSecret("FIXTURE_URL", `https://user:${TOKEN}@example.com`);
    await hub.save(restPack({ url: "{{FIXTURE_URL}}" }, { secretKeys: ["FIXTURE_URL"] }));
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("Capability URL must be an absolute HTTP(S) URL without credentials.");
    await hub.setSecret("FIXTURE_KEY", `${TOKEN}\r\n`);
    await hub.save(restPack({ headers: { Authorization: "Bearer {{FIXTURE_KEY}}" } }, { secretKeys: ["FIXTURE_KEY"] }));
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("Capability request header is invalid.");
    expect(requests).toHaveLength(1);
  });
});

describe("REST outputs", () => {
  test("saves ElevenLabs bytes through the workspace writer with defaults and an approval prompt", async () => {
    const data = Uint8Array.of(4, 6, 10, 12);
    const { hub, requests, fileContext, workspacePath } = setup(() => new Response(data));
    const approvals: AdapterApprovalPrompt[] = [];
    await hub.setSecret("ELEVENLABS_API_KEY", TOKEN);
    const text = 'Literal "quotes"\nsecond line';
    const { artifact, text: summary } = await hub.invoke("elevenlabs-tts", { text }, {
      ...fileContext,
      requestApproval: async (prompt) => {
        approvals.push(prompt);
        return "allow_once";
      },
    });
    expect(requests[0]).toMatchObject({ url: "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb", method: "POST" });
    expect(requests[0].headers.get("xi-api-key")).toBe(TOKEN);
    expect(requests[0].headers.get("accept")).toBe("audio/mpeg");
    expect(JSON.parse(requests[0].body ?? "")).toEqual({ text, model_id: "eleven_multilingual_v2" });
    expect(artifact).toMatchObject({ kind: "audio", bytes: 4, mimeType: "audio/mpeg", sourceId: "elevenlabs-tts", label: "ElevenLabs Voiceover" });
    const path = artifact?.path ?? "";
    expect(path).toMatch(/^assets\/audio\/voice-\d+\.mp3$/u);
    expect(summary).toBe(`Generated audio saved to ${path} (4 bytes).`);
    expect((await readBinary(workspacePath, path)).base64).toBe(Buffer.from(data).toString("base64"));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolName: "elevenlabs-tts", toolKind: "fetch", path });
    expect(JSON.stringify(approvals)).not.toContain(TOKEN);
  });

  test("renders OpenAI speech defaults and honors a trimmed path override", async () => {
    const { hub, requests, fileContext } = setup(() => new Response(Uint8Array.of(1, 2), { headers: { "Content-Type": "audio/wav" } }));
    await hub.setSecret("OPENAI_API_KEY", TOKEN);
    const result = await hub.invoke("openai-speech", { text: "Fixture speech", output_path: "  assets/example.wav " }, { ...fileContext, bypassApproval: true });
    expect(requests[0].url).toBe("https://api.openai.com/v1/audio/speech");
    expect(requests[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(requests[0].body ?? "")).toEqual({ model: "gpt-4o-mini-tts", voice: "alloy", input: "Fixture speech" });
    expect(result.artifact).toMatchObject({ path: "assets/example.wav", mimeType: "audio/wav", bytes: 2 });
  });

  test("uses a configured Suno base URL and downloads same-origin audio", async () => {
    const base = "http://127.0.0.1:8311/fixture/";
    const audioUrl = "http://127.0.0.1:8311/fixture/audio.mp3";
    const { hub, fileContext, requests } = setup((_request, index) => index === 0
      ? Response.json({ audio_url: audioUrl })
      : new Response(Uint8Array.of(8, 4)));
    await hub.setSecret("SUNO_BASE_URL", base);
    await hub.setSecret("SUNO_API_KEY", TOKEN);
    const result = await hub.invoke("suno-music", { prompt: "Ambient instrumental" }, {
      ...fileContext,
      requestApproval: async (prompt) => {
        expect(prompt.detail).toContain("configured endpoint");
        expect(prompt.detail).not.toContain(base);
        return "allow_once";
      },
    });
    expect(requests.map(({ url, method }) => [url, method])).toEqual([[`${base}api/v1/generate`, "POST"], [audioUrl, "GET"]]);
    expect(JSON.parse(requests[0].body ?? "")).toEqual({ prompt: "Ambient instrumental", instrumental: false, customMode: false });
    expect(requests[1].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(result.artifact?.path).toMatch(/^assets\/audio\/music-\d+\.mp3$/u);
  });

  test("extracts fal.ai's nested URL and fetches the CDN without provider headers", async () => {
    const download = "https://cdn.example.com/flux.png?signature=synthetic";
    const { hub, fileContext, requests } = setup((_request, index) => index === 0
      ? Response.json({ images: [{ url: download }] })
      : new Response(Uint8Array.of(5, 6, 7), { headers: { "Content-Type": "image/png" } }));
    await hub.setSecret("FAL_KEY", TOKEN);
    const result = await hub.invoke("fal-image", { prompt: "Synthetic landscape" }, { ...fileContext, bypassApproval: true });
    expect(requests[0].url).toBe("https://fal.run/fal-ai/flux/schnell");
    expect(requests[0].headers.get("authorization")).toBe(`Key ${TOKEN}`);
    expect(JSON.parse(requests[0].body ?? "")).toEqual({ prompt: "Synthetic landscape", image_size: "landscape_16_9" });
    expect(requests[1]).toMatchObject({ url: download, method: "GET", redirect: "error" });
    expect([...requests[1].headers]).toEqual([]);
    expect(result.artifact).toMatchObject({ kind: "image", bytes: 3, mimeType: "image/png" });
    expect(result.artifact?.path).toMatch(/^assets\/images\/flux-\d+\.png$/u);
  });

  test("blocks returned private URLs, cross-origin credential URLs and redirects before a write", async () => {
    const { hub, fileContext, requests } = setup(() => Response.json({ url: output }));
    let output = "http://127.0.0.1:9000/private";
    await hub.setSecret("FIXTURE_KEY", TOKEN);
    await hub.save(restPack({ outputKind: "file", responsePath: "url", headers: { "X-Token": "{{FIXTURE_KEY}}" } }, { secretKeys: ["FIXTURE_KEY"] }));
    await expect(hub.invoke("custom-rest", {}, fileContext)).rejects.toThrow("public HTTPS");
    output = `https://cdn.example.com/output?key=${TOKEN}`;
    await expect(hub.invoke("custom-rest", {}, fileContext)).rejects.toThrow("follow-up URL would send credentials");
    output = "file:///tmp/out.bin";
    await expect(hub.invoke("custom-rest", {}, fileContext)).rejects.toThrow("did not provide an HTTP(S) asset URL");
    expect(requests).toHaveLength(3);

    const redirect = setup((_request, index) => index === 0 ? Response.json({ url: "https://cdn.example.com/a" }) :
      Response.redirect(`https://different.example.com/path?secret=${TOKEN}`, 302));
    await redirect.hub.save(restPack({ outputKind: "file", responsePath: "url" }));
    await expect(redirect.hub.invoke("custom-rest", {}, redirect.fileContext)).rejects.toThrow("Capability redirects are blocked.");
    expect(redirect.requests).toHaveLength(2);
    expect(redirect.requests.every((request) => request.redirect === "error")).toBe(true);
  });

  test("requires a writer and rejects absolute, parent-relative and protected output paths", async () => {
    const { hub, fileContext, requests } = setup(() => new Response(Uint8Array.of(1)));
    await hub.save(restPack({ outputKind: "video" }));
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toMatchObject({ code: -32004 });
    for (const output_path of ["../outside", "/tmp/out.mp4", "C:/out.mp4", ".git/file", "assets/.env", "assets/sub/../out.mp4"]) {
      await expect(hub.invoke("custom-rest", { output_path }, fileContext)).rejects.toThrow("unprotected path inside the workspace");
    }
    expect(requests).toHaveLength(0);
    const result = await hub.invoke("custom-rest", {}, fileContext);
    expect(result.artifact?.path).toMatch(/^assets\/custom-rest-\d+\.mp4$/u);
  });

  test.skipIf(process.platform === "win32")("uses the workspace writer's confinement for symlinked output directories", async () => {
    const { hub, workspacePath, fileContext } = setup(() => new Response(Uint8Array.of(1)));
    const outside = temporaryDirectory();
    symlinkSync(outside, join(workspacePath, "outside"), "dir");
    await hub.save(restPack({ outputKind: "file", outputPathTemplate: "outside/output.bin" }));
    await expect(hub.invoke("custom-rest", {}, fileContext)).rejects.toThrow("Could not save the generated capability output inside the workspace.");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("limits both declared and streamed response sizes and aborts the body before writing", async () => {
    let cancelled = false;
    const { hub, fileContext } = setup((_request, index) => index === 0
      ? new Response("fixture", { headers: { "Content-Length": String(MAX_BINARY_BYTES + 1) } })
      : new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_BINARY_BYTES));
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() { cancelled = true; },
      })));
    await hub.save(restPack({ outputKind: "file", outputPathTemplate: "out.bin" }));
    for (let i = 0; i < 2; i++) await expect(hub.invoke("custom-rest", {}, fileContext)).rejects.toMatchObject({ code: -32010 });
    expect(cancelled).toBe(true);
    expect(existsSync(join(fileContext.workspacePath, "out.bin"))).toBe(false);
  });

  test("cancels a stalled download body without calling the writer", async () => {
    const controller = new AbortController();
    let bodyCancelled = false;
    const { hub, fileContext } = setup(() => new Response(new ReadableStream({
      pull() { setTimeout(() => controller.abort(TOKEN), 0); },
      cancel() { bodyCancelled = true; },
    })));
    await hub.save(restPack({ outputKind: "file", outputPathTemplate: "out.bin" }));
    await expect(hub.invoke("custom-rest", {}, { ...fileContext, signal: controller.signal })).rejects.toThrow("Capability invocation was cancelled.");
    expect(bodyCancelled).toBe(true);
    expect(existsSync(join(fileContext.workspacePath, "out.bin"))).toBe(false);
  });

  test("applies the 30-second deadline when an HTTP transport stalls", async () => {
    const deadline = controlledDeadline(30_000);
    const { hub, requests } = setup(() => {
      queueMicrotask(() => deadline.controller.abort(TOKEN));
      return new Promise<Response>(() => {});
    });
    await hub.save(restPack());
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("Capability request timed out after 30 seconds.");
    expect(requests[0].signal?.aborted).toBe(true);
    expect(deadline.spy).toHaveBeenCalledWith(30_000);
  });
});

describe("REST polling", () => {
  const poll = { urlTemplate: "https://capabilities.example.com/queue/{{job.id}}", statusPath: "job.state", resultUrlPath: "job.outputs.0.url",
    doneValues: ["done"], failedValues: ["failed"], intervalMs: 250, timeoutMs: 1_000 };

  test("renders a job ID, waits for completion and downloads a binary result", async () => {
    const download = "https://cdn.example.com/movie.mp4";
    const { hub, fileContext, requests } = setup((_request, index) => {
      if (index === 0) return Response.json({ job: { id: "job/123", state: "pending" } });
      if (index === 1) return Response.json({ job: { state: "working" } });
      if (index === 2) return Response.json({ job: { state: "done", outputs: [{ url: download }] } });
      return new Response(Uint8Array.of(7, 11, 4));
    });
    await hub.setSecret("FIXTURE_KEY", TOKEN);
    await hub.save(restPack({ outputKind: "video", poll, headers: { "X-Gateway-Token": "{{FIXTURE_KEY}}" } }, { secretKeys: ["FIXTURE_KEY"] }));
    const result = await hub.invoke("custom-rest", {}, fileContext);
    expect(requests.map(({ url, method }) => [url, method])).toEqual([
      [REQUEST_URL, "POST"], ["https://capabilities.example.com/queue/job%2F123", "GET"],
      ["https://capabilities.example.com/queue/job%2F123", "GET"], [download, "GET"],
    ]);
    expect(requests[1].headers.get("x-gateway-token")).toBe(TOKEN);
    expect(requests[3].headers.get("x-gateway-token")).toBeNull();
    expect(result.artifact).toMatchObject({ kind: "video", mimeType: "video/mp4", bytes: 3 });
  });

  test("validates server-selected polling URLs and propagates terminal failure without its details", async () => {
    let statusUrl = "https://192.168.1.2/status";
    const { hub, requests } = setup((request) => request.method === "POST"
      ? Response.json({ status_url: statusUrl })
      : Response.json({ job: { state: "failed", details: TOKEN } }));
    await hub.setSecret("FIXTURE_KEY", TOKEN);
    await hub.save(restPack({ poll: { ...poll, urlTemplate: "{{status_url}}" }, headers: { "X-Token": "{{FIXTURE_KEY}}" } }, { secretKeys: ["FIXTURE_KEY"] }));
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("public HTTPS");
    expect(requests).toHaveLength(1);
    statusUrl = "https://poll.example.com/status";
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("Capability polling reported a failure.");
    expect(requests[2].url).toBe(statusUrl);
    expect(requests[2].headers.get("x-token")).toBeNull();
  });

  test("enforces the overall polling timeout across the wait between requests", async () => {
    const { hub, requests } = setup(() => Response.json({ job: { id: "1", state: "waiting" } }));
    await hub.save(restPack({ poll: { ...poll, intervalMs: 30_000 } }));
    await expect(hub.invoke("custom-rest", {}, {})).rejects.toThrow("Capability polling timed out.");
    expect(requests).toHaveLength(2);
  });
});

describe("MCP transports", () => {
  test("calls the specified MCP HTTP tool with structured arguments and redacts result content", async () => {
    const { hub, requests } = setup(() => reply(1, { content: [{ type: "text", text: `first ${TOKEN}` }, { type: "text", text: "second" }] }));
    await hub.setSecret("MCP_TOKEN", TOKEN);
    await hub.save({ ...mcpPack("mcp-http", { url: "https://mcp.example.com/tools", headers: { Authorization: "Bearer {{MCP_TOKEN}}" } }),
      secretKeys: ["MCP_TOKEN"],
    });
    await expect(hub.invoke("mcp-http", { tool: "inspect", arguments: "[]" }, {})).rejects.toThrow("MCP tool arguments must be a JSON object.");
    expect(requests).toHaveLength(0);
    const args = { tool: "inspect", arguments: '{"path":"fixture","nested":{"active":true}}' };
    expect(await hub.invoke("mcp-http", args, { requestApproval: async () => "allow_once" })).toEqual({ text: "first [redacted]\nsecond" });
    expect(requests[0]).toMatchObject({ method: "POST", url: "https://mcp.example.com/tools", redirect: "error" });
    expect(requests[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].headers.get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(requests[0].body ?? "")).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "inspect", arguments: { path: "fixture", nested: { active: true } },
    } });
  });

  test("consumes a streamed HTTP MCP reply and cancels the stream after matching the request ID", async () => {
    let streamClosed = false;
    const encoder = new TextEncoder();
    const { hub } = setup(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","id":2,"result":"other"}\r\n\r\n'));
        controller.enqueue(encoder.encode('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":'));
        controller.enqueue(encoder.encode('{"structuredContent":{"ok":true}}}\r\n\r\n'));
      },
      cancel() { streamClosed = true; },
    }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
    await hub.save(mcpPack("mcp-http", { url: "https://mcp.example.com/mcp" }));
    expect(await hub.invoke("mcp-http", { tool: "fixture", arguments: {} }, { bypassApproval: true })).toEqual({ text: '{"ok":true}' });
    expect(streamClosed).toBe(true);
  });

  test("negotiates and cleans up an MCP HTTP session after an explicit pre-dispatch rejection", async () => {
    const sessionId = "synthetic-mcp-session";
    const { hub, requests } = setup((_request, index) => {
      if (index === 0) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: Server not initialized" } }, { status: 400 });
      if (index === 1) return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, { headers: { "Mcp-Session-Id": sessionId } });
      if (index === 2 || index === 4) return new Response(null, { status: 204 });
      return reply(2, { content: [{ type: "text", text: `done ${sessionId}` }] });
    });
    await hub.save(mcpPack("mcp-http", { url: "https://mcp.example.com/mcp" }));
    expect(await hub.invoke("mcp-http", { tool: "fixture" }, { bypassApproval: true })).toEqual({ text: "done [redacted]" });
    expect(requests.map(({ method, body }) => body ? JSON.parse(body).method : method)).toEqual([
      "tools/call", "initialize", "notifications/initialized", "tools/call", "DELETE",
    ]);
    expect(requests.slice(2).every(({ headers }) => headers.get("mcp-session-id") === sessionId &&
      headers.get("mcp-protocol-version") === "2025-06-18")).toBe(true);
  });

  test("rejects MCP application failures without returning private details or replaying the call", async () => {
    const { hub, requests } = setup(() => reply(1, { isError: true, content: [{ type: "text", text: TOKEN }] }));
    await hub.save(mcpPack("mcp-http", { url: "https://mcp.example.com/mcp" }));
    await expect(hub.invoke("mcp-http", { tool: "fixture" }, { bypassApproval: true })).rejects.toThrow("MCP tool reported a failure.");
    expect(requests).toHaveLength(1);
  });

  test("initializes a real stdio subprocess, exchanges newline JSON and reaps it after the result", async () => {
    const script = String.raw`
      const {createInterface} = require('node:readline');
      const lines = createInterface({input: process.stdin});
      let initialized = false;
      let ready = false;
      let toolResult;
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      lines.on('line', (line) => {
        const rpc = JSON.parse(line);
        if (rpc.method === 'initialize') {
          initialized = rpc.params.protocolVersion === '2025-11-25';
          process.stderr.write(process.env.FIXTURE_MCP_TOKEN || '');
          send({jsonrpc: '2.0', id: rpc.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}}});
        } else if (rpc.method === 'notifications/initialized') {
          ready = initialized && !('id' in rpc);
        } else if (rpc.method === 'tools/call') {
          const state = { pid: process.pid, ready, tool: rpc.params.name, args: rpc.params.arguments,
            secret: process.env.FIXTURE_MCP_TOKEN, hasUndeclared: !!process.env.FIXTURE_UNDECLARED };
          toolResult = {jsonrpc: '2.0', id: rpc.id, result: {content: [{type: 'text', text: JSON.stringify(state)}]}};
          send({jsonrpc: '2.0', id: 'server-ping', method: 'ping'});
        } else if (rpc.id === 'server-ping' && JSON.stringify(rpc.result) === '{}') {
          send({jsonrpc: '2.0', method: 'notifications/progress', params: {progress: 1}});
          send(toolResult);
        }
      });
      setInterval(() => {}, 1000);
    `;
    const { hub, workspacePath } = setup();
    await hub.setSecret("FIXTURE_MCP_TOKEN", TOKEN);
    await hub.setSecret("FIXTURE_UNDECLARED", "synthetic-undeclared-token");
    await hub.save({ ...mcpPack("mcp-stdio", { command: process.execPath, args: ["--no-env-file", "-e", script] }),
      secretKeys: ["FIXTURE_MCP_TOKEN"],
    });
    const result = await hub.invoke("mcp-stdio", { tool: "echo", arguments: { quote: 'test "\n🙂' } }, {
      workspacePath,
      requestApproval: async (prompt) => {
        expect(prompt.toolKind).toBe("shell");
        expect(JSON.stringify(prompt)).not.toContain(TOKEN);
        return "allow_once";
      },
    });
    expect(result.text).not.toContain(TOKEN);
    const state = JSON.parse(result.text) as { pid: number };
    expect(state).toMatchObject({ ready: true, tool: "echo", args: { quote: 'test "\n🙂' }, secret: "[redacted]", hasUndeclared: false });
    expect(() => process.kill(state.pid, 0)).toThrow();
  });

  test("reports child startup and invalid JSON errors without exposing command or stdout contents", async () => {
    const { hub, workspacePath } = setup();
    const context = { workspacePath, bypassApproval: true };
    await hub.save(mcpPack("mcp-stdio", { command: join(workspacePath, TOKEN) }));
    await expect(hub.invoke("mcp-stdio", { tool: "test" }, context)).rejects.toThrow("Could not start the MCP server.");
    await hub.save(mcpPack("mcp-stdio", {
      command: process.execPath,
      args: ["--no-env-file", "-e", `process.stdout.write(${JSON.stringify(`${TOKEN}\n`)}); setInterval(() => {}, 1000);`],
    }));
    await expect(hub.invoke("mcp-stdio", { tool: "test" }, context)).rejects.toThrow("Capability returned invalid JSON.");
  });

  test.each(["cancellation", "deadline"] as const)("reaps a stdio subprocess waiting on a tool result after %s", async (mode) => {
    const { hub, workspacePath } = setup();
    const ready = join(workspacePath, "mcp-ready.pid");
    const script = String.raw`
      const {createInterface} = require('node:readline');
      const {writeFileSync} = require('node:fs');
      createInterface({input: process.stdin}).on('line', (line) => {
        const rpc = JSON.parse(line);
        if (rpc.method === 'initialize') {
          process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: rpc.id, result: {protocolVersion: '2025-11-25'}}) + '\n');
        } else if (rpc.method === 'tools/call') {
          writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        }
      });
      setInterval(() => {}, 1000);
    `;
    await hub.save(mcpPack("mcp-stdio", { command: process.execPath, args: ["--no-env-file", "-e", script] }));
    const external = new AbortController();
    const timeout = mode === "deadline" ? controlledDeadline(20_000) : undefined;
    const invocation = hub.invoke("mcp-stdio", { tool: "wait" }, { workspacePath, bypassApproval: true, signal: external.signal });
    const outcome = invocation.catch((error: unknown) => error);
    try {
      const deadline = Date.now() + 2_000;
      let pid = 0;
      while (!pid && Date.now() < deadline) {
        if (existsSync(ready)) pid = Number(readFileSync(ready, "utf8"));
        if (!pid) await Bun.sleep(10);
      }
      expect(pid).toBeGreaterThan(0);
      (timeout?.controller ?? external).abort(TOKEN);
      const message = timeout ? "MCP server timed out after 20 seconds." : "Capability invocation was cancelled.";
      expect(await outcome).toMatchObject({ name: "RpcError", message });
      if (timeout) expect(timeout.spy).toHaveBeenCalledWith(20_000);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      external.abort();
      await outcome;
    }
  });
});
