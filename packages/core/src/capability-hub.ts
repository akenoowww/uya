import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as undiciFetch } from "undici/index.js";
import type {
  ApprovalDecision, CapabilityInvokeResult, CapabilityMcpSpec, CapabilityOutputKind, CapabilityPack, CapabilityPollSpec,
  CapabilityRestSpec,
} from "@ide/protocol";
import type { History } from "./history";
import type { AdapterApprovalPrompt } from "./provider-adapter";
import { parseRpcParams, RpcError } from "./validation";
import {
  inferBinaryMimeType, isProtectedRelativePath, isSingleLinkFile, listDirectory, MAX_BINARY_BYTES, readText,
  WorkspaceError,
} from "./workspace-files";

const SECRET_KEY = /^[A-Z][A-Z0-9_]{1,63}$/u;
const HTTP_TIMEOUT_MS = 30_000;
const STDIO_TIMEOUT_MS = 20_000;
const MAX_RESULT_TEXT_BYTES = 32 * 1024;
const PROJECT_CAPABILITIES = ".uya/capabilities";
const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vaultPath(dataDir: string): string {
  return resolve(dataDir, "capability-secrets.json");
}

function readSecrets(path: string): Map<string, string> {
  try {
    if (process.platform === "win32" && !isSingleLinkFile(lstatSync(path))) throw new Error();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stats = fstatSync(fd);
      if (!isSingleLinkFile(stats) || (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600)) {
        throw new Error();
      }
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!isRecord(value)) throw new Error();
      const secrets = new Map<string, string>();
      for (const [key, secret] of Object.entries(value)) {
        if (SECRET_KEY.test(key) && typeof secret === "string" && secret.length > 0) secrets.set(key, secret);
      }
      return secrets;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new RpcError(-32011, "Could not read the capability secret vault.");
  }
}

export class SecretVault {
  private static readonly pending = new Map<string, Promise<void>>();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = vaultPath(dataDir);
  }

  configuredKeys(): string[] {
    return [...readSecrets(this.path).keys()].sort();
  }

  get(key: string): string | undefined {
    return readSecrets(this.path).get(key);
  }

  async set(key: string, value: string | null): Promise<string[]> {
    if (typeof key !== "string" || !SECRET_KEY.test(key)) {
      throw new RpcError(-32602, "Secret key must use UPPER_SNAKE_CASE.");
    }
    if (value !== null && typeof value !== "string") throw new RpcError(-32602, "Secret value must be text or null.");

    const previous = SecretVault.pending.get(this.path) ?? Promise.resolve();
    const write = previous.then(() => this.write(key, value));
    const settled = write.then(() => undefined, () => undefined);
    SecretVault.pending.set(this.path, settled);
    try {
      return await write;
    } finally {
      if (SecretVault.pending.get(this.path) === settled) SecretVault.pending.delete(this.path);
    }
  }

  private async write(key: string, value: string | null): Promise<string[]> {
    const secrets = readSecrets(this.path);
    if (value) secrets.set(key, value);
    else secrets.delete(key);

    const directory = dirname(this.path);
    const temporary = join(directory, `.capability-secrets-${randomUUID()}.tmp`);
    let created = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, "wx", 0o600);
      created = true;
      try {
        if (process.platform !== "win32") await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(Object.fromEntries(secrets)), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      created = false;
      return [...secrets.keys()].sort();
    } catch {
      throw new RpcError(-32011, "Could not write the capability secret vault.");
    } finally {
      if (created) await unlink(temporary).catch(() => undefined);
    }
  }
}

const builtin = { enabled: false, builtin: true, scope: "builtin", requiresApproval: true, kind: "rest" } as const;
const outputPathField = { name: "output_path", type: "string", description: "Workspace-relative output path." } as const;

export const BUILTIN_CAPABILITIES: readonly CapabilityPack[] = [
  {
    ...builtin,
    id: "elevenlabs-tts",
    name: "ElevenLabs Voiceover",
    description: "Generate a voiceover from text with ElevenLabs.",
    domain: "audio",
    secretKeys: ["ELEVENLABS_API_KEY"],
    rest: {
      method: "POST",
      url: "https://api.elevenlabs.io/v1/text-to-speech/{{voice_id}}",
      headers: { "xi-api-key": "{{ELEVENLABS_API_KEY}}", "Content-Type": "application/json", Accept: "audio/mpeg" },
      bodyTemplate: '{"text":{{text}},"model_id":{{model_id}}}',
      inputSchema: [
        { name: "text", type: "string", description: "Text to speak.", required: true },
        { name: "voice_id", type: "string", description: "ElevenLabs voice ID.", default: "JBFqnCBsd6RMkjVDRZzb" },
        { name: "model_id", type: "string", description: "ElevenLabs model ID.", default: "eleven_multilingual_v2" },
        outputPathField,
      ],
      outputKind: "audio",
      outputPathTemplate: "assets/audio/voice-{{timestamp}}.mp3",
    },
  },
  {
    ...builtin,
    id: "suno-music",
    name: "Suno Music Generator",
    description: "Generate music through a configured Suno endpoint.",
    domain: "audio",
    secretKeys: ["SUNO_API_KEY", "SUNO_BASE_URL"],
    rest: {
      method: "POST",
      url: "{{SUNO_BASE_URL}}/api/v1/generate",
      headers: { Authorization: "Bearer {{SUNO_API_KEY}}", "Content-Type": "application/json" },
      bodyTemplate: '{"prompt":{{prompt}},"instrumental":{{instrumental}},"customMode":false}',
      inputSchema: [
        { name: "prompt", type: "string", description: "Description of the music.", required: true },
        { name: "instrumental", type: "boolean", description: "Generate music without vocals.", default: false },
        outputPathField,
      ],
      outputKind: "audio",
      outputPathTemplate: "assets/audio/music-{{timestamp}}.mp3",
      responsePath: "audio_url",
    },
  },
  {
    ...builtin,
    id: "fal-image",
    name: "fal.ai FLUX Image",
    description: "Generate an image from a text prompt with FLUX Schnell.",
    domain: "image",
    secretKeys: ["FAL_KEY"],
    rest: {
      method: "POST",
      url: "https://fal.run/fal-ai/flux/schnell",
      headers: { Authorization: "Key {{FAL_KEY}}", "Content-Type": "application/json" },
      bodyTemplate: '{"prompt":{{prompt}},"image_size":{{image_size}}}',
      inputSchema: [
        { name: "prompt", type: "string", description: "Description of the image.", required: true },
        { name: "image_size", type: "string", description: "Image size preset.", default: "landscape_16_9" },
        outputPathField,
      ],
      outputKind: "image",
      outputPathTemplate: "assets/images/flux-{{timestamp}}.png",
      responsePath: "images.0.url",
    },
  },
  {
    ...builtin,
    id: "openai-speech",
    name: "OpenAI Speech TTS",
    description: "Generate speech from text with OpenAI.",
    domain: "audio",
    secretKeys: ["OPENAI_API_KEY"],
    rest: {
      method: "POST",
      url: "https://api.openai.com/v1/audio/speech",
      headers: { Authorization: "Bearer {{OPENAI_API_KEY}}", "Content-Type": "application/json" },
      bodyTemplate: '{"model":{{model}},"voice":{{voice}},"input":{{text}}}',
      inputSchema: [
        { name: "text", type: "string", description: "Text to speak.", required: true },
        { name: "voice", type: "string", description: "OpenAI voice.", default: "alloy" },
        { name: "model", type: "string", description: "OpenAI speech model.", default: "gpt-4o-mini-tts" },
        outputPathField,
      ],
      outputKind: "audio",
      outputPathTemplate: "assets/audio/speech-{{timestamp}}.mp3",
    },
  },
];

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[(.*)\]$/u, "$1");
}

function isPrivateHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    // Admit global unicast and exclude transition addresses that can embed IPv4 destinations.
    return !/^[23][0-9a-f]{3}:/u.test(host) || /^(?:2002:|2001:(?:0*:|db8:))/u.test(host);
  }
  return !host.includes(".") || /\.(?:localhost|local|internal|home\.arpa)$/u.test(host);
}

const URL_AUTHORITY = /^https?:\/\/([^/?#\\\s]+)/iu;

function invalidUrl(): RpcError {
  return new RpcError(-32602, "Capability URL must be an absolute HTTP(S) URL without credentials.");
}

export function validateCapabilityUrl(rawUrl: string, allowLocalhost: boolean): URL {
  if (typeof rawUrl !== "string" || !URL_AUTHORITY.test(rawUrl) || /[\\\u0000-\u0020\u007f]/u.test(rawUrl)) {
    throw invalidUrl();
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalidUrl();
  }
  if (url.username || url.password || URL_AUTHORITY.exec(rawUrl)?.[1]?.includes("@")) throw invalidUrl();
  if (url.protocol === "https:" && (allowLocalhost || !isPrivateHost(url.hostname))) return url;
  const host = normalizeHost(url.hostname);
  if (url.protocol === "http:" && allowLocalhost && (host === "localhost" || host === "127.0.0.1")) return url;
  throw new RpcError(-32602, "Capability URL must use public HTTPS or an explicitly configured local endpoint.");
}

function networkAgent(local: boolean): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        // Use the validated DNS answers in the connection itself to prevent DNS rebinding.
        lookup(hostname, { all: true, family: options.family, hints: options.hints }, (error, addresses) => {
          const permitted = addresses?.filter(({ address }) => local
            ? normalizeHost(hostname) !== "localhost" || address === "127.0.0.1" || address === "::1"
            : !isPrivateHost(address)) ?? [];
          if (error || permitted.length === 0) {
            const denied = new Error("Capability endpoint address is unavailable or restricted.");
            if (options.all) callback(denied, []);
            else callback(denied, "", 4);
          } else if (options.all) {
            callback(null, permitted);
          } else {
            callback(null, permitted[0].address, permitted[0].family);
          }
        });
      },
    },
  });
}

// The explicit dispatchers also keep capability credentials out of environment-configured proxies.
const publicNetwork = networkAgent(false);
const localNetwork = networkAgent(true);

type Redact = (text: string) => string;
type TokenValue = (token: string) => unknown;

function secretRedactor(secrets: Iterable<string>): Redact {
  const forms = new Set<string>();
  for (const secret of secrets) {
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
    const trimmed = secret.trim();
    if (trimmed) forms.add(trimmed);
    if (URL_AUTHORITY.test(secret)) {
      try {
        const normalized = new URL(secret).href;
        forms.add(normalized);
        forms.add(normalized.replace(/\/$/u, ""));
      } catch {
        // An invalid URL has no normalized representation.
      }
    }
    try {
      const encoded = encodeURIComponent(secret);
      forms.add(encoded);
      forms.add(encoded.replaceAll("%20", "+"));
      forms.add(encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()));
    } catch {
      // A string with malformed Unicode cannot be interpolated into a URL.
    }
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  return (text) => {
    for (const form of ordered) text = text.replaceAll(form, "[redacted]");
    return text;
  };
}

function selectPath(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if ((!isRecord(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function render(template: string, substitute: (token: string) => string): string {
  return template.replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/gu, (_match, token: string) => substitute(token));
}

function tokenText(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return String(value);
  throw new RpcError(-32602, "A capability template variable is missing or invalid.");
}

function renderUrl(template: string, value: TokenValue, allowLocal: boolean, allowBase: (token: string) => boolean): URL {
  const encode = (token: string) => {
    try {
      return encodeURIComponent(tokenText(value(token)));
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(-32602, "Capability URL template could not be rendered.");
    }
  };
  const base = /^\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/u.exec(template);
  if (base) {
    const suffix = template.slice(base[0].length);
    if (!allowBase(base[1]) || (suffix && !suffix.startsWith("/"))) {
      throw new RpcError(-32602, "Capability URL template has an invalid base URL.");
    }
    const target = validateCapabilityUrl(tokenText(value(base[1])), allowLocal);
    if (!suffix) return target;
    if (target.search || target.hash) throw new RpcError(-32602, "A capability base URL cannot contain a query or fragment.");
    return validateCapabilityUrl(target.href.replace(/\/$/u, "") + render(suffix, encode), allowLocal);
  }
  const authority = URL_AUTHORITY.exec(template)?.[1];
  if (!authority || /[{}]/u.test(authority)) throw new RpcError(-32602, "Capability URL template has an invalid host.");
  return validateCapabilityUrl(render(template, encode), allowLocal);
}

const forbiddenHeaders = new Set([
  "connection", "content-length", "expect", "host", "keep-alive", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

function renderHeaders(templates: Record<string, string> | undefined, value: TokenValue): Headers {
  const headers = new Headers();
  for (const [name, template] of Object.entries(templates ?? {})) {
    if (forbiddenHeaders.has(name.toLowerCase())) throw new RpcError(-32602, "Capability request header is restricted.");
    try {
      const rendered = render(template, (token) => tokenText(value(token)));
      if (/[\0\r\n]/u.test(rendered)) throw new Error();
      headers.set(name, rendered);
    } catch {
      throw new RpcError(-32602, "Capability request header is invalid.");
    }
  }
  return headers;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    throw new RpcError(-32602, "Capability data could not be encoded as JSON.");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RpcError(-32000, "Capability returned invalid JSON.");
  }
}

function resolveInputs(rest: CapabilityRestSpec, args: Record<string, unknown>, redact: Redact): Record<string, unknown> {
  const values: Record<string, unknown> = Object.assign(Object.create(null), args);
  for (const field of rest.inputSchema) {
    const value = values[field.name] ?? field.default;
    const name = redact(field.name);
    if (field.required && (value === undefined || (typeof value === "string" && !value.trim()))) {
      throw new RpcError(-32602, `Capability input ${name} is required.`);
    }
    if (value !== undefined && (typeof value !== field.type || (typeof value === "number" && !Number.isFinite(value)))) {
      throw new RpcError(-32602, `Capability input ${name} must be a ${field.type}.`);
    }
    if (value !== undefined && field.enum && (typeof value !== "string" || !field.enum.includes(value))) {
      throw new RpcError(-32602, `Capability input ${name} is not an allowed option.`);
    }
    values[field.name] = value;
  }
  return values;
}

function boundedText(value: unknown, redact: Redact): string {
  const text = redact(typeof value === "string" ? value : stringify(value));
  if (Buffer.byteLength(text) <= MAX_RESULT_TEXT_BYTES) return text;
  const buffer = Buffer.alloc(MAX_RESULT_TEXT_BYTES);
  return buffer.toString("utf8", 0, buffer.write(text));
}

function checkedOutputPath(path: string, redact: Redact): string {
  try {
    if (isProtectedRelativePath(path) || /^[A-Za-z]:/u.test(path) || redact(path) !== path) throw new Error();
    return path;
  } catch {
    throw new RpcError(-32602, "Capability output must use an unprotected path inside the workspace.");
  }
}

type InvokeContext = {
  workspacePath?: string | null;
  writeWorkspaceBinary?: (path: string, data: Uint8Array) => Promise<{ path: string; bytes: number }>;
  requestApproval?: (prompt: AdapterApprovalPrompt) => Promise<ApprovalDecision>;
  bypassApproval?: boolean;
  signal?: AbortSignal;
};

type Invocation = { pack: CapabilityPack; context: InvokeContext; secrets: ReadonlyMap<string, string>; redact: Redact };
type ApprovalAction = Pick<AdapterApprovalPrompt, "toolKind" | "detail" | "path" | "command">;
type BinaryKind = Exclude<CapabilityOutputKind, "text" | "json">;
type BinaryTarget = { kind: BinaryKind; path: string; write: NonNullable<InvokeContext["writeWorkspaceBinary"]> };
type Asset = { data: Uint8Array; contentType: string | null };
type HttpRequest = { method: "GET" | "POST" | "DELETE"; headers?: Headers; body?: string };
type HttpResponse = Response | Awaited<ReturnType<typeof undiciFetch>>;

function cancelled(): RpcError {
  return new RpcError(-32000, "Capability invocation was cancelled.");
}

async function abortable<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) throw cancelled();
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(cancelled()); });
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      if (signal.aborted) throw cancelled();
      return operation();
    })]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

async function requireApproval(invocation: Invocation, action: ApprovalAction) {
  const { pack, context, redact } = invocation;
  if (context.signal?.aborted) throw cancelled();
  if (!pack.requiresApproval || context.bypassApproval === true) return;
  const { requestApproval } = context;
  if (!requestApproval) throw new RpcError(-32003, "Approval is required to run this capability.");
  const credentialDetail = pack.secretKeys.length ? `Uses the credential keys ${pack.secretKeys.join(", ")}.` : undefined;
  const detail = [action.detail, credentialDetail].filter(Boolean).join("\n");
  let decision: ApprovalDecision;
  try {
    decision = await abortable(context.signal, () => requestApproval({
      toolName: redact(pack.id),
      toolKind: action.toolKind,
      title: `Run ${redact(pack.name)}`,
      detail: detail ? redact(detail) : undefined,
      path: action.path,
      command: action.command === undefined ? undefined : redact(action.command),
      options: [
        { id: "allow_once", label: "Allow once", kind: "allow_once" },
        { id: "reject_once", label: "Reject", kind: "reject_once" },
      ],
    }));
  } catch {
    if (context.signal?.aborted) throw cancelled();
    throw new RpcError(-32003, "Capability approval failed.");
  }
  if (context.signal?.aborted) throw cancelled();
  if (decision !== "allow_once" && decision !== "allow_session") throw new RpcError(-32003, "Capability approval was denied.");
}

function binaryTarget(invocation: Invocation, rest: CapabilityRestSpec, args: Record<string, unknown>, values: TokenValue): BinaryTarget | undefined {
  const kind = rest.outputKind;
  if (kind === "text" || kind === "json") return undefined;
  const { workspacePath, writeWorkspaceBinary } = invocation.context;
  if (!workspacePath || !writeWorkspaceBinary) throw new RpcError(-32004, "Open a workspace to save capability output.");
  const extension: Record<BinaryKind, string> = { audio: "mp3", image: "png", video: "mp4", file: "bin" };
  const template = rest.outputPathTemplate ?? `assets/${invocation.pack.id}-{{timestamp}}.${extension[kind]}`;
  const override = typeof args.output_path === "string" ? args.output_path.trim() : "";
  const timestamp = Date.now();
  const path = override || render(template, (token) => tokenText(token === "timestamp" ? timestamp : values(token)));
  return { kind, path: checkedOutputPath(path, invocation.redact), write: writeWorkspaceBinary };
}

async function saveAsset(invocation: Invocation, target: BinaryTarget, asset: Asset): Promise<CapabilityInvokeResult> {
  const { pack, redact, context } = invocation;
  if (context.signal?.aborted) throw cancelled();
  let saved: { path: string; bytes: number };
  try {
    saved = await target.write(target.path, asset.data);
    if (saved.bytes !== asset.data.byteLength) throw new Error();
  } catch {
    throw new RpcError(-32011, "Could not save the generated capability output inside the workspace.");
  }
  const path = checkedOutputPath(saved.path, redact);
  const contentType = asset.contentType?.split(";")[0]?.trim().toLowerCase();
  const inferred = inferBinaryMimeType(path);
  const usableType = contentType && /^[\w.+-]+\/[\w.+-]+$/u.test(contentType) && redact(contentType) === contentType &&
    (target.kind === "file" ? contentType !== "application/octet-stream" : contentType.startsWith(`${target.kind}/`));
  return {
    text: `Generated ${target.kind} saved to ${path} (${saved.bytes} bytes).`,
    artifact: {
      id: randomUUID(),
      kind: target.kind,
      path,
      label: redact(pack.name),
      mimeType: usableType ? contentType : inferred,
      bytes: saved.bytes,
      sourceId: redact(pack.id),
      createdAt: Date.now(),
    },
  };
}

function responseLimit(): RpcError {
  return new RpcError(-32010, "Capability response exceeds the 24 MiB limit.");
}

async function* responseChunks(response: HttpResponse, signal: AbortSignal): AsyncGenerator<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BINARY_BYTES) throw responseLimit();
  if (!response.body) return;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read().catch(() => {
        throw new RpcError(-32000, "Could not read the capability response.");
      });
      if (done) return;
      yield value;
    }
    throw cancelled();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

async function* limitedChunks(chunks: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new RpcError(-32000, "Capability response is not a byte stream.");
    size += chunk.byteLength;
    if (size > MAX_BINARY_BYTES) throw responseLimit();
    yield chunk;
  }
}

async function readBytes(response: HttpResponse, signal: AbortSignal): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of limitedChunks(responseChunks(response, signal))) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readAsset(response: HttpResponse, signal: AbortSignal): Promise<Asset> {
  return { data: await readBytes(response, signal), contentType: response.headers.get("content-type") };
}

async function readJsonResponse(response: HttpResponse, signal: AbortSignal): Promise<unknown> {
  return parseJson((await readBytes(response, signal)).toString("utf8"));
}

async function* textLines(chunks: AsyncIterable<unknown>): AsyncGenerator<string> {
  let pending: Uint8Array[] = [];
  for await (const chunk of limitedChunks(chunks)) {
    let start = 0;
    for (let next = chunk.indexOf(10); next !== -1; next = chunk.indexOf(10, start)) {
      pending.push(chunk.subarray(start, next));
      yield Buffer.concat(pending).toString("utf8").replace(/\r$/u, "");
      pending = [];
      start = next + 1;
    }
    if (start < chunk.byteLength) pending.push(chunk.subarray(start));
  }
  if (pending.length) yield Buffer.concat(pending).toString("utf8");
}

function allowLocalEndpoint(pack: CapabilityPack): boolean {
  return pack.scope === "global" || (pack.scope === "builtin" && pack.id === "suno-music");
}

function followupHeaders(url: URL, initial: URL, headers: Headers, redact: Redact): Headers | undefined {
  if (url.origin === initial.origin) return headers;
  validateCapabilityUrl(url.href, false);
  if (redact(url.href) !== url.href) throw new RpcError(-32003, "A capability follow-up URL would send credentials to another origin.");
  return undefined;
}

function hasTransport(pack: CapabilityPack): boolean {
  if (pack.kind === "rest") return pack.rest !== undefined;
  return pack.kind === "mcp-http" ? !!pack.mcp?.url : !!pack.mcp?.command;
}

function hasUrlCredentials(pack: CapabilityPack): boolean {
  return [pack.rest?.url, pack.rest?.poll?.urlTemplate, pack.mcp?.url].some((template) => {
    if (!template) return false;
    if (URL_AUTHORITY.exec(template)?.[1]?.includes("@")) return true;
    try {
      const url = new URL(template);
      return !!(url.username || url.password);
    } catch {
      return false;
    }
  });
}

function applyBuiltinOverride(pack: CapabilityPack, saved?: CapabilityPack): CapabilityPack {
  return {
    ...pack,
    enabled: saved?.enabled ?? pack.enabled,
    rest: saved?.rest ?? pack.rest,
    ...(saved?.mcp && { mcp: saved.mcp }),
  };
}

function scopedPack(pack: CapabilityPack, scope: "global" | "project"): CapabilityPack {
  return { ...pack, builtin: false, scope, requiresApproval: scope === "project" || pack.requiresApproval };
}

async function readProjectPacks(workspacePath: string): Promise<CapabilityPack[]> {
  let entries: Awaited<ReturnType<typeof listDirectory>>;
  try {
    entries = await listDirectory(workspacePath, PROJECT_CAPABILITIES);
  } catch (error) {
    if (error instanceof WorkspaceError) return [];
    throw error;
  }
  const packs: CapabilityPack[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    try {
      const { text } = await readText(workspacePath, entry.path);
      const { pack } = parseRpcParams("capabilities.save", { pack: parseJson(text) });
      if (hasTransport(pack) && !hasUrlCredentials(pack)) packs.push(scopedPack(pack, "project"));
    } catch (error) {
      if (!(error instanceof WorkspaceError || error instanceof RpcError)) throw error;
    }
  }
  return packs;
}

type McpToolParams = { name: string; arguments: Record<string, unknown> };

function mcpToolParams(args: Record<string, unknown>): McpToolParams {
  if (typeof args.tool !== "string" || !args.tool.trim()) throw new RpcError(-32602, "An MCP tool name is required.");
  let input = args.arguments;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new RpcError(-32602, "MCP tool arguments must be a JSON object.");
    }
  }
  if (input === undefined) input = {};
  if (!isRecord(input)) throw new RpcError(-32602, "MCP tool arguments must be a JSON object.");
  return { name: args.tool.trim(), arguments: input };
}

function rpcCall(id: number, method: string, params: object) {
  return { jsonrpc: "2.0", id, method, params };
}

const mcpInitialize = rpcCall(1, "initialize", {
  protocolVersion: MCP_VERSIONS[0],
  capabilities: {},
  clientInfo: { name: "Uya", version: "0.5.0" },
});
const mcpInitialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function mcpReply(value: unknown, id: number): Record<string, unknown> | undefined {
  const messages: unknown[] = Array.isArray(value) ? value : [value];
  return messages.find((message): message is Record<string, unknown> => isRecord(message) &&
    message.jsonrpc === "2.0" && message.id === id && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")));
}

function mcpResult(reply: Record<string, unknown> | undefined): unknown {
  if (!reply || Object.hasOwn(reply, "error")) throw new RpcError(-32000, "MCP server did not return a successful response.");
  return reply.result;
}

function mcpVersion(result: unknown): string {
  const version = isRecord(result) ? result.protocolVersion : undefined;
  if (typeof version !== "string" || !MCP_VERSIONS.includes(version)) {
    throw new RpcError(-32000, "MCP server returned an unsupported protocol version.");
  }
  return version;
}

function mcpOutput(result: unknown, redact: Redact): CapabilityInvokeResult {
  if (isRecord(result)) {
    if (result.isError === true) throw new RpcError(-32000, "MCP tool reported a failure.");
    if (Array.isArray(result.content)) {
      const text = result.content.flatMap((item: unknown) => isRecord(item) && item.type === "text" && typeof item.text === "string"
        ? [item.text]
        : []);
      if (text.length) return { text: boundedText(text.join("\n"), redact) };
    }
    if (Object.hasOwn(result, "structuredContent")) return { text: boundedText(result.structuredContent, redact) };
  }
  return { text: boundedText(result, redact) };
}

async function readMcpReply(response: HttpResponse, signal: AbortSignal, id: number): Promise<Record<string, unknown> | undefined> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
    return mcpReply(await readJsonResponse(response, signal), id);
  }
  let data: string[] = [];
  for await (const line of textLines(responseChunks(response, signal))) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
    if (line !== "" || data.length === 0) continue;
    const event = data.join("\n");
    data = [];
    const reply = event.trim() ? mcpReply(parseJson(event), id) : undefined;
    if (reply) return reply;
  }
  return undefined;
}

const childEnvironmentKeys = [
  "PATH", "HOME", "TMPDIR", "LANG", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT",
];

async function callMcpStdio(invocation: Invocation, command: string, args: string[], params: McpToolParams): Promise<unknown> {
  const parent = invocation.context.signal;
  if (parent?.aborted) throw cancelled();
  const timeout = AbortSignal.timeout(STDIO_TIMEOUT_MS);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  const env: NodeJS.ProcessEnv = Object.fromEntries(childEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const [key, value] of invocation.secrets) env[key] = value;
  const grouped = process.platform !== "win32";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: invocation.context.workspacePath ?? undefined,
      env,
      detached: grouped,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    throw new RpcError(-32000, "Could not start the MCP server.");
  }
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const failed = new Promise<never>((_resolve, reject) => {
    child.on("error", () => reject(new RpcError(-32000, "Could not start the MCP server.")));
    child.stdin?.on("error", () => reject(new RpcError(-32000, "Could not send a request to the MCP server.")));
  });
  const exchange = async () => {
    const { stdin, stdout } = child;
    if (!stdin || !stdout) throw new RpcError(-32000, "Could not open the MCP server streams.");
    const call = stringify(rpcCall(2, "tools/call", params));
    stdin.write(`${stringify(mcpInitialize)}\n`);
    let awaiting = 1;
    for await (const line of textLines(stdout)) {
      if (!line.trim()) continue;
      const message = parseJson(line);
      const reply = mcpReply(message, awaiting);
      if (!reply) {
        if (isRecord(message) && message.jsonrpc === "2.0" && message.method === "ping" &&
          (typeof message.id === "number" || typeof message.id === "string")) {
          stdin.write(`${stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
        }
        continue;
      }
      const result = mcpResult(reply);
      if (awaiting === 2) return result;
      mcpVersion(result);
      awaiting = 2;
      stdin.write(`${stringify(mcpInitialized)}\n${call}\n`);
    }
    throw new RpcError(-32000, "MCP server exited before returning a result.");
  };
  try {
    return await abortable(signal, () => Promise.race([failed, exchange()]));
  } catch (error) {
    if (parent?.aborted) throw cancelled();
    if (timeout.aborted) throw new RpcError(-32000, "MCP server timed out after 20 seconds.");
    if (error instanceof RpcError) throw error;
    throw new RpcError(-32000, "MCP server communication failed.");
  } finally {
    child.stdin?.destroy();
    try {
      if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill();
    } catch {
      child.kill("SIGKILL");
    }
    child.stdout?.destroy();
    await closed;
  }
}

function requireHttpSuccess(response: HttpResponse) {
  if (!response.ok) throw new RpcError(-32000, `Capability request failed with HTTP ${response.status}.`);
}

function pollValue(poll: CapabilityPollSpec, response: unknown): unknown {
  const status = selectPath(response, poll.statusPath);
  if (typeof status !== "string" && typeof status !== "number" && typeof status !== "boolean") return undefined;
  if (poll.failedValues.includes(String(status))) throw new RpcError(-32000, "Capability polling reported a failure.");
  if (!poll.doneValues.includes(String(status))) return undefined;
  const value = selectPath(response, poll.resultUrlPath);
  if (value === undefined) throw new RpcError(-32000, "Capability polling response is missing its result.");
  return value;
}

function configuredPack(pack: CapabilityPack, configuredKeys: string[]): CapabilityPack {
  return { ...pack, configuredSecrets: configuredKeys.filter((key) => pack.secretKeys.includes(key)) };
}

export class CapabilityHub {
  private readonly vault: SecretVault;

  constructor(private readonly dataDir: string, private readonly history: History, private readonly fetcher: typeof fetch = fetch) {
    this.vault = new SecretVault(dataDir);
  }

  async list(workspacePath?: string | null): Promise<CapabilityPack[]> {
    return this.loadPacks(workspacePath, this.vault.configuredKeys());
  }

  async save(pack: CapabilityPack): Promise<CapabilityPack> {
    const { pack: parsed } = parseRpcParams("capabilities.save", { pack });
    const definition = BUILTIN_CAPABILITIES.find(({ id }) => id === parsed.id);
    const saved = definition ? applyBuiltinOverride(definition, parsed) : scopedPack(parsed, "global");
    if (!hasTransport(saved)) throw new RpcError(-32602, "Capability is missing its transport configuration.");
    if (hasUrlCredentials(saved)) throw invalidUrl();
    const configured = this.vault.configuredKeys();
    delete saved.configuredSecrets;
    try {
      this.history.saveCapability(saved);
    } catch {
      throw new RpcError(-32011, "Could not save the capability pack.");
    }
    return structuredClone(configuredPack(saved, configured));
  }

  async remove(id: string): Promise<void> {
    let removed: boolean;
    try {
      removed = this.history.removeCapability(id);
    } catch {
      throw new RpcError(-32011, "Could not remove the capability pack.");
    }
    if (!removed && !BUILTIN_CAPABILITIES.some((pack) => pack.id === id)) throw new RpcError(-32004, "Capability pack not found.");
  }

  async setSecret(key: string, value: string | null): Promise<{ configuredKeys: string[] }> {
    return { configuredKeys: await this.vault.set(key, value) };
  }

  async invoke(id: string, args: Record<string, unknown>, context: InvokeContext): Promise<CapabilityInvokeResult> {
    if (context.signal?.aborted) throw cancelled();
    const vault = readSecrets(vaultPath(this.dataDir));
    const packs = await this.loadPacks(context.workspacePath, [...vault.keys()].sort());
    const pack = packs.find((entry) => entry.id === id);
    if (!pack) throw new RpcError(-32004, "Capability pack not found.");
    if (!pack.enabled && context.bypassApproval !== true) throw new RpcError(-32003, "Enable the capability pack before running it.");
    const redact = secretRedactor(vault.values());
    const secrets = new Map<string, string>();
    for (const key of pack.secretKeys) {
      const value = vault.get(key);
      if (!value) throw new RpcError(-32004, `Configure secret ${redact(key)} in Capability Hub before running ${redact(pack.name)}.`);
      secrets.set(key, value);
    }
    const invocation: Invocation = { pack, context, secrets, redact };
    if (pack.kind === "rest" && pack.rest) return this.invokeRest(invocation, pack.rest, args);
    if (pack.kind !== "rest" && pack.mcp) return this.invokeMcp(invocation, pack.mcp, args);
    throw new RpcError(-32602, "Capability is missing its transport configuration.");
  }

  private async loadPacks(workspacePath: string | null | undefined, configured: string[]): Promise<CapabilityPack[]> {
    let rows: CapabilityPack[];
    try {
      rows = this.history.listSavedCapabilities();
    } catch {
      throw new RpcError(-32011, "Could not read the saved capability packs.");
    }
    const saved = new Map<string, CapabilityPack>();
    for (const row of rows) {
      try {
        const { pack } = parseRpcParams("capabilities.save", { pack: row });
        if (!hasUrlCredentials(pack)) saved.set(pack.id, pack);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
      }
    }

    const packs = new Map<string, CapabilityPack>();
    for (const definition of BUILTIN_CAPABILITIES) {
      const override = saved.get(definition.id);
      const pack = applyBuiltinOverride(definition, override);
      if (!override && pack.secretKeys.length && pack.secretKeys.every((key) => configured.includes(key))) pack.enabled = true;
      packs.set(pack.id, pack);
    }
    for (const pack of saved.values()) {
      if (!packs.has(pack.id) && hasTransport(pack)) packs.set(pack.id, scopedPack(pack, "global"));
    }
    if (workspacePath) {
      for (const pack of await readProjectPacks(workspacePath)) {
        if (!packs.has(pack.id)) packs.set(pack.id, pack);
      }
    }
    return [...packs.values()].map((pack) => structuredClone(configuredPack(pack, configured)));
  }

  private async approve(invocation: Invocation, action: ApprovalAction): Promise<void> {
    await requireApproval(invocation, action);
    if (!invocation.secrets.size) return;
    const current = readSecrets(vaultPath(this.dataDir));
    for (const [key, value] of invocation.secrets) {
      if (current.get(key) !== value) throw new RpcError(-32004, "Capability credentials changed. Run the capability again.");
    }
  }

  private async request<T>(url: URL, request: HttpRequest, parent: AbortSignal | undefined,
    consume: (response: HttpResponse, signal: AbortSignal) => Promise<T>, handledStatus?: number): Promise<T> {
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    try {
      return await abortable(signal, async () => {
        if (signal.aborted) throw cancelled();
        const headers = request.headers ? Object.fromEntries(request.headers) : undefined;
        const init = { ...request, headers, signal, redirect: "error" } as const;
        let response: HttpResponse;
        try {
          response = this.fetcher === fetch
            ? await undiciFetch(url.href, { ...init, dispatcher: isPrivateHost(url.hostname) ? localNetwork : publicNetwork })
            : await this.fetcher(url.href, init);
        } catch {
          throw new RpcError(-32000, "Capability network request failed.");
        }
        try {
          if (signal.aborted) throw cancelled();
          if (response.redirected || (response.status >= 300 && response.status < 400)) {
            throw new RpcError(-32003, "Capability redirects are blocked.");
          }
          if (response.status !== handledStatus) requireHttpSuccess(response);
          return await consume(response, signal);
        } finally {
          void response.body?.cancel().catch(() => undefined);
        }
      });
    } catch (error) {
      if (parent?.aborted) throw cancelled();
      if (timeout.aborted) throw new RpcError(-32000, "Capability request timed out after 30 seconds.");
      throw error;
    }
  }

  private async invokeRest(invocation: Invocation, rest: CapabilityRestSpec, args: Record<string, unknown>): Promise<CapabilityInvokeResult> {
    const { pack, context, secrets, redact } = invocation;
    const values = resolveInputs(rest, args, redact);
    const input: TokenValue = (token) => selectPath(values, token);
    const tokenValue: TokenValue = (token) => secrets.get(token) ?? input(token);
    const allowLocal = allowLocalEndpoint(pack);
    const url = renderUrl(rest.url, tokenValue, allowLocal, (token) => secrets.has(token));
    const headers = renderHeaders(rest.headers, tokenValue);
    const target = binaryTarget(invocation, rest, args, input);
    let body: string | undefined;
    if (rest.method === "POST" && rest.bodyTemplate !== undefined) {
      body = render(rest.bodyTemplate, (token) => {
        if (secrets.has(token)) throw new RpcError(-32602, "Vault credentials are restricted to URL and header templates.");
        return stringify(input(token));
      });
      try {
        JSON.parse(body);
      } catch {
        throw new RpcError(-32602, "Capability body template must render valid JSON.");
      }
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }

    const endpoint = rest.url.startsWith("{{") ? "configured endpoint" : url.origin;
    await this.approve(invocation, { toolKind: "fetch", detail: `${rest.method} ${endpoint}`, path: target?.path });
    const request = { method: rest.method, headers, body };
    const parseResponse = rest.poll !== undefined || rest.responsePath !== undefined || rest.outputKind === "json";
    if (target && !parseResponse) {
      const asset = await this.request(url, request, context.signal, readAsset);
      return saveAsset(invocation, target, asset);
    }

    const initial = await this.request(url, request, context.signal, async (response, signal) => {
      const text = (await readBytes(response, signal)).toString("utf8");
      return parseResponse ? parseJson(text) : text;
    });
    const output = rest.poll
      ? await this.poll(invocation, rest.poll, url, headers, initial, input)
      : rest.responsePath ? selectPath(initial, rest.responsePath) : initial;
    if (output === undefined) throw new RpcError(-32000, "Capability response is missing the configured result.");
    if (!target) return { text: boundedText(output, redact) };
    if (typeof output !== "string" || !URL_AUTHORITY.test(output)) {
      throw new RpcError(-32000, "Capability response did not provide an HTTP(S) asset URL.");
    }
    const download = validateCapabilityUrl(output, allowLocal);
    const downloadHeaders = followupHeaders(download, url, headers, redact);
    const asset = await this.request(download, { method: "GET", headers: downloadHeaders }, context.signal, readAsset);
    return saveAsset(invocation, target, asset);
  }

  private async poll(invocation: Invocation, poll: CapabilityPollSpec, initialUrl: URL, headers: Headers,
    initial: unknown, input: TokenValue): Promise<unknown> {
    const completed = pollValue(poll, initial);
    if (completed !== undefined) return completed;
    const { pack, context, secrets, redact } = invocation;
    const value: TokenValue = (token) => secrets.get(token) ?? selectPath(initial, token) ?? input(token);
    const url = renderUrl(poll.urlTemplate, value, allowLocalEndpoint(pack),
      (token) => secrets.has(token) || typeof selectPath(initial, token) === "string");
    const pollHeaders = followupHeaders(url, initialUrl, headers, redact);
    const timeout = AbortSignal.timeout(poll.timeoutMs ?? HTTP_TIMEOUT_MS);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
      while (!signal.aborted) {
        const response = await this.request(url, { method: "GET", headers: pollHeaders }, signal, readJsonResponse);
        const value = pollValue(poll, response);
        if (value !== undefined) return value;
        await delay(poll.intervalMs ?? 1_000, undefined, { signal });
      }
      throw cancelled();
    } catch (error) {
      if (context.signal?.aborted) throw cancelled();
      if (timeout.aborted) throw new RpcError(-32000, "Capability polling timed out.");
      throw error;
    }
  }

  private async invokeMcp(invocation: Invocation, spec: CapabilityMcpSpec,
    args: Record<string, unknown>): Promise<CapabilityInvokeResult> {
    const { pack, secrets, redact, context } = invocation;
    const params = mcpToolParams(args);
    if (pack.kind === "mcp-stdio" && spec.command) {
      const command = [spec.command, ...(spec.args ?? [])].map(stringify).join(" ");
      await this.approve(invocation, { toolKind: "shell", detail: `MCP tool ${params.name}`, command });
      return mcpOutput(await callMcpStdio(invocation, spec.command, spec.args ?? [], params), redact);
    }
    if (pack.kind !== "mcp-http" || !spec.url) throw new RpcError(-32602, "Capability is missing its MCP transport configuration.");
    const tokenValue: TokenValue = (token) => secrets.get(token) ?? selectPath(args, token);
    const url = renderUrl(spec.url, tokenValue, allowLocalEndpoint(pack), (token) => secrets.has(token));
    const headers = renderHeaders(spec.headers, tokenValue);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    const endpoint = spec.url.startsWith("{{") ? "configured endpoint" : url.origin;
    await this.approve(invocation, { toolKind: "fetch", detail: `MCP tool ${params.name} at ${endpoint}` });

    const directCall = { method: "POST", headers, body: stringify(rpcCall(1, "tools/call", params)) } as const;
    const direct = await this.request(url, directCall, context.signal, async (response, signal) => {
      // Retry only when the server explicitly rejected the request before dispatch for lack of a session.
      if (response.status === 400 && response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        const rejection = await readJsonResponse(response, signal);
        if (isRecord(rejection) && rejection.jsonrpc === "2.0" && rejection.id === null && isRecord(rejection.error) &&
          rejection.error.code === -32000 && (rejection.error.message === "Bad Request: Server not initialized" ||
          rejection.error.message === "Bad Request: Mcp-Session-Id header is required")) return { sessionRequired: true } as const;
      }
      requireHttpSuccess(response);
      return { sessionRequired: false, result: mcpResult(await readMcpReply(response, signal, 1)) } as const;
    }, 400);
    if (!direct.sessionRequired) return mcpOutput(direct.result, redact);

    const session = await this.request(url, { method: "POST", headers, body: stringify(mcpInitialize) }, context.signal,
      async (response, signal) => {
        const id = response.headers.get("mcp-session-id");
        if (id !== null && !/^[\x21-\x7e]{1,1024}$/u.test(id)) throw new RpcError(-32000, "MCP server returned an invalid session ID.");
        return { id, version: mcpVersion(mcpResult(await readMcpReply(response, signal, 1))) };
      });
    if (session.id) headers.set("Mcp-Session-Id", session.id);
    headers.set("MCP-Protocol-Version", session.version);
    try {
      await this.request(url, { method: "POST", headers, body: stringify(mcpInitialized) }, context.signal, async () => {});
      const result = await this.request(url, { method: "POST", headers, body: stringify(rpcCall(2, "tools/call", params)) },
        context.signal, async (response, signal) => mcpResult(await readMcpReply(response, signal, 2)));
      const redactSession = session.id ? secretRedactor([session.id]) : undefined;
      return mcpOutput(result, redactSession ? (text) => redact(redactSession(text)) : redact);
    } finally {
      if (session.id) {
        await this.request(url, { method: "DELETE", headers }, AbortSignal.timeout(1_000), async () => {}).catch(() => undefined);
      }
    }
  }
}
