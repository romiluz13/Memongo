# @memongo/pi-extension

Memongo durable memory for the [Pi coding agent](https://pi.dev).

**Additive** — sits alongside `pi-hermes-memory` (local SQLite FTS5) and exposes Memongo's hybrid vector + full-text + graph retrieval as new tools. Does **not** replace any existing Pi memory tool.

## Tools

| Tool | Purpose |
|------|---------|
| `memongo_search` | Semantic / cross-project / cross-session search over durable memory (hybrid vector + text + graph) |
| `memongo_save` | Persist a durable structured fact / decision / preference / instruction to Memongo |
| `memongo_status` | Probe Memongo API health + vector search availability |
| `/memongo` | Slash command — quick status check |

## Quick start

### 1. Run Memongo locally

```bash
cd /Users/rom.iluz/Dev/memongo

# Optional automated semantic search (Preview; Atlas Model API key):
export VOYAGE_API_KEY="al-..."

# Start MongoDB (Atlas Local Preview — includes mongod + mongot + Atlas Search + auto-embed)
docker compose -f docker/docker-compose.yml up -d

# Start the HTTP API
cd apps/api && bun run dev
```

`VOYAGE_API_KEY` must be a MongoDB Atlas Model API key with the `al-...`
prefix, not a direct Voyage `pa-...` key. MongoDB Automated Embedding is an
upstream Preview feature that MongoDB says not to use in production.

### 2. Wire into Pi

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/Users/rom.iluz/Dev/memongo/packages/pi-extension"
  ]
}
```

Set env vars (in shell or `.envrc`):
```bash
export MEMONGO_API_URL="http://127.0.0.1:3847"
export MEMONGO_API_KEY="local-dev-secret"
# optional: MEMONGO_AGENT_ID defaults to "pi" in this extension
```

### 3. Reload and verify

```
/reload
/memongo
```

You should see `Memongo @ http://127.0.0.1:3847` with vector status. Then try:
- `memongo_status` — confirms API + vector search are live
- `memongo_search` with a query — semantic recall across projects
- `memongo_save` — persist a durable fact

## Architecture

```
Pi Agent
  ├── pi-hermes-memory (local FTS5)       ← stays
  ├── pi-observational-memory             ← stays
  └── @memongo/pi-extension (this)        ← additive
        └── @memongo/client → HTTP API (port 3847) → MongoDB (Docker)
```

## Config

| Env var | Default | Purpose |
|---------|---------|---------|
| `MEMONGO_API_URL` | `http://127.0.0.1:3847` | Memongo HTTP API base URL |
| `MEMONGO_API_KEY` | _(none)_ | Bearer token (optional for local dev) |
| `MEMONGO_AGENT_ID` | `pi` | Agent identity for scoping |
| `MEMONGO_PI_AUTO_CAPTURE` | `0` (off) | Opt in to automatic capture of your turns (see below) |
| `MEMONGO_PI_SESSION_INJECTION` | `1` (on) | Inject recalled memory at session start |
| `MEMONGO_PI_MEMORY_SCOPE` | `agent` | Memory scope for capture and recall |
| `VOYAGE_API_KEY` | _(none)_ | Required for vector/semantic search (Atlas Model API key) |

Each surface has its own agentId default — `pi` here, `main` for the API
bridge and web console — so Pi's memory stays a separate tenant from other
surfaces by default. Set `MEMONGO_AGENT_ID` to share identity across
surfaces; the web console's agent field views any agent regardless.

## Data boundary (auto-capture)

Auto-capture (turn text sent to Memongo without an explicit tool call) is
**off by default**. At registration the extension prints one notice stating
this boundary. Opting in with `MEMONGO_PI_AUTO_CAPTURE=1` sends, per turn:

- the **raw text** of your user prompts and the agent's assistant replies —
  no redaction, no filtering
- the session id, agent id, and resolved memory scope

Tool calls, tool results, images, and thinking blocks are not captured.
Captured text is stored as canonical events and embedded for semantic
recall; secrets redaction applies to logs and diagnostics, not stored
content — treat anything captured as retained data subject to your
retention/erasure settings. Explicit saves via `memongo_save` are unaffected
by this switch.

## Graceful degradation

If the Memongo API is down, all three tools return clean error messages instead of crashing. The agent is instructed to fall back to `memory_search` (local FTS5). Nothing breaks.

## License

Apache-2.0
