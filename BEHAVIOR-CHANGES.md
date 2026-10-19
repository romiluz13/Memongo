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
