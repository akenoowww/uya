import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { classifyCliDiagnostic, drainCliDiagnostics } from "./cli-diagnostics";
import { ProviderRegistry } from "./provider-registry";

test("reports an allowlisted adapter flag when the installed CLI rejects it", () => {
  const codex = classifyCliDiagnostic("error: unexpected argument '--ignore-user-config' found", ["--ignore-user-config"]);
  expect(codex).toEqual({
    kind: "unsupported-option",
    message: "The CLI rejected --ignore-user-config. Update the CLI to a compatible version or run it in Terminal.",
  });
  const claude = classifyCliDiagnostic("error: unknown option '\u001b[33m--no-chrome\u001b[0m'", ["--no-chrome"]);
  expect(claude?.message).toContain("--no-chrome");
});

test("returns fixed diagnostics without reflecting raw messages or custom argument names", () => {
  const syntheticMarker = "fixture-value-that-must-stay-private";
  const customOption = classifyCliDiagnostic(`Error: unknown option '--${syntheticMarker}'`, [`--${syntheticMarker}`]);
  expect(customOption?.kind).toBe("unsupported-option");
  expect(customOption?.message).not.toContain(syntheticMarker);
  expect(classifyCliDiagnostic("unknown option '--tools'", [])?.message).not.toContain("--tools");
  const auth = classifyCliDiagnostic(`API Error: 401 {"error":"invalid_api_key","fixture":"${syntheticMarker}"}`);
  expect(auth?.kind).toBe("authentication");
  expect(auth?.message).not.toContain(syntheticMarker);
  expect(classifyCliDiagnostic(`Unclassified failure. Debug value: ${syntheticMarker}`)).toBeUndefined();
});

test("recognizes useful failure classes from CLI error syntax", () => {
  const examples = [
    ["Access token expired. Use the CLI login.", "authentication"],
    ['{"error_type":"authentication_error","status_code":403,"message":"Permission denied"}', "authentication"],
    ['{"error_type":"rate_limit_error","status":"RESOURCE_EXHAUSTED","status_code":429}', "rate-limit"],
    ["API Error: 429 insufficient_quota", "quota"],
    ["Request failed with status code 429", "rate-limit"],
    ["403 Forbidden", "permission"],
    ["error EACCES: permission denied", "permission"],
    ["API error: model_not_found", "model-unavailable"],
    ["context_length_exceeded", "context-limit"],
    ["getaddrinfo ENOTFOUND synthetic.invalid", "network"],
  ] as const;
  for (const [stderr, kind] of examples) expect(classifyCliDiagnostic(stderr)?.kind).toBe(kind);
});

test("consumes a long stderr pipe and recognizes a diagnostic split across writes", async () => {
  let count = 0;
  async function* writes(): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    yield encoder.encode("Opening connection\n");
    for (; count < 80; count++) yield encoder.encode("·".repeat(4000));
    yield encoder.encode("\nerror: connection ref");
    yield encoder.encode("used\n");
  }
  expect((await drainCliDiagnostics(Readable.from(writes())))?.kind).toBe("network");
  expect(count).toBe(80);
});

test("preserves startup errors and avoids classifying messages created by concatenating disjoint windows", async () => {
  const burst = "x".repeat(64 * 1024);
  const startup = Readable.from(["error: unknown option '--tools'\n", burst]);
  expect((await drainCliDiagnostics(startup, ["--tools"]))?.message).toContain("--tools");

  const split = Readable.from([" ".repeat(8182) + "connection", burst, " refused" + " ".repeat(8184)]);
  expect(await drainCliDiagnostics(split)).toBeUndefined();
});

test("structured CLI failures surface a safe diagnostic after draining the actual stderr pipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uya-diagnostic-test-"));
  const command = join(directory, "claude-fixture");
  const syntheticMarker = "fixture-value-that-must-stay-private";
  try {
    await writeFile(command, `#!/bin/sh
case " $* " in *" --effort medium "*) ;; *) exit 3;; esac
/bin/cat >/dev/null
/bin/dd if=/dev/zero bs=65536 count=16 >&2 2>/dev/null
printf '%s\\n' "error: unknown option '--effort'" >&2
printf '%s\\n' '${syntheticMarker}' >&2
exit 2
`, { mode: 0o700 });

    const raw: string[] = [];
    const agent = new ProviderRegistry().run({
      provider: { id: "claude", name: "Claude fixture", command, kind: "cli", available: true, terminal: true, structured: true },
      prompt: "synthetic prompt",
      effort: "medium",
      signal: AbortSignal.timeout(3_000),
      output: { emit() {}, raw: (line) => raw.push(line) },
    });
    const error = await agent.catch((error: unknown) => error);
    expect(error).toMatchObject({
      message: "The CLI rejected --effort. Update the CLI to a compatible version or run it in Terminal.",
      exitCode: 2,
    });
    expect((error as Error).message).not.toContain(syntheticMarker);
    expect(raw).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
