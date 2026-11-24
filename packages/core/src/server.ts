import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { RpcMethod, RpcParams, RpcResult, RunEvent } from "@ide/protocol";
import { CONVERSATION_HISTORY_LIMIT } from "./conversation";
import type { CliModelDiscoverer } from "./cli-models";
import { gitDiff, gitStatus } from "./git";
import { History } from "./history";
import type { LocalRuntimeId } from "./local-runtimes";
import { Providers } from "./providers";
import { Runs } from "./runs";
import { isRpcMethod, parseRpcParams, rpcEnvelope, rpcResponseId, RpcError, subscription } from "./validation";
import { Workspace } from "./workspace";
import { WorkspaceError } from "./workspace-files";

const allowedOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
]);
const AUTH_TIMEOUT_MS = 5_000;

type SocketData = { runId?: string; authTimeout?: ReturnType<typeof setTimeout> };
type Socket = ServerWebSocket<SocketData>;
type Handlers = { [Method in RpcMethod]: (params: RpcParams<Method>) => RpcResult<Method> | Promise<RpcResult<Method>> };

function rpcHandlers(history: History, providers: Providers, runs: Runs, workspace: Workspace): Handlers {
  function checkWorkspace(requested: string | null) {
    if (requested !== (workspace.path ?? null)) {
      throw new RpcError(-32009, "The workspace changed. Reopen the project and try again.");
    }
  }
  function gitRoot(requested: string | undefined) {
    const root = workspace.path;
    if (root === undefined) throw new RpcError(-32004, "Open a project folder first.");
    if (requested !== undefined) checkWorkspace(requested);
    return root;
  }
  return {
    "providers.list": ({ refresh }) => providers.list(refresh),
    "providers.add": (params) => providers.add(params),
    "providers.update": ({ id, ...params }) => providers.update(id, params),
    "providers.remove": ({ id }) => {
      providers.remove(id);
      return null;
    },
    "runs.start": (params) => runs.start(params),
    "runs.get": ({ id }) => {
      const run = history.get(id);
      if (!run) throw new RpcError(-32004, "Run not found.");
      return run;
    },
    "runs.list": ({ limit = 30 }) => history.list(limit),
    "runs.conversation": ({ id, workspacePath: requestedPath }) => {
      checkWorkspace(requestedPath);
      return history.conversation(id, workspace.path, CONVERSATION_HISTORY_LIMIT);
    },
    "runs.cancel": ({ id }) => {
      runs.cancel(id);
      return null;
    },
    "runs.getRules": () => history.rules(),
    "runs.setRules": ({ rules }) => history.setRules(rules),
    "workspace.open": (params) => workspace.open(params),
    "workspace.close": ({ path }) => {
      checkWorkspace(path);
      workspace.close();
      return null;
    },
    "workspace.list": ({ workspacePath: requestedPath, ...params }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      return workspace.list(params);
    },
    "workspace.files": ({ workspacePath: requestedPath, ...params }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      return workspace.files(params);
    },
    "workspace.read": ({ workspacePath: requestedPath, ...params }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      return workspace.read(params);
    },
    "workspace.write": ({ workspacePath: requestedPath, ...params }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      return workspace.write(params);
    },
    "workspace.create": ({ workspacePath: requestedPath, ...params }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      return workspace.create(params);
    },
    "workspace.rename": ({ workspacePath: requestedPath, ...params }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      return workspace.rename(params);
    },
    "workspace.remove": async ({ workspacePath: requestedPath, ...params }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      await workspace.remove(params);
      return null;
    },
    "workspace.projectRules": ({ workspacePath: requestedPath }) => {
      if (requestedPath !== undefined) checkWorkspace(requestedPath);
      return workspace.projectRules();
    },
    "git.status": ({ workspacePath }) => gitStatus(gitRoot(workspacePath)),
    "git.diff": ({ workspacePath, ...params }) => gitDiff(gitRoot(workspacePath), params),
    "prompts.list": () => workspace.listPrompts(),
    "prompts.read": (params) => workspace.readPrompt(params),
    "prompts.write": (params) => workspace.writePrompt(params),
    "prompts.render": (params) => workspace.renderPrompt(params),
  };
}

const workspaceCodes = {
  INVALID_INPUT: -32602, NO_WORKSPACE: -32004, NOT_FOUND: -32004, FORBIDDEN: -32003,
  CONFLICT: -32009, LIMIT: -32010, INVALID_PROMPT: -32602, IO: -32011,
} as const;

async function handleRpc(request: Request, handlers: Handlers, headers: Headers) {
  const response = (value: unknown) => Response.json(value, { headers });
  const dispatch = <Method extends RpcMethod>(method: Method, params: unknown) =>
    handlers[method](parseRpcParams(method, params));
  let id: number | string | null = null;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new RpcError(-32700, "Invalid JSON.");
    }
    const envelope = rpcEnvelope.safeParse(body);
    if (!envelope.success) {
      id = rpcResponseId.safeParse(body).data?.id ?? null;
      const invalidId = envelope.error.issues.some((issue) => issue.path[0] === "id");
      throw new RpcError(-32600, invalidId ? "Invalid request ID." : "Invalid request.");
    }
    const call = envelope.data;
    id = call.id;
    if (!isRpcMethod(call.method)) throw new RpcError(-32601, "Unknown RPC method.");
    const result = await dispatch(call.method, call.params);
    return response({ jsonrpc: "2.0", id, result });
  } catch (cause) {
    const error = cause instanceof RpcError ? { code: cause.code, message: cause.message }
      : cause instanceof WorkspaceError ? { code: workspaceCodes[cause.code], message: cause.message }
      : { code: -32603, message: "The orchestrator could not complete the request." };
    return response({ jsonrpc: "2.0", id, error });
  }
}

interface ServerOptions {
  token: string;
  dataDir: string;
  globalPromptsDir?: string;
  discoverRuntimeModels?: () => Promise<string[]>;
  discoverLocalRuntimeModels?: (id: LocalRuntimeId) => Promise<string[]>;
  discoverCliModels?: CliModelDiscoverer;
}

export function startServer(options: ServerOptions) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.token)) throw new Error("Invalid sidecar session token.");
  const token = Buffer.from(options.token);
  function isAuthorized(value: unknown): boolean {
    if (typeof value !== "string" || value.length !== token.length) return false;
    const candidate = Buffer.from(value);
    return candidate.length === token.length && timingSafeEqual(candidate, token);
  }

  const history = new History(options.dataDir);
  const workspace = new Workspace({ globalPromptsDir: options.globalPromptsDir });
  const providers = new Providers(
    history,
    options.discoverRuntimeModels,
    options.discoverLocalRuntimeModels,
    options.discoverCliModels,
  );
  const listeners = new Map<string, Set<Socket>>();

  function deliver(socket: Socket, event: RunEvent) {
    if (socket.send(JSON.stringify(event)) < 0) socket.close(1013, "Reconnect to continue.");
  }

  function publish(event: RunEvent) {
    for (const socket of listeners.get(event.runId) ?? []) {
      deliver(socket, event);
      if (event.type === "status" && event.run.status !== "running") closeAfterSending(socket);
    }
  }

  function closeAfterSending(socket: Socket) {
    // A message handler is corked. Close on the next tick so the replay is flushed first.
    setTimeout(() => socket.close(), 0);
  }

  const runs = new Runs(history, providers, workspace, publish);
  const handlers = rpcHandlers(history, providers, runs, workspace);
  let stopping = false;
  try {
    const server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: 0,
      development: false,
      maxRequestBodySize: 7 * 1024 * 1024,
      fetch(request, server) {
        const origin = request.headers.get("Origin");
        if (origin && !allowedOrigins.has(origin)) return new Response(null, { status: 403 });
        const path = new URL(request.url).pathname;
        if (stopping) return new Response(null, { status: 503 });
        const headers = new Headers({ "Cache-Control": "no-store", "Vary": "Origin" });
        if (origin) headers.set("Access-Control-Allow-Origin", origin);
        if (path === "/stream" && request.method === "GET") {
          if (server.upgrade(request, { data: {} })) return;
          return new Response(null, { status: 400, headers });
        }
        if (path !== "/rpc") return new Response(null, { status: 404, headers });
        if (request.method === "OPTIONS" && origin) {
          headers.set("Access-Control-Allow-Methods", "POST");
          headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
          return new Response(null, { status: 204, headers });
        }
        if (request.method !== "POST") return new Response(null, { status: 405, headers });
        const auth = request.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ") || !isAuthorized(auth.slice(7))) {
          return new Response(null, { status: 401, headers });
        }
        if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
          return new Response(null, { status: 415, headers });
        }
        return handleRpc(request, handlers, headers);
      },
      websocket: {
        maxPayloadLength: 4096,
        backpressureLimit: 2_000_000,
        closeOnBackpressureLimit: true,
        open(socket) {
          socket.data.authTimeout = setTimeout(() => socket.close(1008, "Authentication required."), AUTH_TIMEOUT_MS);
        },
        message(socket, message) {
          if (socket.data.runId || typeof message !== "string") {
            socket.close(1008, "Invalid subscription.");
            return;
          }
          try {
            const { token, runId, after } = subscription.parse(JSON.parse(message));
            if (!isAuthorized(token)) {
              socket.close(1008, "Invalid session.");
              return;
            }
            const run = history.summary(runId);
            if (!run) {
              socket.close(1008, "Run not found.");
              return;
            }
            clearTimeout(socket.data.authTimeout);
            socket.data.runId = runId;
            for (const event of history.events(runId, after)) deliver(socket, event);
            if (run.status !== "running") {
              closeAfterSending(socket);
              return;
            }
            const subscribers = listeners.get(runId) ?? new Set<Socket>();
            subscribers.add(socket);
            listeners.set(runId, subscribers);
          } catch {
            socket.close(1008, "Invalid subscription.");
          }
        },
        close(socket) {
          clearTimeout(socket.data.authTimeout);
          const runId = socket.data.runId;
          if (!runId) return;
          const subscribers = listeners.get(runId);
          subscribers?.delete(socket);
          if (subscribers?.size === 0) listeners.delete(runId);
        },
      },
    });
    return {
      port: server.port!,
      async close() {
        if (stopping) return;
        stopping = true;
        await runs.shutdown();
        // Bun 1.3.14 can leave stop() pending after a server-initiated WebSocket close.
        // https://github.com/oven-sh/bun/issues/36223
        await Promise.race([server.stop(true), Bun.sleep(300)]);
        history.close();
      },
    };
  } catch (error) {
    history.close();
    throw error;
  }
}
