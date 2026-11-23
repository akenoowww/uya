import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@mantine/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Play, Stop, TerminalWindow } from "@phosphor-icons/react";
import { errorMessage } from "./bridge";
import type { Bridge } from "./bridge";
import { themeTokens } from "./theme";
import "@xterm/xterm/css/xterm.css";

interface Props {
  bridge: Bridge | null;
  cwd: string | null;
  program?: string;
  args?: string[];
  title: string;
}

interface Session {
  bridge: Bridge;
  cwd?: string;
  program?: string;
  args?: string[];
}

export function TerminalPanel({ bridge, cwd, program, args, title }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const directoryHint = useId();
  const [session, setSession] = useState<Session | null>(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!session || !viewport.current) return;
    const { bridge, ...options } = session;
    const element = viewport.current;
    const theme = themeTokens();
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: theme("mono"),
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 2500,
      theme: {
        background: theme("terminal-background"),
        foreground: theme("text"),
        cursor: theme("accent"),
        selectionBackground: theme("terminal-selection"),
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();

    let id: string | undefined;
    let disposed = false;
    let finished = false;
    let writes = Promise.resolve();
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    });
    observer.observe(element);
    const resize = terminal.onResize(({ cols, rows }) => {
      if (id) void bridge.resizeTerminal(id, cols, rows).catch(() => {});
    });
    const input = terminal.onData((data) => {
      if (!id) return;
      const sessionId = id;
      writes = writes.then(() => bridge.typeTerminal(sessionId, data)).catch((error) => {
        if (!disposed && !finished) setStatus(errorMessage(error));
      });
    });

    void bridge.openTerminal({
      ...options, cols: terminal.cols, rows: terminal.rows,
    }, (event) => {
      if (disposed) return;
      if (event.type === "data") {
        terminal.write(Uint8Array.from(atob(event.data), (character) => character.charCodeAt(0)));
      } else {
        finished = true;
        id = undefined;
        setStatus(event.code === null ? "Session ended" : `Exited with code ${event.code}`);
      }
    }).then((sessionId) => {
      if (disposed) {
        void bridge.closeTerminal(sessionId).catch(() => {});
      } else if (!finished) {
        id = sessionId;
        void bridge.resizeTerminal(id, terminal.cols, terminal.rows).catch(() => {});
        terminal.focus();
      }
    }).catch((error) => {
      if (!disposed) setStatus(errorMessage(error));
    });

    return () => {
      disposed = true;
      if (id) void bridge.closeTerminal(id).catch(() => {});
      observer.disconnect();
      resize.dispose();
      input.dispose();
      terminal.dispose();
    };
  }, [session]);

  return (
    <div className="terminal-panel">
      <div className="panel-toolbar">
        <TerminalWindow size={15} weight="duotone" aria-hidden="true" />
        <strong>{title}</strong>
        <span className="terminal-status" role="status">{status}</span>
        {session && !status && (
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<Stop size={12} weight="fill" aria-hidden="true" />}
            onClick={() => {
              setSession(null);
              setStatus("Session stopped");
            }}
          >
            Stop
          </Button>
        )}
        {(!session || status) && (
          <Button
            size="compact-xs"
            variant="default"
            disabled={!bridge}
            aria-describedby={session ? undefined : directoryHint}
            leftSection={<Play size={13} weight="fill" aria-hidden="true" />}
            onClick={() => {
              if (!bridge) return;
              setStatus("");
              setHasStarted(true);
              setSession({ bridge, cwd: cwd ?? undefined, program, args: args && [...args] });
            }}
          >
            {hasStarted ? "Restart" : "Start"}
          </Button>
        )}
      </div>
      {session ? <div className="terminal-viewport" ref={viewport} /> : (
        <div className="pane-empty">
          <TerminalWindow size={24} weight="duotone" aria-hidden="true" />
          <strong>Start an interactive session</strong>
          <span id={directoryHint}>{cwd ? "Starts in the project folder with write access." : "Starts in your home folder."}</span>
        </div>
      )}
    </div>
  );
}
