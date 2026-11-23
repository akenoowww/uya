import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RpcCall, RunEvent } from "@ide/protocol";

type CoreConnection = { port: number; token: string };
type PtyEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

export interface Bridge {
  rpc: RpcCall;
  subscribe: (id: string, after: number, onEvent: (event: RunEvent) => void, onClose: () => void) => () => void;
  chooseFolder: () => Promise<string | null>;
  activateFolder: (path: string) => Promise<void>;
  watchFolder: (notify: (path: string) => void) => Promise<() => void>;
  openTerminal: (options: {
    cwd?: string;
    program?: string;
    args?: string[];
    cols: number;
    rows: number;
  }, onEvent: (event: PtyEvent) => void) => Promise<string>;
  typeTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
}

export async function connect(): Promise<Bridge> {
  if (!isTauri()) throw new Error("Open Uya from the desktop app to connect to the local runtime.");
  const { port, token } = await invoke<CoreConnection>("get_core_connection");
  let requestId = 0;

  return {
    async rpc(method, params) {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error("The local runtime could not complete the request.");
      const envelope = await response.json();
      if (envelope.error) throw new Error(envelope.error.message);
      return envelope.result;
    },
    subscribe(id, after, onEvent, onClose) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/stream`);
      socket.onopen = () => socket.send(JSON.stringify({ token, runId: id, after }));
      socket.onmessage = ({ data }) => {
        try {
          onEvent(JSON.parse(String(data)) as RunEvent);
        } catch {
          socket.close();
        }
      };
      socket.onclose = onClose;
      return () => {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      };
    },
    chooseFolder: () => invoke("select_workspace"),
    activateFolder: (path) => invoke("activate_workspace", { path }),
    watchFolder: (notify) => listen<string>("workspace-changed", ({ payload }) => notify(payload)),
    openTerminal(options, onEvent) {
      const channel = new Channel<PtyEvent>();
      channel.onmessage = onEvent;
      return invoke("pty_open", { ...options, onEvent: channel });
    },
    typeTerminal: (id, data) => invoke("pty_write", { id, data }),
    resizeTerminal: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
    closeTerminal: (id) => invoke("pty_close", { id }),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The operation could not be completed.";
}
