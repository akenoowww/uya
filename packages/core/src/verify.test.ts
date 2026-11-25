import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyRun } from "@ide/protocol";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cliEnv } from "./agents";
import { discoverVerifyPresets, VerifyManager } from "./verify";

const WINDOWS = process.platform === "win32";
const HOLD = WINDOWS ? "for /l %i in (1,1,100000000) do @rem" : "exec sleep 30";
const OUTPUT_LIMIT = 128 * 1024;
let workspacePath: string;
let manager: VerifyManager;

beforeEach(async () => {
  workspacePath = await realpath(await mkdtemp(join(tmpdir(), "uya-verify-")));
  manager = new VerifyManager();
});

afterEach(async () => {
  await manager.shutdown();
  await rm(workspacePath, { recursive: true, force: true });
});

async function writeProjectFiles(files: Record<string, string | Buffer>) {
  await Promise.all(Object.entries(files).map(([file, content]) => writeFile(join(workspacePath, file), content)));
}

async function commands() {
  return (await discoverVerifyPresets(workspacePath)).map(({ command }) => command);
}

function bunCommand(source: string): string {
  const executable = WINDOWS ? `"${process.execPath}"` : `'${process.execPath.replaceAll("'", "'\\''")}'`;
  // Encode fixture JavaScript so both shells pass it through without interpreting its syntax.
  const encoded = Buffer.from(source).toString("base64");
  return `${executable} --no-env-file -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

async function observeRun(id: string, ready: (run: VerifyRun) => boolean): Promise<VerifyRun> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const run = manager.get(id);
    if (ready(run)) return run;
    await Bun.sleep(10);
  }
  throw new Error("Verify run did not reach the expected state.");
}

function processStopped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed orphan may remain visible until the Linux init process reaps it.
    return process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "ENOENT") return true;
    throw error;
  }
}

describe("discoverVerifyPresets", () => {
  test("lists Bun scripts in priority order", async () => {
    await writeProjectFiles({
      "package.json": JSON.stringify({
        scripts: { "desktop:test": "desktop", build: "build", dev: "dev", test: "test", check: "check" },
      }),
      "bun.lock": "{}",
      "pnpm-lock.yaml": "lockfileVersion: 9",
    });
    const presets = await discoverVerifyPresets(workspacePath);
    expect(presets.map(({ command }) => command)).toEqual([
      "bun run check", "bun run test", "bun run build", "bun run desktop:test",
    ]);
    expect(presets.every(({ id, label, source }) => !!id && !!label && source === "package.json")).toBe(true);
  });

  test.each([
    ["bun.lockb", Buffer.from([0xff, 0x00]), "bun run test"],
    ["pnpm-lock.yaml", "lockfileVersion: 9", "pnpm run test"],
    ["yarn.lock", "# lockfile", "yarn test"],
  ])("recognizes %s", async (file, content, command) => {
    await writeProjectFiles({ "package.json": '{"scripts":{"test":"verify"}}', [file]: content });
    expect(await commands()).toEqual([command]);
  });

  test("defaults to npm and skips empty or malformed scripts", async () => {
    await writeProjectFiles({
      "package.json": JSON.stringify({
        scripts: { test: "verify", typecheck: "tsc", lint: 123, check: " ", build: "bad\0script" },
      }),
    });
    expect(await commands()).toEqual(["npm run typecheck", "npm run test"]);
  });

  test("finds root Cargo commands once when both Cargo manifests exist", async () => {
    await mkdir(join(workspacePath, "apps/desktop/src-tauri"), { recursive: true });
    await writeProjectFiles({ "Cargo.toml": "[workspace]", "apps/desktop/src-tauri/Cargo.toml": "[package]" });
    expect(await commands()).toEqual(["cargo test", "cargo check"]);
  });

  test("makes desktop Cargo commands runnable from the workspace root", async () => {
    const manifest = "apps/desktop/src-tauri/Cargo.toml";
    await mkdir(join(workspacePath, "apps/desktop/src-tauri"), { recursive: true });
    await writeProjectFiles({ [manifest]: '[package]\nname = "fixture"' });
    const presets = await discoverVerifyPresets(workspacePath);
    expect(presets.map(({ command, source }) => [command, source])).toEqual([
      [`cargo test --manifest-path ${manifest}`, manifest], [`cargo check --manifest-path ${manifest}`, manifest],
    ]);
  });

  test("finds Go, Python and Make commands", async () => {
    await writeProjectFiles({
      "go.mod": "module example.test/fixture",
      "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]",
      Makefile: "# test: commented\ncheck := value\nall test check: setup\n\t@echo done\n",
    });
    expect(await commands()).toEqual(["pytest", "ruff check .", "go test ./...", "go vet ./...", "make test", "make check"]);
    await writeProjectFiles({ Makefile: "test := value\nall:\n\tcheck: recipe\n# check: commented\n" });
    expect(await commands()).toEqual(["pytest", "ruff check .", "go test ./...", "go vet ./..."]);
  });

  test("returns no presets for an empty workspace", async () => {
    expect(await commands()).toEqual([]);
    await expect(discoverVerifyPresets("relative")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("skips oversized or malformed manifests and non-file entries", async () => {
    await mkdir(join(workspacePath, "go.mod"));
    await writeProjectFiles({ "package.json": "{", "pyproject.toml": "[tool.pytest]\n" + " ".repeat(256 * 1024) });
    expect(await commands()).toEqual([]);
  });

  test.skipIf(WINDOWS)("skips symlinked manifests, lockfiles and parent directories", async () => {
    await mkdir(join(workspacePath, "nested/desktop/src-tauri"), { recursive: true });
    await writeProjectFiles({
      "package.json": '{"scripts":{"test":"verify"}}', fixture: "[tool.pytest]",
      "nested/desktop/src-tauri/Cargo.toml": "[package]",
    });
    await symlink(join(workspacePath, "fixture"), join(workspacePath, "pyproject.toml"));
    await symlink(join(workspacePath, "fixture"), join(workspacePath, "bun.lock"));
    await symlink(join(workspacePath, "nested"), join(workspacePath, "apps"));
    expect(await commands()).toEqual(["npm run test"]);
  });

  test("keeps the first ten unique commands", async () => {
    await writeProjectFiles({
      "package.json": JSON.stringify({
        scripts: { check: "verify", typecheck: "verify", test: "verify", lint: "verify", build: "verify", "desktop:test": "verify" },
      }),
      "Cargo.toml": "[workspace]", "pyproject.toml": "[tool.pytest]\n[tool.ruff]",
      "go.mod": "module example.test/fixture", Makefile: "test check:",
    });
    expect(await commands()).toEqual([
      "npm run check", "npm run typecheck", "npm run test", "npm run lint", "npm run build", "npm run desktop:test",
      "cargo test", "cargo check", "pytest", "ruff check .",
    ]);
  });
});

describe("VerifyManager", () => {
  test("returns a running snapshot and completes with readable stdout and stderr", async () => {
    const cwd = join(workspacePath, "worktree");
    await mkdir(cwd);
    const finished: VerifyRun[] = [];
    const command = bunCommand("process.stdout.write('\\x1b[32mpassed\\x1b[0m\\n'); process.stderr.write(process.cwd());");
    const initial = await manager.start({ workspacePath, cwd, command, onFinish: (run) => finished.push(run) });
    expect(initial).toMatchObject({ status: "running", workspacePath, cwd, command, output: "", truncated: false });
    const result = await manager.wait(initial.id);
    expect(result).toMatchObject({ status: "passed", exitCode: 0, truncated: false });
    expect(result.output).toContain("passed\n");
    expect(result.output).toContain(cwd);
    expect(result.output).not.toContain("\x1b");
    expect(result.finishedAt).toBeGreaterThanOrEqual(initial.startedAt);
    expect(finished).toEqual([result]);
    expect(initial.status).toBe("running");
    result.output = "caller edit";
    expect(manager.get(initial.id).output).toContain("passed\n");
  });

  test("reports a nonzero exit and preserves diagnostics", async () => {
    const command = bunCommand("console.error('fixture error'); process.exitCode = 7;");
    const run = await manager.start({ workspacePath, command, onFinish: () => { throw new Error("fixture callback"); } });
    expect(await manager.wait(run.id)).toMatchObject({ status: "failed", exitCode: 7, output: "fixture error\n" });
    manager.cancel(run.id);
    expect(manager.get(run.id).status).toBe("failed");
  });

  test("rejects invalid commands, workspace paths and working directories", async () => {
    for (const command of ["", " \n", "echo a\0b", "x".repeat(1025)]) {
      await expect(manager.start({ workspacePath, command })).rejects.toMatchObject({ code: -32602 });
    }
    await expect(manager.start({ workspacePath: "relative", command: "exit 0" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(manager.start({ workspacePath, cwd: join(workspacePath, "missing"), command: "exit 0" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("strips synthetic sidecar environment variables before spawning", async () => {
    const command = bunCommand(`console.log([
      'IDE_SESSION_TOKEN', 'IDE_DATA_DIR', 'IDE_MANAGED_SIDECAR', 'IDE_DEV_ORIGIN'
    ].every((key) => !process.env[key]) ? 'empty' : 'present');`);
    const source = `
      const { VerifyManager } = await import(${JSON.stringify(new URL("./verify.ts", import.meta.url).href)});
      const manager = new VerifyManager();
      try {
        const run = await manager.start({ workspacePath: process.cwd(), command: ${JSON.stringify(command)} });
        const result = await manager.wait(run.id);
        console.log(result.status === 'passed' && result.output.trim() === 'empty' ? 'stripped' : 'mismatch');
      } finally { await manager.shutdown(); }
    `;
    const fixture = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      cwd: workspacePath, stdout: "pipe", stderr: "ignore", timeout: 3_000,
      env: {
        ...cliEnv({}),
        IDE_SESSION_TOKEN: "fixture-token",
        IDE_DATA_DIR: "fixture-dir",
        IDE_MANAGED_SIDECAR: "1",
        IDE_DEV_ORIGIN: "fixture-origin",
      },
    });
    const [code, output] = await Promise.all([fixture.exited, new Response(fixture.stdout).text()]);
    expect(code).toBe(0);
    expect(output.trim()).toBe("stripped");
  });

  test("truncates output at a UTF-8 boundary", async () => {
    const command = bunCommand("process.stdout.write('a' + '🌏'.repeat(40_000));");
    const run = await manager.start({ workspacePath, command });
    const result = await manager.wait(run.id);
    expect(result).toMatchObject({ status: "passed", exitCode: 0, truncated: true });
    expect(Buffer.byteLength(result.output)).toBe(OUTPUT_LIMIT - 3);
    expect(result.output).not.toContain("\ufffd");
  });

  test("shares one output cap across stdout and stderr", async () => {
    const command = bunCommand("process.stdout.write('a'.repeat(75_000)); process.stderr.write('b'.repeat(75_000));");
    const run = await manager.start({ workspacePath, command });
    const result = await manager.wait(run.id);
    expect(result).toMatchObject({ status: "passed", truncated: true });
    expect(Buffer.byteLength(result.output)).toBe(OUTPUT_LIMIT);
    expect(result.output).toContain("a");
    expect(result.output).toContain("b");
  });

  test("fails a timed-out run and keeps the timeout note within the output limit", async () => {
    const clock = spyOn(globalThis, "setTimeout");
    try {
      const command = `${bunCommand("process.stdout.write('x'.repeat(200_000));")} && ${HOLD}`;
      const run = await manager.start({ workspacePath, command });
      await observeRun(run.id, (current) => current.truncated);
      const deadline = clock.mock.calls.find(([, delay]) => delay === 180_000);
      expect(deadline).toBeDefined();
      deadline?.[0]();
      const result = await manager.wait(run.id);
      expect(result).toMatchObject({ status: "failed", exitCode: null, truncated: true });
      expect(result.output).toEndWith("\nVerification timed out after 180 seconds.\n");
      expect(Buffer.byteLength(result.output)).toBe(OUTPUT_LIMIT);
    } finally {
      clock.mockRestore();
    }
  });

  test("starts a blocked command in the background and cancels it", async () => {
    const finished: VerifyRun[] = [];
    const run = await manager.start({ workspacePath, command: HOLD, onFinish: (result) => finished.push(result) });
    expect(run.status).toBe("running");
    const waiting = manager.wait(run.id);
    manager.cancel(run.id);
    expect(manager.get(run.id).status).toBe("cancelled");
    manager.cancel(run.id);
    const result = await waiting;
    expect(result).toMatchObject({ status: "cancelled", exitCode: null });
    expect(finished).toEqual([result]);
  });

  test.skipIf(WINDOWS)("cancels a descendant in the Unix process group", async () => {
    const run = await manager.start({ workspacePath, command: "sleep 30 & printf 'child:%s\\n' \"$!\"; wait" });
    const ready = await observeRun(run.id, (current) => /^child:\d+\n/u.test(current.output));
    const pid = Number(ready.output.trim().slice("child:".length));
    manager.cancel(run.id);
    expect((await manager.wait(run.id)).status).toBe("cancelled");
    await observeRun(run.id, () => processStopped(pid));
  });

  test.skipIf(WINDOWS)("cleans up a background child after the Unix shell exits", async () => {
    const run = await manager.start({ workspacePath, command: "sleep 30 & printf 'complete\\n'" });
    expect(await manager.wait(run.id)).toMatchObject({ status: "passed", exitCode: 0, output: "complete\n" });
  });

  test("admits at most six concurrent commands and reuses a released slot", async () => {
    const options = { workspacePath, command: HOLD };
    const runs = await Promise.all(Array.from({ length: 6 }, () => manager.start(options)));
    await expect(manager.start(options)).rejects.toMatchObject({ code: -32005, message: "Too many verify commands are running." });
    manager.cancel(runs[0].id);
    await manager.wait(runs[0].id);
    expect((await manager.start(options)).status).toBe("running");
  });

  test("evicts the oldest completed records while keeping active ones", async () => {
    const active = await manager.start({ workspacePath, command: HOLD });
    const completed: string[] = [];
    for (let index = 0; index < 40; index++) {
      const run = await manager.start({ workspacePath, command: "exit 0" });
      await manager.wait(run.id);
      completed.push(run.id);
    }
    expect(manager.get(active.id).status).toBe("running");
    expect(() => manager.get(completed[0])).toThrow("Verify run not found.");
    await expect(manager.wait(completed[0])).rejects.toMatchObject({ code: -32004 });
    expect(manager.get(completed[1]).status).toBe("passed");
    expect(manager.get(completed[39]).status).toBe("passed");
  });

  test("shutdown cancels all running commands and prevents starts racing with it", async () => {
    const options = { workspacePath, command: HOLD };
    const runs = await Promise.all([manager.start(options), manager.start(options)]);
    const racingStart = manager.start(options);
    const stopped = manager.shutdown();
    await expect(racingStart).rejects.toMatchObject({ code: -32005 });
    await stopped;
    for (const { id } of runs) {
      expect(manager.get(id)).toMatchObject({ status: "cancelled", exitCode: null });
      expect(await manager.wait(id)).toEqual(manager.get(id));
    }
  });
});
