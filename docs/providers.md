# Providers & Local Runtimes

Uya works directly with the CLI agents you already authenticate with locally and the local model servers running on your machine — **no Uya cloud account, proxy, or API key vault required**.

---

## Capability Matrix

| Provider | Isolated | Explore (Read-Only) | Agent (Edit + Approvals) | Live Session | Effort Controls | Interactive TUI |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Codex** (`codex`) | Yes | Yes | Yes | Yes (CLI resume) | Live / `minimal`–`max` | Yes |
| **Claude Code** (`claude`) | Yes | Yes | Yes | Yes (CLI resume) | Live / `low`–`max` | Yes |
| **Antigravity** (`agy`) | Yes | Yes | Yes (Inline ACP) | Yes (ACP pool) | Live per-model | Yes |
| **Gemini CLI** (`gemini`) | Yes | Yes | Yes | — | Live | Yes |
| **OpenCode** (`opencode`) | Yes | Yes | Yes | — | — | Yes |
| **Gemini API** (`gemini-api`) | Yes | Map fallback | — | — | Live thinking levels | Yes (`explore`) |
| **Qwen Code** (`qwen`) | Yes | Map fallback | — | — | Live ACP | Yes |
| **Ollama** (`127.0.0.1:11434`) | Yes | Map fallback | — | — | `minimal`–`high` | Yes |
| **llama.cpp** (`127.0.0.1:9931` / `8080`) | Yes | Map fallback | — | — | `low`–`high` | When installed |
| **MLX LM** (`127.0.0.1:8080`) | Yes | Map fallback | — | — | `low`–`high` | When installed |
| **LM Studio** (`127.0.0.1:1234`) | Yes | Map fallback | — | — | `low`–`high` | When installed |
| **Custom CLI** | macOS sandbox | — | — | — | — | macOS & Windows |
| **Kimi Code** (`kimi`) | — | — | — | — | — | Yes |

> **Map fallback**: Stateless APIs and local HTTP runtimes (`Ollama`, `llama.cpp`, `MLX`, `LM Studio`, `Gemini API`, `Qwen Code`) do not invoke filesystem tools directly. When **Workspace Map** is enabled in the Context menu, Uya injects a compact (<= 6 KiB) 2-level repository layout + active file hint so even pure local models understand your project structure immediately.

---

## How Access Modes Map to CLI Adapters

### Codex (`codex`)
- **Isolated**: `codex exec --json --sandbox read-only --skip-git-repo-check` inside a disposable scratch directory.
- **Explore (`read-only`)**: Runs with workspace `cwd` using `--sandbox read-only` and native `exec resume <sessionId>` for warm follow-up turns.
- **Agent**: Runs with workspace (or Worktree Arena) `cwd` using `--sandbox workspace-write` and native session resume, emitting structured tool events (`command`, `file_change`, `mcp_tool_call`) and cached token counts.

### Claude Code (`claude`)
- **Isolated**: `claude -p --output-format stream-json --verbose --tools "" --setting-sources "" --strict-mcp-config` in a scratch directory.
- **Explore (`read-only`)**: Runs in workspace `cwd` with `--permission-mode plan` and `--allowedTools Read,Glob,Grep,LS`, plus `--resume <sessionId>`.
- **Agent**: Runs in workspace (or worktree) `cwd` with `--permission-mode acceptEdits` and `--resume <sessionId>`, capturing structured `tool_use` blocks and `cache_read_input_tokens`.

### Antigravity (`agy`)
- Runs over persistent **ACP (Agent Client Protocol)** sessions (`agy acp --sandbox`) pooled per conversation in `AcpSessionPool`.
- **Isolated**: Scratch `cwd`, denies all tool permission requests.
- **Explore (`read-only`)**: Workspace `cwd`, auto-allows read/search tool permissions and denies write/edit/shell permissions.
- **Agent**: Workspace (or worktree) `cwd`, auto-allows read/search and routes edit/write/shell permissions to **inline Uya approval cards** (`Allow once`, `Allow session`, `Deny`) — failing closed if no approval callback is bound.

### Gemini CLI (`gemini`) & OpenCode (`opencode`)
- **Gemini CLI**: Generates strict ephemeral TOML policy profiles per mode (`isolated` denies all tools; `read-only` allows file read/search tools; `agent` allows workspace edits).
- **OpenCode**: Passes explicit ordered permission rules via `OPENCODE_PERMISSION` matching `isolated`, `read-only`, and `agent`.

---

## Live Model & Effort Discovery

Uya does not ship stale hardcoded model lists. Discovery runs live with short TTL caching (5 minutes when models are found, 30 seconds when empty) and can be refreshed on demand from any split's model picker or **Providers → Refresh**:
- **Codex**: Live paginated `codex app-server` `model/list`, falling back to local Codex CLI cache.
- **Claude Code**: `stream-json` `initialize` `control_request` handshake.
- **Antigravity**: Live ACP `configOptions` + `availableModels` with exact per-model effort levels.
- **Gemini CLI / API**: Isolated ACP discovery, `gemini models list --json`, and live Gemini API thinking schema.
- **Qwen Code / OpenCode**: Live ACP config options and `opencode models --pure`.
- **Local Runtimes**: Direct loopback probes strictly on `127.0.0.1` (`11434`, `9931`, `8080`, `1234`).

---

## Custom CLI Providers

Under **Providers → Custom CLI** (`⌘,` / `Ctrl+,`), you can register any executable on `PATH` or by absolute path:
- **Interactive Terminal**: Available on both macOS and Windows via native PTY/ConPTY.
- **Structured Mode (macOS only, opt-in)**: Reads the prompt from `stdin`, streams the reply from `stdout`, and runs inside a verified macOS `/usr/bin/sandbox-exec` profile that restricts filesystem access and blocks network egress.
