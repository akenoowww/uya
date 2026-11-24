const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  jsonc: "json",
  cs: "csharp",
  kt: "kotlin",
  dockerfile: "dockerfile",
  sql: "sql",
  html: "html",
  xml: "xml",
  css: "css",
  scss: "scss",
  go: "go",
  java: "java",
  cpp: "cpp",
  cc: "cpp",
  c: "c",
  swift: "swift",
  php: "php",
  toml: "ini",
  ini: "ini",
  diff: "plaintext",
  patch: "plaintext",
};

const MAX_CACHE = 180;
const highlightCache = new Map<string, string>();
let themeStylesBootstrapped = false;

function ensureMonacoThemeStyles(monaco: typeof import("./editorMonaco")["monaco"]) {
  if (themeStylesBootstrapped || typeof document === "undefined") return;
  themeStylesBootstrapped = true;
  monaco.editor.setTheme("workbench-dark");
  if (!document.querySelector("style.monaco-colors")) {
    const probe = document.createElement("div");
    const instance = monaco.editor.create(probe, { model: null, theme: "workbench-dark" });
    instance.dispose();
  }
}

function normalizeLanguage(language: string | undefined): string | null {
  if (!language) return null;
  const clean = language.toLowerCase().split(":")[0]?.trim();
  if (!clean || clean === "text" || clean === "txt" || clean === "plain" || clean === "plaintext") return null;
  return LANGUAGE_ALIASES[clean] ?? clean;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderDiffHtml(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line);
      if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) {
        return `<span class="diff-line-meta">${escaped}</span>`;
      }
      if (line.startsWith("@@ ")) return `<span class="diff-line-hunk">${escaped}</span>`;
      if (line.startsWith("+")) return `<span class="diff-line-add">${escaped}</span>`;
      if (line.startsWith("-")) return `<span class="diff-line-del">${escaped}</span>`;
      return escaped;
    })
    .join("\n");
}

export async function highlightCode(code: string, language: string | undefined): Promise<string | null> {
  if (!code || code.length > 64_000) return null;
  const rawLang = (language ?? "").toLowerCase().split(":")[0]?.trim();
  if (rawLang === "diff" || rawLang === "patch") {
    return renderDiffHtml(code);
  }
  const normalized = normalizeLanguage(language);
  if (!normalized || normalized === "plaintext") return null;
  const cacheKey = `${normalized}\0${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const { monaco } = await import("./editorMonaco");
    ensureMonacoThemeStyles(monaco);
    const html = await monaco.editor.colorize(code, normalized, { tabSize: 2 });
    if (highlightCache.size >= MAX_CACHE) {
      const oldest = highlightCache.keys().next().value;
      if (oldest !== undefined) highlightCache.delete(oldest);
    }
    highlightCache.set(cacheKey, html);
    return html;
  } catch {
    return null;
  }
}
