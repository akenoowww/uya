import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Use Undici directly so Bun's proxy settings cannot carry the loopback token off-host.
import { request } from "undici/index.js";
import type { McpStdioServerSpec } from "./provider-adapter";

export interface McpBridgeConfig {
  url: string;
  token: string;
}

export async function writeMcpBridgeSpec(
  scratchDir: string,
  config: McpBridgeConfig,
  entryScriptPath?: string,
): Promise<McpStdioServerSpec> {
  const configPath = join(scratchDir, "uya-mcp-bridge.json");
  const temporaryPath = join(scratchDir, `.uya-mcp-bridge-${randomUUID()}.json`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(config));
    } finally {
      await file.close();
    }
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(Bun.main);
  const bridgeArgs = ["--mcp-stdio", configPath];
  const args = compiled
    ? bridgeArgs
    : ["--no-env-file", entryScriptPath ?? fileURLToPath(new URL("./index.ts", import.meta.url)), ...bridgeArgs];
  return { name: "uya", command: process.execPath, args };
}

const MAX_HEADER_BYTES = 8192;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
type RpcId = string | number | null;

interface MessageFrame {
  text: string;
  contentLength: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readConfig(configPath: string): Promise<McpBridgeConfig> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("Could not read the Uya MCP bridge configuration.");
  }

  if (isObject(config) && typeof config.url === "string" && typeof config.token === "string") {
    const port = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/mcp$/.exec(config.url)?.[1];
    if (port && Number(port) > 0 && Number(port) <= 65535 && config.url.trim() === config.url &&
      config.token.length > 0 && config.token.length <= 128 && !/[^A-Za-z0-9_-]/.test(config.token)) {
      return { url: config.url, token: config.token };
    }
  }
  throw new Error("Invalid Uya MCP bridge configuration.");
}

async function* readFrames(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<MessageFrame> {
  let parts: Buffer[] = [];
  let pendingBytes = 0;
  let headerBytes = 0;
  let length: number | undefined;
  let readingBody = false;

  function takeMessage(): string {
    const message = Buffer.concat(parts, pendingBytes).toString("utf8");
    parts = [];
    pendingBytes = 0;
    return message;
  }

  for await (const chunk of input) {
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      if (readingBody && length !== undefined) {
        const end = Math.min(bytes.length, offset + length - pendingBytes);
        parts.push(bytes.subarray(offset, end));
        pendingBytes += end - offset;
        offset = end;
        if (pendingBytes === length) {
          readingBody = false;
          length = undefined;
          headerBytes = 0;
          yield { text: takeMessage(), contentLength: true };
        }
        continue;
      }

      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      if (end > offset) parts.push(bytes.subarray(offset, end));
      pendingBytes += end - offset;
      const limit = headerBytes > 0 ? MAX_HEADER_BYTES - headerBytes : MAX_MESSAGE_BYTES;
      if (pendingBytes > limit) {
        throw new Error("Uya MCP input exceeds the size limit.");
      }
      if (newline === -1) break;
      offset = newline + 1;

      const lineBytes = pendingBytes + 1;
      const line = takeMessage().replace(/\r$/, "");
      if (headerBytes === 0 && !/^Content-(Length|Type):/i.test(line)) {
        if (line.trim()) yield { text: line, contentLength: false };
        continue;
      }

      headerBytes += lineBytes;
      if (headerBytes > MAX_HEADER_BYTES) throw new Error("Uya MCP headers exceed the size limit.");
      if (line === "") {
        if (length === undefined) throw new Error("Missing Uya MCP Content-Length header.");
        readingBody = true;
      } else if (/^Content-Length:/i.test(line)) {
        const value = /^Content-Length:[ \t]*([0-9]+)[ \t]*$/i.exec(line)?.[1];
        const nextLength = Number(value);
        if (length !== undefined || !Number.isSafeInteger(nextLength) || nextLength < 1 || nextLength > MAX_MESSAGE_BYTES) {
          throw new Error("Invalid Uya MCP Content-Length header.");
        }
        length = nextLength;
      }
    }
  }

  if (headerBytes > 0) throw new Error("Incomplete Uya MCP frame.");
  if (pendingBytes > 0) {
    const text = takeMessage();
    if (text.trim()) yield { text, contentLength: false };
  }
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function forwardMessage(text: string, config: McpBridgeConfig): Promise<unknown> {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "Parse error.");
  }

  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(null, -32600, "Invalid request.");
  }
  const { id } = message;
  if (id !== undefined && id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
    return rpcError(null, -32600, "Invalid request ID.");
  }

  try {
    const { statusCode, body } = await request(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Uya-Mcp-Token": config.token },
      body: text,
    });
    if (id === undefined || (statusCode >= 300 && statusCode < 400)) {
      await body.dump();
    } else {
      const reply: unknown = await body.json();
      if (isObject(reply) && reply.jsonrpc === "2.0" && reply.id === id &&
        Object.hasOwn(reply, "result") !== Object.hasOwn(reply, "error")) {
        return reply;
      }
    }
  } catch {
    // Report transport failures without exposing configuration or HTTP error bodies.
  }
  if (id !== undefined) return rpcError(id, -32603, "The Uya MCP endpoint did not return a valid response.");
}

export async function runMcpStdioBridge(configPath: string): Promise<void> {
  await readConfig(configPath);
  for await (const frame of readFrames(process.stdin)) {
    const config = await readConfig(configPath);
    const reply = await forwardMessage(frame.text, config);
    if (reply === undefined) continue;
    const json = JSON.stringify(reply);
    const output = frame.contentLength ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : `${json}\n`;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(output, (error) => error ? reject(error) : resolve());
    });
  }
}
