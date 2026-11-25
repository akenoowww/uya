import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSessionPool, type AcpSession } from "./session-pool";

const scope = { providerId: "fixture", conversationKey: "conversation", accessMode: "isolated" } as const;
const pools = new Set<AcpSessionPool>();

function createPool(options?: ConstructorParameters<typeof AcpSessionPool>[0]): AcpSessionPool {
  const pool = new AcpSessionPool(options);
  pools.add(pool);
  return pool;
}

function spawnFixture(cwd: string, script = "process.stdin.resume()") {
  return spawn(process.execPath, ["--no-env-file", "-e", script], {
    cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
}

function expectStopped(session: AcpSession): void {
  expect(session.child.exitCode !== null || session.child.signalCode !== null).toBe(true);
  const pid = session.child.pid;
  if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
  if (session.tempDir) expect(existsSync(session.tempDir)).toBe(false);
  expect(session.idleTimer).toBeUndefined();
}

afterEach(async () => {
  await Promise.all([...pools].map((pool) => pool.closeAll()));
  pools.clear();
});

test("an acquired session is exclusive and reuses its scratch directory", async () => {
  const pool = createPool();
  const first = pool.acquire(scope, spawnFixture);
  expect(first.key).toBe(JSON.stringify([scope.providerId, scope.conversationKey, first.cwd, "isolated"]));
  expect(first.tempDir).toBe(first.cwd);
  expect(() => pool.acquire(scope, spawnFixture)).toThrow("already has an active run");
  await pool.release(first);

  expect(first.busy).toBe(false);
  expect(first.idleTimer?.hasRef()).toBe(false);
  expect(pool.acquire(scope, spawnFixture)).toBe(first);
  expect(first.busy).toBe(true);
  expect(first.idleTimer).toBeUndefined();
  await pool.invalidate(first.key!);
  expectStopped(first);
  expect(pool.acquire(scope, spawnFixture).cwd).not.toBe(first.cwd);
});

test("the key scopes reuse to conversation, provider, cwd, and access mode", async () => {
  const pool = createPool();
  const workspaceScope = { ...scope, cwd: process.cwd(), accessMode: "agent" } as const;
  const first = pool.acquire(workspaceScope, spawnFixture);
  await pool.release(first);
  expect(pool.acquire(workspaceScope, spawnFixture)).toBe(first);

  const others = [
    { ...workspaceScope, providerId: "second-provider" },
    { ...workspaceScope, conversationKey: "second-conversation" },
    { ...workspaceScope, cwd: tmpdir() },
    { ...workspaceScope, accessMode: "read-only" as const },
  ].map((other) => pool.acquire(other, spawnFixture));
  expect(new Set([first, ...others]).size).toBe(5);
  expect(others.every((session) => session.tempDir === undefined)).toBe(true);
});

test("the idle TTL terminates the process and removes its scratch directory", async () => {
  const pool = createPool({ idleTtlMs: 20 });
  const session = pool.acquire(scope, spawnFixture);
  await pool.release(session);
  expect(session.idleTimer?.hasRef()).toBe(false);
  await session.closed;
  await pool.invalidate(session);
  expectStopped(session);
  expect(pool.acquire(scope, spawnFixture)).not.toBe(session);
});

test("capacity evicts the least recently released idle session", async () => {
  const pool = createPool({ maxSessions: 2 });
  const first = pool.acquire(scope, spawnFixture);
  const second = pool.acquire({ ...scope, conversationKey: "second" }, spawnFixture);
  const thirdScope = { ...scope, conversationKey: "third" };
  expect(() => pool.acquire(thirdScope, spawnFixture)).toThrow("All ACP sessions are busy");

  await pool.release(first);
  await pool.release(second);
  await pool.release(pool.acquire(scope, spawnFixture));
  const third = pool.acquire(thirdScope, spawnFixture);
  await second.closed;
  await pool.invalidate(second);
  expectStopped(second);
  expect(third.busy).toBe(true);
  expect(pool.acquire(scope, spawnFixture)).toBe(first);
});

test("conversation close and shutdown terminate both idle and active processes", async () => {
  const pool = createPool();
  const first = pool.acquire(scope, spawnFixture);
  const second = pool.acquire({ ...scope, providerId: "another" }, spawnFixture);
  const other = pool.acquire({ ...scope, conversationKey: "other" }, spawnFixture);
  const oneShot = pool.acquire({ ...scope, conversationKey: undefined }, spawnFixture);
  await pool.release(first);

  await pool.closeConversation(scope.conversationKey);
  expectStopped(first);
  expectStopped(second);
  expect(other.child.exitCode).toBeNull();
  expect(oneShot.key).toBeUndefined();
  await pool.closeAll();
  expectStopped(other);
  expectStopped(oneShot);
});

test("unexpected termination and spawn failure remove stale entries and scratch directories", async () => {
  const pool = createPool();
  const stopped = pool.acquire(scope, (cwd) => spawnFixture(cwd, "process.exit(17)"));
  expect(await stopped.closed).toBe(17);
  await pool.invalidate(stopped);
  expectStopped(stopped);

  const failed = pool.acquire(scope, (cwd) => spawn(join(cwd, "missing-cli"), [], {
    cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  }));
  await failed.closed;
  await pool.invalidate(failed);
  expect(existsSync(failed.cwd)).toBe(false);
  expect(pool.acquire(scope, spawnFixture)).not.toBe(failed);
});

test.skipIf(process.platform === "win32")("a session exit terminates descendants holding its output pipes", async () => {
  const pool = createPool();
  const descendant = "setTimeout(() => console.log('descendant survived'), 1500)";
  const script = [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["--no-env-file", "-e", ' + JSON.stringify(descendant) + '],',
    '  { stdio: ["ignore", "inherit", "inherit"] });',
    'child.once("spawn", () => process.exit(17));',
  ].join("\n");
  const session = pool.acquire(scope, (cwd) => spawnFixture(cwd, script));
  let stdout = "";
  session.child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  expect(await session.closed).toBe(17);
  await pool.invalidate(session);
  expect(stdout).toBe("");
  expectStopped(session);
});
