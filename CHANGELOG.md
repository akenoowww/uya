# Changelog

All notable changes to **Uya** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-11-25

### Added

- **Google Antigravity OAuth Provider (`antigravity`, `agy`)**: Added native ACP integration (`agy acp --sandbox --disable-telemetry`) with Google AI Pro / Ultra OAuth support, live model and per-model effort discovery (`configOptions` + `models.availableModels` with `agy models` fallback), read-only `session/request_permission` denial, streaming thought/text/tool events, custom provider icon, and interactive TUI `--model` / `--effort` forwarding.
- **Restored Gemini CLI (`gemini`) Alongside Gemini API (`gemini-api`)**: Users can now choose between **Antigravity** (`agy`, Google OAuth), **Gemini CLI** (`gemini`, Google OAuth / API key / Vertex AI with isolated read-only policy and live ACP + `gemini models list -o json` discovery), and **Gemini API** (`gemini-api`, Interactions API with live `models list` + `generate --schema`).

### Fixed

- Classified zero-limit Free Tier (`limit: 0` / `upgrade your tier`), `quota_exceeded`, and `payment_required` (`402`) API errors as quota/tier diagnostics instead of transient rate-limit retries, and expanded ACP authentication error recognition.

## [0.3.1] - 2026-11-25

### Changed

- **Official `gemini-api` CLI Integration**: Migrated the built-in Gemini provider (`id: "gemini"`, **Gemini API**) to Google's official `gemini-api` CLI and stateless **Gemini Interactions API** (`generate --no-interactive -o json` with native multi-turn JSON stdin, `thought_summary` and `text` SSE streaming, and `gemini-api explore` in Terminal mode).
- **Dynamic API Model & Thinking Discovery**: Queries live Gemini models and per-model `thinking` capabilities via `gemini-api models list`, reads supported `ThinkingLevel` values from `gemini-api generate --schema`, and uses `gemini-api models` for the default model and pre-auth fallback with zero hardcoded model lists.

### Fixed

- Classified structured `gemini-api` JSON authentication (`authentication_error` / `UNAUTHENTICATED`) and rate-limit (`rate_limit_error` / `RESOURCE_EXHAUSTED`) errors cleanly in run diagnostics.
- Hid the per-split `EffortPicker` automatically when the live API reports `thinking: false` for the selected model.

## [0.3.0] - 2026-11-25

### Added

- **Model Effort Control**: End-to-end reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) discovery and execution across Codex, Claude Code, Gemini CLI, Qwen Code, OpenCode, Ollama (with HTTP 400 fallback), and local OpenAI-compatible runtimes, surfaced via per-split `EffortPicker`, `/effort`, Command Palette, interactive TUI arguments, prompt template frontmatter (`effort`), and `tok/s` readouts.
- **Context Mentions & Live Budget**: Attach workspace files, unstaged/staged Git diffs, and recent terminal output using `@file`, `@git-diff`, `@git-staged`, and `@terminal` autocomplete or the `+ Context` menu, with removable context pills and a live `KiB / ~tokens` progress meter.
- **Automatic Project Rules**: Detects workspace instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.uya/rules.md`, `.cursorrules`, `.github/copilot-instructions.md`) within a 64 KiB budget with a one-click toggle per run.
- **Git Sidebar & Built-in Monaco Diff / Apply**: Security-hardened read-only Git status and diff sidebar (`git.status`, `git.diff`) plus side-by-side/inline Monaco `DiffEditorPanel` with `Diff / Apply` preview directly from AI markdown code blocks.
- **Workspace Productivity**: Quick Open (`⌘P` / `Ctrl+P`), Explorer file/folder create, rename, and delete with strict workspace confinement, external disk-change reload/conflict banner in Monaco, syntax-highlighted Markdown code blocks, clickable `path/to/file:line` deep-links, and safe `http`/`https` external link opening.
- **Cross-Model Review & Synthesis**: Broadcast comparison metrics summary bar and arbiter modal (`Find bugs & gaps`, `Synthesize best`, `Pick winner`) sending completed broadcast outputs to a chosen verifier split.
- **History 2.0 & Usage Insights**: SQLite migration v3 with `broadcast_runs` and FTS5 full-text search across prompts and replies, `Threads / Runs` sidebar toggle, conversation Resume, Fork to a new split, Markdown export, deletion, and a local `Usage` dashboard (runs, success rate, avg TTFT, token volume, and effort breakdown).
- **Recent Workspaces & macOS Overlay Titlebar**: Security-preserving Recent Projects menu (picker-approved canonical paths persisted with `0600` atomic writes) and native macOS `TitleBarStyle::Overlay`.

### Changed

- **Full Mantine v9 UI/UX Overhaul**: Unified workbench shell, 38px overlay titlebar, drag-resizable sidebar, Activity Rail `Indicator` badges, single-toolbar split headers, embedded interactive TUI without duplicate toolbars, auto-started PTY sessions, and Mantine dialogs (including `AppUpdateDialog`).
- **Redesigned Provider Icons**: Replaced legacy provider icons with 11 crisp, transparent 128×128 emblems across all supported CLIs and local runtimes.
- **Keyboard Shortcuts**: Moved New Split to `⌘\` / `Ctrl+\` to avoid conflicting with Monaco multi-cursor (`⌘D` / `Ctrl+D`), and added IME-safe Enter handling across chat, mentions, Quick Open, and Explorer dialogs.

## [0.2.1] - 2026-11-24

### Fixed

- Custom CLI Structured mode on macOS now probes `/usr/bin/sandbox-exec` against a test process before enabling, falling back cleanly to the interactive terminal with clear guidance when the sandbox cannot start or on non-macOS platforms.
- Desktop webview navigation and sidecar startup now use `tauri::is_dev()` instead of `!cfg!(feature = "custom-protocol")` to detect development mode reliably.

### Changed

- Clarified Custom CLI platform behavior and structured CLI security boundaries in `README.md` and `README.kk.md`.

## [0.2.0] - 2026-11-24

### Added

- Uya downloads and verifies desktop updates in the background on macOS and Windows. Select **Restart to Update** when the signed update is ready.
- **Check for Updates** in the command palette checks for an update on demand.
- The model picker discovers available models from supported installed CLI providers, shows the provider default when available, and offers a refresh action.

### Changed

- Uya uses the same app icon in the window, browser tab, and desktop installers.

### Upgrade

- On Uya 0.1.0, download the installer for your platform from GitHub Releases and install this release once.

## [0.1.0] - 2026-11-24

Initial public release of **Uya** — a local-first multi-agent AI workbench for macOS and Windows 10/11.

### Added
- **Multi-Split AI Workbench**: Run prompts against one active split or broadcast a single prompt simultaneously across all open structured splits with independent per-split conversation history.
- **CLI Agent & Local Runtime Support**:
  - Structured & interactive support for **Codex**, **Claude Code**, **Gemini CLI**, **Qwen Code**, and **OpenCode**.
  - Local HTTP streaming for **Ollama**, **llama.cpp**, **MLX**, and **LM Studio** over `127.0.0.1`.
  - Interactive terminal support for **Kimi Code** and user-defined **Custom CLI** commands (with opt-in sandboxed structured mode via macOS `sandbox-exec`).
- **Routing & Reliability**: Rule-based provider routing (by tag, file extension, or minimum context length) and ordered fallback chains with TTFT and total duration metrics.
- **Project Explorer & Built-in Editor**: Monaco-based tabbed code editor with workspace boundary enforcement, symlink/private-config protection, revision-checked saves, and file/selection context attachment.
- **Native Interactive Terminals**: Embedded `xterm.js` backed by native PTYs (macOS PTY and Windows ConPTY) for agent TUIs and shell sessions.
- **Prompt Library**: Reusable Markdown templates with YAML frontmatter stored in `<project>/.ai/prompts/` and `~/.uya/prompts/`, supporting variable substitution and template revision tracking.
- **Local Persistence & Security**: Tauri + compiled Bun sidecar communicating over random-port loopback (`127.0.0.1`) with per-session auth tokens, versioned SQLite migrations, and per-project Dockview layout/conversation restoration.
- **Cross-Platform Distribution**: Native macOS `.app` / `.dmg` (Apple Silicon & Intel) and Windows 10/11 NSIS `.exe` / `.msi` installers with custom **Uya** iconography and automated GitHub Actions CI & release workflows.

[0.3.2]: https://github.com/akenoowww/uya/releases/tag/v0.3.2
[0.3.1]: https://github.com/akenoowww/uya/releases/tag/v0.3.1
[0.3.0]: https://github.com/akenoowww/uya/releases/tag/v0.3.0
[0.2.1]: https://github.com/akenoowww/uya/releases/tag/v0.2.1
[0.2.0]: https://github.com/akenoowww/uya/releases/tag/v0.2.0
[0.1.0]: https://github.com/akenoowww/uya/releases/tag/v0.1.0
