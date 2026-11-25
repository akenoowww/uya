import type { ExecutionMode } from "@ide/protocol";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdapterError } from "./provider-adapter";

export interface AcpOptionMeta {
  id: string;
  category?: string;
  currentValue?: string;
  values: string[];
}

interface SessionScope {
  providerId: string;
  conversationKey?: string;
  cwd?: string;
  accessMode: ExecutionMode;
}

export interface AcpSession {
  readonly key?: string;
  readonly providerId: string;
  readonly conversationKey?: string;
  readonly workspaceCwd?: string;
  readonly cwd: string;
  readonly tempDir?: string;
  readonly accessMode: ExecutionMode;
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<number | null>;
  readonly sessionAllowTools: Set<string>;
  sessionId?: string;
  model?: string;
  effort?: string;
  configOptions: AcpOptionMeta[];
  availableModelIds: Set<string>;
  busy: boolean;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface SessionLifecycle {
  terminate(): void;
  cleanup?: Promise<void>;
}

type SpawnSession = (cwd: string) => ChildProcessWithoutNullStreams;

function sessionKey(scope: SessionScope, cwd: string): string {
  return JSON.stringify([scope.providerId, scope.conversationKey, cwd, scope.accessMode]);
}

function terminateProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child when the process group is unavailable.
    }
  }
  try {
    if (process.platform === "win32") child.kill();
    else child.kill("SIGKILL");
  } catch {
    // The process may have already exited.
  }
}

function referenceProcess(child: ChildProcessWithoutNullStreams, referenced: boolean): void {
  const method = referenced ? "ref" : "unref";
  child[method]();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    const handle = stream as typeof stream & { ref?(): void; unref?(): void };
    handle[method]?.();
  }
}

function clearIdleTimer(session: AcpSession): void {
  clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
}

function startChild(spawnChild: SpawnSession, cwd: string, tempDir?: string): ChildProcessWithoutNullStreams {
  try {
    return spawnChild(cwd);
  } catch (error) {
    if (tempDir) rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }
}

export class AcpSessionPool {
  private readonly pooled = new Map<string, AcpSession>();
  private readonly managed = new Map<AcpSession, SessionLifecycle>();

  constructor(private readonly options: { idleTtlMs?: number; maxSessions?: number } = {}) {}

  acquire(scope: SessionScope, spawnChild: SpawnSession): AcpSession {
    const cwd = scope.cwd ? resolve(scope.cwd) : undefined;
    const location = { ...scope, cwd, accessMode: cwd ? scope.accessMode : "isolated" as const };
    const session = this.find(location);
    if (session) {
      if (session.busy) throw new AdapterError("This ACP conversation already has an active run.");
      clearIdleTimer(session);
      referenceProcess(session.child, true);
      session.busy = true;
      session.lastUsedAt = Date.now();
      return session;
    }

    if (scope.conversationKey !== undefined && this.pooled.size >= (this.options.maxSessions ?? 12)) {
      // Releasing a session moves it to the end of the map, so the first idle entry is the oldest.
      const oldest = [...this.pooled.values()].find((candidate) => !candidate.busy);
      if (!oldest) throw new AdapterError("All ACP sessions are busy. Retry when a run finishes.");
      void this.invalidate(oldest);
    }
    return this.create(location, spawnChild);
  }

  async release(session: AcpSession): Promise<void> {
    const lifecycle = this.managed.get(session);
    if (!lifecycle || lifecycle.cleanup || !session.busy) return lifecycle?.cleanup;
    if (session.key === undefined) return this.invalidate(session, true);

    session.busy = false;
    session.lastUsedAt = Date.now();
    this.pooled.delete(session.key);
    this.pooled.set(session.key, session);
    session.idleTimer = setTimeout(() => void this.invalidate(session), this.options.idleTtlMs ?? 600_000);
    session.idleTimer.unref();
    referenceProcess(session.child, false);
  }

  async invalidate(key: string | AcpSession, graceful = false): Promise<void> {
    const session = typeof key === "string" ? this.pooled.get(key) : key;
    if (!session) return;
    const lifecycle = this.managed.get(session);
    if (!lifecycle || lifecycle.cleanup) return lifecycle?.cleanup;

    clearIdleTimer(session);
    if (session.key !== undefined) this.pooled.delete(session.key);
    session.busy = false;
    session.sessionAllowTools.clear();
    referenceProcess(session.child, true);
    const stdin = session.child.stdin;
    const grace = graceful && stdin.writable ? setTimeout(lifecycle.terminate, 250) : undefined;
    grace?.unref();
    lifecycle.cleanup = session.closed.then(async () => {
      clearTimeout(grace);
      if (session.tempDir) {
        await rm(session.tempDir, { force: true, recursive: true, maxRetries: 2 }).catch(() => undefined);
      }
      this.managed.delete(session);
    });
    if (grace) stdin.end();
    else lifecycle.terminate();
    return lifecycle.cleanup;
  }

  async closeConversation(conversationKey: string): Promise<void> {
    const sessions = [...this.managed.keys()].filter((session) => session.conversationKey === conversationKey);
    await Promise.all(sessions.map((session) => this.invalidate(session)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.managed.keys()].map((session) => this.invalidate(session)));
  }

  private find(scope: SessionScope): AcpSession | undefined {
    if (scope.conversationKey === undefined) return;
    if (scope.accessMode !== "isolated" && scope.cwd) return this.pooled.get(sessionKey(scope, scope.cwd));
    // The scratch directory is allocated once per session. Find it by the original workspace scope.
    return [...this.pooled.values()].find((session) =>
      session.accessMode === "isolated" && session.workspaceCwd === scope.cwd
      && session.providerId === scope.providerId && session.conversationKey === scope.conversationKey,
    );
  }

  private create(scope: SessionScope, spawnChild: SpawnSession): AcpSession {
    const workspace = scope.accessMode === "isolated" ? undefined : scope.cwd;
    const cwd = workspace ?? mkdtempSync(join(tmpdir(), "uya-run-"));
    const tempDir = workspace ? undefined : cwd;
    const child = startChild(spawnChild, cwd, tempDir);
    const closed = new Promise<number | null>((resolveClose) => child.once("close", resolveClose));
    const key = scope.conversationKey === undefined ? undefined : sessionKey(scope, cwd);
    const session: AcpSession = {
      key, providerId: scope.providerId, conversationKey: scope.conversationKey,
      workspaceCwd: scope.cwd, accessMode: scope.accessMode, cwd, tempDir, child, closed,
      sessionAllowTools: new Set(), configOptions: [], availableModelIds: new Set(),
      busy: true, lastUsedAt: Date.now(),
    };
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      terminateProcess(child);
    };
    const onFailure = () => {
      terminate();
      void this.invalidate(session);
    };
    this.managed.set(session, { terminate });
    if (key !== undefined) this.pooled.set(key, session);
    child.once("exit", onFailure);
    child.on("error", onFailure);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", onFailure);
    void closed.then(onFailure);
    return session;
  }
}
