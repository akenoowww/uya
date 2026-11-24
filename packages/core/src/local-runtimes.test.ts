import { describe, expect, test } from "bun:test";
import { discoverLocalRuntimeModels, runLocalRuntime } from "./local-runtimes";

function modelList(data: object[]) {
  return Response.json({ object: "list", data: data.map((item) => ({ object: "model", ...item })) });
}

function collect() {
  const chunks: string[][] = [];
  const lines: string[] = [];
  return {
    chunks,
    lines,
    output: {
      emit: (type: string, value: string) => chunks.push([type, value]),
      raw: (line: string) => lines.push(line),
    },
  };
}

function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

describe("local runtime adapters", () => {
  test("detects llama.cpp with loaded local weights across supported loopback ports", async () => {
    const calls: string[] = [];
    const result = await discoverLocalRuntimeModels("llamacpp", async (url, init) => {
      calls.push(url);
      expect(init.method).toBe("GET");
      if (url.includes(":9931")) return modelList([
        { id: "warm", owned_by: "llamacpp", status: { value: "loaded" } },
        { id: "cold", owned_by: "llamacpp", status: { value: "unloaded" } },
        { id: "alias-cloud", owned_by: "llamacpp" },
        { id: "external", owned_by: "llamacpp", remote_host: "synthetic" },
      ]);
      return modelList([{ id: "single", owned_by: "llamacpp" }, { id: "other", owned_by: "generic" }]);
    });
    expect(result).toEqual(["single", "warm"]);
    expect(calls).toEqual(["http://127.0.0.1:9931/v1/models", "http://127.0.0.1:8080/v1/models"]);
  });

  test("selects loaded LM Studio LLM instances and leaves unavailable/cloud entries out", async () => {
    const result = await discoverLocalRuntimeModels("lmstudio", async (url) => {
      expect(url).toBe("http://127.0.0.1:1234/api/v1/models");
      return Response.json({ models: [
        { type: "llm", format: "gguf", loaded_instances: [{ id: "loaded" }] },
        { type: "llm", format: "mlx", loaded_instances: [] },
        { type: "embedding", format: "gguf", loaded_instances: [{ id: "embedding" }] },
        { type: "llm", format: "gguf", remote: true, loaded_instances: [{ id: "remote" }] },
        { type: "llm", format: "remote", loaded_instances: [{ id: "not-local" }] },
      ] });
    });
    expect(result).toEqual(["loaded"]);
  });

  test("distinguishes MLX from unrelated OpenAI-compatible services on port 8080", async () => {
    const localModel = { id: "/fixture/local-mlx", created: 1 };
    const cachedModel = { id: "fixture/model", created: 1 };
    const compatible = await discoverLocalRuntimeModels("mlx", async (url) =>
      url.endsWith("/v1/models") ? modelList([localModel, cachedModel]) : modelList([localModel]));
    expect(compatible).toEqual([localModel.id, cachedModel.id]);
    const generic = await discoverLocalRuntimeModels("mlx", async (url) =>
      url.endsWith("/v1/models") ? modelList([cachedModel]) : new Response(null, { status: 404 }));
    expect(generic).toEqual([]);
    const llamaServer = await discoverLocalRuntimeModels("mlx", async () =>
      modelList([{ ...cachedModel, owned_by: "llamacpp" }]));
    expect(llamaServer).toEqual([]);
  });

  test("sends the whole conversation and streams fragmented UTF-8, thought and usage", async () => {
    const { output, chunks, lines } = collect();
    const messages = [
      { role: "user", content: "Remember the color." },
      { role: "assistant", content: "I will remember." },
      { role: "user", content: "Which color?" },
    ] as const;
    const result = await runLocalRuntime("llamacpp", "fixture", messages, new AbortController().signal, output, async (url, init) => {
      if (init.method === "GET") return modelList([{ id: "fixture", owned_by: "llamacpp" }]);
      expect(url).toBe("http://127.0.0.1:9931/v1/chat/completions?autoload=false");
      expect(init).toMatchObject({ method: "POST", headers: { Accept: "text/event-stream" } });
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      expect(JSON.parse(String(init.body))).toEqual({
        model: "fixture", messages, stream: true, stream_options: { include_usage: true },
      });
      return stream([
        ": ping\r\n\r\n",
        'data: {"choices":\r\ndata: [{"delta":{"reasoning_content":"Вспомнил"},"ignored":"fixture-opaque"}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"Синий"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ].join(""));
    });
    expect(chunks).toEqual([["thinking", "Вспомнил"], ["text", "Синий"]]);
    expect(result).toEqual({ inputTokens: 9, outputTokens: 3 });
    expect(lines.join("\n")).not.toContain("fixture-opaque");
  });

  test.each([
    ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"], ["max", "high"],
  ] as const)("sends local effort %s as reasoning_effort=%s", async (effort, expected) => {
    const { output } = collect();
    await runLocalRuntime("llamacpp", "fixture", "fixture prompt", new AbortController().signal, output, async (_url, init) => {
      if (init.method === "GET") return modelList([{ id: "fixture", owned_by: "llamacpp" }]);
      expect(JSON.parse(init.body as string)).toMatchObject({ reasoning_effort: expected });
      return stream('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, effort);
  });

  test("rejects a stale model before transmitting a prompt, and rejects tool or error frames", async () => {
    const { output, lines } = collect();
    const signal = new AbortController().signal;
    const localModels = () => Response.json({ models: [
      { type: "llm", format: "gguf", loaded_instances: [{ id: "current" }] },
    ] });
    let posted = false;
    await expect(runLocalRuntime("lmstudio", "stale", "fixture", signal, output, async (_url, init) => {
      posted ||= init.method === "POST";
      return localModels();
    })).rejects.toThrow("unavailable");
    expect(posted).toBe(false);

    for (const [frame, message] of [
      ['{"error":{"message":"fixture-opaque"}}', "generation error"],
      ['{"choices":[{"delta":{"tool_calls":[{"type":"function","name":"fixture-opaque"}]}}]}', "read-only run"],
      ['{"choices":[{"delta":{"content":"incomplete"}}]}', "before completion"],
    ]) {
      await expect(runLocalRuntime("lmstudio", "current", "fixture", signal, output,
        async (_url, init) => init.method === "GET" ? localModels() : stream(`data: ${frame}\n\n`)
      )).rejects.toThrow(message);
    }
    expect(lines.join("\n")).not.toContain("fixture-opaque");
  });

  test("cancels a pending stream read when a run is aborted", async () => {
    const { output } = collect();
    const controller = new AbortController();
    let cancelled = false;
    const run = runLocalRuntime("lmstudio", "hosted", "fixture", controller.signal, output, async (_url, init) => {
      if (init.method === "GET") {
        return Response.json({ models: [{ type: "llm", format: "gguf", loaded_instances: [{ id: "hosted" }] }] });
      }
      return new Response(new ReadableStream({
        start() { setTimeout(() => controller.abort(new Error("fixture abort")), 1); },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    });
    await expect(run).rejects.toThrow("fixture abort");
    expect(cancelled).toBe(true);
  });
});
