import type { Provider } from "@ide/protocol";
import { runCli, type CliPrepare } from "./agents";
import {
  geminiBlocked, openCodeBlocked, prepareClaude, prepareCodex, prepareCustomCli, prepareGemini, prepareOpenCode, prepareQwen,
} from "./cli-adapters";
import {
  discoverCliModels, type CliModelDiscoverer, type CliModelDiscovery,
} from "./cli-models";
import { supportsCustomStructured } from "./custom-cli";
import { discoverLocalRuntimeModels, runLocalRuntime, type LocalRuntimeId } from "./local-runtimes";
import { discoverOllamaModels, runOllama } from "./ollama";
import { AdapterError, type AdapterRequest, type ProviderAdapter, type Usage } from "./provider-adapter";

function executable(command: string): string | undefined {
  return Bun.which(command, { PATH: process.env.PATH }) ?? undefined;
}

interface CliDefinition {
  id: string;
  name: string;
  command: string;
  prepare?: CliPrepare;
  blocked?: () => string | undefined;
  detail?: string;
}

const CLI_MODELS_CACHE_TTL_MS = 5 * 60_000;
const CLI_MODELS_EMPTY_TTL_MS = 30_000;

interface CachedCliModels {
  command: string;
  discovery: CliModelDiscovery;
  until: number;
}

function cliAdapter(
  { id, name, command: configured, prepare, blocked, detail }: CliDefinition,
  discoverModels: CliModelDiscoverer,
): ProviderAdapter {
  let cached: CachedCliModels | undefined;
  let pending: { command: string; refresh: boolean; promise: Promise<CliModelDiscovery> } | undefined;

  async function resolveModels(command: string, refresh: boolean): Promise<CliModelDiscovery> {
    if (!refresh && cached && cached.command === command && cached.until > Date.now()) {
      return cached.discovery;
    }
    if (pending && pending.command === command && (pending.refresh || !refresh)) {
      return pending.promise;
    }
    const promise = discoverModels(id, { command, refresh })
      .catch((): CliModelDiscovery => ({ models: [] }))
      .then((discovery) => {
        const ttl = discovery.models.length > 0 ? CLI_MODELS_CACHE_TTL_MS : CLI_MODELS_EMPTY_TTL_MS;
        if (pending?.promise === promise) {
          cached = { command, discovery, until: Date.now() + ttl };
        }
        return discovery;
      })
      .finally(() => {
        if (pending?.promise === promise) pending = undefined;
      });
    pending = { command, refresh, promise };
    return promise;
  }

  return {
    id,
    async discover(refresh = false) {
      const command = executable(configured);
      const unavailable = command ? blocked?.() : "Executable missing from PATH";
      const discovered = command && prepare && !unavailable ? await resolveModels(command, refresh) : undefined;
      return {
        id, name, kind: "cli", command,
        available: Boolean(command), terminal: Boolean(command), structured: Boolean(command && prepare && !unavailable),
        models: discovered?.models.length ? discovered.models : undefined,
        defaultModel: discovered?.defaultModel,
        detail: unavailable ?? detail,
      };
    },
    run: prepare && ((request) => {
      const reason = blocked?.();
      if (reason) throw new AdapterError(reason);
      return runCli(request, prepare);
    }),
  };
}

interface RuntimeDefinition {
  id: string;
  name: string;
  executable: string;
  discoverModels: () => Promise<string[]>;
  generate: (model: string, request: AdapterRequest) => Promise<Usage>;
}

function runtimeAdapter({ id, name, executable: configured, discoverModels, generate }: RuntimeDefinition): ProviderAdapter {
  return {
    id,
    async discover() {
      const command = executable(configured);
      const models = await discoverModels();
      return {
        id, name, kind: "runtime", command, models,
        available: Boolean(command) || models.length > 0,
        terminal: Boolean(command),
        structured: models.length > 0,
        detail: models.length ? undefined : "Start its local inference server with a local model",
      };
    },
    async run(request) {
      if (!request.model) throw new AdapterError("Select an available local model.");
      try {
        return await generate(request.model, request);
      } catch (error) {
        request.signal.throwIfAborted();
        if (error instanceof AdapterError) throw error;
        throw new AdapterError(`${name} did not finish the local request. Check that the server and selected model are available.`);
      }
    },
  };
}

function customBlocked(provider: Provider) {
  if (provider.structuredArgs === undefined) return "Interactive terminal";
  return supportsCustomStructured() ? undefined : "Structured mode requires the macOS command sandbox";
}

export function customAdapter(provider: Provider) {
  return {
    id: provider.id,
    discover(): Provider {
      const configuredCommand = provider.configuredCommand ?? provider.command;
      const command = configuredCommand && executable(configuredCommand);
      const reason = customBlocked(provider);
      return {
        ...provider,
        configuredCommand,
        command: command || undefined,
        structured: Boolean(command && !reason),
        terminal: Boolean(command),
        available: Boolean(command),
        detail: !command ? "Executable missing from PATH" : reason ?? "Sandboxed standard input and output",
      };
    },
    run(request: AdapterRequest) {
      const reason = customBlocked(request.provider);
      if (reason) throw new AdapterError(reason);
      return runCli(request, prepareCustomCli);
    },
  } satisfies ProviderAdapter;
}

export class ProviderRegistry {
  private readonly adapters: Map<string, ProviderAdapter>;

  constructor(
    discoverOllama = discoverOllamaModels,
    discoverLocal: (id: LocalRuntimeId) => Promise<string[]> = discoverLocalRuntimeModels,
    discoverCli: CliModelDiscoverer = discoverCliModels,
  ) {
    const local = (id: LocalRuntimeId, name: string, command: string) => runtimeAdapter({
      id, name, executable: command,
      discoverModels: () => discoverLocal(id),
      generate: (model, request) => runLocalRuntime(id, model, request.messages ?? request.prompt, request.signal, request.output),
    });

    const cli = (definition: CliDefinition) => cliAdapter(definition, discoverCli);

    const adapters = [
      cli({ id: "codex", name: "Codex", command: "codex", prepare: prepareCodex }),
      cli({ id: "claude", name: "Claude Code", command: "claude", prepare: prepareClaude }),
      cli({ id: "gemini", name: "Gemini CLI", command: "gemini", prepare: prepareGemini, blocked: geminiBlocked }),
      cli({ id: "qwen", name: "Qwen Code", command: "qwen", prepare: prepareQwen }),
      cli({
        id: "opencode", name: "OpenCode", command: "opencode", prepare: prepareOpenCode, blocked: openCodeBlocked,
        detail: "Structured uses authentication from the CLI environment. Saved profiles are available in Terminal.",
      }),
      cli({ id: "kimi", name: "Kimi Code", command: "kimi" }),
      local("llamacpp", "llama.cpp", "llama-cli"),
      local("mlx", "MLX LM", "mlx_lm.generate"),
      local("lmstudio", "LM Studio", "lms"),
      runtimeAdapter({
        id: "ollama", name: "Ollama", executable: "ollama",
        discoverModels: discoverOllama,
        generate: (model, { messages, prompt, signal, output }) => runOllama(
          model, messages ?? prompt, signal,
          (text) => output.emit("text", text), output.raw, undefined,
          (text) => output.emit("thinking", text),
        ),
      }),
    ];
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  discover(refresh = false): Promise<Provider[]> {
    return Promise.all(Array.from(this.adapters.values(), (adapter) => adapter.discover(refresh)));
  }

  async run(request: AdapterRequest): Promise<Usage> {
    const { provider } = request;
    const builtin = this.adapters.get(provider.id);
    const adapter = builtin ?? (provider.id.startsWith("custom-") ? customAdapter(provider) : undefined);
    if (!provider.available || !provider.structured || !adapter?.run) {
      throw new AdapterError("This provider has no structured adapter.");
    }
    return await adapter.run(request);
  }
}
