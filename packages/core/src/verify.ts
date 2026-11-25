import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { VerifyPreset, VerifyRun } from "@ide/protocol";
import { cliEnv } from "./agents";
import { RpcError } from "./validation";
import { canonicalDirectory, readText, workspaceFileExists, WorkspaceError } from "./workspace-files";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_VERIFY_OUTPUT_BYTES = 128 * 1024;
const VERIFY_TIMEOUT_MS = 180_000;
const MAX_VERIFY_PRESETS = 10;
const MAX_RECENT_RUNS = 40;
const MAX_ACTIVE_RUNS = 6;
const PACKAGE_SCRIPTS = ["check", "typecheck", "test", "lint", "build", "desktop:test"];
const DESKTOP_CARGO_MANIFEST = "apps/desktop/src-tauri/Cargo.toml";

async function optionalFile<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof WorkspaceError) return undefined;
    throw error;
  }
}

function packageScripts(manifest: string | undefined): string[] {
  if (manifest === undefined) return [];
  let data: unknown;
  try {
    data = JSON.parse(manifest.replace(/^\uFEFF/u, ""));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || !("scripts" in data) ||
    !data.scripts || typeof data.scripts !== "object") return [];
  const scripts = data.scripts as Record<string, unknown>;
  return PACKAGE_SCRIPTS.filter((name) => {
    const script = scripts[name];
    return Object.hasOwn(scripts, name) && typeof script === "string" && script.trim() !== "" && !script.includes("\0");
  });
}

async function packageRunner(root: string): Promise<string> {
  const [bun, bunBinary, pnpm, yarn] = await Promise.all(
    ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]
      .map((file) => optionalFile(workspaceFileExists(root, file))),
  );
  if (bun || bunBinary) return "bun run";
  if (pnpm) return "pnpm run";
  if (yarn) return "yarn";
  return "npm run";
}

function makeTargets(makefile: string): string[] {
  const targets = new Set<string>();
  for (const [, names] of makefile.matchAll(/^ *([^\s:#=][^:#=\r\n]*)::?(?![:=])/gmu)) {
    for (const name of names.replace(/&$/u, "").trim().split(/\s+/u)) targets.add(name);
  }
  return ["test", "check"].filter((name) => targets.has(name));
}

export async function discoverVerifyPresets(workspacePath: string): Promise<VerifyPreset[]> {
  const root = await canonicalDirectory(workspacePath);
  const read = async (file: string) => (await optionalFile(readText(root, file, MAX_MANIFEST_BYTES)))?.text;
  const [pkg, cargo, desktopCargo, python, go, makefile] = await Promise.all(
    ["package.json", "Cargo.toml", DESKTOP_CARGO_MANIFEST, "pyproject.toml", "go.mod", "Makefile"].map(read),
  );
  const presets = new Map<string, VerifyPreset>();
  const add = (label: string, source: string, args = "") => {
    const command = label + args;
    const id = label.replace(/[^a-z0-9]+/gu, "-").replace(/-$/u, "");
    if (!presets.has(command)) presets.set(command, { id, label, command, source });
  };

  const scripts = packageScripts(pkg);
  if (scripts.length > 0) {
    const runner = await packageRunner(root);
    for (const script of scripts) add(`${runner} ${script}`, "package.json");
  }
  if (cargo !== undefined || desktopCargo !== undefined) {
    const source = cargo === undefined ? DESKTOP_CARGO_MANIFEST : "Cargo.toml";
    const args = cargo === undefined ? ` --manifest-path ${source}` : "";
    add("cargo test", source, args);
    add("cargo check", source, args);
  }
  if (python !== undefined) {
    if (/\bpytest\b/iu.test(python)) add("pytest", "pyproject.toml");
    if (/\bruff\b/iu.test(python)) add("ruff check .", "pyproject.toml");
  }
  if (go !== undefined) {
    add("go test ./...", "go.mod");
    add("go vet ./...", "go.mod");
  }
  if (makefile !== undefined) {
    for (const target of makeTargets(makefile)) add(`make ${target}`, "Makefile");
  }
  return [...presets.values()].slice(0, MAX_VERIFY_PRESETS);
}

interface VerifyOptions {
  workspacePath: string;
  cwd?: string;
  command: string;
  onFinish?: (run: VerifyRun) => void;
}

interface ActiveVerify {
  cancel: () => void;
  done: Promise<void>;
}

type FinishedStatus = Exclude<VerifyRun["status"], "running">;

function spawnVerify(cwd: string, command: string) {
  const windows = process.platform === "win32";
  try {
    return spawn(windows ? "cmd.exe" : "/bin/sh", windows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], {
      cwd,
      env: cliEnv({}),
      detached: !windows,
      windowsHide: true,
      windowsVerbatimArguments: windows,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new RpcError(-32603, "Could not start the verify command.");
  }
}

function killProcessGroup(pid: number | undefined): boolean {
  if (process.platform === "win32" || !pid) return false;
  try {
    return process.kill(-pid, "SIGKILL");
  } catch {
    return false;
  }
}

function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (killProcessGroup(child.pid)) return;
  if (process.platform === "win32") child.kill();
  else child.kill("SIGKILL");
}

function utf8Prefix(text: string, byteLimit: number): string {
  const buffer = Buffer.alloc(byteLimit);
  const written = buffer.write(text);
  return buffer.toString("utf8", 0, written);
}

function captureOutput(run: VerifyRun) {
  let bytes = 0;
  return (text: string) => {
    if (run.status !== "running" || run.truncated) return;
    const size = Buffer.byteLength(text);
    const remaining = MAX_VERIFY_OUTPUT_BYTES - bytes;
    if (size > remaining) {
      run.output += utf8Prefix(text, remaining);
      run.truncated = true;
    } else {
      run.output += text;
      bytes += size;
    }
  };
}

function finishRun(run: VerifyRun, status: FinishedStatus, exitCode: number | null, note?: string) {
  run.output = stripVTControlCharacters(run.output);
  if (note !== undefined) {
    const footer = `${run.output ? "\n" : ""}${note}\n`;
    const remaining = MAX_VERIFY_OUTPUT_BYTES - Buffer.byteLength(footer);
    if (Buffer.byteLength(run.output) > remaining) {
      run.output = utf8Prefix(run.output, remaining);
      run.truncated = true;
    }
    run.output += footer;
  }
  run.status = status;
  run.exitCode = exitCode;
  run.finishedAt = Date.now();
}

function snapshot(run: VerifyRun): VerifyRun {
  return { ...run, output: run.status === "running" ? stripVTControlCharacters(run.output) : run.output };
}

function runCommand(run: VerifyRun, onClose: () => void): ActiveVerify {
  const child = spawnVerify(run.cwd, run.command);
  const capture = captureOutput(run);
  const stop = (status: "failed" | "cancelled", note?: string) => {
    if (run.status !== "running") return;
    clearTimeout(timer);
    finishRun(run, status, null, note);
    terminate(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const timer = setTimeout(
    () => stop("failed", `Verification timed out after ${VERIFY_TIMEOUT_MS / 1_000} seconds.`),
    VERIFY_TIMEOUT_MS,
  );
  const done = new Promise<void>((resolve) => {
    child.on("error", () => stop("failed", "Could not start the verify command."));
    child.once("exit", () => {
      // Descendants can retain the output pipes after the shell has exited.
      if (run.status === "running") killProcessGroup(child.pid);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (run.status === "running") finishRun(run, code === 0 ? "passed" : "failed", code ?? null);
      onClose();
      resolve();
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8").on("data", capture);
      stream?.on("error", () => stop("failed", "Could not read verify command output."));
    }
  });
  return { cancel: () => stop("cancelled"), done };
}

export class VerifyManager {
  private readonly runs = new Map<string, VerifyRun>();
  private readonly active = new Map<string, ActiveVerify>();
  private closing = false;

  async start(options: VerifyOptions): Promise<VerifyRun> {
    const { command, onFinish } = options;
    if (typeof command !== "string" || !command.trim() || command.length > 1024 || command.includes("\0")) {
      throw new RpcError(-32602, "Verify command must be nonempty text of at most 1024 characters without NUL.");
    }
    const workspacePath = await canonicalDirectory(options.workspacePath);
    const cwd = options.cwd == null ? workspacePath : await canonicalDirectory(options.cwd);
    if (this.closing) throw new RpcError(-32005, "Verify manager is shutting down.");
    if (this.active.size >= MAX_ACTIVE_RUNS) throw new RpcError(-32005, "Too many verify commands are running.");

    const run: VerifyRun = {
      id: randomUUID(), workspacePath, cwd, command, status: "running", startedAt: Date.now(),
      output: "", truncated: false,
    };
    const execution = runCommand(run, () => {
      this.active.delete(run.id);
      if (onFinish) void Promise.resolve().then(() => onFinish(snapshot(run))).catch(() => undefined);
    });
    this.runs.set(run.id, run);
    this.active.set(run.id, execution);
    this.trimHistory();
    return snapshot(run);
  }

  get(id: string): VerifyRun {
    return snapshot(this.requireRun(id));
  }

  async wait(id: string): Promise<VerifyRun> {
    const run = this.requireRun(id);
    await this.active.get(id)?.done;
    return snapshot(run);
  }

  cancel(id: string): void {
    this.requireRun(id);
    this.active.get(id)?.cancel();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const executions = [...this.active.values()];
    for (const execution of executions) execution.cancel();
    await Promise.all(executions.map(({ done }) => done));
  }

  private requireRun(id: string): VerifyRun {
    const run = this.runs.get(id);
    if (!run) throw new RpcError(-32004, "Verify run not found.");
    return run;
  }

  private trimHistory() {
    for (const id of this.runs.keys()) {
      if (this.runs.size <= MAX_RECENT_RUNS) break;
      if (!this.active.has(id)) this.runs.delete(id);
    }
  }
}
