# Changelog

All notable changes to **Uya** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.1]: https://github.com/akenoowww/uya/releases/tag/v0.2.1
[0.2.0]: https://github.com/akenoowww/uya/releases/tag/v0.2.0
[0.1.0]: https://github.com/akenoowww/uya/releases/tag/v0.1.0
