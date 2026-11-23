import type { CustomProviderInput, Provider } from "@ide/protocol";
import type { History } from "./history";
import type { LocalRuntimeId } from "./local-runtimes";
import type { AdapterRequest, Usage } from "./provider-adapter";
import { customAdapter, ProviderRegistry } from "./provider-registry";
import { RpcError } from "./validation";

export class Providers {
  private cached: { value: Provider[]; until: number } | undefined;
  private discovering: Promise<Provider[]> | undefined;
  private readonly registry: ProviderRegistry;

  constructor(
    private readonly history: History,
    discoverOllama?: () => Promise<string[]>,
    discoverLocal?: (id: LocalRuntimeId) => Promise<string[]>,
  ) {
    this.registry = new ProviderRegistry(discoverOllama, discoverLocal);
  }

  async list(refresh = false): Promise<Provider[]> {
    return (await this.builtins(refresh)).concat(
      this.history.customProviders().map((provider) => customAdapter(provider).discover()),
    );
  }

  run(request: AdapterRequest): Promise<Usage> {
    return this.registry.run(request);
  }

  add(input: CustomProviderInput): Provider {
    return this.save(`custom-${crypto.randomUUID()}`, input);
  }

  update(id: string, input: CustomProviderInput): Provider {
    const previous = this.history.customProviders().find((provider) => provider.id === id);
    if (!previous) throw new RpcError(-32004, "Custom provider not found.");
    return this.save(id, input, previous);
  }

  remove(id: string) {
    if (!this.history.removeCustomProvider(id)) throw new RpcError(-32004, "Custom provider not found.");
  }

  private save(id: string, input: CustomProviderInput, previous?: Provider): Provider {
    const provider = {
      id,
      name: input.name,
      kind: "cli",
      structured: input.structuredArgs !== undefined,
      terminal: true,
      available: true,
      command: input.command,
      configuredCommand: input.command,
      terminalArgs: input.args,
      structuredArgs: input.structuredArgs,
    } satisfies Provider;
    const resolved = customAdapter(provider).discover();
    if (!resolved.available && (previous?.configuredCommand ?? previous?.command) !== input.command) {
      throw new RpcError(-32602, "The executable was not found. Use a command on PATH or an absolute executable path.");
    }
    this.history.saveCustomProvider(provider);
    return resolved;
  }

  private builtins(refresh: boolean): Promise<Provider[]> {
    if (!refresh && this.cached && this.cached.until > Date.now()) return Promise.resolve(this.cached.value);
    this.discovering ??= this.registry.discover().then((value) => {
      this.cached = { value, until: Date.now() + 15_000 };
      return value;
    }).finally(() => {
      this.discovering = undefined;
    });
    return this.discovering;
  }
}
