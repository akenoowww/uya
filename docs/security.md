# Security Model

Uya is engineered as a local-first workbench with explicit, auditable trust boundaries. See also [SECURITY.md](../SECURITY.md) for responsible disclosure instructions.

---

## 1. Localhost Sidecar & Transport Hardening

- **Loopback-only binding**: `uya-core` binds strictly to `127.0.0.1` on an ephemeral port (`port: 0`). It never listens on `0.0.0.0` or LAN interfaces.
- **Per-session authentication**: On startup, `uya-core` generates a cryptographic random bearer token passed once over stdout to the Tauri host. Every HTTP JSON-RPC (`POST /rpc`) and WebSocket (`GET /events`) request must present this token.
- **Origin & redirect protection**: Non-local `Origin` headers are rejected; internal local runtime probes enforce loopback-only targets without following cross-origin redirects or inheriting malicious proxy overrides.
- **Strict schema validation**: Every RPC payload passes through Zod schemas (`packages/core/src/validation.ts`) that strip unknown keys and return fixed, static error messages — never echoing untrusted input or internal stack traces.

---

## 2. Workspace Confinement & Protected Paths

All file reads, writes, directory listings, ripgrep searches, checkpoints, Git mutations, and Worktree Arena operations pass through Uya's confinement layer (`packages/core/src/workspace-files.ts`):

- **Path containment**: Relative paths are normalized and verified against the canonical workspace root. Path traversal (`..`), NUL bytes, and cross-directory escapes are rejected.
- **Symlink & hardlink refusal**: Symlinks and multi-link hardlinks that point outside the workspace — or to protected files — are refused across editor reads/writes, ripgrep/native search, checkpoints, and worktree seeding.
- **Protected file policy**: Sensitive configuration and credential files (`.env`, `.env.*`, `*.pem`, `*.key`, `.npmrc`, `.pypirc`, `.netrc`, cloud credential manifests, `.git/` internals) are excluded from search results, context attachments, Git staging/discarding, and Worktree Arena copying — while allowing normal source files such as `credentials.ts` or `auth.rs`.
- **Optimistic concurrency**: Editor saves (`workspace.write`) and multi-file patch applies validate the file's content revision hash so concurrent edits are never silently clobbered.

---

## 3. Agent Approval Gate & Reversible Checkpoints

- **Explicit mode separation**:
  - `isolated` runs inside an empty scratch directory with zero tools.
  - `read-only` (Explore) permits inspecting code while refusing file edits and shell commands.
  - `agent` unlocks edits with an **interactive approval queue** (`Allow once`, `Allow session`, `Deny`).
- **Fail-closed ACP permissions**: If an ACP agent requests a mutating or shell tool without an active approval handler — or if the run is cancelled while waiting for approval — Uya responds with cancellation/denial and tears down the session cleanly.
- **Automatic pre-run checkpoints**: Before an `agent` turn or a Worktree Arena workspace apply touches files, Uya records a reversible snapshot so you can undo an entire turn in one click (**Undo turn** or `/undo`).

---

## 4. Hardened Git & Verification Subprocesses

- **Hook & filter neutralization**: All internal Git commands run with `-c core.hooksPath=/dev/null`, `-c protocol.file.allow=never`, clean/smudge filters disabled, and commit signing disabled so opening or inspecting an untrusted repository cannot trigger arbitrary hook execution.
- **No `shell: true` with untrusted arguments**: Git, ripgrep, and CLI adapters spawn binaries directly with argument arrays and `--` option terminators.
- **Secret environment stripping**: Discovery probes, CLI runs, and the Verification Runner filter sensitive environment variables (`*_SECRET*`, `*_TOKEN*`, cloud credentials, etc.) while preserving required toolchain/CLI paths and user-authenticated CLI session directories.
- **Bounded outputs**: Verify runner output is capped at 128 KiB, tool output cards at 4 KiB, and workspace map context at 6 KiB to prevent memory exhaustion.

---

## 5. Desktop Shell Guarantees (Tauri / Rust)

- **Picker-approved workspaces**: Recent project paths are validated against canonical directories previously selected through the native OS folder picker.
- **Single-instance data lock**: Prevents concurrent sidecar processes from corrupting SQLite or worktree directories.
- **External URL validation**: Only `http://` and `https://` URLs with valid hosts and no ASCII control characters may be opened externally.
- **Signed updates**: Release builds verify cryptographic Tauri updater signatures and require user consent if active terminals are running before restarting.
