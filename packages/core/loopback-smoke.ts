import assert from "node:assert/strict";
import { fetchLoopback } from "./src/loopback-http";

const localHost = "127.0.0.1";
let proxyRequests = 0;
const proxy = Bun.serve({
  hostname: localHost,
  port: 0,
  fetch() {
    proxyRequests++;
    return new Response("fixture proxy");
  },
});
const proxyAddress = `http://${localHost}:${proxy.port}`;
const proxyEnvironment = {
  http_proxy: proxyAddress,
  HTTP_PROXY: proxyAddress,
  all_proxy: proxyAddress,
  ALL_PROXY: proxyAddress,
  no_proxy: "fixture.invalid",
  NO_PROXY: "fixture.invalid",
  NODE_USE_ENV_PROXY: "1",
};
Object.assign(process.env, proxyEnvironment);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const messages = [
  { role: "user", content: "synthetic first turn" },
  { role: "assistant", content: "synthetic reply" },
  { role: "user", content: "synthetic second turn" },
];
let finishStream: (() => void) | undefined;
const origin = Bun.serve({
  hostname: localHost,
  port: 0,
  async fetch(request) {
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("proxy-authorization"), null);
    assert.equal(request.headers.get("cookie"), null);
    const path = new URL(request.url).pathname;
    if (path === "/redirect") return Response.redirect(proxyAddress, 307);
    if (path === "/models") return Response.json({ models: ["fixture"] });
    assert.equal(path, "/chat");
    assert.equal(request.method, "POST");
    assert.deepEqual(await request.json(), { messages });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("fixture first chunk"));
        finishStream = () => {
          controller.enqueue(encoder.encode("fixture second chunk"));
          controller.close();
        };
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  },
});
const base = `http://${localHost}:${origin.port}`;

try {
  const signal = AbortSignal.timeout(5_000);
  const options = { method: "GET", signal } as const;
  // Control request verifies the synthetic proxy is active on a transport that honors it.
  assert.equal(await (await fetch(base + "/models", { proxy: proxyAddress, signal })).text(), "fixture proxy");
  const models = await fetchLoopback(base + "/models", options);
  assert.equal(models.headers.get("content-type")?.startsWith("application/json"), true);
  assert.deepEqual(await models.json(), { models: ["fixture"] });

  const post = {
    method: "POST",
    body: JSON.stringify({ messages }),
    headers: { "Content-Type": "application/json" },
  } as const;
  const response = await fetchLoopback(base + "/chat", { ...post, signal });
  const reader = response.body!.getReader();
  assert.equal(decoder.decode((await reader.read()).value), "fixture first chunk");
  finishStream!();
  assert.equal(decoder.decode((await reader.read()).value), "fixture second chunk");
  assert.equal((await reader.read()).done, true);

  const abort = new AbortController();
  const pending = await fetchLoopback(base + "/chat", { ...post, signal: AbortSignal.any([signal, abort.signal]) });
  const pendingReader = pending.body!.getReader();
  assert.equal(decoder.decode((await pendingReader.read()).value), "fixture first chunk");
  const pendingChunk = pendingReader.read();
  abort.abort();
  await assert.rejects(pendingChunk);

  await assert.rejects(fetchLoopback(base + "/redirect", options), /returned a redirect/);
  await assert.rejects(fetchLoopback(`http://localhost:${origin.port}/models`, options), /loopback HTTP/);
  await assert.rejects(fetchLoopback(`https://${localHost}:${origin.port}/models`, options), /loopback HTTP/);
  await assert.rejects(fetchLoopback(`http://fixture-user@${localHost}:${origin.port}/models`, options), /loopback HTTP/);
  assert.equal(proxyRequests, 1);
  for (const [key, value] of Object.entries(proxyEnvironment)) assert.equal(process.env[key], value);
  console.log("Loopback smoke passed: direct GET, streamed POST, abort, redirect and origin checks, unchanged proxy environment.");
} finally {
  await Promise.all([origin.stop(true), proxy.stop(true)]);
}
