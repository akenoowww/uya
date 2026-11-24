<p align="center">
  <img src="docs/assets/uya-icon.png" alt="Uya" width="112" height="112" />
</p>

<h1 align="center">Uya</h1>

<p align="center">
  <strong>A local-first multi-agent AI workbench for macOS and Windows.</strong><br />
  Named after Kazakh <em>ұя</em> ("nest" / "cell") — one calm home where your CLI agents, local models, code editor, and terminals work side-by-side.
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> · <a href="README.kk.md">Қазақша</a>
</p>

<p align="center">
  <a href="https://github.com/akenoowww/uya/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/akenoowww/uya?style=flat-square&amp;color=b4a2ff" /></a>
  <a href="https://github.com/akenoowww/uya/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/akenoowww/uya/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-21232b?style=flat-square" />
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%2F11-21232b?style=flat-square" />
  <a href="LICENSE"><img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache%202.0-7dd1a4?style=flat-square" /></a>
</p>

---

## Overview

Uya lets you open a local project on **macOS** or **Windows 10/11**, send a single prompt to one or multiple CLI agents and local models in parallel splits, compare their answers side-by-side, inspect files in a built-in Monaco editor, and launch native interactive terminals without leaving the workbench.

- **Parallel Splits, Broadcast & Cross-Model Review**: Compare multiple agents or local models simultaneously with per-split **Model Effort** controls (`minimal`–`max`), then cross-review or synthesize completed broadcast responses with an arbiter model.
- **Smart Context & Project Rules**: Attach files, Git diffs, and terminal output via `@file`, `@git-diff`, `@git-staged`, and `@terminal` with a live context budget meter, plus automatic discovery of `AGENTS.md` / `CLAUDE.md` / `.uya/rules.md`.
- **Rule-Based & Fallback Routing**: Route prompts automatically by tag, context file extension, or minimum context size, or define ordered fallback chains.
- **Built-in Explorer, Git Diff & Monaco Editor**: Quick Open (`⌘P` / `Ctrl+P`), confined file/folder CRUD, read-only Git sidebar, side-by-side/inline Monaco **Diff / Apply** from AI code blocks, syntax-highlighted Markdown, and clickable `file:line` references.
- **History 2.0 & Usage Insights**: SQLite FTS5 full-text search across prompts and replies, thread Resume, Fork, Markdown export, Delete, and local TTFT / token / effort usage metrics.
- **Native Interactive Terminals**: Run interactive agent TUIs or a shell right inside any split via auto-starting native PTYs (macOS PTY / Windows ConPTY).
- **Prompt Library**: Version project prompts in Git (`<project>/.ai/prompts/`) and keep personal prompts globally (`~/.uya/prompts/`) with `{{variable}}` substitution and optional `effort` frontmatter.
- **Local-First Security**: Loopback-only Bun sidecar with per-session bearer authentication, workspace confinement, picker-approved Recent Projects, hardened read-only Git inspection, and sandboxed Structured runs for Custom CLI on macOS.

## Download & Install

Prebuilt desktop installers are published on [GitHub Releases](https://github.com/akenoowww/uya/releases/latest):

### macOS (13+)
1. Download the `.dmg` (or `.app.zip`) for your Mac from the [latest release](https://github.com/akenoowww/uya/releases/latest):
   - **Apple Silicon (M1 / M2 / M3 / M4)**: `Uya-<version>-macos-arm64.dmg`
   - **Intel Mac**: `Uya-<version>-macos-x64.dmg`
2. Open the `.dmg` and drag **Uya** into **Applications**.
3. If macOS Gatekeeper blocks the first launch, verify the download and follow [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445).

### Windows (10 / 11, 64-bit)
1. Download the installer from the [latest release](https://github.com/akenoowww/uya/releases/latest):
   - **Recommended (per-user, no admin required)**: `Uya-<version>-windows-x64-setup.exe`
   - **MSI package**: `Uya-<version>-windows-x64.msi`
2. Run the installer (WebView2 is included on Windows 11 and bootstrapped automatically on Windows 10 if needed).
3. If SmartScreen displays *"Windows protected your PC"*, verify the download before selecting **More info → Run anyway**.

### Verify Checksums (Optional)

Download `SHA256SUMS.txt` into the folder with your installer. On macOS, run:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

On Windows, compare the output with the matching line in `SHA256SUMS.txt`:

```powershell
Get-ChildItem Uya-*-windows-x64-setup.exe | Get-FileHash -Algorithm SHA256
```

### In-app updates

Signed desktop builds from GitHub Releases check for updates in the background. Select **Restart to Update** when the downloaded update is ready, or run **Check for Updates** from the command palette.

## Build from Source

Requires **Bun 1.3.14+**, **Node.js 20.19+** or **22.12+**, **stable Rust**, plus:
- **macOS 13+**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows 10/11**: Visual Studio Build Tools (C++ workload) and Microsoft Edge WebView2

```sh
git clone https://github.com/akenoowww/uya.git
cd uya
bun install --frozen-lockfile
bun run desktop:dev
```

Build standalone native installers (with the compiled `uya-core` Bun sidecar bundled inside):

```sh
bun run desktop:build
```

Tauri outputs `Uya.app` & `.dmg` on macOS, and NSIS `.exe` & `.msi` installers on Windows.

### Publish releases with updates

Configure a [Tauri update signing key pair](https://v2.tauri.app/plugin/updater/#signing-updates) in GitHub Actions. Put the public `.pub` file contents in the repository variable `TAURI_UPDATER_PUBLIC_KEY`. Set the repository secret `TAURI_SIGNING_PRIVATE_KEY` and, for a password-protected key, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep the same key pair across releases so installed copies can verify future updates.

Follow the [release process](CONTRIBUTING.md#publishing-a-release). The release workflow verifies the signed packages for both Mac architectures and both Windows installer types before publishing `latest.json` with the installers. Uya reads this manifest from the latest stable GitHub release.

## Quick Workflow

1. **Open a project**: Click **Open project** in the titlebar. Files open in separate editor tabs. Composer context is built from checked files in the Explorer plus the saved selection from the last active editor tab. Switching projects prompts for confirmation if unsaved drafts exist.
2. **Run in splits**: Pick a provider and model in each split. Activate a split for a single run, or use **Broadcast** to send one prompt to all open structured splits at once. Use **New conversation** to reset a split's thread, and **Run History** to inspect saved runs.
3. **Configure routing**: Choose **Rule-based** to match the first rule (by tag, file extension in context, or minimum context size), or **Fallback** to try backup providers in order.
4. **Launch terminals & custom CLIs**: Click the terminal icon inside a split and press **Start** to launch an interactive TUI or shell (defaults to your home directory when no project is open). Under **Providers → Custom CLI**, register, edit, or remove your own CLI commands. Authentication is handled by each CLI's own login flow.

## Supported Providers & Local Runtimes

| Source | Structured Run | Interactive Terminal (TUI) |
| --- | --- | --- |
| **Codex** | `exec --json` in read-only sandbox | Yes |
| **Claude Code** | `stream-json` with tools and project settings disabled | Yes |
| **Gemini API (`gemini-api`)** | Stateless Interactions API streaming (`generate --no-interactive -o json`) with live API model & thinking discovery | Yes (`gemini-api explore`) |
| **Qwen Code** | `stream-json` in `--safe-mode` with `0` tool calls | Yes |
| **OpenCode** | `run --format json --pure` with isolated config & CLI environment auth | Yes (including saved login & managed settings) |
| **Ollama** | Local HTTP streaming for installed weights | Yes (when `ollama` is installed) |
| **llama.cpp, MLX, LM Studio** | Local HTTP streaming from a compatible server with an available model | When CLI is installed |
| **Custom CLI** | macOS only, opt-in via **Enable Structured** (prompt via stdin, reply from stdout) | Yes (macOS and Windows) |
| **Kimi Code** | — | Yes |

On macOS, Structured mode for Custom CLI uses the deprecated `/usr/bin/sandbox-exec` to restrict filesystem reads and writes and block network access. Before enabling Structured mode, Uya checks that macOS can apply its sandbox profile to a test process. If that check fails, Custom CLI is available only in the interactive terminal. On Windows 10/11, Custom CLI runs only in the interactive terminal via ConPTY, with the current user's permissions and without a Uya sandbox.

Uya probes local runtimes strictly over `127.0.0.1`: **Ollama** on port `11434`, **llama.cpp** on `9931` and `8080`, **MLX** on `8080`, and **LM Studio** on `1234`. Remote CLI providers may send the current prompt, attached context, and prior conversation turns to their upstream service.

## Prompt Library

Store project templates in `<project>/.ai/prompts/` (easy to track in Git) and personal templates in `~/.uya/prompts/`. Clicking **Use prompt** substitutes variable values, and submitting records the source template revision.

```markdown
---
title: Code Review
providerId: codex
effort: high
mode: manual
variables:
  language: TypeScript
  focus:
---
Review this {{language}} code. Focus: {{focus}}.
```

`providerId`, `effort` (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), and `mode` (`manual`, `rule`, or `fallback`) are optional. Leaving a variable empty in YAML marks it as having no default value.

## Architecture & Security Boundaries

- **Loopback-Only Sidecar**: Tauri manages the local compiled Bun process (`uya-core`). The core binds exclusively to `127.0.0.1` on an ephemeral port and authenticates JSON-RPC and WebSocket calls using a per-session random token passed over IPC.
- **Structured CLI Runs**: Each run starts in a temporary working directory. Filesystem and network restrictions depend on the provider adapter and platform. Diagnostics classify incompatible flags, auth failures, network errors, and quota issues in memory from `stderr` and surface clean guidance.
- **Workspace Confinement**: The built-in editor confines file access to the selected project folder, blocks symlinks/hardlinks and sensitive config files, and checks file revisions on save — while allowing normal source files with names like `credentials.ts`.
- **SQLite History & Context Budget**: Run history is stored in SQLite with versioned migrations. Conversation continuation keeps the last 12 successful exchanges within 48 KiB; files and selections attach to the current turn. TTFT measures from the start of the responding attempt, while total duration includes fallback switches.
- **Per-Project Layout State**: Dockview layout and conversation IDs are stored in WebView storage and scoped per project, restoring each split's latest turns when reopening a folder.

## Verification

```sh
bun run check
bun run desktop:test
```

Individual checks:

```sh
bun run typecheck
bun test
bun run core:smoke
bun run core:loopback-smoke
bun run web:build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Smoke tests use synthetic CLI fixtures, local HTTP runtimes, and proxy checks and require loopback (`127.0.0.1`) access.

## License

Licensed under the [Apache License 2.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for contribution and security guidelines.
