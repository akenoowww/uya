const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
const MAX_LINES = 160;
const MAX_CHARS = 32 * 1024;

interface SessionBuffer {
  title: string;
  lines: string[];
  updatedAt: number;
}

const sessions = new Map<string, SessionBuffer>();
let latestSessionId: string | null = null;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function recordTerminalOutput(sessionId: string, title: string, chunk: string) {
  const clean = stripAnsi(chunk);
  if (!clean) return;
  const entry = sessions.get(sessionId) ?? { title, lines: [""], updatedAt: Date.now() };
  entry.title = title;
  entry.updatedAt = Date.now();
  const parts = clean.split("\n");
  entry.lines[entry.lines.length - 1] += parts[0];
  for (let i = 1; i < parts.length; i++) {
    entry.lines.push(parts[i]);
  }
  if (entry.lines.length > MAX_LINES) {
    entry.lines = entry.lines.slice(-MAX_LINES);
  }
  sessions.set(sessionId, entry);
  latestSessionId = sessionId;
}

export function clearTerminalSession(sessionId: string) {
  sessions.delete(sessionId);
  if (latestSessionId === sessionId) {
    let newestId: string | null = null;
    let newestAt = -1;
    for (const [id, entry] of sessions) {
      if (entry.updatedAt > newestAt) {
        newestAt = entry.updatedAt;
        newestId = id;
      }
    }
    latestSessionId = newestId;
  }
}

export function readLatestTerminalOutput(maxLines = 80): { title: string; text: string } | null {
  if (!latestSessionId) return null;
  const entry = sessions.get(latestSessionId);
  if (!entry) return null;
  const trimmed = entry.lines.slice(-maxLines).join("\n").trim();
  if (!trimmed) return null;
  const text = trimmed.length > MAX_CHARS ? trimmed.slice(-MAX_CHARS) : trimmed;
  return { title: entry.title, text };
}

export function hasTerminalOutput(): boolean {
  return readLatestTerminalOutput(10) !== null;
}
