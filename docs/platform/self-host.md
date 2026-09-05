# Self-host Memongo

Memongo is data-plane memory you run next to your agents. This runbook describes the supported Memongo deployment layout for managed Atlas cloud and the local Atlas Preview parity stack.

## Components

1. MongoDB via managed Atlas cloud or `mongodb/mongodb-atlas-local` (pinned dated tag in `docker/docker-compose.yml`).
2. `apps/api` - stateless HTTP service.
3. Optional: `apps/web` and `apps/mcp`.

## Configuration

- `MEMONGO_MONGODB_URI` - required for standalone API processes.
- `MEMONGO_API_KEY` - set in any untrusted network.
- `MEMONGO_API_SCOPED_KEYS` - optional JSON policy for narrower bearer tokens bound to explicit `agentId`, `scope`, and `scopeRef` values.
- `MEMONGO_API_PORT` / `MEMONGO_API_HOST` - bind address for `apps/api`.
- `VOYAGE_API_KEY` - required for auto-embed and hybrid retrieval quality. Use an Atlas Model key with the `al-...` prefix.

Connection budget defaults: all managers for the same MongoDB URI share one
client and therefore one bounded pool (`MEMONGO_MONGODB_MAX_POOL_SIZE`,
default 10), the manager cache is LRU-capped (`MEMONGO_MANAGER_CACHE_MAX`,
default 50) with idle eviction (`MEMONGO_MANAGER_CACHE_IDLE_TTL_MS`, default
10 minutes) in every mode, and the standing memory-job sweep runs every
`MEMONGO_JOB_SWEEP_MS` (default 30 s) — writes still drain immediately.
Agent count no longer multiplies connections: connections are fixed per URI,
and standing poll traffic is capped by the bounded manager cache (<=50
sweeps per 30 s). Deployments
that relied on per-manager client isolation must set
`MEMONGO_SHARED_CLIENT=0` to opt out; in that mode an idle agent
re-bootstraps its manager (and reconnects) after the idle TTL, and pool
options are honored per manager instead of per URI (first-resolved options
win for a shared URI).

Optional file config: `~/.memongo/memongo.json` or `MEMONGO_CONFIG_PATH`. See `apps/docs/guides/memory-config.mdx`.

## Cost observability and telemetry controls

Per-tenant provider spend is recorded in the `memory_cost_ledger` collection
(one document per agent, UTC day, and channel) and surfaced as trailing
30-day sums on `GET /v1/status/detailed` under `costLedger`. Ledger writes
are fire-and-forget — a failed ledger write can never fail a memory
operation — and rows expire 90 days after their last update. Convert the
counters (LLM tokens, embedding operations) to dollars with the table in
`docs/platform/cost-model.md`.

Operation telemetry (`memory_telemetry`) is a separate, higher-volume
channel and has two operator controls, both resolved per emit so they can be
flipped without a restart:

- `MEMONGO_TELEMETRY_ENABLED` - set to `false`, `0`, `off`, or `no` to
  hard-disable every telemetry write (kill switch for incidents where the
  telemetry path itself is implicated). Any other value, including unset,
  keeps telemetry on.
- `MEMONGO_TELEMETRY_SAMPLE_RATE` - fraction of telemetry documents to emit,
  `0` to `1` (default `1`). Window aggregates read as counts ×
  `1 / rate`. Invalid values fall back to full emission; the cost ledger is
  never sampled regardless of this setting.

> [!WARNING]
> MongoDB Automated Embedding is an upstream Preview feature that MongoDB says
> not to use in production. The current automated semantic-search path is for
> evaluation and controlled preview deployments.

## MongoDB runtimes

Managed Atlas cloud:

```bash
export MEMONGO_MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=memongo"
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
```

Atlas Local Preview:

```bash
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
docker compose -f docker/docker-compose.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
```

Use managed Atlas cloud for benchmark/control runs and Atlas Local Preview for local reproducibility.

## Running the API

```bash
cd /opt/memongo
bun install --frozen-lockfile
export MEMONGO_MONGODB_URI="mongodb://..."
export MEMONGO_API_KEY="your-secret-key"
export MEMONGO_API_HOST="0.0.0.0"
cd apps/api && bun run start
```

The API defaults to `127.0.0.1` (loopback only). To bind a non-loopback address you must also set `MEMONGO_API_KEY` (or `MEMONGO_API_SCOPED_KEYS`) so the server is authenticated. Without auth, the server refuses to start on a non-loopback bind to prevent unauthenticated network access to all memories.

If you have a trusted network and need no auth (e.g. behind a gateway), set both `MEMONGO_ALLOW_INSECURE_NO_AUTH=true` and `MEMONGO_ALLOW_INSECURE_REMOTE=true` to explicitly accept the risk.

Put TLS termination and your preferred ingress in front of `apps/api` when exposing it outside localhost.

## Docker

Inside a Docker container the app **must** bind `0.0.0.0` — binding `127.0.0.1` inside the container's network namespace makes it unreachable from outside, even with `-p` port publishing. The Dockerfile defaults to `MEMONGO_API_HOST=0.0.0.0` for this reason.

The security boundary in Docker is the **port publish** and the **auth layer**, not the app's bind address:

```bash
# Safe: host-only access + auth
docker run -p 127.0.0.1:3847:3847 \
  -e MEMONGO_MONGODB_URI="mongodb+srv://..." \
  -e MEMONGO_API_KEY="your-long-random-token" \
  memongo-api

# Public exposure: put a reverse proxy (Caddy/Nginx/Traefik) in front
# and let it handle TLS + rate limiting
```

The `docker/compose.yaml` already publishes to `127.0.0.1` on the host and requires `MEMONGO_API_KEY`. The guardrail enforces auth at startup: if `MEMONGO_API_KEY` is not set, the container refuses to start with a clear error message listing all remediation options.

## Scoped API keys

`MEMONGO_API_KEY` is the admin bearer token. For agent-facing integrations, prefer a scoped token so a valid client cannot freely choose another agent or memory namespace:

```bash
export MEMONGO_API_SCOPED_KEYS='[
  {
    "token": "agent-facing-secret",
    "agentIds": ["codex"],
    "scopes": ["workspace"],
    "scopeRefs": ["/opt/workspaces/memongo"]
  }
]'
```

Requests using a scoped token must send the matching `agentId`, `scope`, and `scopeRef` explicitly. Use `MEMONGO_API_KEY` only for admin operators, migrations, and trusted local development.

`MEMONGO_API_SCOPED_KEYS` is fail-closed: invalid JSON, an empty policy list, or a token without at least one constraint prevents the API from starting. This avoids accidentally exposing `/v1` routes because of a malformed scoped-key config.

## Health checks

- Liveness: `GET /health`
- OpenAPI: `GET /openapi.json`
- Memory status: `GET /v1/status`
- Contract proof: `bun run proof-pack`

## MCP

MCP is stdio; the host process spawns `apps/mcp` and sets `MEMONGO_API_URL` to your API base URL.
