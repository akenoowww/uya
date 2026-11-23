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
  <a href="https://github.com/akenoowww/uya/releases/latest"><img alt="Release v0.1.0" src="https://img.shields.io/badge/release-v0.1.0-b4a2ff?style=flat-square" /></a>
  <a href="https://github.com/akenoowww/uya/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/akenoowww/uya/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-21232b?style=flat-square" />
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%2F11-21232b?style=flat-square" />
  <a href="LICENSE"><img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache%202.0-7dd1a4?style=flat-square" /></a>
</p>

---

## Overview

In **v0.1.0**, Uya lets you open a local project on **macOS** or **Windows 10/11**, send a single prompt to one or multiple CLI agents and local models in parallel splits, compare their answers side-by-side, inspect files in a built-in Monaco editor, and launch native interactive terminals without leaving the workbench.

- **Parallel Splits & Broadcast**: Compare multiple agents or local models simultaneously, with independent conversation threads per split and **Run History**.
- **Rule-Based & Fallback Routing**: Route prompts automatically by tag, context file extension, or minimum context size, or define ordered fallback chains.
- **Built-in Project Explorer & Monaco Editor**: Open files in tabs, attach selected files and active editor selections as prompt context, and get unsaved-draft warnings when switching projects.
- **Native Interactive Terminals**: Run interactive agent TUIs or a shell right inside any split via native PTYs (macOS PTY / Windows ConPTY).
- **Prompt Library**: Version project prompts in Git (`<project>/.ai/prompts/`) and keep personal prompts globally (`~/.uya/prompts/`) with `{{variable}}` substitution.
- **Local-First Security**: Loopback-only Bun sidecar with per-session bearer authentication, workspace confinement, and isolated structured CLI runs.

## Download & Install

Prebuilt desktop installers are published on [GitHub Releases](https://github.com/akenoowww/uya/releases/latest):

### macOS (13+)
1. Download the `.dmg` (or `.app.zip`) for your Mac from [Releases → v0.1.0](https://github.com/akenoowww/uya/releases/tag/v0.1.0):
   - **Apple Silicon (M1 / M2 / M3 / M4)**: `Uya-0.1.0-macos-arm64.dmg`
   - **Intel Mac**: `Uya-0.1.0-macos-x64.dmg`
2. Open the `.dmg` and drag **Uya** into **Applications**.
3. If macOS Gatekeeper blocks the first launch, verify the download and follow [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445).

### Windows (10 / 11, 64-bit)
1. Download the installer from [Releases → v0.1.0](https://github.com/akenoowww/uya/releases/tag/v0.1.0):
   - **Recommended (per-user, no admin required)**: `Uya-0.1.0-windows-x64-setup.exe`
   - **MSI package**: `Uya-0.1.0-windows-x64.msi`
2. Run the installer (WebView2 is included on Windows 11 and bootstrapped automatically on Windows 10 if needed).
3. The installers are unsigned. If SmartScreen displays *"Windows protected your PC"*, verify the download before selecting **More info → Run anyway**.

### Verify Checksums (Optional)

Download `SHA256SUMS.txt` into the folder with your installer. On macOS, run:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

On Windows, compare the output with the matching line in `SHA256SUMS.txt`:

```powershell
Get-FileHash .\Uya-0.1.0-windows-x64-setup.exe -Algorithm SHA256
```

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
| **Gemini CLI** | `stream-json` with tools disabled (managed system settings via PTY) | Yes |
| **Qwen Code** | `stream-json` in `--safe-mode` with `0` tool calls | Yes |
| **OpenCode** | `run --format json --pure` with isolated config & CLI environment auth | Yes (including saved login & managed settings) |
| **Ollama** | Local HTTP streaming for installed weights | Yes (when `ollama` is installed) |
| **llama.cpp, MLX, LM Studio** | Local HTTP streaming from a compatible server with an available model | When CLI is installed |
| **Custom CLI** | Opt-in via **Enable Structured** (prompt via stdin, reply from stdout) | Yes |
| **Kimi Code** | — | Yes |

Uya probes local runtimes strictly over `127.0.0.1`: **Ollama** on port `11434`, **llama.cpp** on `9931` and `8080`, **MLX** on `8080`, and **LM Studio** on `1234`. Structured mode for Custom CLI restricts filesystem reads, writes, and network access with macOS `sandbox-exec`. Note that remote CLI providers may send the current prompt, attached context, and prior conversation turns to their upstream service.

## Prompt Library

Store project templates in `<project>/.ai/prompts/` (easy to track in Git) and personal templates in `~/.uya/prompts/`. Clicking **Use prompt** substitutes variable values, and submitting records the source template revision.

```markdown
---
title: Code Review
providerId: codex
mode: manual
variables:
  language: TypeScript
  focus:
---
Review this {{language}} code. Focus: {{focus}}.
```

`providerId` and `mode` are optional (`manual`, `rule`, or `fallback`). Leaving a variable empty in YAML marks it as having no default value.

## Architecture & Security Boundaries

- **Loopback-Only Sidecar**: Tauri manages the local compiled Bun process (`uya-core`). The core binds exclusively to `127.0.0.1` on an ephemeral port and authenticates JSON-RPC and WebSocket calls using a per-session random token passed over IPC.
- **Isolated Structured Runs**: Structured CLI executions run in temporary directories. Diagnostics classify incompatible flags, auth failures, network errors, and quota issues in memory from `stderr` and surface clean guidance.
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

## Roadmap

- **v0.1.0 (Current)**: Multi-split workbench, CLI & local runtime orchestration, Monaco editor, native PTY terminals, routing/fallback, Prompt Library, SQLite history.
- **v0.2**: Worktree / Diff / Apply, Eval Matrix, Compare / Judge, conversation branching.
- **v0.3**: MCP & Skill Studio, Plugin SDK, pipeline graphs.

## License

Licensed under the [Apache License 2.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for contribution and security guidelines.
