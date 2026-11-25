import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { drainCliDiagnostics } from "./cli-diagnostics";
import { promptForCli } from "./conversation";
import { AdapterError, type AdapterRequest, type Usage } from "./provider-adapter";

export class CliResponseError extends Error {
  constructor(message: string, readonly diagnostic?: string) {
    super(message);
  }
}

interface CliInvocation {
  args: string[];
  command?: string;
  cwd?: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  replaceEnv?: boolean;
  diagnosticArgs?: readonly string[];
  stdin?: string;
  useSingleTurnPrompt?: boolean;
  encode?: (text: string) => string;
  parse?: (line: string) => boolean;
}

export type CliPrepare = (
  request: AdapterRequest,
  scratchDir: string,
  usage: Usage,
) => CliInvocation | Promise<CliInvocation>;

export function cliEnv(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.IDE_SESSION_TOKEN;
  delete env.IDE_DATA_DIR;
  delete env.IDE_MANAGED_SIDECAR;
  delete env.IDE_DEV_ORIGIN;
  return env;
}

async function* decode(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    yield typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  const remainder = decoder.decode();
  if (remainder) yield remainder;
}

async function* lines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of decode(stream)) {
    buffer += chunk;
    let offset = 0;
    for (let next = buffer.indexOf("\n"); next !== -1; next = buffer.indexOf("\n", offset)) {
      if (next - offset > 2_000_000) throw new AdapterError("A CLI event exceeded the output limit.");
      yield buffer.slice(offset, next);
      offset = next + 1;
    }
    buffer = buffer.slice(offset);
    if (buffer.length > 2_000_000) throw new AdapterError("A CLI event exceeded the output limit.");
  }
  if (buffer.trim()) yield buffer;
}

function quoteCmdArg(value: string): string {
  if (/[&|<>^%!"\r\n]/.test(value)) {
    throw new AdapterError("The CLI argument contains characters unsupported by Windows command shims.");
  }
  return !value || /\s/.test(value) ? `"${value}"` : value;
}

export function spawnTarget(executable: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return {
      command: quoteCmdArg(executable),
      args: args.map(quoteCmdArg),
      shell: true,
    };
  }
  return { command: executable, args, shell: false };
}

function terminateCli(child: ChildProcess, group: boolean): void {
  try {
    if (group && child.pid) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // The process group may already have exited.
  }
  if (process.platform === "win32") child.kill();
  else child.kill("SIGKILL");
}

async function readCliResponse(
  request: AdapterRequest, stdout: NodeJS.ReadableStream, parse: CliInvocation["parse"],
): Promise<{ finished: boolean; failure?: CliResponseError }> {
  let finished = false;
  let failure: CliResponseError | undefined;
  if (parse) {
    for await (const line of lines(stdout)) {
      request.signal.throwIfAborted();
      if (failure) continue;
      try {
        finished = parse(line) || finished;
      } catch (error) {
        if (!(error instanceof CliResponseError)) throw error;
        failure = error;
      }
    }
  } else {
    for await (const text of decode(stdout)) {
      request.signal.throwIfAborted();
      finished ||= Boolean(text.trim());
      request.output.raw(JSON.stringify({ type: "text", text }));
      request.output.emit("text", text);
    }
  }
  return { finished, failure };
}

function cliStdin(request: AdapterRequest, invocation: CliInvocation): string {
  if (invocation.stdin !== undefined) return invocation.stdin;
  const input = invocation.useSingleTurnPrompt ? request.prompt : promptForCli(request.prompt, request.messages);
  return invocation.encode ? invocation.encode(input) : input;
}

async function executeCli(request: AdapterRequest, invocation: CliInvocation, command: string, cwd: string): Promise<void> {
  const { provider, signal } = request;
  const stdin = cliStdin(request, invocation);
  const env = invocation.replaceEnv ? invocation.env : cliEnv(invocation.env);
  const group = process.platform !== "win32";
  const target = spawnTarget(invocation.command ?? command, invocation.args);
  const child = spawn(target.command, target.args, {
    cwd, env, detached: group, shell: target.shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const diagnostic = drainCliDiagnostics(child.stderr, invocation.diagnosticArgs ?? invocation.args);
  const close = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  const terminate = () => terminateCli(child, group);
  signal.addEventListener("abort", terminate, { once: true });
  if (signal.aborted) terminate();
  child.stdin.on("error", () => undefined);

  try {
    child.stdin.end(stdin);
    const { finished, failure } = await readCliResponse(request, child.stdout, invocation.parse);
    const code = await close;
    signal.throwIfAborted();
    if (failure || code !== 0 || !finished) {
      const reason = failure?.diagnostic ?? (await diagnostic)?.message ?? failure?.message;
      const fallback = code === 0 ? `${provider.name} did not return a complete structured response.`
        : `${provider.name} stopped before completing the run. Check login and CLI compatibility in Terminal.`;
      throw new AdapterError(reason ?? fallback, code ?? undefined);
    }
  } finally {
    signal.removeEventListener("abort", terminate);
    if (child.exitCode === null) terminate();
    await close;
    await diagnostic;
  }
}

export async function runCli(request: AdapterRequest, prepare: CliPrepare): Promise<Usage> {
  const { command } = request.provider;
  if (!command) throw new AdapterError("This provider has no executable for structured runs.");

  const scratchDir = await mkdtemp(join(tmpdir(), "uya-run-"));
  const usage: Usage = {};
  try {
    const invocation = await prepare(request, scratchDir, usage);
    request.signal.throwIfAborted();
    // Only the run's scratch tree is owned by the launcher and removed below.
    const configPath = relative(scratchDir, invocation.configDir ?? scratchDir);
    if (isAbsolute(configPath) || configPath === ".." || configPath.startsWith(`..${sep}`)) {
      throw new AdapterError("CLI configuration must be generated in the run scratch directory.");
    }
    const spawnCwd = invocation.cwd ?? scratchDir;
    await executeCli(request, invocation, command, spawnCwd);
    return usage;
  } finally {
    await rm(scratchDir, { force: true, recursive: true }).catch(() => undefined);
  }
}
