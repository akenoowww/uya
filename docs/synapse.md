# Uya Synapse — Symbiotic Multi-Model Orchestration & Open Capability Hub

**Uya Synapse** makes every coding agent inside Uya aware of the workbench it lives in, the peer splits running beside it, which installed models excel at each domain, and which external multimodal or MCP capabilities the user has enabled — without losing warm CLI/ACP prompt caches or relaxing Uya's security boundaries.

---

## 1. Universal Ephemeral `uya` MCP Server

When a structured run starts in **Explore** (`read-only`) or **Agent** (`agent`) mode, Uya registers a run-scoped session in `SynapseBroker` (authenticated by a 32-byte random `X-Uya-Mcp-Token` stored in a `0600` scratch file, never on the command line) and attaches the built-in `uya-core --mcp-stdio` bridge natively to:

- **Codex** (`-c mcp_servers.uya...`)
- **Claude Code** (`--strict-mcp-config --mcp-config uya-claude-mcp.json`)
- **Antigravity (`agy`)** (ACP `session/new` `mcpServers` with atomic per-turn bridge rotation preserving warm pooled sessions)
- **Gemini CLI** (`settings.json` `mcpServers` + TOML policy rule)
- **OpenCode** (`OPENCODE_CONFIG_CONTENT` `mcp.uya`)

Stateless providers and local HTTP models (`Ollama`, `llama.cpp`, `MLX`, `LM Studio`, `Gemini API`, `Qwen Code`) receive a compact structured `uya-action` fallback contract executed through the exact same `SynapseBroker` policy and call budget.

> **Strict isolation invariant**: `Isolated` mode never injects MCP servers into any CLI subprocess.

### Exposed `uya_*` Tools

| Tool | Purpose | Safety & Recursion Policy |
| --- | --- | --- |
| `uya_get_workbench` | Inspect active workspace, open peer splits (`@alias`, model, busy state), domain specialist rankings, verify presets, and enabled capabilities | Read-only; never exposes secret values |
| `uya_open_file` | Open a confined workspace-relative file in Uya's Monaco editor (optional 1-based line) | Path-confined; live runs only |
| `uya_run_verify` | Execute the workspace verification preset (or an approved custom command) and record empirical pass/fail telemetry | Custom commands require inline user approval |
| `uya_consult_specialist` | Synchronously ask the highest-rated installed specialist for `code`, `webdev`, `text`, `vision`, or `search` without breaking the caller's warm session | Root turns only (`depth === 0`); child runs in `read-only` / `isolated` |
| `uya_red_team` | Spawn up to 3 independent reviewers in parallel across Security, Edge-Case, and Architecture lenses | Root turns only (`depth === 0`); `read-only` / `isolated` |
| `uya_propose_mission` | Propose a multi-step **Mission** (`agent`, `capability`, and `verify` steps) rendered as an interactive Gatekeeper card in the transcript | Never auto-executes; waits for explicit user approval |
| `uya_use_capability` | Invoke an enabled multimodal or external pack (`elevenlabs-tts`, `suno-music`, `fal-image`, `openai-speech`, custom REST, or custom MCP) | Requires inline approval when `requiresApproval: true` |

Each run is capped at `MAX_CALLS_PER_RUN = 8` and `MAX_SYNAPSE_DEPTH = 2`.

---

## 2. Living Capability Matrix (`arena.ai` Elo + Local Empirical Telemetry)

Open **Synapse → Living Capability Matrix** (`/matrix` or `⌘K` → `Uya Synapse: Living Capability Matrix`) to inspect how Uya ranks your installed models across `code`, `webdev`, `text`, `vision`, and `search`:

1. **Public Arena Elo**: Ships with an offline seed of current `arena.ai` ratings and syncs on demand (`Sync Arena Leaderboard`) against upstream community Arena datasets over HTTPS with strict size and deadline bounds.
2. **Local Workspace Evidence**: Tracks per-model `verify` pass rates, **Worktree Arena** winner selections (`arena.apply`), TTFT latency, and token cache-hit ratios in SQLite.
3. **Cache-Aware Routing**: Applies a warm-session bonus (`28` composite points) so an agent only hands off to another model when the specialist has a decisive capability advantage — preventing context-switch tax.
4. **Manual Domain Pins**: Pin your preferred provider and model for any domain (`Auto` or explicit model override).

---

## 3. Tech Lead Gatekeeper Missions & Split Forwarding

- **Proposed Missions (`/mission`)**: When a lead agent calls `uya_propose_mission`, Uya renders a `<MissionCard>` directly in the chat transcript. You can swap the assigned provider or reasoning effort on any step before clicking **Approve & Execute Mission**.
- **Shared `WorkspaceTurnLock`**: Standalone `Agent` turns and `MissionCoordinator` agent steps share a canonicalized, symlink-aware FIFO workspace writer lock so two agents never edit your working tree concurrently.
- **One-Click Reply Forwarding**: Click **Forward** on any completed response in a split to bounce its output directly to another open split (or a newly opened split) with provenance (`From @codex-1 · forward`).

---

## 4. Open Capability Hub & `0600` Secret Vault

Open **Synapse → Capability Hub & Vault** (`/capabilities` or `/vault`) to connect multimodal APIs and custom tools once for every agent in Uya:

- **Owner-Only Secret Vault**: API keys (`ELEVENLABS_API_KEY`, `SUNO_API_KEY`, `SUNO_BASE_URL`, `FAL_KEY`, `OPENAI_API_KEY`, or custom `UPPER_SNAKE_CASE` keys) are stored in `<dataDir>/capability-secrets.json` with `0600` permissions (`O_NOFOLLOW` + single-link verification). Secrets are never passed into CLI environments, prompts, or error messages, and any accidental echo in text output is automatically redacted.
- **Built-in Multimodal Packs**:
  - **ElevenLabs Voiceover** (`elevenlabs-tts`) — saves `.mp3` speech into `assets/audio/` and renders an inline `<audio>` player card.
  - **Suno Music Generator** (`suno-music`) — generates vocal or instrumental tracks via your configured Suno endpoint.
  - **fal.ai FLUX Image** (`fal-image`) — generates images into `assets/images/` with click-to-zoom preview and `Attach @file`.
  - **OpenAI Speech TTS** (`openai-speech`) — generates speech audio with configurable voice and model.
- **Custom REST & MCP Packs**: Add global custom REST endpoints (including async job polling) or external `mcp-stdio` / `mcp-http` servers, or commit team-shared `.uya/capabilities/*.json` definitions (project-scoped packs always enforce `requiresApproval: true` and block private/localhost SSRF targets).
