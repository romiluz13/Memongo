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

- The `mongodb-atlas-local` image is pinned to `preview@sha256:ff75fd47e918952cc91094e888e8aeb7529aeb70f987b075aeef3944c9bd8014` in CI, the nightly workflow and Docker Compose. The `8.2.6` local override is replaced, because boot requires 8.3. `publish.yml` is unchanged.

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
