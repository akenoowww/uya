export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ParsedPatch {
  targetPath?: string;
  hunks: PatchHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function isUnifiedDiff(language: string | undefined, code: string): boolean {
  const lang = (language ?? "").toLowerCase();
  if (lang === "diff" || lang === "patch") return HUNK_HEADER.test(code) || /^--- /m.test(code);
  return /^--- [^\n]+\n\+\+\+ [^\n]+\n@@ /m.test(code);
}

export function extractTargetPath(language: string | undefined, code: string): string | undefined {
  const plusMatch = /^\+\+\+ (?:b\/)?([^\t\r\n]+)$/m.exec(code);
  if (plusMatch?.[1] && plusMatch[1] !== "/dev/null") {
    return normalizeCandidatePath(plusMatch[1]);
  }
  const firstLine = code.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const commentMatch = /^(?:\/\/|#|\/\*|<!--|--)\s*(?:file:\s*)?([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?:\s*(?:\*\/|-->))?$/.exec(firstLine);
  if (commentMatch?.[1]) {
    return normalizeCandidatePath(commentMatch[1]);
  }
  if (language && language.includes(":") && !language.includes(" ")) {
    const candidate = language.slice(language.indexOf(":") + 1);
    return normalizeCandidatePath(candidate);
  }
  return undefined;
}

function normalizeCandidatePath(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/^["']|["']$/g, "").replace(/^\.\//, "");
  if (!cleaned || cleaned.startsWith("/") || cleaned.includes("..") || cleaned.includes("\\")) return undefined;
  return cleaned;
}

export function parseUnifiedDiff(diffText: string): ParsedPatch | null {
  const rawLines = diffText.replace(/\r\n/g, "\n").split("\n");
  let targetPath: string | undefined;
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (const line of rawLines) {
    if (line.startsWith("+++ ")) {
      const candidate = line.slice(4).split("\t")[0]?.trim().replace(/^b\//, "");
      if (candidate && candidate !== "/dev/null") targetPath = normalizeCandidatePath(candidate);
      continue;
    }
    const match = HUNK_HEADER.exec(line);
    if (match) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      continue;
    }
    if (current) {
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
        current.lines.push(line);
      } else if (line === "\\ No newline at end of file") {
        continue;
      } else if (line.startsWith("diff --git ") || line.startsWith("--- ")) {
        hunks.push(current);
        current = null;
      }
    }
  }
  if (current) hunks.push(current);
  if (!hunks.length) return null;
  return { targetPath, hunks };
}

function matchesAt(source: string[], startIndex: number, expected: string[]): boolean {
  if (startIndex < 0 || startIndex + expected.length > source.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (source[startIndex + i] !== expected[i]) return false;
  }
  return true;
}

function findHunkStart(source: string[], hint: number, expected: string[]): number {
  if (!expected.length) return Math.max(0, Math.min(source.length, hint));
  if (matchesAt(source, hint, expected)) return hint;
  for (let delta = 1; delta <= 60; delta++) {
    if (matchesAt(source, hint - delta, expected)) return hint - delta;
    if (matchesAt(source, hint + delta, expected)) return hint + delta;
  }
  for (let index = 0; index <= source.length - expected.length; index++) {
    if (matchesAt(source, index, expected)) return index;
  }
  return -1;
}

export function applyUnifiedDiff(original: string, diffText: string): { ok: true; text: string } | { ok: false; error: string } {
  const parsed = parseUnifiedDiff(diffText);
  if (!parsed) return { ok: false, error: "Could not parse unified diff hunks." };

  const endsWithNewline = original.endsWith("\n");
  const lines = original ? original.replace(/\r\n/g, "\n").split("\n") : [];
  if (endsWithNewline && lines.at(-1) === "") lines.pop();

  let offset = 0;
  for (const hunk of parsed.hunks) {
    const expected = hunk.lines
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1));
    const replacement = hunk.lines
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1));

    const hint = Math.max(0, hunk.oldStart - 1 + offset);
    const start = findHunkStart(lines, hint, expected);
    if (start < 0) {
      return { ok: false, error: `Hunk at line ${hunk.oldStart} does not match the current file.` };
    }
    lines.splice(start, expected.length, ...replacement);
    offset += replacement.length - expected.length;
  }

  return { ok: true, text: lines.join("\n") + (endsWithNewline || lines.length > 0 ? "\n" : "") };
}
