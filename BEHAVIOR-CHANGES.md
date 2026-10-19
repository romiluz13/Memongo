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
  - A definition without autoEmbed fails with `autoembed-unavailable`.
  - Unknown or inconsistent metadata fails with `index-metadata-unknown`. This includes the undocumented `ACTIVE` status and a READY index without `queryable: true`.
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

## T2

Index health is read per request (#111, decision 8). Every public search entry opens a request-local snapshot of the manifest indexes its planned operations use, reads each collection's `$listSearchIndexes` at most once, and shares the result with its nested passes. The claim is "never runs against an index observed unhealthy at admission". It does not cover a transition after the check or read-after-write freshness; the M1 write-token barrier stays the visibility witness.

### Removed

- **The boot snapshot is no longer live capability.** `status().custom.capabilities` and `status().custom.searchModes` are gone, and the manager has no `capabilities` field. `status().custom.deploymentFacts` now reports only deployment facts (`scoreFusion`, `rankFusion`, `storedSource`, `vectorIndexMethod`, `capabilityGates`); the fusion-stage and storedSource facts still come from boot, because they describe the server, not an index.
- **`noteSearchLaneFailure` and its re-poll are removed**, with `searchLaneHealth`, `lastSearchLaneFailure` and the re-poll guard. A failed lane no longer triggers a throttled background probe whose result a later status call might show. Each request reads its own health, and a later request recovers on a healthy read.
- **`getDetailedStatus().searchLanes.lastFailure` is removed.**
- **`probeSearchLaneReadiness` is removed** from `mongodb-schema-capabilities.ts`. Nothing else called it.
- **`searchV2` no longer assumes every capability is present when a caller omits `capabilities`.** The omitted view now comes from the request's snapshot. Outside any request scope it throws a typed `SearchLaneError` (stage `request`, reason `internal-error`) instead of assuming healthy indexes. Direct callers pass the view they want or run inside `runWithIndexHealth`.
- **The `searchV2` `onPathFailure` hook is removed.** A lane failure is its outcome row. The manager no longer passes `onLaneFailure` to conversation recall; the parameter itself stays until the recall ticket.
- **`refreshNativeBitemporalVectorPrefilter` no longer checks the boot vector capability.** It asks the events vector index itself.

### Changed

- **Two new typed reasons and one stage.** A lane that planned to use an index observed non-READY, not queryable, drifted from its manifest definition, or with a failed metadata read fails before it runs, with stage `index-health` and reason `index-stale` (STALE, a drifted definition, or a definition still being applied) or `index-unavailable` (absent, BUILDING or otherwise not queryable, FAILED, unknown metadata, or a metadata read that failed). A failed read is `index-unavailable` and is remembered for the rest of that request, so no later lane reads it as healthy.
- **Lane gate.** Each lane checks only the indexes it uses (for example `structured` checks `structured_mem` and `chunks`; `kb` checks `kb_chunks`). A failed gate is that lane's failed row, so sibling lanes stand and the request is `partial`; a request whose only lane failed is `failed` (R3 keeps its meaning). Direct `searchKB` fails with a typed `SearchLaneError` and the failed `kb` row; `recallConversation` fails typed (lane `search`) before the recall core runs, over the `events` and `chunks` indexes.
- **A stale text or vector index no longer degrades a hybrid lane.** The lane fails typed. Previously its capability flag turned false and the search fell to a weaker tier. (T3 removes the ladder itself.)
- **HTTP.** Both reasons are retryable unavailability: `503 SEARCH_LANES_UNAVAILABLE` when every required lane failed with them, with `outcomes` in the body. `/v1/recall-conversation` now maps typed search failures through the same table; previously every recall failure was a generic `500 RECALL_CONVERSATION_FAILED`. An untyped failure keeps that envelope. OpenAPI enumerates both reasons and the `index-health` stage, and documents the 500/503 bodies on recall.
- **SDK and silent mode.** `MemongoSearchLaneOutcome` and its reason union carry both reasons. A silent client keeps `code` and `outcomes` on the degradation marker, for `recallConversation` as well as the search calls.
- **MCP.** A tool call that fails with an API error carrying `outcomes` returns a tool error with `error`, `code`, `retryable` (true for a 503, so both new reasons are retryable) and the rows, instead of a bare message.
- **Metadata checks are reported apart from retrieval work.** The request ledger snapshot (`metadata.budget`) gains `indexHealth: { metadataReads, failedMetadataReads, indexesChecked }`. Metadata reads spend none of `maxAggregations`, `maxEmbeds` or a lane reservation, so a budget that fit before still fits.
- **`getDetailedStatus().searchLanes` is read live for the call.** The shape is `{ vectorSearch, textSearch, probedAt, indexes }`. `probedAt` is always set (it was absent until the first probe), and `indexes` lists every required index with `healthy` and, when not, `reason` and `cause`. A failed metadata read is reported per index as `index-unavailable` / `metadata-read-failed`; it never reads as a healthy lane.
- **`probeVectorAvailability` and `probeEmbeddingAvailability` answer from the same snapshot reader.** A serving index now means READY, queryable and serving its manifest definition, which is stricter than the old queryable check. A failed metadata read throws the typed `index-unavailable` instead of a transport error.
- **`memongoBridgeCapabilities` is live.** It returns the manager's per-call view (`requestCapabilities()`), where it used to return the value stored at boot.
- **Benchmark scenario identity.** `vectorSearch` and `textSearch` in the run identity come from the boot contract's manifest, and the convergence gates read a live request view.

### Not covered, and unchanged

- Only the search entries open a snapshot: `search`, `searchDetailed`, `searchKB`, `relevanceExplain`, `buildContextBundle` and `recallConversation`. The novelty scan, consolidation, memory jobs, discovery and the write paths do not check index health here. The seam they can adopt is `runIndexHealthRequest` plus `assertCollectionIndexesHealthy`.
- A post-commit barrier failure still reports the committed state: `awaitSearchBarrier` returns `committed: true`, `status: "not-yet-searchable"`, `reason: "probe-failed"` when its probe cannot run. The barrier's own pre-write target check and its probe are unchanged, and writes open no health scope.
- A lane that is optional by mode (session or memory-evidence chunks) can still record `capability-absent` when the chunk indexes are unhealthy; the always-planned `hybrid:chunks` lane carries the typed `index-health` row in the same request.
