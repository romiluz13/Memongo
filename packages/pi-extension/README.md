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

# Start MongoDB (Atlas Local Preview — includes mongod + mongot + Atlas Search + auto-embed)
docker compose -f docker/docker-compose.yml up -d

# Start the HTTP API
cd apps/api && bun run dev
```

Get a [Voyage AI API key](https://docs.voyageai.com/) (free tier, `al-...` prefix) and export it:
```bash
export VOYAGE_API_KEY="al-..."
```

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
export MEMONGO_AGENT_ID="pi-agent"
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
| `MEMONGO_AGENT_ID` | `pi-agent` | Agent identity for scoping |
| `VOYAGE_API_KEY` | _(none)_ | Required for vector/semantic search (Atlas Model API key) |

## Graceful degradation

If the Memongo API is down, all three tools return clean error messages instead of crashing. The agent is instructed to fall back to `memory_search` (local FTS5). Nothing breaks.

## License

Apache-2.0
