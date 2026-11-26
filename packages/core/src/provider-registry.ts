import type { EffortLevel, ExecutionMode, Provider } from "@ide/protocol";
import { closeAcpConversation, shutdownAcpSessions } from "./acp-runner";
import { runCli, type CliPrepare } from "./agents";
import {
  geminiBlocked, openCodeBlocked, prepareClaude, prepareCodex, prepareCustomCli,
  prepareGeminiApi, prepareGeminiCli, prepareOpenCode, prepareQwen, runAntigravity,
} from "./cli-adapters";
import {
  discoverCliModels, fallbackCliEfforts, type CliModelDiscoverer, type CliModelDiscovery,
} from "./cli-models";
import { customStructuredBlockReason } from "./custom-cli";
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
  terminalArgs?: string[];
  prepare?: CliPrepare;
  run?: (request: AdapterRequest) => Promise<Usage>;
  closeSession?: (conversationKey: string) => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
  supportedModes?: ExecutionMode[];
  supportsPersistentSession?: boolean;
  supportsMcp?: boolean;
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
  {
    id, name, command: configured, terminalArgs, prepare, run: customRun,
    closeSession, shutdown, supportedModes, supportsPersistentSession, supportsMcp, blocked, detail,
  }: CliDefinition,
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

  const executor = customRun ?? (prepare ? ((request: AdapterRequest) => runCli(request, prepare)) : undefined);

  return {
    id,
    async discover(refresh = false) {
      const command = executable(configured);
      const unavailable = command ? blocked?.() : "Executable missing from PATH";
      const discovered = command && executor && !unavailable ? await resolveModels(command, refresh) : undefined;
      const canStructure = Boolean(command && executor && !unavailable);
      return {
        id, name, kind: "cli", command,
        ...(terminalArgs ? { terminalArgs } : {}),
        available: Boolean(command), terminal: Boolean(command), structured: canStructure,
        models: discovered?.models.length ? discovered.models : undefined,
        defaultModel: discovered?.defaultModel,
        supportedEfforts: discovered && (discovered.supportedEfforts ?? fallbackCliEfforts(id)),
        defaultEffort: discovered?.defaultEffort,
        modelEfforts: discovered?.modelEfforts,
        ...(canStructure ? {
          supportedModes: supportedModes ?? ["isolated"],
          supportsPersistentSession: Boolean(supportsPersistentSession),
          ...(supportsMcp ? { supportsMcp: true } : {}),
        } : {}),
        detail: unavailable ?? detail,
      };
    },
    run: executor && ((request) => {
      const reason = blocked?.();
      if (reason) throw new AdapterError(reason);
      return executor(request);
    }),
    closeSession,
    shutdown,
  };
}

interface RuntimeDefinition {
  id: string;
  name: string;
  executable: string;
  discoverModels: () => Promise<string[]>;
  generate: (model: string, request: AdapterRequest) => Promise<Usage>;
  supportedEfforts: EffortLevel[];
}

function runtimeAdapter({
  id, name, executable: configured, discoverModels, generate, supportedEfforts,
}: RuntimeDefinition): ProviderAdapter {
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
        supportedEfforts: models.length ? supportedEfforts : undefined,
        ...(models.length ? { supportedModes: ["isolated"] as ExecutionMode[], supportsPersistentSession: false } : {}),
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
  return customStructuredBlockReason();
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
      supportedEfforts: ["low", "medium", "high"],
      generate: (model, request) => runLocalRuntime(
        id, model, request.messages ?? request.prompt, request.signal, request.output, undefined, request.effort,
      ),
    });

    const cli = (definition: CliDefinition) => cliAdapter(definition, discoverCli);

    const workspaceModes: ExecutionMode[] = ["isolated", "read-only", "agent"];
    const adapters = [
      cli({
        id: "codex", name: "Codex", command: "codex", prepare: prepareCodex,
        supportedModes: workspaceModes, supportsPersistentSession: true, supportsMcp: true,
      }),
      cli({
        id: "claude", name: "Claude Code", command: "claude", prepare: prepareClaude,
        supportedModes: workspaceModes, supportsPersistentSession: true, supportsMcp: true,
      }),
      cli({
        id: "antigravity", name: "Antigravity", command: "agy", run: runAntigravity,
        closeSession: closeAcpConversation, shutdown: shutdownAcpSessions,
        supportedModes: workspaceModes, supportsPersistentSession: true, supportsMcp: true,
      }),
      cli({
        id: "gemini", name: "Gemini CLI", command: "gemini", prepare: prepareGeminiCli, blocked: geminiBlocked,
        supportedModes: workspaceModes, supportsPersistentSession: false, supportsMcp: true,
      }),
      cli({
        id: "gemini-api", name: "Gemini API", command: "gemini-api", terminalArgs: ["explore"], prepare: prepareGeminiApi,
        supportedModes: ["isolated"], supportsPersistentSession: false,
      }),
      cli({
        id: "qwen", name: "Qwen Code", command: "qwen", prepare: prepareQwen,
        supportedModes: ["isolated"], supportsPersistentSession: false,
      }),
      cli({
        id: "opencode", name: "OpenCode", command: "opencode", prepare: prepareOpenCode, blocked: openCodeBlocked,
        supportedModes: workspaceModes, supportsPersistentSession: false, supportsMcp: true,
        detail: "Structured uses authentication from the CLI environment. Saved profiles are available in Terminal.",
      }),
      cli({ id: "kimi", name: "Kimi Code", command: "kimi" }),
      local("llamacpp", "llama.cpp", "llama-cli"),
      local("mlx", "MLX LM", "mlx_lm.generate"),
      local("lmstudio", "LM Studio", "lms"),
      runtimeAdapter({
        id: "ollama", name: "Ollama", executable: "ollama",
        discoverModels: discoverOllama,
        supportedEfforts: ["minimal", "low", "medium", "high"],
        generate: (model, { messages, prompt, signal, output, effort }) => runOllama(
          model, messages ?? prompt, signal,
          (text) => output.emit("text", text), output.raw, undefined,
          (text) => output.emit("thinking", text), effort,
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

  async closeSession(conversationKey: string): Promise<void> {
    await Promise.allSettled(
      Array.from(this.adapters.values(), (adapter) => adapter.closeSession?.(conversationKey)),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.adapters.values(), (adapter) => adapter.shutdown?.()),
    );
  }
}
