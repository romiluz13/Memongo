# Client

Active contributors: Rom Iluz

`@memongo/client` is the typed TypeScript HTTP client for `apps/api`'s `/v1/*` routes. `apps/mcp`, `packages/tools`, and external agent apps all talk to Memongo through this package's `MemongoClient` class rather than issuing raw `fetch` calls, so retry, timeout, auth, and error-envelope handling are consistent everywhere.

## Key source files

| File | Role |
| --- | --- |
| `packages/client/src/client.ts` | `MemongoClient` class, `MemongoClientError`, retry/timeout/auth plumbing, and the response types unique to typed client methods (`MemongoSearchDetailedResponse`, `MemongoStateResponse`, etc.). |
| `packages/client/src/types.ts` | Request/response shapes shared with the HTTP API contract (inputs, scopes, lifecycle handles, job/status/stats response types). |
| `packages/client/src/index.ts` | Public export surface: `MemongoClient`, `MemongoClientError`, and the type re-exports from both `client.ts` and `types.ts`. |
| `packages/client/src/version.ts` | `MEMONGO_CLIENT_VERSION`, sent as the `x-memongo-client-version` header; `scripts/check-publishability.ts` fails the release gate if it drifts from `packages/client/package.json`. |
| `packages/client/README.md` | Install and usage examples. |

## Construction and auth

```ts
new MemongoClient({ baseUrl, apiKey, maxRetries, timeoutMs, silent })
```

- `baseUrl` defaults to `MEMONGO_API_URL` env var, then `http://127.0.0.1:3847`.
- `apiKey` defaults to the `MEMONGO_API_KEY` env var; when present it's sent as `Authorization: Bearer <key>`.
- `maxRetries` (default 2) and `timeoutMs` (default 30,000) control retry count and per-request timeout via `AbortSignal.timeout`.
- `silent` (default false) makes search/read calls resolve to a benign empty result on any HTTP error, timeout, or network failure, instead of throwing — for callers like prompt middleware that would rather inject "no memory" than break the request. Writes never use this mode: a swallowed write failure would look like data that was never lost.

`readEnv` guards every `process.env` read because `process` is absent in browser/edge runtimes, so the client degrades to explicit options only rather than throwing there.

## Retry and error handling

- `apiFetch` retries on HTTP 429 and 503 up to `maxRetries` times, honoring a server `Retry-After` header (seconds or HTTP-date, per RFC 9110) capped at 10 seconds (`MAX_RETRY_DELAY_MS`) so a hostile or buggy server can't park the client for minutes; falls back to `200ms * attempt` local backoff otherwise.
- Any other non-OK response throws `MemongoClientError`, which parses the API's `{ error: { code, message } }` envelope (`parseErrorEnvelope`) and exposes `.status`, `.body`, `.code`, and `.apiMessage`, falling back gracefully for non-envelope bodies (plain text, proxies, older servers).
- `getRecallTrace` and `getJob` catch a 404 `MemongoClientError` and return `null` instead of throwing, honoring their `| null` return type — a 404 there means "absent," not an exceptional failure.
- Writes (`add`, `writeEvent`, `writeEvents`) generate a client-side idempotency key (`generateIdempotencyKey`, a UUIDv4 via `crypto.randomUUID` with a `Math.random` fallback for exotic runtimes) that stays stable across retries of the same logical call, sent as an `Idempotency-Key` header — the Stripe-style pattern lets the server dedup instead of double-writing on a retried POST.

## Key methods

| Method | Route | Notes |
| --- | --- | --- |
| `add(input)` | `POST /v1/add` | Legacy-style write; generates/reuses an idempotency key. |
| `search(input)` | `POST /v1/search` | Silent-mode default: `{ results: [] }`. |
| `searchDetailed(input)` | `POST /v1/search-detailed` | Agentic multi-pass search with plan/metadata; silent-mode default includes an empty `EMPTY_DETAILED_METADATA` shell. |
| `searchKB(input)` | `POST /v1/search-kb` | Knowledge-base search with tag/category/source filters and fusion method. |
| `recallConversation(input)` | `POST /v1/recall-conversation` | Silent-mode default: empty results with zeroed metadata. |
| `getLifecycleItem` / `updateLifecycleItem` / `deleteLifecycleItem` / `getLifecycleHistory` | `POST /v1/lifecycle/*` | Lifecycle CRUD keyed by a `MemongoStableHandle`. |
| `reportProcedureOutcome(input)` | `POST /v1/procedures/outcome` | Records a procedure success/failure. |
| `applyMemoryFeedback(input)` | `POST /v1/memory/feedback` | Confirm/correct/irrelevant feedback signal; only sends `patch`/`invalidatedBy` for the matching signal. |
| `readFile(input)` | `POST /v1/read-file` | Silent-mode default: empty text. |
| `writeEvent(input)` | `POST /v1/write-event` | Single conversation event write with idempotency key. |
| `writeEvents(input)` | `POST /v1/write-events` | Bulk write; per-item idempotency keys, per-item receipts (`MemongoWriteEventReceipt`) so one failed item doesn't fail the batch. |
| `writeStructured(input)` / `writeProcedure(input)` | `POST /v1/write-structured`, `/v1/write-procedure` | Upsert structured facts/procedures. |
| `extract(input)` | `POST /v1/extract` | Schedules background extraction from an event. |
| `profile(input)` | `POST /v1/profile` | Synthesized agent profile. |
| `hydrateActiveSlate(input)` | `POST /v1/hydrate-active-slate` | Active-slate hydration for session start. |
| `state(input)` | `GET /v1/state` | Combined profile + blocks + context bundle. |
| `buildDiscoveryProjection(input)` | `POST /v1/discovery-projection` | Entity-brief / topic-brief / what-changed / contradiction-report projections. |
| `buildContextBundle(input)` | `POST /v1/context-bundle` | Silent-mode default via `emptyContextBundle` (`rendered: ""` injects nothing). `mode: "wake-up"` returns a compact ~250-token projection. |
| `status(agentId)` / `getDetailedStatus(agentId)` / `stats(agentId)` | `GET /v1/status`, `/v1/status/detailed`, `/v1/stats` | Health, detailed lane health, and storage stats. |
| `sync(input)` | `POST /v1/sync` | Manual source sync trigger. |
| `probeEmbedding(agentId)` / `probeVector(agentId)` | `GET /v1/probes/*` | Capability probes. |
| `relevanceExplain` / `relevanceReport` / `relevanceSampleRate` | `POST/GET /v1/admin/relevance/*` | Retrieval-quality observability. |
| `importConversations(input)` | `POST /v1/import/conversations` | Bulk conversation dataset import. |
| `accessTrends(input)` / `accessSummaries(input)` | `GET /v1/admin/access-trends`, `/v1/admin/access-summaries` | Access-pattern analytics. |
| `listRecallTraces(input)` / `getRecallTrace(input)` | `GET /v1/admin/traces*` | Recall-trace observability; `getRecallTrace` returns `null` on 404. |
| `listJobs(input)` / `getJob(input)` | `GET /v1/jobs*` | Background job queue reads; `getJob` returns `null` on 404. |
| `traceChain(input)` | `POST /v1/chain-trace` | Reasoning-chain traversal. |
| `scanNovelty(input)` | `POST /v1/novelty-scan` | Surprisal novelty detection. |
| `consolidate(input)` | `POST /v1/consolidate` | Triggers the consolidation agent. |
| `selfEdit(input)` | `POST /v1/self-edit` | Edits a self-context block (user/persona/instructions). |

`MemongoClientError` and every request/response type above are exported from `packages/client/src/index.ts`; the full type catalog (`MemongoSearchInput`, `MemongoStableHandle`, `MemongoStatusResponse`, etc.) is defined in `packages/client/src/types.ts` — see [Reference: data models](../reference/data-models.md) for the complete catalog.

## Integration points

- `apps/mcp`'s stdio MCP server calls the HTTP API exclusively through `MemongoClient` — see `apps/mcp/index.md`.
- `packages/tools`' AI SDK tool helpers wrap `MemongoClient` methods as typed tools — see [`@memongo/tools`](../packages/tools.md).
- External agent apps and integrations install `@memongo/client` directly (`npm install @memongo/client`) to call `apps/api` without depending on the engine or bridge.
- `apps/api/index.md` documents the server side of every route this client calls.
