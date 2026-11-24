import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { RefObject } from "react";
import { Button, Stack, Text } from "@mantine/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Play, Stop, TerminalWindow } from "@phosphor-icons/react";
import { errorMessage } from "./bridge";
import type { Bridge } from "./bridge";
import { clearTerminalSession, recordTerminalOutput } from "./terminalBuffer";
import { themeTokens } from "./theme";
import "@xterm/xterm/css/xterm.css";

export interface TerminalControls {
  start: () => void;
  stop: () => void;
}

export interface TerminalStateSnapshot {
  running: boolean;
  hasStarted: boolean;
  status: string;
}

interface Props {
  bridge: Bridge | null;
  cwd: string | null;
  program?: string;
  args?: string[];
  title: string;
  embedded?: boolean;
  autoStart?: boolean;
  controlsRef?: RefObject<TerminalControls | null>;
  onStateChange?: (state: TerminalStateSnapshot) => void;
}

interface Session {
  bridge: Bridge;
  cwd?: string;
  program?: string;
  args?: string[];
}

export function TerminalPanel({
  bridge, cwd, program, args, title, embedded = false, autoStart = true, controlsRef, onStateChange,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const bufferKey = useId();
  const directoryHint = useId();
  const [session, setSession] = useState<Session | null>(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [status, setStatus] = useState("");
  const autoStartedRef = useRef(false);

  const running = Boolean(session && !status);

  function startSession() {
    if (!bridge) return;
    setStatus("");
    setHasStarted(true);
    setSession({ bridge, cwd: cwd ?? undefined, program, args: args && [...args] });
  }

  function stopSession() {
    setSession(null);
    setStatus("Session stopped");
  }

  useImperativeHandle(controlsRef, () => ({
    start: startSession,
    stop: stopSession,
  }));

  useEffect(() => {
    onStateChange?.({ running, hasStarted, status });
  }, [hasStarted, onStateChange, running, status]);

  useEffect(() => {
    if (!autoStart || !bridge || autoStartedRef.current) return;
    autoStartedRef.current = true;
    setStatus("");
    setHasStarted(true);
    setSession({ bridge, cwd: cwd ?? undefined, program, args: args && [...args] });
  }, [args, autoStart, bridge, cwd, program]);

  useEffect(() => {
    if (!session || !viewport.current) return;
    const { bridge: activeBridge, ...options } = session;
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
    const textDecoder = new TextDecoder();
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    });
    observer.observe(element);
    const resize = terminal.onResize(({ cols, rows }) => {
      if (id) void activeBridge.resizeTerminal(id, cols, rows).catch(() => {});
    });
    const input = terminal.onData((data) => {
      if (!id) return;
      const sessionId = id;
      writes = writes.then(() => activeBridge.typeTerminal(sessionId, data)).catch((error) => {
        if (!disposed && !finished) setStatus(errorMessage(error));
      });
    });

    void activeBridge.openTerminal({
      ...options, cols: terminal.cols, rows: terminal.rows,
    }, (event) => {
      if (disposed) return;
      if (event.type === "data") {
        const bytes = Uint8Array.from(atob(event.data), (character) => character.charCodeAt(0));
        terminal.write(bytes);
        recordTerminalOutput(bufferKey, title, textDecoder.decode(bytes, { stream: true }));
      } else {
        finished = true;
        id = undefined;
        setStatus(event.code === null ? "Session ended" : `Exited with code ${event.code}`);
      }
    }).then((sessionId) => {
      if (disposed) {
        void activeBridge.closeTerminal(sessionId).catch(() => {});
      } else if (!finished) {
        id = sessionId;
        void activeBridge.resizeTerminal(id, terminal.cols, terminal.rows).catch(() => {});
        terminal.focus();
      }
    }).catch((error) => {
      if (!disposed) setStatus(errorMessage(error));
    });

    return () => {
      disposed = true;
      if (id) void activeBridge.closeTerminal(id).catch(() => {});
      clearTerminalSession(bufferKey);
      observer.disconnect();
      resize.dispose();
      input.dispose();
      terminal.dispose();
    };
  }, [bufferKey, session, title]);

  return (
    <div className="terminal-panel">
      {!embedded && (
        <div className="panel-toolbar">
          <TerminalWindow size={15} weight="duotone" aria-hidden="true" />
          <strong>{title}</strong>
          <span className="terminal-status" role="status">{status}</span>
          {running && (
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<Stop size={12} weight="fill" aria-hidden="true" />}
              onClick={stopSession}
            >
              Stop
            </Button>
          )}
          {!running && (
            <Button
              size="compact-xs"
              variant="default"
              disabled={!bridge}
              aria-describedby={session ? undefined : directoryHint}
              leftSection={<Play size={13} weight="fill" aria-hidden="true" />}
              onClick={startSession}
            >
              {hasStarted ? "Restart" : "Start"}
            </Button>
          )}
        </div>
      )}
      {session ? <div className="terminal-viewport" ref={viewport} /> : (
        <Stack align="center" justify="center" gap="xs" flex={1} p="lg" ta="center">
          <TerminalWindow size={24} weight="duotone" color="var(--muted)" aria-hidden="true" />
          <Text size="sm" fw={600}>Start an interactive session</Text>
          <Text id={directoryHint} size="xs" c="dimmed">
            {cwd ? "Starts in the project folder with write access." : "Starts in your home folder."}
          </Text>
          <Button
            size="compact-xs"
            color="iris"
            variant="light"
            disabled={!bridge}
            leftSection={<Play size={12} weight="fill" aria-hidden="true" />}
            onClick={startSession}
          >
            {hasStarted ? "Restart" : "Start"}
          </Button>
        </Stack>
      )}
    </div>
  );
}
