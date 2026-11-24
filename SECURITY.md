# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| [Latest stable release](https://github.com/akenoowww/uya/releases/latest) | Yes |
| `0.1.x` | Yes |

## Security Architecture Summary

Uya is designed as a local-first desktop workbench with explicit boundaries:
- The Tauri desktop shell manages the local Bun sidecar (`uya-core`), which binds strictly to `127.0.0.1` on an ephemeral port and requires a per-session random bearer token for JSON-RPC and WebSocket requests.
- Structured CLI runs execute in temporary directories with tool calls disabled or restricted (`sandbox-exec` on macOS for Custom CLI structured mode).
- The built-in file explorer and editor confine reads/writes to the user-selected workspace directory, exclude symlinks/hardlinks outside the workspace, block sensitive config files (such as `.env.local` and credential manifests), and verify file revisions on save.
- Local model runtimes (Ollama, llama.cpp, MLX, LM Studio) are probed strictly on `127.0.0.1`.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report suspected vulnerabilities privately via [GitHub Security Advisories](https://github.com/akenoowww/uya/security/advisories/new) (**Security → Advisories → Report a vulnerability**). Include:
- Affected Uya version, operating system version, and architecture
- Clear reproduction steps or proof of concept
- Impact assessment and any suggested remediation

We will acknowledge receipt and work with you on a coordinated fix and disclosure.
