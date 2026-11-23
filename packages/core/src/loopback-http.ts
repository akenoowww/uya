import { Readable } from "node:stream";
// The bare specifier resolves to Bun's shim, which still routes through HTTP_PROXY.
import { Client } from "undici/index.js";

export type LoopbackFetch = (url: string, request: {
  method: "GET" | "POST";
  signal: AbortSignal;
  headers?: { Accept?: string; "Content-Type"?: string };
  body?: string;
}) => Promise<Response>;

export const fetchLoopback: LoopbackFetch = async (url, request) => {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password) {
    throw new Error("Local inference requires a loopback HTTP address.");
  }
  request.signal.throwIfAborted();

  const client = new Client(target.origin);
  try {
    const { statusCode, headers, body } = await client.request({
      path: target.pathname + target.search,
      method: request.method,
      headers: {
        ...(request.headers?.Accept && { Accept: request.headers.Accept }),
        ...(request.headers?.["Content-Type"] && { "Content-Type": request.headers["Content-Type"] }),
      },
      body: request.body,
      signal: request.signal,
    });
    const stream = Readable.toWeb(body) as ReadableStream<Uint8Array>;
    if (statusCode >= 300 && statusCode < 400) {
      await stream.cancel().catch(() => {});
      throw new Error("The local inference server returned a redirect.");
    }
    const contentType = headers["content-type"];
    const responseOptions = {
      status: statusCode,
      headers: typeof contentType === "string" ? { "Content-Type": contentType } : undefined,
    };
    if (statusCode === 204 || statusCode === 205) {
      body.resume();
      return new Response(null, responseOptions);
    }
    return new Response(stream, responseOptions);
  } catch (error) {
    void client.destroy().catch(() => {});
    throw error;
  } finally {
    // close waits for the response stream, including cancellation via AbortSignal or body.cancel().
    void client.close().catch(() => {});
  }
};
