import { expect, test } from "bun:test";
import { isRpcMethod, parseRpcParams, rpcEnvelope, rpcResponseId, subscription } from "./validation";

test("accepts existing RPC defaults and strips unexpected fields", () => {
  expect(parseRpcParams("providers.list", undefined)).toEqual({});
  expect(parseRpcParams("workspace.list", { workspacePath: "/fixture", redundant: true })).toEqual({ workspacePath: "/fixture" });
  expect(parseRpcParams("runs.start", { prompt: "  review  ", mode: null, workspacePath: null })).toEqual({
    prompt: "  review  ", mode: "manual", workspacePath: null,
  });
  expect(parseRpcParams("runs.setRules", { rules: [{ providerId: "fixture", extension: ".TS" }] })).toEqual({
    rules: [{ providerId: "fixture", extension: "ts" }],
  });
  expect(parseRpcParams("providers.add", { name: " Fixture CLI ", command: " /fixture/tool ", args: [""] })).toEqual({
    name: "Fixture CLI", command: "/fixture/tool", args: [""],
  });
});

test("validates the envelope and preserves a usable ID when the envelope is invalid", () => {
  expect(rpcEnvelope.safeParse({ jsonrpc: "2.0", method: "runs.list", id: 1 }).success).toBe(true);
  const wrongVersion = { jsonrpc: "1.0", method: "runs.list", id: "fixture" };
  expect(rpcEnvelope.safeParse(wrongVersion).success).toBe(false);
  expect(rpcResponseId.safeParse(wrongVersion).data?.id).toBe("fixture");
  for (const id of [null, Number.MAX_SAFE_INTEGER + 1, 1.5, {}]) {
    expect(rpcEnvelope.safeParse({ jsonrpc: "2.0", method: "runs.list", id }).success).toBe(false);
  }
  expect(isRpcMethod("providers.add")).toBe(true);
  expect(isRpcMethod("constructor")).toBe(false);
  expect(isRpcMethod("__proto__")).toBe(false);
});

test("rejects invalid payloads with fixed messages and no input or variable names", () => {
  const marker = "synthetic private marker";
  const ref = { scope: "global", path: "fixture.prompt.md" };
  for (const operation of [
    () => parseRpcParams("providers.add", { name: "Fixture", command: "./tool", args: [] }),
    () => parseRpcParams("runs.start", { prompt: "😀".repeat(128_001) }),
    () => parseRpcParams("runs.start", { prompt: "fixture\0", mode: marker }),
    () => parseRpcParams("runs.start", { prompt: "fixture", contextPaths: Array(21).fill(marker) }),
    () => parseRpcParams("runs.conversation", { id: "fixture", workspacePath: false }),
    () => parseRpcParams("prompts.render", { ref, values: { [marker]: { invalid: marker } } }),
  ]) {
    try {
      operation();
      throw new Error("Expected schema rejection.");
    } catch (error) {
      expect(error).toMatchObject({ code: -32602 });
      expect((error as Error).message).not.toContain(marker);
    }
  }
});

test("keeps literal prompt variable names without modifying the prototype", () => {
  const values = JSON.parse('{"__proto__":"literal","constructor":"fixture"}');
  const parsed = parseRpcParams("prompts.render", { ref: { scope: "global", path: "fixture.prompt.md" }, values }).values;
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(parsed["__proto__"]).toBe("literal");
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(parsed["constructor"]).toBe("fixture");
});

test("requires a safe nonnegative replay cursor", () => {
  const parsed = subscription.safeParse({ runId: "fixture", after: 0, token: "fixture" });
  expect(parsed.success).toBe(true);
  for (const after of [-1, "0", 0.5]) {
    expect(subscription.safeParse({ runId: "fixture", after, token: "fixture" }).success).toBe(false);
  }
});
