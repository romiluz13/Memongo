# Debugging

Where to look when Memongo misbehaves, from cheapest signal to deepest.

## Health, readiness, and status endpoints

| Endpoint | Auth | Tells you |
|----------|------|-----------|
| `GET /health` | none | Process is up: `{ ok: true, service: "memongo-api" }` — liveness only |
| `GET /ready` | none | Deep readiness: 200 only when **all** required lanes (mongo, vector, embedding) are up; 503 otherwise. Payload is per-lane and sanitized so it cannot leak secrets (`apps/api/src/lib/readiness.ts`) |
| `GET /v1/status` | bearer | Manager status |
| `GET /v1/status/detailed` | bearer | Per-subsystem detail |
| `GET /v1/stats` | bearer | Memory counts |
| `GET /v1/probes/embedding` | bearer | Can the embedding provider actually embed? |
| `GET /v1/probes/vector` | bearer | Is the vector index present and queryable? |

Debug flow: `/health` (is it up?) → `/ready` (which lane is down?) → `/v1/probes/*` (is it Mongo or the provider?) → `/v1/status/detailed`.

## Logs

- Engine and API log through `createSubsystemLogger` (`packages/lib/src/logger.ts`); every line carries a subsystem prefix like `memory:mongodb:planner`, `memory:mongodb:capabilities`, or `memory:backend-config` — grep by subsystem to isolate a lane.
- Verbosity: `MEMONGO_LOG_LEVEL`, `MEMONGO_DEBUG`, `MEMONGO_DEBUG_EMBEDDINGS`.
- **Boot logs to read first:** the CORS policy line, the retrieval-lane capability table, and any `MEMONGO_REQUIRE_VECTOR` enforcement (`apps/api/src/server.ts`). The capability table shows which lanes (hybrid/vector/keyword/text) this deployment can actually serve *before* the first request.
- Logs are redacted through `packages/lib/src/redact.ts`; if you see `abcdef***wxyz`, that is the redactor, not corruption.

## Common errors

| Symptom | Meaning | Fix |
|---------|---------|-----|
| `401 AUTH_NOT_CONFIGURED` | No `MEMONGO_API_KEY` or scoped keys set | Set one, or `MEMONGO_ALLOW_INSECURE_NO_AUTH=1` for trusted local dev |
| `401 UNAUTHORIZED` | Bearer didn't match any configured credential | Check the key; comparison is constant-time so it is never a timing flake |
| `403 FORBIDDEN` (scoped key) | Policy rejected the request: missing/disallowed `agentId`/`scope`/`scopeRef`, admin-only route, or agent-global route with a scope-constrained key | Align the request identity with the key policy (`apps/api/src/app.ts`) |
| `400 INVALID_JSON` | Body failed to parse (non-empty) | Fix the payload; empty bodies are fine |
| `413 PAYLOAD_TOO_LARGE` | Over `MEMONGO_API_MAX_BODY_BYTES` (default 1 MB) | Split the batch (`/v1/write-events` caps at 500 events) or raise the limit |
| `429 RATE_LIMITED` | Over `MEMONGO_API_RATE_LIMIT` (default 600/60s) | Back off using `Retry-After`; raise the limit or disable with `0` for local dev |
| Boot exit: "missing MongoDB configuration" | `validateBootEnv` failed before binding the port | Set `MEMONGO_MONGODB_URI` |
| Boot exit under `MEMONGO_REQUIRE_VECTOR=1` | Vector lane unavailable or capability probe failed | Check `mongot` is healthy (`docker compose ps`), indexes reached READY |
| `SsrFBlockedError` | Outbound fetch hit a private/blocked host | Expected for metadata IPs and RFC-1918; opt in via `allowPrivateNetwork` policy only for legitimate private endpoints (`packages/lib/src/ssrf.ts`) |
| `Missing API key for provider "…"` | Provider key not in env | Set `<PROVIDER>_API_KEY` or `MEMONGO_<PROVIDER>_API_KEY` (`packages/lib/src/auth.ts`) |
| Search returns `$text`-only results | Vector/search indexes not READY | `/v1/probes/vector`; check `MEMONGO_STRICT_SEARCH_INDEX_READY` and index readiness timeouts |

## Container-level checks

```bash
docker compose -f docker/docker-compose.yml ps          # mongod + mongot health
docker logs memongo-preview                             # mongot/index build output
curl -s localhost:3847/ready | jq                       # per-lane readiness
```

The MongoDB image's own healthcheck (`/usr/local/bin/runner healthcheck`) verifies **both** mongod and mongot — a "healthy" container means search is up, not just the database.

## Test-level debugging

- E2E suites share one MongoDB deployment; run a single file with `bunx vitest run src/<file>.e2e.test.ts --no-file-parallelism` from `packages/memory-engine`.
- If tests *skip* rather than fail, suspect a blown hook budget — Vitest skips a file's tests when its `beforeAll` exceeds the timeout (`packages/memory-engine/vitest.config.ts` explains the budgets).
- Every error response carries a `requestId` (Hono `requestId` middleware is first on `/v1`), so client-side failures correlate to server logs.

## Related pages

- [Testing](testing.md)
- [Configuration](../reference/configuration.md) — every knob mentioned above
- [REST API](../api/index.md)
