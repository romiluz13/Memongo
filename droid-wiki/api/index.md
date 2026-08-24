# API

This is the wire-level reference for callers of the Memongo HTTP API: what endpoints exist, how to authenticate, and what shapes to send and expect. For how the API app is built internally (middleware order, router composition, file layout), see [API app](../apps/api/index.md) and [Routes and middleware](../apps/api/routes-and-middleware.md).

The API is a Hono server (`apps/api/src/app.ts`) that listens on port 3847 by default and exposes everything under `/v1/*`, plus three unauthenticated infrastructure routes.

## Authentication

Every `/v1/*` route requires a bearer token unless `MEMONGO_ALLOW_INSECURE_NO_AUTH` is set for local development:

```bash
curl -s http://127.0.0.1:3847/v1/search \
  -H "content-type: application/json" \
  -H "authorization: Bearer $MEMONGO_API_KEY" \
  -d '{"query":"..."}'
```

Two credential shapes are accepted, checked with a constant-time comparison (`timingSafeBearerEquals` in `apps/api/src/app.ts`):

- **`MEMONGO_API_KEY`** — a single admin token with full access to every route, including agent-global routes (status, stats, jobs, admin analytics, self-edit) that have no tenant scope to restrict.
- **`MEMONGO_API_SCOPED_KEYS`** — a JSON policy list binding individual tokens to explicit `agentId` / `scope` / `scopeRef` constraints. A scoped key is rejected from agent-global routes and from server-file routes (`/v1/read-file`, `/v1/import/conversations`) because there is no tenant boundary on those to enforce.

The full scope model (`session|user|agent|workspace|tenant|global`, `scopeRef`, how a request's identity is resolved) is covered in [Multi-tenancy and scopes](../features/multi-tenancy-and-scopes.md) — this page only covers the wire contract.

Requests to `/v1/*` with no valid bearer get `401 UNAUTHORIZED`; if neither `MEMONGO_API_KEY` nor `MEMONGO_API_SCOPED_KEYS` nor the insecure flag is set, every `/v1/*` request gets `401 AUTH_NOT_CONFIGURED`.

## Discovering the full contract

`GET /openapi.json` serves a generated OpenAPI 3.0 document (`apps/api/src/openapi-spec.ts`) covering every route below with full request/response schemas. It is built from per-family path fragments (`openapi-paths-search.ts`, `openapi-paths-write.ts`, etc.) and shared schema fragments in `apps/api/src/openapi-schemas.ts`, and is kept honest against the live router by `apps/api/src/contract-conformance.test.ts` — that test fails CI if a route exists in the router but not in the documented contract, or vice versa. Point any OpenAPI-aware client generator or explorer at this URL.

## Infrastructure routes (unauthenticated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness — always `{ok:true,service:"memongo-api"}` if the process is up. |
| GET | `/ready` | Readiness — 200 only once MongoDB, vector search, and the embedding path all check out; 503 otherwise. Use this for orchestrator health checks, not `/health`. |
| GET | `/openapi.json` | The full OpenAPI document described above. |

## Route table

All `/v1` routes below require the bearer described above. Routes marked **admin-only** reject scoped API keys outright.

### Write (`apps/api/src/routes/v1-write-routes.ts`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/add` | Add a memory (freeform content), the primary write path used by most agents. |
| POST | `/v1/write-event` | Write a single typed conversation turn (`role`, `body`, timestamps). |
| POST | `/v1/write-events` | Bulk-write conversation turns; per-item validation failures become per-item receipts, never a batch-level 4xx. |
| POST | `/v1/extract` | Trigger structured-fact extraction from a previously written event. |
| POST | `/v1/write-structured` | Upsert a structured memory entry (key/value fact with lifecycle state). |
| POST | `/v1/write-procedure` | Upsert a procedural memory entry (a named, reusable procedure). |

### Search (`apps/api/src/routes/v1-search-routes.ts`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/search` | Primary semantic/hybrid search over an agent's memory. |
| POST | `/v1/search-kb` | Search the knowledge base collection, with optional tag/category/source filter and fusion method. |
| POST | `/v1/recall-conversation` | Time- and role-filtered recall of raw conversation history. |
| POST | `/v1/import/conversations` | **Admin-only.** Bulk-import a conversation dataset from a server-local path. |
| POST | `/v1/search-detailed` | Full-control search: recipe/recall-profile tuning, per-source scoping (structured/reference/procedural), plan return. |

### Context (`apps/api/src/routes/v1-context-routes.ts`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/hydrate-active-slate` | Build the "active slate" — the working set of currently-relevant memories for a session. |
| POST | `/v1/discovery-projection` | Build a discovery view (`entity-brief`, `topic-brief`, `what-changed`, `contradiction-report`). |
| POST | `/v1/context-bundle` | Compose a token-budgeted context bundle (active slate + evidence + discovery projection) for injection into an agent prompt. |
| POST | `/v1/read-file` | **Admin-only.** Read a slice of a server-local file by relative path. |

### Lifecycle (`apps/api/src/routes/v1-lifecycle-routes.ts`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/lifecycle/get` | Fetch a structured or procedure memory by its stable handle. |
| POST | `/v1/lifecycle/update` | Patch a structured or procedure memory in place. |
| POST | `/v1/lifecycle/delete` | Invalidate (soft-delete) a memory, recording `invalidatedBy`. |
| POST | `/v1/lifecycle/history` | Fetch the bitemporal validity history of a memory. |
| POST | `/v1/procedures/outcome` | Report a success/failure outcome for a procedure, feeding its reliability score. |
| POST | `/v1/memory/feedback` | Apply a `confirm`/`correct`/`irrelevant` feedback signal to a structured memory. |

Every lifecycle route resolves the handle's owning identity and rejects a mismatched caller with `403 FORBIDDEN` — a scoped key cannot reach a handle outside its authorized scope even if it knows the handle string.

### Admin (`apps/api/src/routes/v1-admin-routes.ts`) — all agent-global, admin-key only

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/admin/relevance/explain` | Explain why a query would or would not surface a given result set. |
| GET | `/v1/admin/relevance/report` | Aggregate relevance-sampling report for an agent (or all agents). |
| GET | `/v1/admin/relevance/sample-rate` | Current relevance-sampling rate. |
| GET | `/v1/admin/access-trends` | Access-frequency trend series for a set of memory ids. |
| GET | `/v1/admin/access-summaries` | Access-count summaries for a set of memory ids. |
| GET | `/v1/admin/traces` | List recorded recall traces. |
| GET | `/v1/admin/traces/:traceId` | Fetch one recall trace by id. |
| GET | `/v1/jobs` | List background memory jobs (consolidation, extraction, import, materialization, enrichment), filterable by status/type. |
| GET | `/v1/jobs/:jobId` | Fetch one background job by id. |

### Maintenance (`apps/api/src/routes/v1-maintenance-routes.ts`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chain-trace` | Trace the provenance chain of a fact back through its supporting events. |
| POST | `/v1/novelty-scan` | Scan recent writes for novel (not-yet-consolidated) content. |
| POST | `/v1/consolidate` | Run consolidation — dedup, contradiction resolution, and (optionally) LLM-assisted merge — over an agent's memory. |
| POST | `/v1/self-edit` | **Agent-global.** Edit an agent's own persona/instructions/user block; rejected with `422 SELF_EDIT_REJECTED` if the content fails the prompt-injection screen (see [Security](../security.md)). |

### Status (`apps/api/src/routes/v1-status-routes.ts`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/profile` | Build a profile summary (entities, episodes, recent activity) for a scope. |
| GET | `/v1/state` | Current state snapshot for a scope. |
| GET | `/v1/status` | **Agent-global.** Overall service status; echoes `version` (the release version, for client/server skew detection against `x-memongo-client-version`). |
| GET | `/v1/status/detailed` | **Agent-global.** Deeper status breakdown (per-lane readiness detail). |
| GET | `/v1/stats` | **Agent-global.** Memory volume statistics. |
| POST | `/v1/sync` | **Agent-global.** Force a sync/reindex pass. |
| GET | `/v1/probes/embedding` | **Agent-global.** Probe the configured embedding path end-to-end. |
| GET | `/v1/probes/vector` | **Agent-global.** Probe that Atlas Vector Search is reachable and returning results. |

## Example: add and search

From the root `README.md`:

```bash
curl -s http://127.0.0.1:3847/health

curl -s http://127.0.0.1:3847/v1/add \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-dev-secret" \
  -d '{"content":"The user prefers TypeScript and concise release notes.","sessionId":"demo-user"}'

curl -s http://127.0.0.1:3847/v1/search \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-dev-secret" \
  -d '{"query":"What does the user prefer?","sessionKey":"demo-user","maxResults":5}'
```

`/v1/add` responds:

```json
{ "ok": true, "eventId": "...", "chunkCreated": true }
```

`/v1/search` responds:

```json
{ "results": [ /* scored memory hits */ ] }
```

Semantic search returns `{"results":[]}` until `VOYAGE_API_KEY` is configured — embeddings are required to match stored memories by meaning.

## Error envelope

Every error response, from validation failures through unhandled exceptions, uses one shape (`apps/api/src/lib/errors.ts`):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "content is required" } }
```

Common codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` / `AUTH_NOT_CONFIGURED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `IDEMPOTENCY_CONFLICT` / `SELF_EDIT_REJECTED` (422), `RATE_LIMITED` (429), `PAYLOAD_TOO_LARGE` (413), `SERVICE_UNAVAILABLE` (503, MongoDB unreachable), and a generic `INTERNAL` (500) for anything unexpected — unexpected errors never leak raw driver messages, hostnames, or stack traces to the client; those go to the server log keyed by the request id that the message references.

See [Routes and middleware](../apps/api/routes-and-middleware.md) for how the router composes this behavior, and [Security](../security.md) for the auth, rate-limit, and body-size mechanics that sit in front of every route.
