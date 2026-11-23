import { expect, test } from "bun:test";
import type { RunDetail, RunSummary } from "@ide/protocol";
import type { Bridge } from "./bridge";
import { createRunStreams } from "./runStreams";

test("runStreams falls back cleanly to runs.get polling when WebSocket fails", async () => {
  const seed: RunSummary = {
    id: "run-poll-1",
    providerId: "codex",
    prompt: "Test",
    status: "running",
    startedAt: 1000,
  };
  const finished: RunSummary = { ...seed, status: "succeeded", finishedAt: 2000, exitCode: 0 };
  let polls = 0;
  const received: RunDetail[] = [];
  const errors: string[] = [];

  const bridge = {
    subscribe(_id: string, _after: number, _onEvent: unknown, onClose: () => void) {
      queueMicrotask(onClose);
      return () => {};
    },
    async rpc(method: string) {
      if (method !== "runs.get") throw new Error("unexpected method");
      polls += 1;
      if (polls === 1) {
        return {
          run: seed,
          events: [{ runId: seed.id, seq: 1, type: "status", run: seed }],
        };
      }
      return {
        run: finished,
        events: [
          { runId: seed.id, seq: 1, type: "status", run: seed },
          { runId: seed.id, seq: 2, type: "text", text: "Hello from fallback poll" },
          { runId: seed.id, seq: 3, type: "status", run: finished },
        ],
      };
    },
  } as unknown as Bridge;

  const streams = createRunStreams(
    (detail) => received.push(detail),
    (message) => errors.push(message),
  );
  streams.follow(bridge, seed);

  const deadline = Date.now() + 3000;
  while (received.at(-1)?.run.status !== "succeeded" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  streams.stop();

  expect(errors).toEqual([]);
  expect(received.at(-1)?.run.status).toBe("succeeded");
  expect(received.at(-1)?.events.some((event) => event.type === "text" && event.text === "Hello from fallback poll")).toBe(true);
});
