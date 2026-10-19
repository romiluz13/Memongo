# Behavior changes (M2)

Each M2 ticket lists the behavior it removed or changed, under its own heading.

## T1: startup contract (#110)

### Boot refuses instead of degrading

- Boot requires MongoDB 8.3 or later.
  - An older server fails boot with `server-version-unsupported`.
  - An unreadable `buildInfo` fails with `server-version-unreadable`.
  - Previously, an unknown version made boot probe the fusion stages, and a probe error counted as support.
- Boot requires Search index management.
  - A deployment without Search fails with `search-management-unavailable`.
  - Previously, a failed `$listSearchIndexes` probe skipped the Search bootstrap, and the server served with lanes off.
- Boot requires Search index management privileges, read through `connectionStatus`. A user without them fails with `search-privileges-denied` before boot writes anything.
- Boot builds a required-index manifest from the selected profile and the enabled surfaces. Every manifest index must meet these conditions within one total deadline (180 s by default):
  - It is READY with `queryable: true`.
  - It serves its manifest definition, including model, path, filter, token and analyzer mappings.
  - It serves the latest definition generation on every host that `statusDetail` lists.
  - A pending `latestDefinition` does not count.
- Failures are typed:
  - FAILED and STALE indexes fail fast, as `index-failed` and `index-stale`, before any repair write.
  - An index still building at the deadline fails with `index-not-ready`.
  - An index still absent after repair fails with `index-absent`.
  - A same-named index of the wrong type fails with `index-type-mismatch`; boot never drops it.
    - `$listSearchIndexes` documents no `type` field, and the server omits it. When it is absent, the definition decides: `mappings` means a search index and `fields` means a vectorSearch index.
    - Previously, a missing `type` counted as compatible with any type, so boot sent `updateSearchIndex` to a wrong-type index.
  - A definition without autoEmbed fails with `autoembed-unavailable`.
  - A create or update the deployment answers and refuses fails with `index-definition-rejected`. `search-management-unavailable` now means only that the listing failed, or that the Search Index Management service could not be reached.
  - Unknown or inconsistent metadata fails with `index-metadata-unknown`. This includes:
    - the undocumented `ACTIVE` status
    - a READY index without `queryable: true`
    - an index with neither a readable type nor a definition
- Previously, the engine warned and served when indexes were not queryable after the wait (`mongodb-manager.ts:718-826`). That warn-and-serve path is gone.
- Boot repair creates or updates manifest indexes. It never drops an index or a collection.
- Previously, all 17 index-create catches, the `ensureNamedSearchIndex` swallow paths and the capability-probe catches logged and continued. They now fail as `MemongoBootError`.
- `waitForSearchCapabilities` now throws `index-not-ready` on timeout. Previously, it returned its last result.
- A failed bitemporal prefilter readiness probe now propagates, both at boot and at the request-time refresh. Previously, it disabled the prefilter silently.
- `listSearchIndexes` no longer retries a failed `$listSearchIndexes` aggregate through the driver helper.

### Removed

- The boot-time storedSource probe is removed. It was a `$vectorSearch` with `query.text`, which embeds a query: a paid call at every boot.
  - storedSource now comes from the serving index definition plus the version gate.
- Boot no longer creates the `$text` indexes `idx_chunks_text`, `idx_kbchunks_text`, `idx_entities_text` or `idx_episodes_text`.
  - Existing ones are left in place; nothing drops them.
  - The `textFallbackIndexes` option and `shouldEnsureTextFallbackIndexes` are removed.
- `MEMONGO_STRICT_SEARCH_INDEX_READY` and `MEMONGO_REQUIRE_VECTOR` are removed. Strict readiness is the only mode, and setting either fails boot with `config-removed`, naming the setting.
- `isSearchIndexManagementAvailable` is removed. Search management is part of the boot contract.

### Config that now fails boot

Each of these settings now fails boot with `config-invalid`, naming the setting:

| Setting | Rejected value | Previous behavior |
|---|---|---|
| `memory.mongodb.deploymentProfile` | `community-mongot` or any unknown profile | `community-mongot` was rewritten to `atlas-local-preview` |
| `fusionMethod`, from config, a config file or `MEMONGO_MONGODB_FUSION_METHOD` | `js-merge` or any unknown value | The env silently fell back to the config value; the env wins when it is valid |
| `memory.mongodb.ttl.sessionDays` | not a positive number | Fell back to 30 days with a warning |
| `memory.mongodb.memoryTtlDays` | not a non-negative number | Became 0 |
| `MEMONGO_RERANKING_ENABLED` (any env boolean) | an unrecognized value | Used the default |
| `memory.mongodb.numDimensions` | differs from the autoEmbed model's dimension (1024) | Logged an error and was ignored |
| `memory.mongodb.graph.entityExtraction.method` | `llm` | The regex extractor ran silently, because no provider exists |
| `MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS` / `_POLL_MS` | not a positive integer | Fell back to the default; the default is now 180 s for every profile |

### API

- `memongo-api` refuses to serve on any boot failure. It logs `memongo-api refused to start: boot failure <code>: <reason>` and exits 1 before binding the port (X-06).
  - The search-lane table no longer has a classic `$text` lane.
- `/ready` adds a `manifest` lane. It runs a read-only pass over the required-index manifest and returns 503, naming each unmet `<code> <index>` (X-08).
- `memongoBridgeGetManager` rethrows the engine's `MemongoBootError` with its code, index and requirement. It is no longer flattened into a bare `Error` (X-04).
- New `bun run --filter @memongo/api preflight`. It reports every unmet boot requirement as redacted JSON, exits 1 when any is unmet, and writes nothing.

### Deployment

- The `mongodb-atlas-local` image is pinned to `preview@sha256:ff75fd47e918952cc91094e888e8aeb7529aeb70f987b075aeef3944c9bd8014` in CI, the nightly workflow and Docker Compose. The `8.2.6` local override is replaced, because boot requires 8.3. `publish.yml` pins the same digest for its MongoDB service.

## T4

KB search (`searchKB`, the `kb` lane of `searchV2`, `/v1/search-kb`) now runs one native fusion over `kb_chunks`. The fusion is `$scoreFusion` (minMaxScaler, `avg`, MongoDB 8.3+) by default or `$rankFusion`, chosen by configuration before the query runs. Nothing runs after it.

- **Healthy zero hits are final.** A fusion that returns no rows used to fall to vector-only, then keyword-only, then `$text`. It now returns `[]` with an `ok-empty` row (`zero-hits`) and runs one aggregation and one embed.
- **No capability downgrades.** The KB lane no longer reads the detected deployment capabilities (`vectorSearch`, `textSearch`, `scoreFusion`, `rankFusion`). A missing capability no longer picks a weaker tier; the fusion runs and the server's error comes back as a typed `SearchLaneError` at stage `score-fusion` or `rank-fusion`. The `capabilities`, `skipVectorLane` and `strict` options of `searchKB` are gone.
- **KB JavaScript merge and survivor-stands are removed.** `fusionMethod: "js-merge"` is no longer a KB option, and a failed branch can no longer be hidden by the surviving one. The engine rejects any `fusionMethod` other than `scoreFusion` or `rankFusion` with a typed `SearchLaneError` (stage `plan`, reason `query-error`) before touching the database.
- **The `$text` last-resort tier is removed.** KB search on a deployment without Atlas Search and a query embedding now fails typed instead of returning `$text` matches. As a consequence the keyless CI tier cannot execute a real KB search, so `mongodb-kb-isolation.e2e.test.ts` now captures the tenant predicate that `searchKB` hands to `$vectorSearch` and applies it to the stored chunks. `kb-scope-community.e2e.test.ts` (which asserted the `$text` pipeline and `js-merge`) is deleted, and its `--require-suite` line is removed from `.github/workflows/e2e-nightly.yml`; its partition-selection cases live on in `kb-request-scope-resolution.test.ts`.
- **Admission denial no longer degrades to text-only.** When the process-level admission bucket refuses the embed spend, the direct `searchKB` route used to drop the vector lane and answer from `$text` while marking `kb:throttled`. It now throws a typed `SearchBudgetDeniedError` (lane `kb`, stage `request`, reason `budget-embeds`), still marks `kb:throttled`, and emits the throttled telemetry event. The `retryAfterMs` hint is no longer surfaced on a degradation event, because KB search no longer produces one; the `onDegradation` callback is never called for KB search.
- **Budget denial is typed.** A refused aggregation or embed inside a request ledger makes `searchKB` throw a `SearchBudgetDeniedError` (`budget-aggregations`, `budget-embeds`) at the fusion stage, which `searchV2` reports as a `budget-denied` lane row. Nothing executes off the ledger.
- **A fusion error is typed and final.** A failure of the fusion is a `failed` row with the typed reason (`query-error`, `index-missing`, `query-timeout`, and so on). No weaker tier runs and no row claims success.
- **Filters never widen.** A requested `tags`, `category` or `source` filter used to be dropped, with a warning, when the document collection was unavailable, so the search covered the whole scope. It now fails typed at stage `filter` (reason `internal-error` when `kbDocs` is missing, `dependency-unavailable` or `query-error` when the document read fails). A filter that matches no document is a successful empty with an `ok-empty` row at stage `filter`.
- **Empty query.** An empty query runs nothing and reports a `not-applicable` row (`empty-query`) at the fusion stage.
- **Reservation cost.** The KB lane reserves one aggregation and one embed up front (previously up to three aggregations and two embeds, depending on capabilities). A request budget of exactly one aggregation and one embed now runs the lane. `kbLaneCost` takes only `{ embeddingMode }`.
- **Explain.** Only the `fusionExplain` artifact is produced for KB search; the vector, keyword and `$text` explain artifacts are gone with their tiers.
- **`/v1/search-kb` validates `fusionMethod`.** An unknown value used to be silently ignored. `js-merge`, any other string, `null` and non-string values now return `400 VALIDATION_ERROR` ("fusionMethod must be scoreFusion or rankFusion") and the engine is not called. Omitting the field keeps the configured fusion.

## T2

Index health is read per request (#111, decision 8). Every public search entry opens a request-local snapshot of the manifest indexes its planned operations use, reads each collection's `$listSearchIndexes` at most once, and shares the result with its nested passes. The claim is "never runs against an index observed unhealthy at admission". It does not cover a transition after the check or read-after-write freshness; the M1 write-token barrier stays the visibility witness.

### Removed

- **The boot snapshot is no longer live capability.** `status().custom.capabilities` and `status().custom.searchModes` are gone, and the manager has no `capabilities` field. `status().custom.deploymentFacts` now reports only deployment facts (`scoreFusion`, `rankFusion`, `storedSource`, `vectorIndexMethod`, `capabilityGates`); the fusion-stage and storedSource facts still come from boot, because they describe the server, not an index.
- **`noteSearchLaneFailure` and its re-poll are removed**, with `searchLaneHealth`, `lastSearchLaneFailure` and the re-poll guard. A failed lane no longer triggers a throttled background probe whose result a later status call might show. Each request reads its own health, and a later request recovers on a healthy read.
- **`getDetailedStatus().searchLanes.lastFailure` is removed.**
- **`probeSearchLaneReadiness` is removed** from `mongodb-schema-capabilities.ts`. Nothing else called it.
- **`searchV2` no longer assumes every capability is present when a caller omits `capabilities`.** The omitted view now comes from the request's snapshot. Outside any request scope it throws a typed `SearchLaneError` (stage `request`, reason `internal-error`) instead of assuming healthy indexes. Direct callers pass the view they want or run inside `runWithIndexHealth`.
- **The `searchV2` `onPathFailure` hook is removed.** A lane failure is its outcome row. The manager no longer passes `onLaneFailure` to conversation recall, and the recall core's own `onLaneFailure` parameter now has no caller in the manager.
- **`refreshNativeBitemporalVectorPrefilter` no longer checks the boot vector capability.** It asks the events vector index itself.

### Changed

- **Two new typed reasons and one stage.** A lane that planned to use an index observed non-READY, not queryable, drifted from its manifest definition, or with a failed metadata read fails before it runs, with stage `index-health` and reason `index-stale` (STALE, a drifted definition, or a definition still being applied) or `index-unavailable` (absent, BUILDING or otherwise not queryable, FAILED, unknown metadata, or a metadata read that failed). A failed read is `index-unavailable` and is remembered for the rest of that request, so no later lane reads it as healthy.
- **Lane gate.** Each lane checks only the indexes it uses (for example `structured` checks `structured_mem` and `chunks`; `kb` checks `kb_chunks`). A failed gate is that lane's failed row, so sibling lanes stand and the request is `partial`; a request whose only lane failed is `failed` (R3 keeps its meaning). Direct `searchKB` fails with a typed `SearchLaneError` and the failed `kb` row; `raw-window` checks `events` and `chunks`. A recall with a query fails typed (lane `recall`, stage `index-health`) before the recall core runs, over the `events` indexes; a recall without a query is a plain find, reads no Search index and is not gated.
- **A stale text or vector index no longer degrades a hybrid lane.** The lane fails typed. Previously its capability flag turned false and the search fell to a weaker tier. (T3 removes the ladder itself.)
- **HTTP.** Both reasons are retryable unavailability: `503 SEARCH_LANES_UNAVAILABLE` when every required lane failed with them, with `outcomes` in the body. `/v1/recall-conversation` now maps typed search failures through the same table; previously every recall failure was a generic `500 RECALL_CONVERSATION_FAILED`. An untyped failure keeps that envelope. OpenAPI enumerates both reasons and the `index-health` stage, and documents the 500/503 bodies on recall.
- **SDK and silent mode.** `MemongoSearchLaneOutcome` and its reason union carry both reasons. A silent client keeps `code` and `outcomes` on the degradation marker, for `recallConversation` as well as the search calls.
- **MCP.** A tool call that fails with an API error carrying `outcomes` returns a tool error with `error`, `status`, `code` and the rows, so an agent reads `status: 503` as retryable for both new reasons.
- **Metadata checks are reported apart from retrieval work.** The request ledger snapshot (`metadata.budget`) gains `indexHealth: { metadataReads, failedMetadataReads, indexesChecked }`. Metadata reads spend none of `maxAggregations`, `maxEmbeds` or a lane reservation, so a budget that fit before still fits.
- **`getDetailedStatus().searchLanes` is read live for the call.** The shape is `{ vectorSearch, textSearch, probedAt, indexes }`. `probedAt` is always set (it was absent until the first probe), and `indexes` lists every required index with `healthy` and, when not, `reason` and `cause`. A failed metadata read is reported per index as `index-unavailable` / `metadata-read-failed`; it never reads as a healthy lane.
- **`probeVectorAvailability` and `probeEmbeddingAvailability` answer from the same snapshot reader.** A serving index now means READY, queryable and serving its manifest definition, which is stricter than the old queryable check. A failed metadata read throws the typed `index-unavailable` instead of a transport error.
- **`memongoBridgeCapabilities` is live.** It returns the manager's per-call view (`requestCapabilities()`), where it used to return the value stored at boot.
- **Benchmark scenario identity.** `vectorSearch` and `textSearch` in the run identity come from the boot contract's manifest, and the convergence gates read a live request view.

### Not covered, and unchanged

- Only the search entries open a snapshot: `search`, `searchDetailed`, `searchKB`, `relevanceExplain`, `buildContextBundle` and `recallConversation`. The novelty scan, consolidation, memory jobs, the active slate, discovery projections, context expansion and the write paths do not check index health here: their Search reads still fail typed when an index is absent, but a STALE index serves out-of-date matches. The seam they can adopt is `runIndexHealthRequest` plus `assertCollectionIndexesHealthy`; discovery's single read is `searchDiscoveryCandidates`.
- A post-commit barrier failure still reports the committed state: `awaitSearchBarrier` returns `committed: true`, `status: "not-yet-searchable"`, `reason: "probe-failed"` when its probe cannot run. The barrier's own pre-write target check and its probe are unchanged, and writes open no health scope.
- A lane that is optional by mode (session or memory-evidence chunks) can still record `capability-absent` when the chunk indexes are unhealthy; the always-planned `hybrid:chunks` lane carries the typed `index-health` row in the same request.

## T10

M2 ticket #119: bridge and API silent empties and swallowed errors. Each entry names what used to happen, what happens now and the inventory row.

- **Bridge search returns an envelope and throws on a failed call (X-01, X-02).** `memongoBridgeSearch()` and `memongoBridgeSearchKB()` returned a bare array, so a failed or throttled search read as `[]`. They now return `{ results, outcomes?, degradation? }`. When every lane failed they throw the engine's typed `SearchLaneError` (or `SearchBudgetDeniedError` for a pure budget denial) with the rows on `error.outcomes`. A partial or throttled call returns its results plus the rows or the throttle marker. Callers that used the array must read `.results`.
- **`getState` reports failed sections as typed rows (X-03).** A rejected section used to become `{}` or `null` with a boolean `partial`. The bridge now omits the section and lists `{ section, reason }` in `failures` with `partial: true`; `reason` is the engine's value-free failure enum or `erasure-in-progress`. All three sections failing still rejects. `GET /v1/state`, its OpenAPI schema and `MemongoStateResponse` carry the same fields; `profile` and `blocks` are now absent, not empty, when their read failed.
- **`/novelty-scan` maps an engine failure to a typed non-2xx (X-10).** A failed scan answered 200 with an `error` field. A typed engine failure now returns 500 `SEARCH_LANES_FAILED` or 503 `SEARCH_LANES_UNAVAILABLE` with its outcome row; the report's `error` field (until T9 makes the engine throw) is served as 503 `SEARCH_LANES_UNAVAILABLE`; an untyped failure stays 500 `NOVELTY_SCAN_FAILED`. `/v1/novelty-scan` documents 500 and 503.
- **Relevance explain no longer scores a failed lane as health (X-11).** With failed or partial lanes the engine now reports health `insufficient-data` and records no signal. A run whose write failed returns `persistFailure: { reason }` instead of a silent missing `runId`. `POST /v1/admin/relevance/explain` serves an all-lanes-failed explain as the typed search failure (500 or 503, no health verdict) and returns `outcomes` on a partial one.
- **Reasoning chain rejects a non-allowlisted collection (G2-51).** The engine returned an empty `chainComplete: true` chain. It now throws `ReasoningChainCollectionError` (code `CHAIN_TRACE_COLLECTION_INVALID`).
- **`readFile` rejects while an erasure is in progress (G2-69).** An erasure-gated read used to return an empty miss shape. The engine now rejects with `ErasureGateConflictError`; `POST /v1/read-file` returns 409 `ERASURE_IN_PROGRESS` (contract, OpenAPI and MCP tool error carry it; the client's silent mode keeps the code on `degradation`).
- **`/stats` no longer runs a vector coverage probe (G3-75).** `getMemoryStats` embedded a `coverage probe` text query four times per request through `$vectorSearch`, outside the cost ledger. The probe is removed. Automated-embedding coverage under the per-agent tenant filter is now `unknown` (`coveragePercent: null`, `basis: "search-index"`) instead of a probe-derived number; the stored-vector (client) basis is unchanged.
- **`js-merge` and unknown `fusionMethod` are rejected (X-05, G4-86).** `POST /v1/search-detailed` `searchConfig.fusionMethod` returns 400 `VALIDATION_ERROR` for anything but `scoreFusion` or `rankFusion`; its OpenAPI enum matches. The MCP tools (`memongo_search_detailed` `searchConfig`, `memongo_search_kb`) reject it with a typed `VALIDATION_ERROR` tool error and no longer list it in their schemas. The client types (`SearchConfig`, `searchKB` input, resolved config) no longer offer it. `/v1/search-kb` is left to T4.
- **MCP tool errors carry the typed reason.** A failed tool call used to return only `{ error: message }`. When the client raised `MemongoClientError` the payload (and `structuredContent`) now also carries `status`, `code` and, for a failed search, `outcomes`.

## T3

Ticket #112: chunk and planner hybrid lanes on native fusion. Rule: no
fallback; a failure is a typed row, never an empty success.

### Removed

- **Tier ladder in `mongoSearch`.** The chain native fusion, then the other
  fusion, then vector-only, keyword-only, JS merge and `$text` no longer
  exists. `mongoSearch` runs the one configured `fusionMethod` (`scoreFusion`
  by default, `rankFusion`) as one aggregate. A failure throws a
  `SearchLaneError` at that fusion stage.
- **`hybridSearchJSFallback`, `keywordSearch` and `classicTextSearch`.** The JS
  merge of a vector pass and a text pass, the keyword-only `$search` pass and
  the `$text` pass are deleted. A request with `fusionMethod: "js-merge"` is
  refused by `mongoSearch` with a typed `SearchLaneError` (stage `request`,
  reason `query-error`) instead of running a JS merge.
- **Vector-only and keyword-only downgrades.** When the fusion aggregate
  errors, the lane no longer retries a single-signal search and no longer
  reports that result as success.
- **Vector-denial to keyword.** A budget denial of the fused aggregate no
  longer runs a keyword search. The denial is a typed
  `budget-denied` throw and a `budget-denied` lane row.
- **`legacySearch` and the legacy re-run.** The manager no longer re-runs a
  second retrieval after the v2 planner returns empty or errors. A healthy
  zero-hit v2 answer is final. The `legacy` lane row and the `legacy` entry in
  `pathsExecuted` are no longer produced.
- **`legacySearchFallback` option.** `search`, `searchDetailed` and the
  manager no longer read it. A stale `true` value changes nothing. (Boot-time
  rejection and the config type belong to T1.)
- **`searchConfig.lexicalPrefilter`.** The engine throws a typed
  `SearchLaneError` (stage `request`, reason `query-error`) when the key is
  present. The API returns 400 `VALIDATION_ERROR` naming `lexicalPrefilter`.
  The key is gone from the SDK types, the MCP search tool schema, the bridge
  options and the OpenAPI search paths.
- **`SearchTraceEvent` and the `onTrace` option of `mongoSearch`.** The tier
  ladder is gone, so no tier trace is emitted. Tier outcomes still reach
  `onTierOutcome` as one row per lane.
- **`detectSearchMethod` and `resolveObservedSearchMethod`.** The manager no
  longer infers a search method from a trace.
- **Legacy search isolation e2e suite**
  (`mongodb-legacy-search-isolation.e2e.test.ts`) and its `--require-suite`
  lines in `ci.yml`, `publish.yml` and the memory-engine tier-a script. The
  code it covered no longer exists.

### Changed

- **Split JS RRF of conversation and bridge chunk lanes is one native
  aggregate.** The planner no longer runs `hybrid:chunks` and `hybrid:bridge`
  as two lanes whose results are merged in JS. When the two filters cannot be
  merged into one (`fuseChunkLaneFilters` returns nothing), the bridge filter
  rides in the same aggregate as a second input pair, each pair with its own
  filter. The `hybrid:bridge` lane row no longer exists; its work reports
  under `hybrid:chunks`.
- **Combination semantics of the two sub-lanes.** Output is capped once at
  `maxResults + bridgeMaxResults` rather than per sub-lane. A document found
  by both sub-lanes is combined by the server (`scoreFusion` `avg` with
  sigmoid normalization, or `rankFusion`) rather than by `mergeRankedResultSets`
  in JS. Weights are unchanged: 0.7 vector, 0.3 text. They are applied per
  input pipeline.
- **`hybridMode: "vector-only"` with a sibling filter** is one `$vectorSearch`
  whose filter is the `$or` of both sub-lane filters, not two vector lanes.
  Without a sibling it stays one `$vectorSearch` per lane.
- **Cross-collection RRF** (`mergeRankedResultSets` across chunks, procedures,
  sessions and other collections) stays, as declared composition.
- **Throttled search is visible.** A throttled `search` or `searchDetailed`
  call returns `laneOutcomes` with one `budget-denied` row
  (lane `search`, stage `request`, reason `budget-embeds`) and
  `outcomeStatus: "failed"` instead of a bare empty list. Over HTTP, a failed
  status with only budget-denied rows is a 503 `SEARCH_BUDGET_EXHAUSTED`
  where the call used to be a 200 with a throttle marker. That 503 body
  carries `outcomes`; the route does not yet turn the manager's
  `degradation.retryAfterMs` into a `Retry-After` header.
- **Ledger.** The default stays 12 aggregations and 5 embeds. One fused
  aggregate costs one aggregation plus one embed per embedded vector input
  (a fused sibling pair is 1 aggregation and 2 embeds, taken atomically
  before the call; an automated-embedding retry charges the same shape).
  `nativeFusionCost` replaces `mongoSearchTierCost`. A planner `hybrid`
  reservation now includes its embed. The equivalence key of `hybrid:chunks`
  carries both sub-lane filters and `bridgeMaxResults`; there is no
  `hybrid:bridge` key.
- **Outcome status for an empty plan.** `outcomes` always come from the v2
  metadata; there is no longer a branch that replaces them after a legacy
  re-run.

### Not changed (left to other tickets)

- KB search still uses `mergeHybridResultsMongoDB`, keyword and `$text` paths
  (T4). The function stays in `mongodb-hybrid.ts` for that caller.
- Event-lane JS RRF (T6), rerank block of `mongodb-search-v2.ts` (T5),
  procedural-exact backstop (T7), capabilities defaults (T2), and
  `backend-config.ts` including `legacySearchFallback` boot handling (T1).
- The `js-merge` value in `fusionMethod` types and in the API schema stays
  until T1 and T10 remove it; the chunk path refuses it at runtime.

## T9

Write decisions, LLM extraction, background jobs, transactions and the change stream (#118).

### Write decisions never default

- Consolidator similarity probe: a failed `$vectorSearch` similarity probe used to read as "nothing similar" and the candidate was ADDed. It now throws a typed `SearchLaneError` and the run fails.
- Contradiction detection (`detectContradictions`, `invalidateContradictedFacts`): a provider failure, malformed JSON or a response with no `contradictions` list used to return "no conflict" (`[]` / `0`). It now throws the provider's typed error or `EnrichmentParseError`. An empty list is a verdict only when the model returned one.
- Conflicted-candidate adjudication: with no admission token, failures used to log and return "unresolved" (the old skip). They now throw with or without admission.
- Dedup adjudication: a provider failure, malformed JSON, an unknown verdict or a MERGE without union text used to become `NO_MERGE`. Each now throws `EnrichmentParseError` or the provider error. `NO_MERGE` is a verdict only when the model said so.
- Consolidation reasoning: a provider or parse failure used to return an empty list. It now throws.
- Novelty scan (`scanNovelty`): a failed scan used to return `{ events: [], error: "mongot_unavailable" }`. It now throws a typed `SearchLaneError`. `NoveltyReport.error` is deprecated and never set. Events outside a successful scan's cap still carry the `UNSCORED_NOVELTY` value (0.5); that value means "not scanned", not "scan failed".
- Provider resolution: a configured provider (API key set) that cannot resolve used to become `null`, which read as the no-provider mode. It now throws `EnrichmentConfigError`. No API key stays the declared deterministic-only mode and returns `null`.
- The affected unit is marked failed with retry state and the run row is failed; phase failures in prune, dedup and reasoning leave their events unacknowledged and rethrow instead of being swallowed.

### LLM extraction failures are typed

- Derived-memory extraction: a configured provider whose call fails used to fall back to regex-only candidates. The derivation now fails and the job is retried. Deterministic-only extraction remains when no provider is configured.
- Temporal extraction: a provider failure, a wrong response shape or an unparseable date used to return the event-timestamp baseline. They now throw. The event timestamp is used only when the model answers `validFrom: null` (the text states no date). Both `validFrom` and `validTo` keys are required in the response.
- Relation extraction: a response with no `relations` list used to return `[]`. It now throws `EnrichmentParseError`.
- Entity extraction (`LLMEntityExtractor`): the regex fallback on LLM failure is gone; a failure throws.
- Session enrichment: `extractSessionEnrichment` no longer takes a `strict` option. It always throws parse errors (`strictJson` is removed with it; one argument deleted in `scripts/benchmark/mongodb-manager-benchmark.ts`).

### Consolidator entity filter

- `entitySet` used to scan a batch and regex-filter it afterwards. It now selects the batch with one Atlas Search `$search` `text` query on the events index, with the batch window (`agentId`, `scope`, `scopeRef`, `timestamp` range) in `compound.filter`. The text query is analyzed per term and ORed, so it matches a word, not a regex substring. A failed `$search` throws a typed `SearchLaneError`; it is never an empty batch.

### One ledger per job

- A consolidation run now opens one search ledger and records its snapshot on the `consolidation_runs` row. Inside a background job it joins the job's ledger instead of opening a second one. The exported `consolidationSearchBudgetLimits(maxEvents)` sizes it. Work past the limit throws `SearchBudgetDeniedError`.

### Transactions are required

- Every "transaction unsupported, write without one" fallback is deleted (structured memory, procedures, graph, KB, sync). A deployment that cannot run a transaction now throws `TransactionUnsupportedError` (`code: "TRANSACTION_UNSUPPORTED"`) from `typedTransactionError`. The `TransactionTooLargeForCache` split-and-retry stays; it is a retry, not a downgrade.

### Background jobs are durable

- A job with no event id or a corrupt admission epoch is dead-lettered instead of left `running`.
- A failure in a job's preamble (provider resolution, epoch read, prefetch) or completion write now marks the row `failed` with `error`, `retryAt`, and `deadLetterAt` after the attempt cap. The row used to stay `running` until its lease expired.
- A session-batched prefetch failure fails every job in that session group with the typed error. It no longer runs those jobs one event at a time.
- A failure to write the failure record itself is logged and counted, and the row falls back to lease-expiry reclaim.
- The tenant epoch read before claiming a consolidation job now throws instead of defaulting.
- The auto-episode trigger records a failed `episodes` projection run row when it fails.
- `countPendingMemoryJobs` throws on a failed read instead of returning zero.

### Declared best-effort bookkeeping

- Worker sweeps (chunk projection repair, idempotency fingerprint prune, expired-lease dead-letter), the backlog gauge and auto-consolidation staging are declared best-effort through `best-effort.ts`: a failure logs a line and increments a per-label counter (`getBestEffortFailureCounts()`), and the round continues. An erasure-gate conflict still aborts the sweep.
- Audit and telemetry writes (entity, relation, structured-memory and procedure audit rows; projection-run rows; consolidation cache invalidation; coverage telemetry) use the same helper. None of them sits on a retrieval or write-decision path.

### Change stream

- `MongoDBChangeStreamWatcher.start()` no longer returns `false` and falls back to a "file watcher only" mode. It throws `ChangeStreamUnavailableError`, and the manager factory surfaces it. The "retry from latest after a failed resume" branch is removed because it skipped events without a re-scan.

## T5: HTTP reranker removed (#114)

There is no reranker in M2. The client-side Voyage cross-encoder is gone. Native `$rerank` (Atlas only) arrives in M4.

### Default change

- Reranking was on by default whenever a Voyage key was present (model `rerank-3`, top 20). After M2 it is off and cannot be enabled.
- Keyed deployments lose that rerank until M4. Their result order is now the fused retrieval order plus the heuristic reranker, MMR and the trust ordering, which stay.
- A missing key, a provider error or an exhausted budget used to return the input order silently. No code calls the rerank endpoint any more, so there is no such failure to hide.

### Fails boot, or fails the request

- `memory.mongodb.reranking.enabled: true` and `MEMONGO_RERANKING_ENABLED=true` fail boot with `rerank-unsupported`. `enabled: false`, absent, and `MEMONGO_RERANKING_ENABLED=false` stay valid. A non-boolean `enabled` fails with `config-invalid`.
- The keys `model`, `topN`, `minScore`, `voyageApiKey`, `instruction`, `recencyBoost`, `accessBoost` and the env `MEMONGO_RERANK_MIN_SCORE` fail boot with `config-removed`, naming the setting. The message never echoes the value, because `voyageApiKey` was a secret.
- `reranking.temporalProximityBoost` stays. It belongs to the raw-window lane, and `0` is still its off-switch.
- A per-request demand is new: `searchConfig.rerank: true`.
  - The engine throws a `SearchLaneError` with reason `rerank-unsupported` at stage `request`, before any retrieval work.
  - The API answers `400 RERANK_UNSUPPORTED`. `rerank: false` is accepted, and a non-boolean value is a `400 VALIDATION_ERROR`.
  - `searchConfig.rerank` is added to the OpenAPI schema, the SDK `SearchConfig` and the MCP `memongo_search_detailed` schema.
  - In silent SDK mode the refused demand returns the empty answer with a `degradation` marker that carries the status and the code.

### Status and metadata

- `status().custom.rerank` reports `nativeRerank: { engineSupport: false, serverSupport: "unknown" }` and a `lane` of `not-applicable` with reason `capability-absent`. The OpenAPI status response, the SDK `MemongoStatusResponse` type and the API capability table describe the same state.
- `metadata.reranked` stays on the wire and is always `false`.
- The `rerank` provider operation in the cost ledger and the `rerankModel`, `rerankLatencyMs` and `rerankSkipped` telemetry fields stay as deprecated, so historical rows still read. Nothing writes them.

### Removed

- `crossEncoderRerank`, its module and tests, and `http-rerank-config.ts` (`DEFAULT_HTTP_RERANK_MODEL`, `resolveEffectiveRerankTopN`). Both rerank URLs are gone: `https://api.voyageai.com/v1/rerank` and the Atlas proxy `https://ai.mongodb.com/v1/rerank`.
- The post-cross-encoder boosts: recency, access and preference-evidence (`applyRecencyAccessBoostAfterRerank`, `applyPreferenceEvidenceBoostAfterRerank`).
- RET-08 partition ordering and the B10 rule that skipped the per-session cap after the reranker. `applyLaneAwareResultControls` always sorts by score and always applies the cap.
- The searchV2 latency phases `phase:lane-controls-pre-rerank`, `phase:rerank-input`, `phase:rerank` and `phase:lane-controls-post-rerank`. One `phase:lane-controls` replaces them.
- `RERANK_TIMEOUT_MS` and `SEARCH_TAIL_COMPOSITION_BUDGET_MS`. The documented worst-case tail is the 10 s `maxTimeMS` alone (it was 10 s + 2 s).
- The unwired JEV reranker (`mongodb-jev-reranker.ts`, `mongodb-jev-protocol.ts`) and its tests. `reranking.minScore` no longer feeds the search or benchmark default; both use `0.01`, the value it had by default.

### Benchmark harness

- The run manifest's `reranker` is always `{ model: "none", version: null, stage: "none" }`, and the run configuration records `rerankerEnabled: false`, `rerankerModel: "none"`, `rerankerTopN: 0` and null for the other reranker fields. Run-configuration hashes therefore differ from pre-T5 runs: do not pool them.
- The B7 refusal ("reranking enabled but no reranker key") and the B12 boost overrides are removed, because neither state can exist.
- `--no-rerank` still sets `MEMONGO_RERANKING_ENABLED=false`, which is now the only valid state, so the flag has no effect.

## T7: store lanes on Search (#116)

Procedure exact match, entity exact-name and prefix lookup, episode search and the derived-memory supporting-event lookup now run on `$search`. The `$regex` tiers and the global `textSearch` capability gate are gone from these lanes. Each lane is one operation: a Search failure, a missing index or a budget denial is a typed failure (`SearchLaneError` or `SearchBudgetDeniedError`), never a different lookup and never an empty result.

A Search stage only proposes candidates. Each lane applies owner, scope and lifecycle again on the hydrated document, before its limit, so a document that changed after it was indexed cannot return. Search is eventually consistent: a document written moments ago is not found until mongot has indexed it. The regex tiers read the collection and saw it at once. The opt-in write barrier (`searchWriteToken`) is unchanged and is the way to wait for visibility.

### Procedure exact match

- `findExactProcedureMatches` runs `$search` `equals` on `name` and `triggerQueries` (`should`, `minimumShouldMatch: 1`), with owner, scope, state and `intentTags` in `compound.filter` where expressible. The whole filter, including the validity window, is applied again with `$match` after the Search stage. It keeps the previous `updatedAt` ordering, the limit and the score of 1.
  - Previously it ran an anchored, case-insensitive `$regex` find (`^value$`, flag `i`) on the same two fields. The match is still the whole value in any case; only the matcher changed.
- `textIndexName` is now a required option. `searchV2` passes `<prefix>procedures_text`.
- The backstop now needs `procedures_text` to be queryable. A missing or unready index fails the `backstop:procedural-exact` lane typed (stage `exact-match`) and the answer is `partial`. Previously the find needed no index.
- The backstop now counts one aggregation against the request's search budget. Previously the find was uncounted. A denial is a `budget-denied` lane row, not zero hits.
- **Declared, unverified difference: case folding of non-ASCII names.** The `lowercase` normalizer on a `token` field is documented only as "lowercase"; the documentation does not say which characters it maps. The old matcher was PCRE caseless matching. They agree for ASCII. For a few characters they can disagree, for example the Greek final sigma (`ς` versus `Σ`) and the Turkish dotted capital `İ`. This was not checked against a live cluster, and the unit tests use a stand-in for the normalizer.
- Token values longer than 8181 characters are truncated by the index, so a name or trigger query that long cannot match.

### Entity lookups

- `findEntitiesByName` now matches the whole name or alias: `$search` `equals` on the lowercase `name` and `aliases` tokens, owner and scope in `compound.filter` and again in `$match`, newest first, limit 50 by default.
  - Previously it ran an unanchored, case-insensitive substring `$regex`. A query of `github.com` matched a URL entity named `https://github.com/...`, and `rom` matched `romiluz`. Neither matches now. Callers that want partial names use `searchEntitiesAutocomplete`.
  - A blank query returns `[]` without a database call. A failure is a typed `SearchLaneError` at stage `entity-lookup`.
- `searchEntitiesAutocomplete` no longer takes `textSearchAvailable`. Previously a deployment without the `textSearch` capability ran the substring `$regex` of `findEntitiesByName` instead. It is now always `$search` `autocomplete` (edgeGram) on `name` and `aliases`, and a blank query returns `[]`.
- The previous entity and episode `autocomplete` pipelines put `should` clauses next to a `filter`. In that shape Search treats `should` as optional (`minimumShouldMatch` defaults to 0), so a lookup could return tenant documents that matched neither field. `searchEntitiesAutocomplete` and the new `equals` lookups set `minimumShouldMatch: 1`, and episode search puts its `text` clause in `must`.
- The graph lane of `searchV2` no longer reads `capabilities.textSearch`. A deployment without Search, or without a queryable `entity_autocomplete` index, now fails that lane typed. Previously it fell to the regex.

### Episode search

- `searchEpisodes` runs one `$search` `text` query over `title` and `summary`, with owner and scope in `compound.filter`. Status (`deleted` excluded) and the time window are applied again with `$match` before the limit (50 by default).
  - Previously, with `textSearch`, it ran `autocomplete` on both fields. Otherwise it ran a keyword regex: terms of three or more characters, query stopwords removed, joined with `|`, as an unanchored substring match, newest first.
- Matching is now on whole analyzed terms, any one of them. Results are ordered by relevance.
  - A partial word no longer matches: `pipe` does not find `pipeline`. Typing a prefix no longer finds the episode either, as the `autocomplete` tier used to.
  - Query stopwords are no longer removed. A summary-style query such as `what happened in the pipeline` also matches episodes that contain `the` or `in`. The limit keeps the most relevant.
- A blank query still returns `[]` with an `episode-search` `not-applicable` row. Hits and healthy zero hits report as stage `atlas-search` (`ok`, `ok-empty`). A failure is a typed `SearchLaneError` at stage `atlas-search`. The stage `episode-search` no longer reports a failure.
- The episodic lane of `searchV2` no longer reads `capabilities.textSearch`.
- `buildEpisodeSearchRegex` and `EPISODE_QUERY_STOPWORDS` are removed.

### Derived-memory supporting events

- A full LLM claim is a `$search` `phrase` over `events.body`, with the two forms the verifier accepts (`My ...` and `The user's ...`) as the query. Any other value is a `text` query with `matchCriteria: "all"`. Tenant (`agentId`, `scope`, `scopeRef`) is in `compound.filter`.
  - Previously it was an unanchored case-insensitive `$regex` find on `body`, ordered newest first, limit 3.
- Unchanged: the verifier runs on every hit (the anchored full-claim pattern, or the literal value). A Search hit alone never counts as corroboration. The event being promoted is still excluded, and at most 3 events are kept, newest first.
- Tenant and lifecycle are revalidated with `$match` after the Search stage (bitemporal validity and expiry on the hydrated event, plus the exclusion of the current event). They are not in `compound.filter`: the events text index does not map `validAt`, `invalidAt` or `expiresAt`, and the Search documentation does not say how a missing date field behaves in a filter. This differs from the ticket text; see the Return.
- The lookup reads a window of 25 Search candidates, then keeps the 3 newest that pass the verifier. Previously the scan saw every matching event. If more than 25 events match, the 3 newest are chosen within the 25 best by relevance.
- A value now has to share every analyzed term with an event, and still appear literally. A value that is only a fragment of a longer word no longer corroborates.
- A supporting event that mongot has not yet indexed does not corroborate. The candidate stays unpromoted and a later repeat can promote it.
- A Search failure now throws a typed `SearchLaneError` (stage `atlas-search`) out of `resolveStructuredCandidatesForPromotion` and `prepareDerivedMemoryPromotion`. It is never read as "no supporting events".

### Index definitions

Three manifest definitions changed. Boot reads each as drift and updates it in place; it never drops. The first boot after the upgrade rebuilds these three indexes, and a user without update privilege fails with `search-privileges-denied`.

| Index | Field | Before | Now |
|---|---|---|---|
| `<prefix>procedures_text` | `name` | `string` | `string` and lowercase `token` |
| `<prefix>procedures_text` | `triggerQueries` | not mapped | lowercase `token` |
| `entity_autocomplete` | `name`, `aliases` | `autocomplete` | `autocomplete` and lowercase `token` |
| `episode_autocomplete` | `title`, `summary` | `autocomplete` | `string` with the configured text analyzer |

The two graph index names stay unprefixed and `episode_autocomplete` keeps its name although it no longer holds an `autocomplete` mapping; a rename would build a new index. The LongMemEval index profile builds neither graph index, so the entity and episode lanes fail typed there instead of using the regex.

### Removed

- The `$regex` tiers of `findEntitiesByName`, `searchEntitiesAutocomplete`, `searchEpisodes`, `findExactProcedureMatches` and `findSupportingEventIds`.
- The `textSearchAvailable` option of `searchEntitiesAutocomplete` and `searchEpisodes`, and the two `textSearch` reads in `searchV2`.
- `procedure-exact-search-timeout.test.ts`; the lane test `mongodb-procedures-exact-search.test.ts` covers the same processing limit.

## T6

M2 ticket #115: recall, raw-window and temporal expansion run through Search, and the JS-fused event lanes run as native fusion.

### Recall (`recallConversation`, `POST /v1/recall-conversation`)

- **Recall with a query is one hybrid lane.** It runs one `$rankFusion` aggregate (vector and text inputs) on events. A healthy zero is final.
- **The semantic tier is removed.** A failed or empty fusion used to retry as a `$vectorSearch`-only "semantic" recall. That retry is gone.
- **The regex tier is removed.** The last resort was a case-insensitive `$regex` substring scan of `body`. It is gone, and the no-query listing no longer carries any body filter.
- **Capabilities no longer pick the tier.** Recall used to read `capabilities` and, when they were absent (the default was false), skip straight to the regex scan. The `capabilities` parameter is removed, and the fusion always runs.
- **The "falling back" catches are removed.** A fusion failure used to log "falling back" and try the next tier. It now throws a typed `SearchLaneError` (lane `recall`, stage `rank-fusion`) and calls `onLaneFailure("recall:hybrid", error)`. The API maps a retryable reason to 503 `SEARCH_LANES_UNAVAILABLE` and a `query-error` or `internal-error` to 500 `SEARCH_LANES_FAILED`, with the outcome row. Before, these returned 500 `RECALL_CONVERSATION_FAILED` only when the regex tier also failed, and otherwise returned 200.
- **An admission denial is a typed budget error.** When the process-level admission bucket refused a recall, it used to degrade to the regex listing and return `metadata.throttled`. It now throws `SearchBudgetDeniedError` (lane `recall`, stage `request`, reason `budget-embeds`), and the API returns 503 `SEARCH_BUDGET_EXHAUSTED`. A request-ledger denial of the fused aggregate is typed the same way and runs nothing.
- **An invalid timezone is a 400.** An unknown `timezone` used to log a warning and fall back to UTC. It now rejects with `invalid timezone`, and the API returns 400 `VALIDATION_ERROR`. The value is not echoed.
- **The response contract narrows.** `metadata.searchMethod` is `"standard"` (no query) or `"hybrid"`. `matchType` is `"filter"` or `"hybrid"`, and `"semantic"` is gone from both. `metadata.throttled` is removed. The engine types, the client types and the OpenAPI schema all match, and the OpenAPI now documents the 400 and the search failure responses.
- **The fused aggregate is charged.** Recall's aggregate and its embed are counted in the request ledger, as one aggregation and one embed.
- **The no-query listing is unchanged.** It is still a chronological `find` (`searchMethod: "standard"`).

### Event lanes (turn-precision and conversation-evidence)

- **The lanes use native `$rankFusion`.** Each lane used to run a `$vectorSearch` aggregate and a `$search` aggregate, then merge them in JS with reciprocal-rank fusion. Each is now one `$rankFusion` aggregate with weights `{ vector: 1, text: 1 }`. Those weights and the server's fixed rank constant 60 reproduce the former JS RRF. Both inputs re-check identity and lifecycle after their Search stage.
- **Survivor-stands is removed.** When one branch failed or was budget-denied, the surviving branch used to stand alone. Now a fusion failure fails the lane typed (stage `rank-fusion`), and a denial is a typed `SearchBudgetDeniedError` that runs nothing.
- **The lanes need vector, text and `rankFusion`.** Before, either capability alone ran its single branch. Now, without all three (or without automated embedding), the lane reports `not-applicable` (`capability-absent`, stage `rank-fusion`) and runs nothing.
- **The cost is one aggregation and one embed.** The conversation-evidence reservation was up to two aggregations and one embed. It is now one aggregation and one embed, and nothing when the lane cannot run.
- **The result provenance lane changes.** Fused results carry provenance lane `turn-fusion` instead of `turn-vector` or `turn-text`.

### Raw-window lane (`searchV2` `raw-window`)

- **Raw-window selects through `$search`.** It used to `find` the 50 earliest events in the window and score them in JS. It now runs one `$search` on `events_text`. Identity and the window are a `range` on `timestamp` in `compound.filter`, and the query terms are a `must` text clause on `body`. The candidates are the top 50 Search hits. The existing term scoring, the temporal-proximity boost and the ordering stay as composition over them.
- **A window with no term match returns zero.** Before, it returned the window's earliest events scored near zero. A query with no extractable terms is `not-applicable` (`query-shape`, stage `atlas-search`).
- **Validity is checked at the reference clock.** After the Search stage, each candidate is re-checked for identity, the window, and the lifecycle clause at the reference clock (`questionDate`, else now). Before, only expiry was checked, so a retracted or not-yet-valid event could appear.
- **The order is deterministic.** Equal score, proximity and timestamp now break ties by `eventId`.
- **A failure is typed.** A Search failure is a typed failed row (stage `atlas-search`), never an empty success. Without `textSearch` the lane is `not-applicable` (`capability-absent`).
- **The lane is charged.** Raw-window now reserves and counts one aggregation. The find it replaced was not counted.

### Temporal-coverage session expansion

- **The expansion selects through `$search`.** The lane used to expand its hit sessions with an uncharged `find` sorted by time. It now uses one `$search` with these clauses in `compound.filter`: the session ids, `role: "user"`, identity, and `timestamp <= questionDate`. The lane terms are an optional `should` clause. After the Search stage, each candidate is re-checked for identity, role, time and lifecycle.
- **The bound now keeps the most relevant turns.** The per-session pick still sorts its candidates by time and takes the earliest. Under the bound (`max(maxEvents × 4, sessions × 6)`), the candidates are now the most relevant turns rather than the earliest ones.
- **The expansion is charged and typed.** It counts one aggregation, and a failure throws typed (stage `atlas-search`) instead of the driver error.

## T8: discovery projections and context bundle through Search (#117)

Discovery briefs and the context bundle's episode summary now select content with `$search` `text`, not with a regular expression, and a failed section is a typed row instead of an empty one.

### Content matching

- **Substring matching is removed.** Entity, structured memory, episode, procedure, revision and event lookups used to build a case-insensitive `RegExp` from up to 8 distinct query words and match it as a substring. They now run one `$search` `text` over the analyzed fields, with the tenant (`agentId`, `scope`, `scopeRef`) and the state or date window in `compound.filter`. A query word now matches whole analyzed terms, any word suffices, and case and punctuation do not matter. `redi` no longer finds `Redis`, `80` no longer finds `8080`, and `reds` finds nothing. The 8-word cap is gone; the query is clamped to the existing search query length (2000 characters).
- **Search hits are candidates, not proof.** Every hit goes through a canonical `$match` (tenant, state, window, expiry, lifecycle) before it can reach a brief, so a record that was deleted, superseded, expired or moved out of the window after it was indexed is dropped. The pool is the first 100 re-checked hits in relevance order, which are then ordered by recency (the previous ordering) and limited to the brief size. Recency now orders only within that pool.
- **Eventual consistency.** A record written after the last index snapshot is invisible to a brief until it is indexed. Briefs used to read their own writes immediately.
- **Fields that match.**
  - Entities match on name and aliases.
  - Structured memory matches on key, value, context and tags.
  - Episodes match on title, summary, tags and topics. The context bundle's episode summary matches on title, summary and topics; it no longer matches the short, medium and long term summary fields.
  - Procedures match on name and `searchText`, which already embeds the steps, intent tags and trigger queries.
  - Events match on body. Revisions match on key, value, context and tags.
- **Relation briefs search entities first.** A relation brief matches entities (name, aliases, type) through Search and then reads relations by the matched entity ids. A query that only names a relation type, such as `related_to`, no longer finds relations.
- **No query keeps the canonical listing.** `what-changed` and `contradiction-report` without a query, and the bundle's episode summary without a query, read the newest records and run no Search. A whitespace-only query counts as no query.
- **`what-changed` events gain their lifecycle clause.** The events window used to return expired, invalidated and not-yet-valid events. It now applies the same lifecycle clause as the event search lanes, with or without a query.
- **`key` and `tags` text matching under dual keyword mapping.** Where the structured memory index maps `key` for folding strategies, `key` matches as a whole value.

### Typed section failures

- **A failed section is a row, never `null`.** `metadata.failures` on the active slate, discovery projections and the context bundle lists one row per failed section: `{ section, stage, outcome: "failed" | "budget-denied", reason }`. Rows carry enum values only, with no query, document text or driver message. `metadata.partial` stays and is true exactly when `failures` is not empty. Nested rows are named `parent:child` (`active-slate:procedures`, `discovery-projection:episodes`, `query-evidence:context-expansion`).
- **Total failure throws.** When every planned section of a brief, slate or bundle fails, the call throws the representative typed error (a defect first, then unavailability, then a budget denial) instead of returning an empty 200. `/v1/hydrate-active-slate`, `/v1/discovery-projection` and `/v1/context-bundle` map it with the search failure table: 500 `SEARCH_LANES_FAILED`, 503 `SEARCH_LANES_UNAVAILABLE` or 503 `SEARCH_BUDGET_EXHAUSTED`, with the bounded `outcomes` row. Any other error keeps the route's internal error code. A healthy sibling still returns a 200 with the failed section as a row.
- **Context expansion reports failures.** A session whose raw-window read fails no longer vanishes; one deduplicated `context-expansion` row is reported under `query-evidence`. Expansion stays optional enrichment and never throws.
- **Query evidence keeps its lane outcomes (X-09).** `metadata.laneOutcomes`, `metadata.outcomeStatus` and `metadata.throttled` from the bundle's search now reach the bundle response. A throttled query-evidence search is a `budget-denied` row (stage `request`, reason `budget-reservation`); a failed lane row is a `failed` row.
- **The projection run record is declared best-effort.** `recordReadProjectionRun`'s silent `.catch(() => {})` is replaced by a counted warning (`discovery-projection-run`). The brief is still returned when the run record cannot be written, and the loss is logged and counted instead of swallowed.

### Index manifest

- New `{prefix}structured_mem_revisions_text` Search index on `structured_mem_revisions` (full profile only), serving revision lookups in `what-changed`.
- `structured_mem_text` maps `key` and `tags` as analyzed strings as well as tokens, so they can be matched as text without losing their token filters.
- `entity_autocomplete` maps `name`, `aliases` as `[autocomplete, string]` and `type` as a string. `episode_autocomplete` maps `title`, `summary` as `[autocomplete, string]`, `topics` and `tags` as strings, and `status` as a token.
- A changed definition is drift, so boot updates the existing index in place. No index or collection is dropped.

### API and SDK

- The three routes above can return the typed non-2xx described above. OpenAPI adds `failures` to the three metadata objects, `laneOutcomes`, `outcomeStatus` and `throttled` to the bundle metadata, and the 500 and 503 responses.
- `@memongo/client` adds the optional `failures` (and, on the bundle, `laneOutcomes`, `outcomeStatus`, `throttled`) to the slate, projection and bundle response types, and exports `MemongoSectionFailure`.

## T13: tenant and lifecycle gaps (#120)

A tenant is `(agentId, scope, scopeRef)`. The reads below used to filter by `agentId` alone, accept `scope` and `scopeRef` as optional narrowing, or skip the store's lifecycle clause. They now require the full identity and fail typed without it. Nothing widens to the agent, and no failure is relabeled as an empty success. No index or collection is dropped.

### Typed failure for a missing tenant identity

- **New error.** `TenantIdentityRequiredError` (`code: "TENANT_IDENTITY_REQUIRED"`, with `operation` and the `missing` parts) is thrown before any collection is read, any admission token is captured or any health snapshot is taken. `scope` counts as missing when it is not one of `session|user|agent|workspace|tenant|global`; a whitespace-only `scopeRef` counts as missing, and a present `scopeRef` is trimmed.
- **HTTP.** A route that can see the omission answers `400 VALIDATION_ERROR` ("scope and scopeRef are required"). The error itself, raised below a route, answers `400 TENANT_IDENTITY_REQUIRED` instead of a 500 and is not logged as a server fault.

### Reads that now require `scope` and `scopeRef`

- **Conversation recall.** `POST /v1/recall-conversation`, `recallConversation` in the client, `memongo_recall_conversation`, `memongo_recall_messages` and the AI SDK tool of the same name require `scope` and `scopeRef`. They used to recall every scope of the agent when the caller sent neither. The chronological listing and both hybrid lanes (vector filter, text filter and both hydrated re-checks) carry the tenant. A caller that sent only `scope: "session"` and a `sessionId` must now also send `scopeRef` (`session:<id>`); the route no longer derives it. The identity check runs before the index-health gate, so a recall without a tenant is a 400 even when an index is STALE.
- **`readFile` locators.** `structured:`, `entity:`, `procedure:`, `event:`, `episode:` (also `?expand=events`), `relation:`, `conversation:`, `events/…` and `sessions/…` locators must carry `?scope=<scope>&scopeRef=<scopeRef>`. Without both, `readFile` throws `TenantIdentityRequiredError` before the erasure gate is touched, and `POST /v1/read-file` answers `400 TENANT_IDENTITY_REQUIRED`. A locator that names another tenant's document reads as a miss. `kb:` and bridge paths are not tenant locators and are unchanged. A path returned by search carries no identity; the caller appends the result's own `scope` and `scopeRef` (`scripts/real-capability-stress.ts` does this).
- **Reasoning chain.** `POST /v1/chain-trace`, `traceChain`, `memongo_chain_trace` and the AI SDK tool require `scope` and `scopeRef`; the trace follows a fact and its premises only inside that tenant, and its leaf events honor expiry.
- **Quarantine list.** `GET /v1/admin/quarantine` (and the client's `listQuarantined`, `memongo_quarantine_list` and the web console) takes `scope` and `scopeRef` and lists only that tenant's review queue. Quarantine rows written without a scope belong to no tenant and are no longer listed.
- **Engine reads and deletes** (no HTTP route of their own) throw the typed error without the full identity: graph reads and `deleteEntity` / `deleteEntityConservative`, entity lookup by name, event reads (`getEventsBySession`, `getEventsByTimeRange`, `getSessionEventsWithBound`, `getUnconsolidatedEvents`), episode reads and status writes (`getEpisodesByIds`, `getEpisodesByTimeRange`, `getEpisodesByType`, `searchEpisodes`, `updateEpisodeStatus`, `hasRecentEpisodeWrite`, `materializeEpisode`) and the session-evidence expiry lookup. The consolidator's best-effort `traceReasoningChain` call, whose result nothing reads, now runs only for a candidate event that carries its own scope and scopeRef; it used to trace by `agentId` alone.

### Lifecycle clauses added

- **Events.** Novelty candidates and their k-NN neighbors, the consolidator batch, the `extractEvent` ownership check and the profile activity window now exclude expired, invalidated and not-yet-valid events. `extractEvent` now runs its ownership check for every caller, so an event that is expired or invalidated is `EventNotInScopeError` even when the caller named no scope.
- **Relations.** Profile relation counts and the discovery what-changed procedure and relation lanes count live, currently valid rows only (a superseded, invalidated or expired edge is history, not a relation of the entity today).

### KB expiry and erasure

- **Expired chunks are excluded.** Both KB fusion branches (`$scoreFusion` and `$rankFusion`) and the hydrated re-check drop a `kb_chunks` row whose `expiresAt` is past. `expiresAt` is not an indexed filter field, so the check runs on the hydrated document after Search; an expired chunk can occupy a candidate slot, so a result may hold fewer rows than `limit`. The documented scopeRef-shared global and tenant KB semantics are unchanged, with no `agentId` restriction added.
- **Erasure closes during Search.** Direct `searchKB` re-checks the erasure gate against its admission token at the return boundary. An erasure that began during the aggregate yields the typed `ErasureGateConflictError`, and the search routes answer `409 ERASURE_IN_PROGRESS` (the read paths already did), with no results and no outcome summary.

### Index health on the T8 reads

- **Discovery.** Each discovery content read checks the section's `*_text` Search index through the request-local snapshot and fails typed `index-stale` or `index-unavailable` (a section failure row per T8; a total failure throws). `hydrateActiveSlate` and `buildDiscoveryProjection` open a request scope. The check names the Search index type, so a text-only read is not refused for an unrelated vector index.
- **Slate and context expansion are not gated.** They read plain `find`s and no Search index, so there is no index to be stale; this is pinned by tests. The brief expected them to read through Search.
