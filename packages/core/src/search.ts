import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { createInterface } from "node:readline";
import type { SearchMatch, SearchOptions, SearchResponse } from "@ide/protocol";
import {
  canonicalDirectory,
  isIndexedWorkspacePath,
  isSingleLinkFile,
  listIndexedDirectory,
  MAX_TEXT_BYTES,
  readText,
  WorkspaceError,
} from "./workspace-files";

type Options = Omit<SearchOptions, "workspacePath">;
type PathFilter = (path: string) => boolean;
type RipgrepBatch = { paths: Set<string>; globs: Set<string> };

const MAX_MATCHED_LINES = 50;
const MAX_PREVIEW_CHARS = 400;
const MAX_GLOB_ARG_BYTES = 16 * 1024;
const RIPGREP_TIMEOUT_MS = 10_000;
const WORD = "[\\p{Alphabetic}\\p{Mark}\\p{Decimal_Number}\\p{Connector_Punctuation}\\p{Join_Control}]";
const SPACE = "\\t\\x0B-\\x0D\\x20\\xA0\\u{1680}\\u{2000}-\\u{200A}\\u{2028}\\u{2029}\\u{202F}\\u{205F}\\u{3000}\\u{FEFF}";
const REGEX_CLASSES: Readonly<Record<string, string>> = {
  "\\d": "[0-9]", "\\D": "[^0-9]",
  "\\w": "[A-Za-z0-9_]", "\\W": "[^A-Za-z0-9_]",
  "\\s": "[" + SPACE + "]", "\\S": "[^" + SPACE + "]",
};

class RipgrepUnavailable extends Error {}

function compilePattern(options: Options): RegExp {
  if (typeof options.query !== "string" || !options.query || options.query.includes("\0")) {
    throw new WorkspaceError("INVALID_INPUT", "Enter a search query.");
  }
  const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  try {
    return new RegExp(options.wholeWord ? "(?<!" + WORD + ")(?:" + source + ")(?!" + WORD + ")" : source,
      options.caseSensitive ? "gu" : "giu");
  } catch {
    throw new WorkspaceError("INVALID_INPUT", "Invalid search pattern.");
  }
}

function ripgrepPattern({ query, regex }: Options): string | undefined {
  // An LF in a ripgrep argument separates patterns. Search matches within one line.
  if (query.includes("\n")) return undefined;
  if (!regex) return query;
  // Keep JavaScript's character classes and use its engine for differing assertions.
  let compatible = !/&&|--|~~/u.test(query);
  const pattern = query.replace(/\\[\s\S]/gu, (escape) => {
    if (/^\\[bBpP]$/u.test(escape)) compatible = false;
    return REGEX_CLASSES[escape] ?? escape;
  });
  return compatible ? pattern : undefined;
}

function compileGlob(glob?: string): PathFilter {
  if (glob === undefined || glob === "") return () => true;
  if (typeof glob !== "string" || glob.includes("\0") || glob.startsWith("-")) {
    throw new WorkspaceError("INVALID_INPUT", "Invalid search glob.");
  }
  const negated = glob.startsWith("!");
  const value = negated ? glob.slice(1) : glob;
  const directoryOnly = value.endsWith("/");
  const source = value.replace(/^\//u, "").replace(/\/$/u, "");
  const anchored = value.startsWith("/") || source.includes("/");
  const pattern = new Bun.Glob(source);
  const matches = (path: string) => pattern.match(anchored ? path : posix.basename(path));
  return (path) => {
    if (!negated) return !directoryOnly && matches(path);
    if (!directoryOnly && matches(path)) return false;
    for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
      if (matches(path.slice(0, end))) return false;
    }
    return true;
  };
}

async function* workspacePaths(root: string, matchesGlob: PathFilter, parent = ""): AsyncGenerator<string> {
  for (const entry of await listIndexedDirectory(root, parent)) {
    if (entry.kind === "directory") yield* workspacePaths(root, matchesGlob, entry.path);
    else if (matchesGlob(entry.path)) yield entry.path;
  }
}

function lowSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

function preview(text: string, start: number, end: number): Pick<SearchMatch, "text" | "matchStart" | "matchEnd"> {
  const margin = Math.max(0, Math.floor((MAX_PREVIEW_CHARS - (end - start)) / 2));
  let left = Math.min(Math.max(0, start - margin), Math.max(0, text.length - MAX_PREVIEW_CHARS));
  let right = Math.min(left + MAX_PREVIEW_CHARS, text.length);
  if (lowSurrogateAt(text, left)) left++;
  if (lowSurrogateAt(text, right)) right--;
  return { text: text.slice(left, right), matchStart: start - left, matchEnd: Math.min(end, right) - left };
}

function collectFileMatches(response: SearchResponse, path: string, text: string, pattern: RegExp, limit: number) {
  const matches: SearchMatch[] = [];
  let matchedLines = 0;
  lines: for (let offset = 0, number = 1; offset < text.length; number++) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(offset, end > offset && text.charCodeAt(end - 1) === 13 ? end - 1 : end);
    offset = end + 1;
    let firstMatch = true;
    for (const match of line.matchAll(pattern)) {
      if ((firstMatch && ++matchedLines > MAX_MATCHED_LINES) || response.totalMatches === limit) {
        response.truncated = true;
        break lines;
      }
      firstMatch = false;
      matches.push({ line: number, column: match.index + 1, ...preview(line, match.index, match.index + match[0].length) });
      response.totalMatches++;
    }
  }
  if (matches.length) response.files.push({ path, matches });
}

async function collectMatches(
  root: string, query: string, engine: SearchResponse["engine"], paths: AsyncIterable<string>, pattern: RegExp, limit: number,
): Promise<SearchResponse> {
  const response: SearchResponse = { query, engine, files: [], totalMatches: 0, truncated: false };
  for await (const path of paths) {
    try {
      // Reopen candidates with the editor's checks for confinement, links, size and UTF-8/NUL.
      const { text } = await readText(root, path);
      collectFileMatches(response, path, text, pattern, limit);
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
    }
    if (response.totalMatches === limit && response.truncated) break;
  }
  response.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return response;
}

function ripgrepPathGlobs(path: string): string[] {
  const literal = path.replace(/[[\]*?{}]/gu, "\\$&").replace(/ /gu, "[ ]");
  const globs = ["--glob=/" + literal];
  for (let end = literal.indexOf("/"); end !== -1; end = literal.indexOf("/", end + 1)) {
    globs.push("--glob=/" + literal.slice(0, end + 1));
  }
  return globs;
}

async function* ripgrepBatches(root: string, paths: AsyncIterable<string>): AsyncGenerator<RipgrepBatch> {
  let batch: RipgrepBatch = { paths: new Set(), globs: new Set() };
  let bytes = 0;
  for await (const path of paths) {
    const stats = await lstat(join(root, path)).catch(() => undefined);
    if (!isSingleLinkFile(stats) || stats.size > MAX_TEXT_BYTES) continue;
    const globs = ripgrepPathGlobs(path);
    const extra = globs.reduce((size, glob) => size + (batch.globs.has(glob) ? 0 : Buffer.byteLength(glob) + 4), 0);
    if (batch.paths.size && bytes + extra > MAX_GLOB_ARG_BYTES) {
      yield batch;
      batch = { paths: new Set(), globs: new Set() };
      bytes = 0;
    }
    for (const glob of globs) {
      if (batch.globs.has(glob)) continue;
      batch.globs.add(glob);
      bytes += Buffer.byteLength(glob) + 4;
    }
    if (bytes > MAX_GLOB_ARG_BYTES) throw new RipgrepUnavailable();
    batch.paths.add(path);
  }
  if (batch.paths.size) yield batch;
}

function ripgrepArgs(options: Options): string[] {
  const args = [
    "--json", "--line-number", "--column", "--no-heading", "--color=never", "--max-filesize=1M",
    "--max-count=" + MAX_MATCHED_LINES, "--no-follow", "--no-config", "--no-ignore",
    "--hidden", "--encoding=none", "--crlf", "--sort=path",
  ];
  if (!options.regex) args.push("-F");
  if (!options.caseSensitive) args.push("-i");
  if (options.wholeWord) args.push("-w");
  if (options.glob) args.push("--glob=" + options.glob);
  // Only allow approved files and their parent directories, even with a broad user glob.
  args.push("--glob=!**");
  return args;
}

function ripgrepPath(line: string): string | undefined {
  if (!line.includes('"type":"begin"')) return undefined;
  const event: { type?: unknown; data?: { path?: { text?: unknown } } } = JSON.parse(line);
  const name = event.data?.path?.text;
  if (event.type !== "begin" || typeof name !== "string") return undefined;
  const path = process.platform === "win32" ? name.replaceAll("\\", "/") : name;
  return path.startsWith("./") ? path.slice(2) : path;
}

async function* runRipgrep(
  command: string, root: string, args: string[], query: string, batch: RipgrepBatch, deadline: number,
): AsyncGenerator<string> {
  const timeLeft = deadline - performance.now();
  if (timeLeft <= 0) throw new WorkspaceError("IO", "Search timed out.");
  // Passing individual files directly would let ripgrep follow explicit symlinks.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, [...args, ...batch.globs, "--", query, "."], {
      cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new RipgrepUnavailable();
  }
  const stdout = child.stdout;
  if (!stdout) {
    child.kill("SIGKILL");
    throw new RipgrepUnavailable();
  }
  const output = createInterface({ input: stdout, crlfDelay: Infinity });
  const closeOutput = () => {
    output.close();
    stdout.destroy();
  };
  const stop = () => {
    closeOutput();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.once("error", () => {
      closeOutput();
      resolve(null);
    });
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeLeft);
  try {
    for await (const line of output) {
      const path = ripgrepPath(line);
      if (path && isIndexedWorkspacePath(path) && batch.paths.has(path)) yield path;
    }
    const code = await closed;
    if (code !== 0 && code !== 1) throw new RipgrepUnavailable();
  } finally {
    clearTimeout(timer);
    stop();
    await closed;
    if (timedOut) throw new WorkspaceError("IO", "Search timed out.");
  }
}

async function* ripgrepPaths(
  command: string, root: string, options: Options, query: string, paths: AsyncIterable<string>,
): AsyncGenerator<string> {
  const args = ripgrepArgs(options);
  const deadline = performance.now() + RIPGREP_TIMEOUT_MS;
  for await (const batch of ripgrepBatches(root, paths)) {
    yield* runRipgrep(command, root, args, query, batch, deadline);
  }
}

export async function searchWorkspace(
  root: string, options: Options, deps?: { rgPath?: string | null },
): Promise<SearchResponse> {
  const directory = await canonicalDirectory(root);
  const pattern = compilePattern(options);
  const glob = compileGlob(options.glob);
  const requested = options.maxResults ?? 200;
  const limit = Number.isNaN(requested) ? 200 : Math.max(1, Math.min(500, Math.floor(requested)));
  const command = deps?.rgPath !== undefined ? deps.rgPath : Bun.which("rg");
  const query = command ? ripgrepPattern(options) : undefined;
  if (command && query !== undefined) {
    try {
      const paths = ripgrepPaths(command, directory, options, query, workspacePaths(directory, glob));
      return await collectMatches(directory, options.query, "rg", paths, pattern, limit);
    } catch (error) {
      if (!(error instanceof RipgrepUnavailable)) throw error;
    }
  }
  return collectMatches(directory, options.query, "native", workspacePaths(directory, glob), pattern, limit);
}
