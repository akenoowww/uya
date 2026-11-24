import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  env?: NodeJS.ProcessEnv;
  replaceEnv?: boolean;
  diagnosticArgs?: readonly string[];
  stdin?: string;
  encode?: (text: string) => string;
  parse?: (line: string) => boolean;
}

export type CliPrepare = (
  request: AdapterRequest,
  directory: string,
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

export async function runCli(request: AdapterRequest, prepare: CliPrepare): Promise<Usage> {
  const { provider, prompt, signal, output, messages } = request;
  if (!provider.command) throw new AdapterError("This provider has no executable for structured runs.");

  const cwd = await mkdtemp(join(tmpdir(), "uya-run-"));
  const usage: Usage = {};
  try {
    const invocation = await prepare(request, cwd, usage);
    signal.throwIfAborted();
    const env = invocation.replaceEnv ? invocation.env : cliEnv(invocation.env);
    const group = process.platform !== "win32";
    const target = spawnTarget(invocation.command ?? provider.command, invocation.args);
    const child = spawn(target.command, target.args, {
      cwd,
      env,
      detached: group,
      shell: target.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const diagnostic = drainCliDiagnostics(child.stderr, invocation.diagnosticArgs ?? invocation.args);
    const close = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", (code) => resolve(code));
    });
    const terminate = () => {
      try {
        if (group && child.pid) {
          process.kill(-child.pid, "SIGKILL");
          return;
        }
      } catch {
        // If the group is unavailable, terminate the direct child.
      }
      if (process.platform === "win32") child.kill();
      else child.kill("SIGKILL");
    };
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdin.on("error", () => undefined);
    const stdinPayload = invocation.stdin ?? (() => {
      const input = promptForCli(prompt, messages);
      return invocation.encode ? invocation.encode(input) : input;
    })();
    child.stdin.end(stdinPayload);

    try {
      let finished = false;
      let failure: CliResponseError | undefined;
      if (invocation.parse) {
        for await (const line of lines(child.stdout)) {
          signal.throwIfAborted();
          if (failure) continue;
          try {
            finished = invocation.parse(line) || finished;
          } catch (error) {
            if (!(error instanceof CliResponseError)) throw error;
            failure = error;
          }
        }
      } else {
        for await (const text of decode(child.stdout)) {
          signal.throwIfAborted();
          finished ||= Boolean(text.trim());
          output.raw(JSON.stringify({ type: "text", text }));
          output.emit("text", text);
        }
      }
      const code = await close;
      signal.throwIfAborted();
      if (failure || code !== 0 || !finished) {
        const reason = failure?.diagnostic ?? (await diagnostic)?.message ?? failure?.message;
        const fallback = code === 0 ? `${provider.name} did not return a complete structured response.`
          : `${provider.name} stopped before completing the run. Check login and CLI compatibility in Terminal.`;
        throw new AdapterError(reason ?? fallback, code ?? undefined);
      }
      return usage;
    } finally {
      signal.removeEventListener("abort", terminate);
      if (child.exitCode === null) terminate();
      await close;
      await diagnostic;
    }
  } finally {
    await rm(cwd, { force: true, recursive: true }).catch(() => undefined);
  }
}
