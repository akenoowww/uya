import { expect, test } from "bun:test";
import { discoverOllamaModels, runOllama } from "./ollama";

const tag = "fixture:latest";
const tags = () => Response.json({ models: [{ model: tag }] });
const noOutput = () => {};

test("discovers distinct local tags and tolerates an offline service", async () => {
  const models = await discoverOllamaModels(async (url, init) => {
    expect(url).toBe("http://127.0.0.1:11434/api/tags");
    expect(init.method).toBe("GET");
    return Response.json({
      models: [
        { model: tag },
        { name: tag },
        { name: "another:custom" },
        { model: "model:cloud" },
        { model: "model-cloud:latest" },
        { model: "alias:latest", remote_host: "fixture.example" },
        { model: "alias-2:latest", remote_model: "fixture-cloud" },
        null,
      ],
    });
  });
  expect(models).toEqual(["another:custom", tag]);
  expect(await discoverOllamaModels(async () => { throw new Error("offline"); })).toEqual([]);
});

test("streams fragmented UTF-8 records and reports terminal usage", async () => {
  const messages = [
    { role: "user", content: "fixture first turn" },
    { role: "assistant", content: "fixture reply" },
    { role: "user", content: "fixture second turn" },
  ] as const;
  const content = [
    '{"message":{"thinking":"fixture thought"},"done":false}',
    '{"message":{"content":"✓"},"done":false}',
    "",
    '{"done":true,"prompt_eval_count":4,"eval_count":1}',
  ];
  const payload = new TextEncoder().encode(content.join("\r\n"));
  const split = payload.indexOf(0xe2) + 1;
  const deltas: string[] = [];
  const thoughts: string[] = [];
  const raw: string[] = [];
  const usage = await runOllama(
    tag,
    messages,
    new AbortController().signal,
    (delta) => deltas.push(delta),
    (line) => raw.push(line),
    async (url, init) => {
      if (url.endsWith("/api/tags")) return tags();
      expect(url).toBe("http://127.0.0.1:11434/api/chat");
      expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
      expect(JSON.parse(init.body as string)).toEqual({
        model: tag,
        messages,
        stream: true,
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.subarray(0, split));
          controller.enqueue(payload.subarray(split));
          controller.close();
        },
      }));
    },
    (delta) => thoughts.push(delta),
  );
  expect(deltas).toEqual(["✓"]);
  expect(thoughts).toEqual(["fixture thought"]);
  expect(raw).toEqual(content.filter(Boolean));
  expect(usage).toEqual({ inputTokens: 4, outputTokens: 1 });
});

test.each([
  ["minimal", false], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"], ["max", "high"],
] as const)("sends Ollama effort %s as think=%p", async (effort, think) => {
  await runOllama(tag, "fixture", new AbortController().signal, noOutput, noOutput, async (url, init) => {
    if (url.endsWith("/api/tags")) return tags();
    expect(JSON.parse(init.body as string)).toEqual({
      model: tag, messages: [{ role: "user", content: "fixture" }], stream: true, think,
    });
    return new Response('{"done":true}\n');
  }, undefined, effort);
});

test.each([
  ["minimal", false], ["high", "high"],
] as const)("retries without think after Ollama rejects effort %s", async (effort, think) => {
  const sent: unknown[] = [];
  const text: string[] = [];
  let rejectedBodyCancelled = false;
  const usage = await runOllama(tag, "fixture", new AbortController().signal, (delta) => text.push(delta), noOutput, async (url, init) => {
    if (url.endsWith("/api/tags")) return tags();
    sent.push(JSON.parse(init.body as string));
    if (sent.length === 1) {
      return new Response(new ReadableStream({
        cancel() { rejectedBodyCancelled = true; },
      }), { status: 400 });
    }
    expect(rejectedBodyCancelled).toBe(true);
    return new Response('{"message":{"content":"fixture reply"},"done":true,"eval_count":2}\n');
  }, undefined, effort);
  const defaultBody = { model: tag, messages: [{ role: "user", content: "fixture" }], stream: true };
  expect(sent).toEqual([{ ...defaultBody, think }, defaultBody]);
  expect(text).toEqual(["fixture reply"]);
  expect(usage.outputTokens).toBe(2);
});

test.each([
  ["high", 400, 2], ["high", 500, 1], [undefined, 400, 1],
] as const)("bounds Ollama retries for effort %p and HTTP %i", async (effort, status, attempts) => {
  let posts = 0;
  await expect(runOllama(tag, "fixture", new AbortController().signal, noOutput, noOutput, async (url) => {
    if (url.endsWith("/api/tags")) return tags();
    posts += 1;
    return new Response(null, { status });
  }, undefined, effort)).rejects.toThrow(`Ollama chat failed (HTTP ${status})`);
  expect(posts).toBe(attempts);
});

test("honors cancellation before retrying a rejected Ollama thinking option", async () => {
  const abort = new AbortController();
  let posts = 0;
  await expect(runOllama(tag, "fixture", abort.signal, noOutput, noOutput, async (url) => {
    if (url.endsWith("/api/tags")) return tags();
    posts += 1;
    return new Response(new ReadableStream({
      cancel() { abort.abort(); },
    }), { status: 400 });
  }, undefined, "medium")).rejects.toHaveProperty("name", "AbortError");
  expect(posts).toBe(1);
});

test("rejects stale and cloud-backed aliases before sending prompts", async () => {
  let chatRequests = 0;
  const run = runOllama(
    tag,
    "fixture prompt",
    new AbortController().signal,
    noOutput,
    noOutput,
    async (url) => {
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: [{ model: tag, remote_model: "fixture-cloud" }] });
      }
      chatRequests += 1;
      return new Response();
    },
  );
  await expect(run).rejects.toThrow("unavailable as a local Ollama model");
  expect(chatRequests).toBe(0);
});

test("rejects incomplete streams and omits rejected provider records from raw output", async () => {
  const signal = new AbortController().signal;
  const incomplete = runOllama(tag, "fixture", signal, noOutput, noOutput, async (url) =>
    url.endsWith("/api/tags") ? tags() : new Response('{"message":{"content":"partial"},"done":false}\n'));
  await expect(incomplete).rejects.toThrow("ended before completion");

  const raw: string[] = [];
  const failed = runOllama(tag, "fixture", signal, noOutput, (line) => raw.push(line), async (url) =>
    url.endsWith("/api/tags") ? tags() : new Response('{"error":"fixture error"}\n'));
  await expect(failed).rejects.toThrow("reported a generation error");
  expect(raw).toEqual([]);
});

test("cancels the body reader when a run is aborted after chat begins", async () => {
  const abort = new AbortController();
  let bodyCancelled = false;
  const raw: string[] = [];
  const run = runOllama(tag, "fixture", abort.signal, () => abort.abort(), (line) => raw.push(line), async (url) => {
    if (url.endsWith("/api/tags")) return tags();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const records = ['{"message":{"content":"first"},"done":false}', '{"done":true}', ""];
        controller.enqueue(new TextEncoder().encode(records.join("\n")));
      },
      cancel() {
        bodyCancelled = true;
      },
    }));
  });
  await expect(run).rejects.toHaveProperty("name", "AbortError");
  expect(bodyCancelled).toBe(true);
  expect(raw).toHaveLength(1);
});
