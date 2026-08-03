# Cross-Package Harmony — Deep Review Findings

Contract chain reviewed end to end:
`apps/api/src/routes/v1.ts` (43 routes) + `apps/api/src/app.ts` (auth/rate-limit) + `apps/api/src/openapi-spec.ts` (42 documented paths)
↔ `packages/client/src/client.ts` (43 methods) + `packages/client/src/types.ts`
↔ `apps/mcp/src/server.ts` (49 tool registrations, all dispatching through `MemongoClient`)
↔ `packages/tools/src/index.ts` (28 AI SDK tools) + `packages/tools/src/vercel/index.ts` + `packages/tools/src/openai/index.ts` (raw-fetch middleware)
↔ `packages/memory-bridge/src/memongo-bridge.ts` (46 exported functions)
↔ `packages/memory-engine/src/types.ts` (`MemorySearchManager` interface) + `packages/memory-engine/src/mongodb-manager.ts` (concrete).

## Route-by-route coverage matrix

| # | API route (apps/api/src/routes/v1.ts) | Client method (packages/client/src/client.ts) | MCP tool(s) (apps/mcp/src/server.ts) | AI SDK tool (packages/tools/src/index.ts) |
|---|---|---|---|---|
| 1 | POST /v1/search (:819) | `search` (:463) | `memongo_search` | `memongo_search` |
| 2 | POST /v1/search-kb (:846) | `searchKB` (:528) | `memongo_search_kb` | `memongo_search_kb` |
| 3 | POST /v1/recall-conversation (:878) | `recallConversation` (:544) | `memongo_recall_conversation` + alias `memongo_recall_messages` | `memongo_recall_conversation` |
| 4 | POST /v1/import/conversations (:923) | `importConversations` (:873) | `memongo_import_conversations` + alias `memongo_import_conversation_history` | `memongo_import_conversations` |
| 5 | POST /v1/lifecycle/get (:953) | `getLifecycleItem` (:561) | `memongo_lifecycle_get` + alias `memongo_memory_get` | `memongo_lifecycle_get` |
| 6 | POST /v1/lifecycle/update (:980) | `updateLifecycleItem` (:569) | `memongo_lifecycle_update` + alias `memongo_memory_update` | `memongo_lifecycle_update` |
| 7 | POST /v1/lifecycle/delete (:1019) | `deleteLifecycleItem` (:578) | `memongo_lifecycle_delete` + alias `memongo_memory_delete` | `memongo_lifecycle_delete` |
| 8 | POST /v1/lifecycle/history (:1059) | `getLifecycleHistory` (:587) | `memongo_lifecycle_history` + alias `memongo_memory_history` | `memongo_lifecycle_history` |
| 9 | POST /v1/procedures/outcome (:1099) | `reportProcedureOutcome` (:596) | `memongo_procedure_outcome` | `memongo_procedure_outcome` |
| 10 | POST /v1/memory/feedback (:1146) | `applyMemoryFeedback` (:607) | `memongo_memory_feedback` | `memongo_memory_feedback` |
| 11 | POST /v1/search-detailed (:1228) | `searchDetailed` (:480) | `memongo_search_detailed` | — MISSING |
| 12 | POST /v1/hydrate-active-slate (:1347) | `hydrateActiveSlate` (:711) | `memongo_hydrate_active_slate` | — MISSING |
| 13 | POST /v1/discovery-projection (:1367) | `buildDiscoveryProjection` (:734) | `memongo_discovery_projection` | — MISSING |
| 14 | POST /v1/context-bundle (:1408) | `buildContextBundle` (:748) | `memongo_build_context_bundle` | `memongo_build_context_bundle` |
| 15 | POST /v1/read-file (:1474) | `readFile` (:622) | `memongo_read_file` | `memongo_read_file` |
| 16 | POST /v1/add (:1494) | `add` (:451) | `memongo_add` | `memongo_add` |
| 17 | POST /v1/write-event (:1530) | `writeEvent` (:636) | `memongo_write_event` | `memongo_write_event` |
| 18 | POST /v1/extract (:1607) | `extract` (:682) | — MISSING | — MISSING |
| 19 | POST /v1/write-structured (:1631) | `writeStructured` (:662) | `memongo_write_structured` | — MISSING |
| 20 | POST /v1/write-procedure (:1651) | `writeProcedure` (:672) | `memongo_write_procedure` | — MISSING |
| 21 | POST /v1/profile (:1671) | `profile` (:689) | `memongo_profile` | `memongo_profile` |
| 22 | GET /v1/state (:1700) | `state` (:722) | `memongo_state_unified` (renamed) | `memongo_state_unified` |
| 23 | GET /v1/status (:1717) | `status` (:769) | `memongo_status` | `memongo_status` |
| 24 | GET /v1/status/detailed (:1728) | `getDetailedStatus` (:773) | `memongo_status_detailed` | — MISSING |
| 25 | GET /v1/stats (:1739) | `stats` (:779) | `memongo_stats` | — MISSING |
| 26 | POST /v1/sync (:1750) | `sync` (:783) | `memongo_sync` | — MISSING |
| 27 | GET /v1/probes/embedding (:1765) | `probeEmbedding` (:795) | `memongo_probe_embedding` | — MISSING |
| 28 | GET /v1/probes/vector (:1776) | `probeVector` (:801) | `memongo_probe_vector` | — MISSING |
| 29 | POST /v1/admin/relevance/explain (:1787) | `relevanceExplain` (:805) | `memongo_relevance_explain` | — MISSING |
| 30 | POST /v1/admin/relevance/benchmark (:1819) | `relevanceBenchmark` (:825) | `memongo_relevance_benchmark` | — MISSING |
| 31 | POST /v1/admin/benchmarks/ingest (:1906) | `benchmarkIngest` (:857) | `memongo_benchmark_ingest` | `memongo_benchmark_ingest` |
| 32 | GET /v1/admin/relevance/report (:1934) | `relevanceReport` (:885) | `memongo_relevance_report` | — MISSING |
| 33 | GET /v1/admin/relevance/sample-rate (:1950) | `relevanceSampleRate` (:895) | `memongo_relevance_sample_rate` | — MISSING |
| 34 | GET /v1/admin/access-trends (:1961) | `accessTrends` (:901) | `memongo_admin_access_trends` | `memongo_admin_access_trends` |
| 35 | GET /v1/admin/access-summaries (:1991) | `accessSummaries` (:925) | `memongo_admin_access_summaries` | `memongo_admin_access_summaries` |
| 36 | GET /v1/admin/traces (:2025) | `listRecallTraces` (:947) | `memongo_admin_list_traces` | `memongo_admin_list_traces` |
| 37 | GET /v1/admin/traces/:traceId (:2040) | `getRecallTrace` (:957) | `memongo_admin_get_trace` | `memongo_admin_get_trace` |
| 38 | GET /v1/jobs (:2060) | `listJobs` (:967) | `memongo_list_jobs` | `memongo_list_jobs` |
| 39 | GET /v1/jobs/:jobId (:2093) | `getJob` (:983) | `memongo_get_job` | `memongo_get_job` |
| 40 | POST /v1/chain-trace (:2113) | `traceChain` (:993) | `memongo_chain_trace` | `memongo_chain_trace` |
| 41 | POST /v1/novelty-scan (:2138) | `scanNovelty` (:1004) | `memongo_novelty_scan` | `memongo_novelty_scan` |
| 42 | POST /v1/consolidate (:2154) | `consolidate` (:1014) | `memongo_consolidate` | `memongo_consolidate` |
| 43 | POST /v1/self-edit (:2175) | `selfEdit` (:1026) | `memongo_self_edit` | `memongo_self_edit` |

Totals: client 43/43 routes; MCP 42/43 (missing only `/v1/extract`; 6 tools are pure aliases); tools package 28/43 (15 routes unwrapped). No client method calls a nonexistent route; no MCP tool fetches a URL directly (all dispatch through `MemongoClient` methods, which all hit real routes).

Bridge-only capability not routed anywhere: `memongoBridgeWaitForBenchmarkSearchReadiness` (`packages/memory-bridge/src/memongo-bridge.ts:391`) — no `/v1` route calls it (internal benchmark use only; acceptable but it is an engine capability invisible to every remote surface).

## Findings

- [SEV: high] scope/scopeRef silently dropped by the client on search, add, searchDetailed, searchKB, recall, scanNovelty, extract
  - Where: `packages/client/src/client.ts:463-477` (`search` builds body without `scope`/`scopeRef`), `:451-460` (`add`), `:480-527` (`searchDetailed` input type has no `scope`/`scopeRef` at all), `:528-542` (`searchKB` sends no `scopeRef`), `:544-560` (`recallConversation`), `:1004-1013` (`scanNovelty` sends `scope` but not `scopeRef`), `:682-687` (`extract`). Type declarations confirm the omission: `packages/client/src/types.ts:8-27` (`MemongoAddInput`, `MemongoSearchInput` have no `scope`/`scopeRef`), `:52-63` (`MemongoConversationRecallInput`), `:300-304` (`MemongoScanNoveltyInput`).
  - What: the API routes read scope/scopeRef for every one of these operations (`apps/api/src/routes/v1.ts:830-836`, `:1507-1513`, `:1274-1279`, etc.) and the bridge forwards them, but the client — the single choke point for MCP and AI-SDK-tools traffic — drops them. `packages/tools/src/index.ts:17-26` even advertises `scope`/`scopeRef` in `searchSchema` and `addSchema` and passes the whole input to `client.search`/`client.add`, where the fields evaporate with no error.
  - Why it matters: tenant isolation is requested by the agent and silently not applied — reads search the wrong scope (engine default `agent`, `packages/memory-engine/src/mongodb-manager.ts:2475`) and writes land in the default scope while the caller believes they scoped them. Worst case: `POST /v1/search-kb` with a scoped API key REQUIRES a scopeRef in the request (`apps/api/src/app.ts:260-264` `routePolicyError` + `authorizeScopedApiKey`), so scoped keys are guaranteed a 403 through the client SDK. Real-world proof of the break: `packages/pi-extension/extensions/index.ts:185-198` bypasses the client with a raw `fetch` to `/v1/search-detailed` with an explicit comment "The client SDK's searchDetailed doesn't accept scope, so call the API directly."
  - Recommendation: add `scope`/`scopeRef` to `MemongoSearchInput`, `MemongoAddInput`, the `searchDetailed` input, `searchKB` input, `MemongoConversationRecallInput`, `MemongoScanNoveltyInput`, `MemongoExtractInput`, and forward them in every corresponding `apiPost` body; fail loudly (throw) if a caller passes a field the client cannot serialize rather than dropping it.

- [SEV: high] No canonical error contract past the API boundary — client stringifies, MCP double-encodes
  - Where: API emits one clean shape `{ error: { code, message } }` everywhere (`apps/api/src/lib/errors.ts:10-17`, plus 401/403/413/429 in `apps/api/src/app.ts:106-111,124-128,335-342`). Client throws `MemongoClientError(status, rawText)` without parsing it (`packages/client/src/client.ts:64-75,131-136`). MCP catch-all wraps the resulting message string into another JSON envelope (`apps/mcp/src/server.ts:2088-2091` `jsonResult({ error: message }, true)`).
  - What: an agent calling `memongo_search` against a failing API receives `{"error": "Memongo API 500: {\"error\":{\"code\":\"SEARCH_FAILED\",\"message\":\"...\"}}"}` — the canonical `code` is buried inside a stringified JSON substring of a string field.
  - Why it matters: three layers define errors and none consume the layer below's contract; no consumer can branch on `code` (`RATE_LIMITED`, `VALIDATION_ERROR`, `SELF_EDIT_REJECTED`...) without regex-parsing a message. The API's deliberate per-route error taxonomy (`VALIDATION_ERROR`, `EVENT_NOT_FOUND`, `SELF_EDIT_REJECTED` 422 at `apps/api/src/routes/v1.ts:2209-2212`) is wasted.
  - Recommendation: parse the `{error:{code,message}}` body in `apiFetch` and expose `code`/`apiMessage` on `MemongoClientError`; have the MCP catch emit `{ error: { code, message } }` (same shape as the API) instead of a flat string.

- [SEV: medium] OpenAPI spec drift: one route missing, several schemas narrower than the implementation, no auth documented
  - Where: `apps/api/src/openapi-spec.ts` — `/v1/self-edit` route (`apps/api/src/routes/v1.ts:2175`) has NO spec entry (42 spec paths vs 43 routes); `/v1/add` spec (:2018-2047) omits `scope`, `scopeRef`, `metadata`; `/v1/search-kb` spec (:1991-2010) omits `agentId`, `scopeRef`, `filter`, `q`, `maxResults`; `/v1/extract` spec (:2101-2120) omits `scope`/`scopeRef`; `/v1/novelty-scan` (:2722) and `/v1/consolidate` (:2751) omit `scopeRef`. The `ApiError` component (:2787) is defined but never `$ref`erenced by any response — error responses are undocumented throughout. No `components.securitySchemes` / `security` exists, so the Bearer contract (`apps/api/src/app.ts:388-404`) is invisible to generated clients.
  - Why it matters: the spec header says "Keep this aligned with the supported route contract" (:2) but it isn't; anyone generating a client from `/openapi.json` gets a wrong picture on exactly the fields (scope/scopeRef) that are already being dropped by the hand-written client (compounds finding 1).
  - Recommendation: add the `/v1/self-edit` path, the missing body fields, a `bearerAuth` security scheme applied to `/v1/*`, and reference `ApiError` on 400/401/403/404/413/422/429/500 responses.

- [SEV: medium] Client retry contract contradicts the API: retries a status the API never sends, ignores the Retry-After the API does send, no timeout at all
  - Where: `packages/client/src/client.ts:93-95` retries only 429/503 with `sleep(200 * attempt)` (:97-99, :124-129). The API never emits 503 (grep of `apps/api/src` finds no 503/SERVICE_UNAVAILABLE) — manager-init failure surfaces as route-specific 500s (`apps/api/src/routes/v1.ts:838-841` etc.). The API's 429 carries an explicit `Retry-After` header (`apps/api/src/app.ts:106-111`) which the client ignores, retrying 200ms later inside a fixed 60-second window (`DEFAULT_RATE_WINDOW_MS`, `apps/api/src/app.ts:15`). `apiFetch` has no `AbortSignal`/timeout support (`packages/client/src/client.ts:106-136`).
  - Why it matters: lifecycle behavior is incoherent — the one retry that can fire (429) almost always fails again (fixed window barely advances in 400ms), the retryable failure mode that matters (bridge/manager down) returns 500 and is never retried, and every MCP/tool call can hang forever on a stalled connection. The MCP server adds no timeout of its own (`apps/mcp/src/server.ts:9-12`).
  - Recommendation: honor `Retry-After` (capped), map bridge-init failures to 503 `SERVICE_UNAVAILABLE` in the API so the existing client retry means something, and add a default request timeout with caller-overridable AbortSignal.

- [SEV: medium] Engine public interface is stale vs the concrete manager; the bridge compensates with ad-hoc casts
  - Where: `packages/memory-engine/src/types.ts:703-710` — `MemorySearchManager.searchKB` opts lack `scopeRef`, but the concrete manager accepts it (`packages/memory-engine/src/mongodb-manager.ts:6368-6375`) and the HTTP auth layer can REQUIRE it (`apps/api/src/app.ts:260-264`). Same for `extractEvent` — interface `types.ts:666-668` lacks `scope`/`scopeRef`, concrete accepts them (`mongodb-manager.ts:9104-9108`). The bridge works around this with six hand-rolled `*CapableManager` intersection casts (`packages/memory-bridge/src/memongo-bridge.ts:167-321`) and re-declares engine response shapes structurally (`MemongoBridgeActiveSlate` etc. `:47-165`) — a third copy alongside engine types and client types (`packages/client/src/client.ts:169-447`, using `string` where engine/bridge use `Date`).
  - Why it matters: the canonical public contract of the engine lies about its capabilities; every layer re-declares the same domain objects (ActiveSlate, DiscoveryProjection, ContextBundle, trust block) structurally, so a field added in the engine silently narrows at the bridge and client instead of flowing. New consumers coding against `MemorySearchManager` will not discover `scopeRef` on `searchKB` and will reintroduce the tenant-isolation bug the concrete class already fixed.
  - Recommendation: update `MemorySearchManager` to match the concrete signatures and collapse the `*CapableManager` casts; make the bridge re-export engine types instead of re-declaring them, and generate/derive client response types from one source.

- [SEV: medium] MCP tool surface: 6 duplicate alias tools + missing `memongo_extract` + inconsistent result envelopes
  - Where: aliases registered as separate tools — `memongo_memory_get/update/delete/history` (`apps/mcp/src/server.ts:402,439,481,523`), `memongo_recall_messages` (:329), `memongo_import_conversation_history` (:754) — all dispatch to the same handlers as their primary names (:21-42). No `memongo_extract` tool exists (grep "extract" in server.ts finds only jobType strings), leaving `POST /v1/extract` unreachable from MCP. Response envelopes are inconsistent: lifecycle/recall/import handlers return `jsonResult(...)` with `structuredContent` (:122-135) while ~30 other handlers return bare `{ content: [...] }`.
  - Why it matters: 49 tools where 43 would do — alias duplication costs every agent prompt tokens and forces a meaningless choice between identically-described tools; the missing extract tool makes the write→extract pipeline (write-event returns `chunkCreated`, extract schedules the job) impossible to complete from MCP.
  - Recommendation: drop the aliases (or hide behind an env flag), add `memongo_extract`, and standardize on `jsonResult` for all handlers.

- [SEV: medium] `MemongoClientError` null-return type lies on 404 routes
  - Where: `packages/client/src/client.ts:957-965` `getRecallTrace` and `:983-991` `getJob` are typed `Promise<... | null>`, but `apiFetch` throws on any non-OK status (:131-136) and the API returns 404 for missing traces/jobs (`apps/api/src/routes/v1.ts:2049-2052, 2102-2105`). The `| null` branch is unreachable.
  - Why it matters: callers write `if (trace === null)` guards that never run; a missing job crashes the call path with an exception instead.
  - Recommendation: either catch 404 in these two methods and return null, or change the API to 200-with-null; align type and behavior.

- [SEV: low] Three independent HTTP clients for the same API inside the repo
  - Where: `MemongoClient` (`packages/client/src/client.ts:106`), raw `fetch` in the Vercel middleware (`packages/tools/src/vercel/index.ts:100-115,129-141`) and OpenAI middleware (`packages/tools/src/openai/index.ts:49,70`), raw `fetch` in pi-extension (`packages/pi-extension/extensions/index.ts:189`).
  - What: middleware duplicates the context-bundle/write-event calls with no retry, silent failure (`return ""` on any error, `vercel/index.ts:117-125`), fire-and-forget writes, and a 50-entry/60s cache keyed on a weak 32-bit `hashQuery` (:31-36 — collisions serve another user's cached memory: cache key is `userId:hash`, and a hash collision between two queries of the SAME user serves the wrong memory).
  - Why it matters: behavior diverges per entry point (client throws + retries; middleware swallows), and fixes (like scope support) must be applied N times.
  - Recommendation: route the middleware through `MemongoClient` (with a `silent` option), and use a collision-resistant cache key (full query string or SHA-256).

- [SEV: low] Naming disharmony across layers
  - Where: GET `/v1/state` ↔ `client.state` ↔ `memongoBridgeGetState` ↔ MCP/tools name it `memongo_state_unified` (`apps/mcp/src/server.ts:703`); POST `/v1/procedures/outcome` (plural) ↔ tool `memongo_procedure_outcome` (singular); POST `/v1/memory/feedback` uses singular `memory` while the lifecycle family is called `structured`; middleware option `userId` doubles as `agentId` (`packages/tools/src/vercel/index.ts:9,96`). MCP `memongo_status` injects a hardcoded `guidance` block into the status response (`apps/mcp/src/server.ts:1330-1355`) so the same route returns different payloads depending on surface.
  - Why it matters: an agent reading API docs then switching to MCP cannot map `state` → `memongo_state_unified` or predict that status output differs; `userId`-vs-`agentId` invites misconfiguration.
  - Recommendation: one canonical verb per operation across route/method/tool (`state`, `report_procedure_outcome`/`procedures/outcome`, `structured` vs `memory`), rename middleware `userId` → `agentId` (keep alias), and move the guidance block into a separate `memongo_guide` tool or the tool description.

- [SEV: low] Version numbers disagree across the same release
  - Where: OpenAPI `info.version: "1.0.0"` (`apps/api/src/openapi-spec.ts:638`), MCP server `{ name: "memongo", version: "0.1.0" }` (`apps/mcp/src/server.ts:1125`), published packages at `2.0.0`, apps at `0.1.0`, pi-extension at `2.1.1`.
  - Why it matters: support/bug reports cannot correlate client/server/spec versions; the `/v1` URL prefix implies "API v1" while packages ship v2.
  - Recommendation: derive the OpenAPI version and MCP server version from the workspace package version at build time.

- [SEV: low] Dead/deprecated fields still accepted and forwarded
  - Where: `MemongoAddInput.entityContext`/`customId` (`packages/client/src/types.ts:12-13`) are never sent by `client.add` (`client.ts:451-460`) — dead type fields. Deprecated `containerTag` aliases forwarded by client (`client.ts:456,474,701`) and accepted by API (`apps/api/src/routes/v1.ts:93-95,111-113` via `pickContainerTag`) with no sunset; `searchDetailed` input keeps a `containerTag` marked "ignored" (`client.ts:504-505`).
  - Why it matters: two naming eras (`containerTag` vs `scopeRef`/`sessionId`) coexist in every layer; agents see both in schemas and pick arbitrarily.
  - Recommendation: remove dead fields, stop emitting `containerTag` from the client, and add a deprecation warning server-side when it is used.

- [SEV: low] MCP `memongo_hydrate_active_slate` / `memongo_discovery_projection` cast unvalidated `args.scope` to a literal type
  - Where: `apps/mcp/src/server.ts:1677-1681,1696-1700` — `typeof args.scope === "string" ? (args.scope as "user") : undefined`. Any garbage string passes as a scope and is forwarded; the API's `pickScope` then silently drops it (`apps/api/src/routes/v1.ts:133-138`), so a typo'd scope produces an unscoped query with no error.
  - Recommendation: validate against the same 6-value enum used by `memongo_build_context_bundle` (:1231-1239) before casting.

## Top 5

1. [high] Client SDK silently drops scope/scopeRef on search/add/searchDetailed/searchKB/recall/scanNovelty/extract — tenant isolation requested by agents evaporates at the choke point; scoped API keys get guaranteed 403 on `/v1/search-kb`; pi-extension already bypasses the client over this (`packages/client/src/client.ts:463-477`, `packages/client/src/types.ts:19-27`, `packages/pi-extension/extensions/index.ts:185-198`).
2. [high] No canonical error contract beyond the API — client stringifies the `{error:{code,message}}` body, MCP re-wraps the string into another JSON envelope; error codes unreachable for agents (`apps/api/src/lib/errors.ts:10-17`, `packages/client/src/client.ts:131-136`, `apps/mcp/src/server.ts:2088-2091`).
3. [medium] OpenAPI spec drift — `/v1/self-edit` undocumented; scope/scopeRef/filter fields missing from `/v1/add`, `/v1/search-kb`, `/v1/extract`, `/v1/novelty-scan`, `/v1/consolidate`; `ApiError` component never referenced; no bearer security scheme (`apps/api/src/openapi-spec.ts:1991-2047,2101-2120,2787`).
4. [medium] Retry/lifecycle incoherence — client retries 503 which the API never emits, ignores `Retry-After` on 429 (fixed 60s window vs 200ms backoff), and has no timeout; bridge-down surfaces as 500, never retried (`packages/client/src/client.ts:93-136`, `apps/api/src/app.ts:106-111`).
5. [medium] Engine `MemorySearchManager` interface is stale (no `scopeRef` on `searchKB`, no scope on `extractEvent`); bridge papers over it with 6 `*CapableManager` casts and re-declares engine response types — third structural copy of the same domain objects (`packages/memory-engine/src/types.ts:666-668,703-710`, `packages/memory-bridge/src/memongo-bridge.ts:47-321`).

## Harmony note

The bones of one organism are visible: every MCP tool flows through the single `MemongoClient`, every route flows through the single bridge facade, scope enums are literally identical (`session|user|agent|workspace|tenant|global`) in four places, field names (`path`, `snippet`, `body`, `scopeRef`, stable-handle shape) match across engine/bridge/API/client, and the auth contract (`Authorization: Bearer $MEMONGO_API_KEY`) is uniform on every surface. But the seams leak exactly where layers hand off: the client is a lossy filter that silently strips the scope fields the API's own auth layer can require; the API speaks a rich typed error language that the client flattens to a string and the MCP buries in nested JSON; the OpenAPI spec, the engine's public interface, and the MCP/AI-SDK tool surfaces each present a slightly different, narrower view of the same capabilities — so which features exist depends on which door you enter through (extract missing from MCP, 15 routes missing from AI SDK tools, scoped KB search impossible through the client). The fix is not more code but one shared contract source: engine-owned types re-exported through the bridge, client input types that extend them instead of re-declaring subsets, an error parser in the client, and a spec generated from (or tested against) the route table.

## Out-of-scope sightings

- `packages/pi-extension/extensions/index.ts:198,332` — the extension's search tool hardcodes `scope: "global"` with no scope parameter, while its save tool defaults to `scope: "workspace"`; engine search filters exact scope (`packages/memory-engine/src/mongodb-manager.ts:2468-2486`), so the extension cannot find its own default-scope saves.
- `packages/tools/src/vercel/index.ts:31-36` — 32-bit `hashQuery` cache key means two different user queries that collide serve a stale cached memory context for 60s.
- `packages/memory-engine/src/mongodb-manager.ts` is 11,266 LOC — far over the repo's ~500 LOC guideline (for the engine-review agent).
