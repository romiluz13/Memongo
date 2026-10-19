# Self-host Memongo

Memongo is data-plane memory you run next to your agents. This runbook describes the supported Memongo deployment layout for managed Atlas cloud and the local Atlas Preview parity stack.

## Components

1. MongoDB via managed Atlas cloud or `mongodb/mongodb-atlas-local:preview@sha256:ff75fd47e918952cc91094e888e8aeb7529aeb70f987b075aeef3944c9bd8014` (the digest pin in `docker/docker-compose.yml`; boot requires MongoDB 8.3 or later).
2. `apps/api` - stateless HTTP service.
3. Optional: `apps/web` and `apps/mcp`.

## Deployment contract

M2 is an intentional breaking change. Memongo serves retrieval only from a deployment that can run all of it, and refuses to start otherwise. There is no compatibility mode, and it never serves weaker retrieval while indexes build.

| Requirement | Boot failure code |
|---|---|
| The server is reachable | `server-unreachable` |
| MongoDB 8.3 or later | `server-version-unsupported`, `server-version-unreadable` |
| Search index management (managed Atlas, or the Atlas Local preview image with mongot) | `search-management-unavailable` |
| Search index management privileges for the connecting user, read through `connectionStatus` | `search-privileges-denied` |
| Automated Embedding (autoEmbed) on every vector index, with an Atlas Model key in `VOYAGE_API_KEY` | `autoembed-unavailable` |
| A replica set, because writes run in transactions | A write fails with `TransactionUnsupportedError` (`TRANSACTION_UNSUPPORTED`) |
| Every index of the required-index manifest for the selected profile is READY, queryable and serving its manifest definition within one deadline (180 s by default; `MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS` sets it) | `index-absent`, `index-not-ready`, `index-failed`, `index-stale`, `index-type-mismatch`, `index-definition-rejected`, `index-metadata-unknown`, `boot-deadline-exceeded` |
| A configuration with no removed key | `config-removed`, `config-invalid`, `rerank-unsupported` |

Boot creates or updates Search indexes and waits for them. It never drops a Search index. When a requirement is unmet, the process exits with a typed `MemongoBootError`; `apps/api` does not bind. No URI, host, database name or secret appears in the diagnostics.

The capability table, with the index each retrieval lane needs and what it does when that index is unhealthy, is in [capability-matrix.md](capability-matrix.md#retrieval-capabilities).

### Preflight

Run preflight before replacing a binary or changing a deployment. It reports every unmet requirement for the configured deployment, writes nothing and starts no server:

```bash
bun run --filter @memongo/api preflight
```

The report is JSON on stdout. The exit code is 0 when boot would pass as is and 1 otherwise, with one entry per unmet requirement (one per failed collection for index listings). Run it with the same environment as the service.

`GET /ready` is the readiness probe. On each call it checks MongoDB, the vector index, the embedding provider and the same manifest, and it answers 503 with a `lanes` object that names each unmet manifest index. `GET /health` is liveness only.

### First boot after an upgrade

The first M2 boot updates changed Search index definitions in place and creates new ones: `procedures_text`, `entity_autocomplete`, `episode_autocomplete` and `structured_mem_text` change, and `structured_mem_revisions_text` is new. Each update rebuilds that index. Boot waits up to the readiness deadline and fails with `index-not-ready` while one is still building; the build continues on the server, so start the service again. The connecting user needs the privilege to update Search indexes, or boot fails with `search-privileges-denied`. The full list of behavior changes is in [BEHAVIOR-CHANGES.md](../../BEHAVIOR-CHANGES.md).

### Local Atlas preview image

Local runs and CI use `mongodb/mongodb-atlas-local:preview@sha256:ff75fd47e918952cc91094e888e8aeb7529aeb70f987b075aeef3944c9bd8014`. The digest is the pin in `docker/docker-compose.yml`, `.github/workflows/ci.yml` and the nightly workflow. The `preview` tag moves, so a floating tag is not a supported way to run Memongo. Change the digest in all three places together.

### Rolling back to the prior binary

Rollback is a binary swap. Stop the M2 binary and start the prior one against the same database:

1. Stop the M2 API and its workers. M2 holds no state outside MongoDB.
2. Start the prior binary with its own configuration. Remove nothing from MongoDB first.
3. Expect the prior binary to behave as it did before M2, including its weaker retrieval paths when an index is missing.

M2 boot creates Search indexes and updates their definitions. It drops no Search index and no collection, so there is no data step to reverse. Search indexes M2 created stay in place. An index whose definition M2 updated keeps the M2 definition until the prior binary's own boot rewrites it. No rolling upgrade is claimed: do not run M2 and the prior binary against one database at the same time.

## Configuration

- `MEMONGO_MONGODB_URI` - required for standalone API processes.
- `MEMONGO_API_KEY` - set in any untrusted network.
- `MEMONGO_API_SCOPED_KEYS` - optional JSON policy for narrower bearer tokens bound to explicit `agentId`, `scope`, and `scopeRef` values.
- `MEMONGO_API_PORT` / `MEMONGO_API_HOST` - bind address for `apps/api`.
- `VOYAGE_API_KEY` - required, because every vector index uses Automated Embedding. Use an Atlas Model key with the `al-...` prefix.

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

Memongo's automated semantic-search path uses MongoDB Automated Embedding,
currently labeled [Preview by MongoDB](https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/).
Boot refuses a deployment that does not support it (`autoembed-unavailable`). Verify the upstream requirements for the deployment you use.

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

## Migrating retained diagnostics to ordinary collections

Older Memongo versions created `memory_telemetry` and `access_events` as
time-series collections. Current versions write ordinary collections with a
TTL index on `ts`; startup leaves existing time-series collections untouched,
so retained history keeps working but stays on the old layout. The offline
converter moves that history during a maintenance window. Stop application
writes and external DDL for the target database until conversion finishes:

```bash
export MEMONGO_MONGODB_URI="mongodb://..."
bun scripts/migrate-diagnostics-to-ordinary.ts --state /tmp/migrate-state.json
```

- Default mode is a dry run: it reports what it would do, mutates nothing,
  and writes no state file. Add `--apply` to convert, `--abort` to clean up.
- The tool requires MongoDB 9 or newer with FCV 9 or newer. This is a minimum
  gate, not certification of untested future releases; namespace, digest, UUID,
  and command checks still fail safely if the server does not support the
  required behavior. The tested baseline is MongoDB 9.0.0-rc0 with FCV 9.
- Each surface is copied into a `...__ordinary_candidate` collection under a
  snapshot session, verified against a pinned digest of the source, then
  installed by renaming over the source. The state file records every step,
  so an interrupted `--apply` reconciles the observed namespaces before it
  resumes or safely restarts an incomplete copy.
- Time-series `_id` values are not unique (duplicates and missing values
  occur). The conversion assigns fresh unique `_id` values and preserves
  every other field byte-for-byte; the digest check proves payload equality
  before the install step.
- Canonical retention is 7 days for telemetry and 30 days for access events
  (the values the engine enforces at startup). If a source carries a
  different TTL, the run stops with the source unchanged; pass
  `--accept-retention-change` to adopt the canonical value.
- `--abort` drops only candidate collections whose UUID matches the state
  file. Once a surface is installed, abort refuses: the rename already
  removed the time-series source, and the ordinary collection is the data.

`MEMONGO_MONGODB_DATABASE` (default `memongo`) and
`MEMONGO_MONGODB_COLLECTION_PREFIX` (default `memongo_`) select the target
names and must match the values the deployment uses.

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
