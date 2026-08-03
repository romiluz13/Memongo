# REST API

The Memongo HTTP API is a Hono app serving **44 endpoints** under `/v1`, plus three unauthenticated utility routes (`/health`, `/ready`, `/openapi.json`). Every route is registered in `apps/api/src/routes/v1.ts` (~2,515 LOC) and delegates to the stable bridge facade (`@memongo/memory-bridge`) — route handlers never touch the engine directly.

This page is the endpoint map. For the middleware stack (auth, rate limiting, CORS, body limits), see [API app](../apps/api/index.md); for auth mechanics, see [Security](../security.md).

## Endpoint groups

### Search and retrieval

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/search` | POST | Hybrid semantic search (`apps/api/src/routes/v1.ts:936`) |
| `/v1/search-kb` | POST | Knowledge-base search (`v1.ts:962`) |
| `/v1/search-detailed` | POST | Search with scores/provenance (`v1.ts:1352`) |
| `/v1/recall-conversation` | POST | Exact past messages with citations (`v1.ts:1005`) |
| `/v1/context-bundle` | POST | Answer-ready context bundle, incl. wake-up mode (`v1.ts:1529`) |
| `/v1/hydrate-active-slate` | POST | Rebuild the active working slate (`v1.ts:1470`) |
| `/v1/discovery-projection` | POST | Discovery projection build (`v1.ts:1489`) |
| `/v1/chain-trace` | POST | Recall chain tracing (`v1.ts:2410`) |
| `/v1/profile` | POST | Agent profile (`v1.ts:1979`) |
| `/v1/read-file` | POST | Server-side file read (admin-only for scoped keys, `v1.ts:1594`) |

### Write and import

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/add` | POST | Quick add (`v1.ts:1613`) |
| `/v1/write-event` | POST | Write one conversation event (`v1.ts:1652`) |
| `/v1/write-events` | POST | Batch write, capped at 500 events (`v1.ts:1735`) |
| `/v1/extract` | POST | Extract structured memories from an event (`v1.ts:1913`) |
| `/v1/write-structured` | POST | Typed type+key fact (`v1.ts:1937`) |
| `/v1/write-procedure` | POST | Procedural memory (`v1.ts:1958`) |
| `/v1/import/conversations` | POST | Bulk conversation import (admin-only, `v1.ts:1050`) |

### Lifecycle

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/lifecycle/get` | POST | Fetch one memory item (`v1.ts:1083`) |
| `/v1/lifecycle/update` | POST | Update with revision semantics (`v1.ts:1109`) |
| `/v1/lifecycle/delete` | POST | Delete (`v1.ts:1147`) |
| `/v1/lifecycle/history` | POST | Revision history (`v1.ts:1186`) |
| `/v1/procedures/outcome` | POST | Report procedure outcome (`v1.ts:1225`) |
| `/v1/memory/feedback` | POST | Apply memory feedback (`v1.ts:1271`) |
| `/v1/self-edit` | POST | Agent-identity self-edit (`v1.ts:2469`) |
| `/v1/sync` | POST | Sync (`v1.ts:2053`) |

### Consolidation

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/novelty-scan` | POST | Novelty detection (`v1.ts:2434`) |
| `/v1/consolidate` | POST | Run the Dreamer pipeline (`v1.ts:2449`) |

### Status and stats

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/state` | GET | Unified state (`v1.ts:2007`) |
| `/v1/status` | GET | Status (`v1.ts:2023`) |
| `/v1/status/detailed` | GET | Detailed status (`v1.ts:2033`) |
| `/v1/stats` | GET | Stats (`v1.ts:2043`) |

### Probes

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/probes/embedding` | GET | Embedding lane probe (`v1.ts:2067`) |
| `/v1/probes/vector` | GET | Vector index probe (`v1.ts:2077`) |

### Jobs

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/jobs` | GET | List durable memory jobs (`v1.ts:2359`) |
| `/v1/jobs/:jobId` | GET | Job detail (`v1.ts:2391`) |

### Admin

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/admin/relevance/explain` | POST | Explain a relevance decision (`v1.ts:2087`) |
| `/v1/admin/relevance/benchmark` | POST | Run relevance benchmark (`v1.ts:2118`) |
| `/v1/admin/relevance/report` | GET | Relevance report (`v1.ts:2239`) |
| `/v1/admin/relevance/sample-rate` | GET | Telemetry sample rate (`v1.ts:2254`) |
| `/v1/admin/benchmarks/ingest` | POST | Ingest benchmark results (`v1.ts:2208`) |
| `/v1/admin/access-trends` | GET | Access trends (`v1.ts:2264`) |
| `/v1/admin/access-summaries` | GET | Access summaries (`v1.ts:2293`) |
| `/v1/admin/traces` | GET | List recall traces (`v1.ts:2326`) |
| `/v1/admin/traces/:traceId` | GET | Trace detail (`v1.ts:2340`) |

## Cross-cutting behavior

- **Body parsing once.** A v1 middleware pre-parses every non-GET JSON body; malformed JSON is a 400 `INVALID_JSON` from the middleware, never a 500 (`apps/api/src/routes/v1.ts:77-114`).
- **List caps.** `MAX_LIST_LIMIT = 100`, `MAX_HISTORY_LIMIT = 200`, `MAX_WRITE_EVENTS_BATCH = 500` (`v1.ts:69-74`).
- **Identity resolution.** `agentId`/`scope`/`scopeRef` are resolved through `apps/api/src/scope-identity.ts`, the *same* module the auth layer uses, so authorization and partition selection cannot diverge (issue #57).
- **Machine-readable contract.** The full spec is served at `/openapi.json` from `apps/api/src/openapi-spec.ts` (~3,016 LOC), and `apps/api/src/contract-conformance.test.ts` keeps routes conformant with `MEMONGO_API_ROUTES` in `packages/lib/src/contract.ts:144`.

```mermaid
graph TD
    REQ[Request] --> MW[requestId → rate limit → body limit → auth]
    MW --> V1[/v1 router]
    V1 --> BRIDGE[memongoBridge* functions]
    BRIDGE --> ENGINE[memory-engine]
    V1 --> ERR[typed error envelope\nerror.code + request id]
```

## Related pages

- [API app](../apps/api/index.md) — middleware, scoped keys, graceful shutdown
- [MCP server](../apps/mcp.md) — the tool layer over these endpoints
- [Security](../security.md) — authentication and hardening
- [Debugging](../how-to-contribute/debugging.md) — health/readiness/probe endpoints in practice
