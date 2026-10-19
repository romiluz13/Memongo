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
