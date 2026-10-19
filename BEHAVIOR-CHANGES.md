# Behavior changes (M2)

Each M2 ticket lists the behavior it removed or changed, under its own heading. Read the upgrade section first. The tickets follow in order, T1 to T11, then T13.

## Upgrading to M2

M2 is an intentional breaking change. There is no compatibility mode, and Memongo never serves weaker retrieval while indexes build. The deployment contract, the preflight command, the pinned preview image and the rollback steps are in [docs/platform/self-host.md](docs/platform/self-host.md#deployment-contract). Per-entry-point failure behavior and its tests are in [docs/m2/FAILURE-MATRIX.md](docs/m2/FAILURE-MATRIX.md).

1. **Check the target first.** Run `bun run --filter @memongo/api preflight` with the service's environment. It writes nothing and exits 1 with one JSON entry per unmet requirement.
2. **Meet the contract.** MongoDB 8.3 or later, Search index management and the privileges to use it, Automated Embedding, and a replica set (writes run in transactions). The server refuses to start otherwise, with a typed boot code (T1).
3. **Expect index work on first boot.** Boot creates the indexes of the required-index manifest and updates changed definitions in place; it drops no Search index. `procedures_text`, `entity_autocomplete`, `episode_autocomplete` and `structured_mem_text` change definition, and `structured_mem_revisions_text` is new (T7, T8). A user without update privilege fails with `search-privileges-denied`. Boot waits up to 180 s and fails with `index-not-ready` if an index is still building; the build continues, so start again.
4. **Remove configuration that no longer exists.** These now fail boot, naming the setting: `legacySearchFallback`, `MEMONGO_STRICT_SEARCH_INDEX_READY`, `MEMONGO_REQUIRE_VECTOR`, `fusionMethod: "js-merge"`, every `reranking` key except `temporalProximityBoost`, `MEMONGO_RERANK_MIN_SCORE`, `reranking.enabled: true`, an out-of-range `numDimensions`, and the other rows of T1's table.
5. **Update callers.** `memongoBridgeSearch()` and `memongoBridgeSearchKB()` return `{ results, outcomes?, degradation? }` (T10). A search whose lanes failed is a non-2xx: 500 `SEARCH_LANES_FAILED`, 503 `SEARCH_LANES_UNAVAILABLE` or 503 `SEARCH_BUDGET_EXHAUSTED`, with `outcomes` in the body, and `Retry-After` when an admission denial carries a hint (T11). A refused `readFile` is 409 `ERASURE_IN_PROGRESS`. An invalid `timezone` is 400. Recall, `readFile`, chain-trace and the quarantine list now require `scope` and `scopeRef`; a reopened search result passes its own `scope` and `scopeRef`, and rows stored without them are no longer visible to these reads (T13).
6. **Expect different retrieval.** A healthy zero-hit answer is final: no second path runs after it. There is no `$regex`, `$text` or substring matching; lookups match whole analyzed terms. Search is eventually consistent, so a document written moments ago is not found until mongot has indexed it; the write barrier waits for visibility.
7. **Expect no reranking until M4.** Keyed deployments lose the default Voyage rerank (T5). Benchmark manifests from earlier runs do not verify and must not be pooled (T5, T11).
8. **Roll back by swapping the binary.** Nothing in M2 boot drops a Search index or a collection, so there is no data step to reverse.
9. **Not changed.** Boot still drops a fixed list of retired standard (non-Search) indexes, as the 2.x releases did. That ruling is open (Decision needed 1 in the failure matrix).

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

### Review fixes (F1, F3, F5, F6 of review 1232)

- **The 180 s deadline bounds the work, not only the polling (F1).**
  - Previously, the deadline was tested between polls. `buildInfo`, the privilege read, the metadata reads, `beforeRepair`, creates and updates ran with no limit, so a stalled call never reached the test, and a metadata command that completed after the deadline with every index READY booted.
  - Now one deadline covers every contract operation. An operation starts only while time remains, and a repair is not started after the deadline.
  - The reads (`buildInfo`, `connectionStatus`, `$listSearchIndexes`) receive the remaining time as the driver `timeoutMS`, which the driver also sends to the server as `maxTimeMS` where the command takes one. It is never 0, because the driver reads 0 as no timeout.
  - `createSearchIndex`, `updateSearchIndex` and `beforeRepair` accept no timeout option (mongodb 7.7), so each is raced against the deadline. A timed-out call stops being awaited and may still finish on the server; the factory closes an owned client after the failed boot, and a shared client is released to its registry instead.
  - An operation that completes after the deadline fails, even when every index is then READY.
  - Expiry is the new typed failure `boot-deadline-exceeded`, naming the operation that was running. An index still BUILDING at the last poll still fails as `index-not-ready`, also when the deadline cuts off a later readiness poll: the failure then names the indexes the last completed poll saw unmet.
  - The last poll sleep now leaves time for one more read (`now + poll >= deadline` stops), so the final read is never started after the deadline.
  - Preflight and `/ready` use the same machinery with the same 180 s default. They report the expiry once, as an unmet entry, and run no further check.
- **Partial host metadata no longer authorizes serving (F3).**
  - Previously, a READY host `mainIndex` with neither `definitionVersion` nor `definition`, beside `latestDefinitionVersion`, passed on the requested `latestDefinition` alone.
  - Now, once `statusDetail` is present, each host must report its serving `definition`, or a `definitionVersion` that can be compared with `latestDefinitionVersion`. Otherwise the index fails as `index-metadata-unknown`. A `statusDetail` that is not a list fails the same way.
  - Complete absence of `statusDetail` (atlas-local today) is unchanged.
  - Diagnostics name a host by its position (`host 2`), never by its reported hostname.
- **No URI, host, database or secret in boot or preflight output (F5).**
  - Previously, `describeDriverError` forwarded the driver message after masking passwords only, so `connection to mongodb://private-host.example/tenant-db failed` reached the typed message, the preflight JSON and the API refusal line.
  - Now a driver error is rendered as its server code name or error class and numeric code only (`HostUnreachable (code 6)`). The driver's message text is no longer printed, with one exception: when the server refuses a definition (`index-definition-rejected`, or an unavailable autoEmbed), its wording is shown as a scrubbed excerpt (URI, host, address and database tokens replaced, secret shapes redacted, 200 characters at most) because that wording is the operator's remedy. The typed code, collection, index and requirement name the failure.
  - Every `MemongoBootError` message and field, every preflight entry and the API refusal line go through `safeBootText`. It replaces whole URI tokens (any scheme, `mongodb://` and `mongodb+srv://` included, credentialed or not), host:port and IP tokens, and `ENOTFOUND` hosts, then redacts known secret shapes. It is exported from `@memongo/memory-engine` and `@memongo/memory-bridge`.
  - Provider-reported index statuses, types and `queryable` values are echoed only when they are short plain tokens.
  - Config rejections no longer repeat the rejected value (`deploymentProfile`, `fusionMethod`, `ttl.sessionDays`, `memoryTtlDays`, `numDimensions`, boolean env values and the readiness timeout and poll settings). They still name the setting.
  - `bun run --filter @memongo/api preflight` renders every string in its JSON through `safeBootText`, and prints a safe one-line failure if the preflight itself throws.
- **Preflight reports every unmet requirement across collections (F6).**
  - Previously, one collection whose `$listSearchIndexes` failed made preflight skip every index assessment.
  - Now preflight keeps one error per failed collection (one unmet entry each) and still assesses every collection it could read. Boot stays fail-fast on the first failed collection.

## T2: per-request index health (#111)

Index health is read per request (#111, decision 8). Every public search entry opens a request-local snapshot of the manifest indexes its planned operations use, reads each collection's `$listSearchIndexes` at most once, and shares the result with its nested passes. The claim is "never runs against an index observed unhealthy at admission". It does not cover a transition after the check or read-after-write freshness; the M1 write-token barrier stays the visibility witness.

### Removed

- **The boot snapshot is no longer live capability.** `status().custom.capabilities` and `status().custom.searchModes` are gone, and the manager has no `capabilities` field. `status().custom.deploymentFacts` now reports only deployment facts (`scoreFusion`, `rankFusion`, `storedSource`, `vectorIndexMethod`, `capabilityGates`); the fusion-stage and storedSource facts still come from boot, because they describe the server, not an index.
- **`noteSearchLaneFailure` and its re-poll are removed**, with `searchLaneHealth`, `lastSearchLaneFailure` and the re-poll guard. A failed lane no longer triggers a throttled background probe whose result a later status call might show. Each request reads its own health, and a later request recovers on a healthy read.
- **`getDetailedStatus().searchLanes.lastFailure` is removed.**
- **`probeSearchLaneReadiness` is removed** from `mongodb-schema-capabilities.ts`. Nothing else called it.
- **`searchV2` no longer assumes every capability is present when a caller omits `capabilities`.** The omitted view now comes from the request's snapshot. Outside any request scope it throws a typed `SearchLaneError` (stage `request`, reason `internal-error`) instead of assuming healthy indexes. Direct callers pass the view they want or run inside `runWithIndexHealth`.
- **The `searchV2` `onPathFailure` hook is removed.** A lane failure is its outcome row. The manager no longer passes `onLaneFailure` to conversation recall, and the recall core's own `onLaneFailure` parameter now has no caller in the manager (T11 removes the parameter).
- **`refreshNativeBitemporalVectorPrefilter` no longer checks the boot vector capability.** It asks the events vector index itself.

### Changed

- **Two new typed reasons and one stage.** A lane that planned to use an index observed non-READY, not queryable, drifted from its manifest definition, or with a failed metadata read fails before it runs, with stage `index-health` and reason `index-stale` (STALE, a drifted definition, or a definition still being applied) or `index-unavailable` (absent, BUILDING or otherwise not queryable, FAILED, unknown metadata, or a metadata read that failed). A failed read is `index-unavailable` and is remembered for the rest of that request, so no later lane reads it as healthy.
- **Lane gate.** Each lane checks only the indexes it uses (for example `structured` checks `structured_mem` and `chunks`; `kb` checks `kb_chunks`). A failed gate is that lane's failed row, so sibling lanes stand and the request is `partial`; a request whose only lane failed is `failed` (R3 keeps its meaning). Direct `searchKB` fails with a typed `SearchLaneError` and the failed `kb` row; `raw-window` checks `events` (T11 dropped its `chunks` entry). A recall with a query fails typed (lane `recall`, stage `index-health`) before the recall core runs, over the `events` indexes; a recall without a query is a plain find, reads no Search index and is not gated.
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

## T3: chunk and planner lanes on native fusion (#112)

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
  carries `outcomes`; T11 adds `Retry-After` to that 503 when the denial
  carries a retry hint (see T11).
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

### Left to other tickets, since done

- KB search still used `mergeHybridResultsMongoDB`, keyword and `$text` paths
  (T4 removed them; T11 deleted the function).
- Event-lane JS RRF (T6), rerank block of `mongodb-search-v2.ts` (T5),
  procedural-exact backstop (T7), capabilities defaults (T2), and
  `backend-config.ts` including `legacySearchFallback` boot handling (T11 made
  the key fail boot).
- The `js-merge` value in `fusionMethod` types and in the API schema stayed
  until T1 and T10 removed it; the chunk path refuses it at runtime.

## T4: KB search on native fusion (#113)

KB search (`searchKB`, the `kb` lane of `searchV2`, `/v1/search-kb`) now runs one native fusion over `kb_chunks`. The fusion is `$scoreFusion` (minMaxScaler, `avg`, MongoDB 8.3+) by default or `$rankFusion`, chosen by configuration before the query runs. Nothing runs after it.

- **Healthy zero hits are final.** A fusion that returns no rows used to fall to vector-only, then keyword-only, then `$text`. It now returns `[]` with an `ok-empty` row (`zero-hits`) and runs one aggregation and one embed.
- **No capability downgrades.** The KB lane no longer reads the detected deployment capabilities (`vectorSearch`, `textSearch`, `scoreFusion`, `rankFusion`). A missing capability no longer picks a weaker tier; the fusion runs and the server's error comes back as a typed `SearchLaneError` at stage `score-fusion` or `rank-fusion`. The `capabilities`, `skipVectorLane` and `strict` options of `searchKB` are gone.
- **KB JavaScript merge and survivor-stands are removed.** `fusionMethod: "js-merge"` is no longer a KB option, and a failed branch can no longer be hidden by the surviving one. The engine rejects any `fusionMethod` other than `scoreFusion` or `rankFusion` with a typed `SearchLaneError` (stage `plan`, reason `query-error`) before touching the database.
- **The `$text` last-resort tier is removed.** KB search on a deployment without Atlas Search and a query embedding now fails typed instead of returning `$text` matches. As a consequence the keyless CI tier cannot execute a real KB search, so `mongodb-kb-isolation.e2e.test.ts` now captures the tenant predicate that `searchKB` hands to `$vectorSearch` and applies it to the stored chunks. `kb-scope-community.e2e.test.ts` (which asserted the `$text` pipeline and `js-merge`) is deleted, and its `--require-suite` line is removed from `.github/workflows/e2e-nightly.yml`; its partition-selection cases live on in `kb-request-scope-resolution.test.ts`.
- **Admission denial no longer degrades to text-only.** When the process-level admission bucket refuses the embed spend, the direct `searchKB` route used to drop the vector lane and answer from `$text` while marking `kb:throttled`. It now throws a typed `SearchBudgetDeniedError` (lane `kb`, stage `request`, reason `budget-embeds`), still marks `kb:throttled`, and emits the throttled telemetry event. The `retryAfterMs` hint is no longer surfaced on a degradation event, because KB search no longer produces one. T11 removes the `onDegradation` option from `searchKB` and carries the hint on the error, so `/v1/search-kb` answers with 503 `SEARCH_BUDGET_EXHAUSTED` and a `Retry-After` header.
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
- `--no-rerank` had no effect once reranking could not be enabled. T11 makes `scripts/run-benchmark.ts` fail on it with a removal message.

## T6: recall, event lanes and raw-window on Search (#115)

M2 ticket #115: recall, raw-window and temporal expansion run through Search, and the JS-fused event lanes run as native fusion.

### Recall (`recallConversation`, `POST /v1/recall-conversation`)

- **Recall with a query is one hybrid lane.** It runs one `$rankFusion` aggregate (vector and text inputs) on events. A healthy zero is final.
- **The semantic tier is removed.** A failed or empty fusion used to retry as a `$vectorSearch`-only "semantic" recall. That retry is gone.
- **The regex tier is removed.** The last resort was a case-insensitive `$regex` substring scan of `body`. It is gone, and the no-query listing no longer carries any body filter.
- **Capabilities no longer pick the tier.** Recall used to read `capabilities` and, when they were absent (the default was false), skip straight to the regex scan. The `capabilities` parameter is removed, and the fusion always runs.
- **The "falling back" catches are removed.** A fusion failure used to log "falling back" and try the next tier. It now throws a typed `SearchLaneError` (lane `recall`, stage `rank-fusion`) (T11 removes the `onLaneFailure` option; the thrown error is the only signal). The API maps a retryable reason to 503 `SEARCH_LANES_UNAVAILABLE` and a `query-error` or `internal-error` to 500 `SEARCH_LANES_FAILED`, with the outcome row. Before, these returned 500 `RECALL_CONVERSATION_FAILED` only when the regex tier also failed, and otherwise returned 200.
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
- **A failure is typed.** A Search failure is a typed failed row (stage `atlas-search`), never an empty success. The lane no longer reads the `textSearch` capability flag (T11): it reads `events_text`, so only the `events` index health gates it.
- **The lane is charged.** Raw-window now reserves and counts one aggregation. The find it replaced was not counted.

### Temporal-coverage session expansion

- **The expansion selects through `$search`.** The lane used to expand its hit sessions with an uncharged `find` sorted by time. It now uses one `$search` with these clauses in `compound.filter`: the session ids, `role: "user"`, identity, and `timestamp <= questionDate`. The lane terms are an optional `should` clause. After the Search stage, each candidate is re-checked for identity, role, time and lifecycle.
- **The bound now keeps the most relevant turns.** The per-session pick still sorts its candidates by time and takes the earliest. Under the bound (`max(maxEvents × 4, sessions × 6)`), the candidates are now the most relevant turns rather than the earliest ones.
- **The expansion is charged and typed.** It counts one aggregation, and a failure throws typed (stage `atlas-search`) instead of the driver error.

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

The two graph index names stay unprefixed and `episode_autocomplete` keeps its name although it no longer holds an `autocomplete` mapping; a rename would build a new index. The LongMemEval index profile builds neither graph index, so the entity and episode lanes report `not-applicable` (`capability-absent`, stage `plan`) there (T11) instead of using the regex or failing on an index that is not declared.

### Removed

- The `$regex` tiers of `findEntitiesByName`, `searchEntitiesAutocomplete`, `searchEpisodes`, `findExactProcedureMatches` and `findSupportingEventIds`.
- The `textSearchAvailable` option of `searchEntitiesAutocomplete` and `searchEpisodes`, and the two `textSearch` reads in `searchV2`.
- `procedure-exact-search-timeout.test.ts`; the lane test `mongodb-procedures-exact-search.test.ts` covers the same processing limit.

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

## T9: write decisions, jobs, transactions and the change stream (#118)

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

- `entitySet` used to scan a batch and regex-filter it afterwards. It now selects the batch with one Atlas Search `$search` `text` query on the events index, with the batch window (`agentId`, `scope`, `scopeRef`, `timestamp` range) in `compound.filter`. The text query is analyzed per term and ORed, so it matches a word, not a regex substring. T11 narrows it to one `phrase` clause per entity name, so a multi-word entity matches as a whole. A failed `$search` throws a typed `SearchLaneError`; it is never an empty batch.

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

- `MongoDBChangeStreamWatcher.start()` no longer returns `false` and falls back to a "file watcher only" mode. It throws `ChangeStreamUnavailableError`, and the manager factory surfaces it. The "retry from latest after a failed resume" branch is removed because it skipped events without a re-scan. T11 also makes a failed read of the stored resume token reject, where it used to start the stream from now.

## T10: bridge and API silent empties (#119)

M2 ticket #119: bridge and API silent empties and swallowed errors. Each entry names what used to happen, what happens now and the inventory row.

- **Bridge search returns an envelope and throws on a failed call (X-01, X-02).** `memongoBridgeSearch()` and `memongoBridgeSearchKB()` returned a bare array, so a failed or throttled search read as `[]`. They now return `{ results, outcomes?, degradation? }`. When every lane failed they throw the engine's typed `SearchLaneError` (or `SearchBudgetDeniedError` for a pure budget denial) with the rows on `error.outcomes`. A partial call returns its results plus the rows. A throttled call is a failed call: `memongoBridgeSearch()` throws, and the `WithDegradation` envelope carries the failed rows beside the throttle marker. Callers that used the array must read `.results`.
- **`getState` reports failed sections as typed rows (X-03).** A rejected section used to become `{}` or `null` with a boolean `partial`. The bridge now omits the section and lists `{ section, reason }` in `failures` with `partial: true`; `reason` is the engine's value-free failure enum or `erasure-in-progress`. All three sections failing still rejects. `GET /v1/state`, its OpenAPI schema and `MemongoStateResponse` carry the same fields; `profile` and `blocks` are now absent, not empty, when their read failed.
- **`/novelty-scan` maps an engine failure to a typed non-2xx (X-10).** A failed scan answered 200 with an `error` field. A typed engine failure now returns 500 `SEARCH_LANES_FAILED` or 503 `SEARCH_LANES_UNAVAILABLE` with its outcome row; the report's `error` field (until T9 makes the engine throw) is served as 503 `SEARCH_LANES_UNAVAILABLE`; an untyped failure stays 500 `NOVELTY_SCAN_FAILED`. `/v1/novelty-scan` documents 500 and 503.
- **Relevance explain no longer scores a failed lane as health (X-11).** With failed or partial lanes the engine now reports health `insufficient-data` and records no signal. A run whose write failed returns `persistFailure: { reason }` instead of a silent missing `runId`. `POST /v1/admin/relevance/explain` serves an all-lanes-failed explain as the typed search failure (500 or 503, no health verdict) and returns `outcomes` on a partial one.
- **Reasoning chain rejects a non-allowlisted collection (G2-51).** The engine returned an empty `chainComplete: true` chain. It now throws `ReasoningChainCollectionError` (code `CHAIN_TRACE_COLLECTION_INVALID`).
- **`readFile` rejects while an erasure is in progress (G2-69).** An erasure-gated read used to return an empty miss shape. The engine now rejects with `ErasureGateConflictError`; `POST /v1/read-file` returns 409 `ERASURE_IN_PROGRESS` (contract, OpenAPI and MCP tool error carry it; the client's silent mode keeps the code on `degradation`).
- **`/stats` no longer runs a vector coverage probe (G3-75).** `getMemoryStats` embedded a `coverage probe` text query four times per request through `$vectorSearch`, outside the cost ledger. The probe is removed. Automated-embedding coverage under the per-agent tenant filter is now `unknown` (`coveragePercent: null`, `basis: "search-index"`) instead of a probe-derived number; the stored-vector (client) basis is unchanged.
- **`js-merge` and unknown `fusionMethod` are rejected (X-05, G4-86).** `POST /v1/search-detailed` `searchConfig.fusionMethod` returns 400 `VALIDATION_ERROR` for anything but `scoreFusion` or `rankFusion`; its OpenAPI enum matches. The MCP tools (`memongo_search_detailed` `searchConfig`, `memongo_search_kb`) reject it with a typed `VALIDATION_ERROR` tool error and no longer list it in their schemas. The client types (`SearchConfig`, `searchKB` input, resolved config) no longer offer it. `/v1/search-kb` is left to T4.
- **MCP tool errors carry the typed reason.** A failed tool call used to return only `{ error: message }`. When the client raised `MemongoClientError` the payload (and `structuredContent`) now also carries `status`, `code` and, for a failed search, `outcomes`.

## T11: source check, failure matrix, dead code and docs (#121)

Ticket #121 keeps the fallbacks out and finishes what T1 to T10 left. It adds a CI source check, maps every REBUILD and TYPED inventory row to a test, removes dead code, and ends each builder leftover typed or removed.

### CI source check

- **`bun run check-no-fallbacks` runs in the `quality` job before Typecheck.** It parses the production sources of `packages`, `apps`, `scripts` and `benchmarks`, plus the YAML and shell under `.github` and `docker`, and fails on:
  - a BSON `$regex` or `$options` operator;
  - a `RegExp` value used as a query property or built at run time from a non-literal pattern;
  - the `$text` operator or any string that names it;
  - a removed configuration key, alias or environment name (`MEMONGO_STRICT_SEARCH_INDEX_READY`, `MEMONGO_REQUIRE_VECTOR`, `MEMONGO_RERANK_MIN_SCORE`, `community-mongot`, `js-merge`, `legacySearchFallback`, `lexicalPrefilter` and the removed `reranking.*` keys);
  - a JavaScript fusion or rerank entry point (`hybridSearchJSFallback`, `mergeHybridResultsMongoDB`, `classicTextSearch`, `crossEncoderRerank`).
- **Exceptions are explicit.** `ALLOWLIST` in `scripts/ci/check-no-fallbacks.ts` names each file, the rules it may break and the reason. An allowlisted file that no longer exists fails the check, and an entry that suppresses nothing is reported as a note.
- **It fails on the base and passes here.** On commit `5280803` it reports violations; on this branch it exits 0. `scripts/ci/check-no-fallbacks.test.ts` pins each rule.

### Failure matrix

- `docs/m2/FAILURE-MATRIX.md` reconciles all 108 REBUILD and TYPED rows of the call-path inventory to tests, with error, denial, absent and healthy-zero controls. Of the 34 rows whose read-scope, lifecycle or erasure clause T13 owned, 14 name T13's merged tests and 20 read `no test:` because T13 changed nothing at their layer; each of those points to the engine row that pins the clause. Ten open rulings and limits are listed under Decision needed.
- New tests close the gaps the reconciliation found: `memongo-bridge-failure-propagation.test.ts`, `tool-failure-matrix.test.ts`, `route-failure-matrix.test.ts`, `search-fusion-validation.test.ts`, `mongodb-manager-sync-ops.test.ts`, `mongodb-manager-extraction-forwarding.test.ts`, and additions to the write-state, factory-unwind and analytics suites.

### Retry hints and degradation markers

- **A budget 503 carries `Retry-After` when the denial has a hint.** `SearchBudgetDeniedError` has a new `retryAfterMs`, set by an admission-bucket denial in recall and KB search. The route sends `Retry-After: max(1, ceil(retryAfterMs / 1000))` for `SEARCH_BUDGET_EXHAUSTED` when the value is a finite positive number. A per-request ledger denial has no hint and sends no header, and a lane failure never sends one. OpenAPI documents the header on the 503.
- **`/v1/search` answers an admission denial with a 503.** The engine reports a denied admission as a failed `budget-denied` outcome row, and the route maps failed outcomes before its 200 branch, so the answer is 503 `SEARCH_BUDGET_EXHAUSTED`, not a 200 with the `degradation` marker. Since the final review (1237 ruling 4) the 503 also carries the admission's `Retry-After`, on `/v1/search-detailed` as well.
- **`degradation.scope` has one value, `denied`.** `legacy-fallback-skipped` and `vector-lane-skipped` are gone from `MemorySearchDegradation` and from the OpenAPI enum, because nothing emits them. `/v1/search-kb` responses never carry `degradation`; the OpenAPI schema and the bridge envelope drop it.
- **`searchKB` no longer takes `onDegradation`**, and `recallConversation` no longer takes `onLaneFailure`. A failure or a denial is the thrown error.
- **Four `SearchStage` values are removed:** `rerun`, `classic-text`, `keyword` and `js-merge`. No code produces them.
- **`NoveltyReport.error` and `MemongoNoveltyResponse.error` are removed.** T9 stopped setting them. The novelty route's branch that turned that field into a 503 is deleted.

### Configuration

- **`memory.mongodb.legacySearchFallback` fails boot** with `config-removed`. It was read nowhere after T3, so a stale `true` changed nothing; now it is refused.
- **`embeddingMode` and `queryRewriting.method` rejections are typed.** They were a bare `Error` that echoed the value. They are now `config-invalid`, name the setting and print no value.
- **Benchmark manifests change.** The run configuration drops four environment keys that can no longer vary: `MEMONGO_RERANKING_ENABLED`, `MEMONGO_RERANK_MIN_SCORE`, `MEMONGO_RERANK_STRICT` and `MEMONGO_STRICT_SEARCH_INDEX_READY`. The hash-bound coverage marker is `b02-keyed-v4`, so a manifest from `b02-keyed-v3` does not verify.
- **`scripts/run-benchmark.ts --no-rerank` fails** with "--no-rerank was removed", instead of setting an environment variable that has no other valid value.

### Search lanes

- **`raw-window` no longer reads the `textSearch` capability flag.** It queries `events_text`, so the flag guarded the wrong index. Its health gate checks `events` only, and its lane cost is one aggregation.
- **`graph` and `episodic` report `not-applicable`** (`capability-absent`, stage `plan`) when the request's manifest declares indexes but none for their collections. The LongMemEval profile builds neither. An empty manifest declares nothing and gates nothing, so it never marks a lane `not-applicable`.
- **Consolidator entity batches match whole phrases.** `searchEntityBatch` sent one `text` query over all entity names, so a multi-word entity matched on any one of its words. It now sends one `phrase` clause per entity in `compound.should` with `minimumShouldMatch: 1`.
- **Structured and procedure vector tiers no longer test for a query vector.** That test belonged to client-side embeddings, which boot no longer allows; the tier now depends on the capability flag alone.
- **`canUseLegacyFallback` is removed** from the search executor. `requestHasHardConstraints` states the constraint list itself.

### Boot and connection

- **An unreachable server is `server-unreachable`.** A failed connect or ping used to throw a bare `Error` carrying a redacted URI and the driver message. It is now a `MemongoBootError` that names no URI, host or database. `redactMongoURI` and the URI log lines are removed: connection logs no longer print the URI or the database name.
- **The orphan check uses a key range.** `checkChunkEventOrphans` read chunks with a `^events/` regular expression. It now uses `path` in `[events/, events0)`, the same prefix, with no pattern run against stored content.

### Failures that used to read as success

- **`measureEmbeddingCoverage` rejects on a failed read.** It returned zero totals for a failed stored-vector aggregation and `unknown` for a failed index read. A failed read now rejects, so a stats call reports the failure instead of coverage of zero.
- **`runSync` no longer reports a delta as the total.** When the tenant count query failed, it set the file and chunk totals to the numbers this one run processed. The count failure now fails the sync, and the dirty flag stays set.
- **A failed read of the change stream resume token rejects.** It returned `null`, which started the stream from now and skipped the events in between. A missing token is still `null`.
- **Declared best-effort bookkeeping grows by three sites,** each counted by label through `best-effort.ts` and logged with the numeric driver code only: the resume token write (`change-stream-resume-token`), the startup sync and the startup projection repair (`startup-sync`, `startup-projection-repair`), and the projection-run record of an event write (`projection-run-record`, single and batch). The startup and run-record sites used to log the message or swallow with an empty catch.
- **`recordBestEffortFailure` logs the label and the numeric code, never the message.** A driver message can carry a query, a value or a host. The duplicate helper `noteBestEffortFailure` in `section-failures.ts` is removed; the discovery projection run record uses `best-effort.ts` too.
- **The manager forwarded two of three arguments** of `runClaimedBackgroundExtractionJob`, dropping the prefetched effects. It forwards all three.

### Dead code removed

- Engine functions with no caller: `cosineSimilarity`, `getStructuredMemoryByType`, `findExistingEventIds`, `reconcileEmbeddingStatus`, `mergeHybridResultsMongoDB`, `waitForSearchCapabilities`, `assertIndexBudget` (with `mongodb-schema-budget.ts` and `MongoIndexBudgetCheck`), `clearPersistedChangeStreamResumeToken` and `canUseLegacyFallback`.
- `mongodb-tiered-summary.ts` and its test (`buildTieredSummaryPrompt`, `parseTieredSummaryResponse`, `withTieredSummaries`), and `LLMEntityExtractor` with its prompt builders and `LLMFunction` type. T9 had already made the extractor throw instead of falling back; nothing constructed it.
- The query-decomposition imports `decomposeQuery` and `mergeMultiQueryResults` in the manager.
- Their tests: the `mongodb-hybrid.test.ts` merge cases, the entity-extractor LLM cases, and the structured-memory case for `getStructuredMemoryByType`.

### Docs

- The deployment contract, preflight, the preview image digest and rollback are in `docs/platform/self-host.md`. The capability table, with the index each lane needs, what each does when an index is unhealthy and the planned follow-ups after a healthy zero, is in `docs/platform/capability-matrix.md`.
- README, the engine README, the Docker README and the docs site no longer describe a retrieval fallback, a `js-merge` choice, a `$text` tier or a reranker. The engine README's "HTTP reranking" section is replaced by a statement that this release cannot rerank.
- This file is one ordered document: the upgrade section, then T1 to T11.

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

## Review fixes R3, R4, R6-R9 (1237)

Fixes for the blocking findings of the final M2 review (ticket #122). R1, R2 and R5 are a separate section.

### R3: conversation recall honors the erasure gate

- **Refused while an erasure runs.** `POST /v1/recall-conversation`, `recallConversation` in the client, `memongo_recall_conversation`, `memongo_recall_messages` and the AI SDK tool of the same name take the erasure admission before they read, as `readFile` and KB search do. While an erasure is in progress for the agent the recall is `409 ERASURE_IN_PROGRESS` (the engine's `ErasureGateConflictError`), for a query recall and for a chronological listing alike. It used to answer with the events the sweep had not reached yet. The refusal comes after the tenant identity check and before the index-health check.
- **Closed during the read.** The recall re-checks the gate against its admission at the return boundary. An erasure that began while the recall ran is the same 409, and the events it read are not returned.
- **Cost.** Each recall now writes the gate's admission (a majority-acknowledged upsert) and runs the fence transaction once, as `readFile` and KB search already do.

### R4: each host proves its own serving definition

- **Index assessment.** Boot, preflight and the per-request index health judge each `statusDetail` host on that host's own proof: the `mainIndex.definition` it reports or, for a host whose comparable generation equals `latestDefinitionVersion`, the listing's `latestDefinition`. A previous host's definition is never reused for another host. A host that proves only a generation, beside a drifted `latestDefinition`, is `drift` (boot repairs it; a request sees `index-stale`) even when another host reports the intended definition. It used to be judged serving on that other host's definition. A host that proves a current generation when the listing carries no `latestDefinition` is `index-metadata-unknown`.
- **Generations must be finite numbers.** A `latestDefinitionVersion.version` or a host `definitionVersion.version` that is NaN, an infinity or any non-number (it used to count as "not comparable" and fall back to a definition) is `index-metadata-unknown`. An absent generation is still "no generation reported".

### R6: configuration refusals no longer echo the rejected value

- **Messages name the setting, not the value.** The refusals for `MEMONGO_QUERY_EMBEDDING_MODEL` / `memory.mongodb.queryEmbeddingModel`, `MEMONGO_CONVERSATION_EVIDENCE_MODE`, `memory.backend`, `MEMONGO_SEARCH_DEFAULT_SCOPE`, `MEMONGO_DEFAULT_SCOPE` and the embedding-pipeline contract check used to repeat the rejected value in the error (for example `memory.mongodb.queryEmbeddingModel "<value>" is not supported`). A value that was a connection string reached the error, the `memory backend resolution failed` log line and the `error` of `getMemorySearchManager`. The messages now say which setting is wrong and what is accepted. The `MEMONGO_DEFAULT_SCOPE` conflict warning no longer prints the legacy `MEMONGO_SEARCH_DEFAULT_SCOPE` value.
- **The manager scrubs what is left.** `getMemorySearchManager` passes a configuration refusal through the boot-safe renderer before it logs it or returns it as `error`, so a URI, host or address in any resolver message becomes `<uri>` or `<host>`. `cause` still holds the original error object.

### R7: a failed KB auto-refresh is a typed failure

- **`sync` rejects.** The KB auto-refresh that runs at the end of `sync` (and so at startup, on a watch event and on `POST /v1/sync`) used to log a rejected import and resolve, and to write the success marker after an import that resolved with `errors`. It now throws `KBRefreshError` (`code: "KB_REFRESH_FAILED"`, `reason` of `import-rejected`, `import-errors` or `marker-write-failed`) carrying the import's `documentsProcessed`, `chunksCreated` and `skipped` counts, a bounded scrubbed sample of its `errors` and the original `cause`. The file sync and the tenant totals are already committed when it throws.
- **The marker never advances on a failure.** The `kb_last_auto_refresh` marker is written only after an import with no errors, so the next cycle re-attempts the whole refresh. A refresh that is due is retried on every sync until it succeeds, where an import with errors used to suppress it for `autoRefreshHours`.
- **Erasure deferral is unchanged.** An erasure conflict at admission or at the marker fence still defers the refresh with a warn line and no error.
- **Startup.** The startup sync's failure is recorded under the `startup-sync` best-effort counter, which now also counts a failed KB refresh. A path `ingestFilesToKB` cannot scan or a file it cannot read is still logged and skipped; it is not an import error. Review fix D2 changed that: it is now an import error.

### R8: typed Search failures reach the routes that run Search underneath

- **`POST /v1/consolidate` and `GET /v1/probes/vector`.** A typed Search failure from the engine (a lane failure, `index-unavailable`, `index-stale`, `index-not-ready` or a budget denial) used to surface as the generic 500 `CONSOLIDATE_FAILED` or `PROBE_VECTOR_FAILED`, which hid a retryable 503 from a client. It now goes through the same outcome and status mapper as the search routes: 503 `SEARCH_LANES_UNAVAILABLE`, 503 `SEARCH_BUDGET_EXHAUSTED` (with `Retry-After` when the denial carries a retry hint) or 500 `SEARCH_LANES_FAILED`, with the bounded `outcomes` row in the body. The client SDK and the MCP tools already read `outcomes` from any error body, so they need no change. The OpenAPI document lists the new 500 and 503 responses on both routes.
- **Unexpected errors stay generic.** An error that is not one of the typed Search errors (by class name and enum reason) keeps the route's own code (`CONSOLIDATE_FAILED`, `PROBE_VECTOR_FAILED`) with a request id and no engine text.
- **`POST /v1/sync`.** A failed KB auto-refresh (R7) is `500 KB_REFRESH_FAILED`. The message names the reason (`import-rejected`, `import-errors` or `marker-write-failed`) and the documents and chunks the import had already committed, and says the refresh marker was not advanced so the next sync retries. It carries no engine message, cause or import error text. Before this fix the same call answered 200 `{ ok: true }` after logging the failure. The file sync and the tenant totals are already committed when it fails. A client that treated every `/v1/sync` 200 as a complete refresh now sees the failure.
- **Audited and unchanged.** The other non-search routes (`/v1/chain-trace`, `/v1/extract`, `/v1/profile`, `/v1/state`, `/v1/status`, `/v1/status/detailed`, `/v1/stats`, the write, lifecycle and admin routes) do not reach a Search runner, so no typed Search failure can arrive there; their route-coded errors are unchanged.

### R9: reasoning chain leaves follow the event lifecycle

- **Leaf events.** `POST /v1/chain-trace`, `traceChain`, `memongo_chain_trace` and the AI SDK tool hydrate each leaf event under the store's full event lifecycle at one clock taken when the trace starts: retained (`expiresAt`), already valid (`validAt`) and not retracted (`invalidAt`). The read used to apply expiry only, so a leaf whose `invalidAt` had passed, or whose `validAt` was still in the future, came back with its body. Such a leaf is now a `gap` node (reason `deleted`, the same row an expired leaf already produced) and `chainComplete` is `false`. The starting fact and its premises are unchanged and now use the same clock.

## Review fixes D2, D3 (1242)

Review 1242 found two gaps left by the R7 and R8 fixes: a configured KB source the refresh could not read was still skipped silently, and a failure after work had committed said nothing about that work. Ticket #122. Rom's rule applies to both: no fallback, fail loudly.

### D2: a configured source the KB refresh cannot read fails the refresh

- **Scan and read failures are import errors.** `ingestFilesToKB` used to log a path it could not scan or a file it could not read and carry on, so a refresh over a missing path, an unreadable directory or an unreadable file completed and wrote the success marker. It now records each one in the import's `errors` (`<path>: KB file scan failed: <message>`, `<path>: KB file read failed: <message>`) and returns the real counts of the documents that did ingest. A source that fails is never a clean empty import.
- **The refresh fails typed.** Those errors take the existing `import-errors` path from R7: `maybeAutoRefreshKB` throws `KBRefreshError`, `sync` rethrows it, `POST /v1/sync` answers 500 `KB_REFRESH_FAILED`, and the `kb_last_auto_refresh` marker does not advance, so the next sync retries the whole refresh. The R7 bullet above that said such a path "is still logged and skipped" no longer holds.
- **Intentional skips stay skips.** An unsupported extension, a symlink and unchanged content are still skipped and are not errors, so a refresh whose only skips are those completes and writes the marker.
- **A missing configured path now fails every sync.** There is no optional-path setting. An operator whose configured KB path is gone sees `KB_REFRESH_FAILED` on each sync until the path returns or the configuration changes (Decision needed 6 in the failure matrix).

### D3: a typed failure after committed work reports what committed

- **One state, three meanings.** An engine failure that comes after a write committed now carries `commitState`: `none` (no data write committed and none is uncertain; a consolidation run's own run-record row is bookkeeping and is not counted, and `commit.runId` names it), `committed` (known committed effects) or `unknown` (at least one write's commit outcome is uncertain, so neither a commit nor a rollback is claimed). `committed` and `unknown` come with a `commit` detail of the work known to be committed. The error keeps its class, name, message, code, status and outcome rows; the report is added to the same error object. An error that already states its own `commitState` keeps it. An error with no `commitState` makes no claim, which is not the same as `none`.
- **Consolidation.** A consolidation run that fails after it claimed the gate (a typed Search failure after an earlier candidate was promoted, for example) carries `commit: { operation: "consolidate", runId, eventsProcessed, factsPromoted, factsInferred, factsMerged, factsPruned }`: the run identity and the work the run acknowledged before it failed. The state comes from every committed write of the run, graph and quarantine rows included, so `none` is never inferred from zero counters.
- **Sync.** A failed KB refresh runs after the file sync committed. The `KBRefreshError` (and any other error the refresh throws) now carries `commitState: "committed"` and `commit: { operation: "sync", fileSync: { filesFailed, enumerationComplete }, kbImport?: { documentsProcessed, chunksCreated, skipped } }`. `kbImport` is present only when the import produced those counts; a rejected import has none, and absent means not known, never zero. A failure of the file sync itself carries no state.
- **`POST /v1/sync` and `POST /v1/consolidate`.** Status, code, `outcomes` rows and `Retry-After` are unchanged: `KB_REFRESH_FAILED` stays 500, and the typed Search failures stay 503 `SEARCH_LANES_UNAVAILABLE`, 503 `SEARCH_BUDGET_EXHAUSTED` or 500 `SEARCH_LANES_FAILED`. The body adds `error.commitState` and `error.commit`. The `KB_REFRESH_FAILED` message also says "the file sync committed" when the engine reported it. Both fields are rebuilt at the route from the documented fields only: an unrecognized state is dropped, a malformed or extended detail is dropped or cut to the documented fields, and no message, cause or driver text is forwarded. The generic `SYNC_FAILED`, `CONSOLIDATE_FAILED` and other route-coded 500 and 503 bodies carry the state the same way when the error states one; this also replaces the earlier handling that carried only `commitState: "unknown"`.
- **SDK, MCP and OpenAPI.** `MemongoClientError` gains `commitState` and `commit` (types `MemongoCommitState`, `MemongoSyncCommit`, `MemongoConsolidateCommit` and `MemongoCommitDetail`), parsed strictly and dropped when malformed. The MCP tool error payload and `structuredContent` carry both for `memongo_sync` and `memongo_consolidate`. The shared `ApiError` OpenAPI schema declares `commitState` and a `commit` union by `operation`, and the `/v1/sync` 500 and `/v1/consolidate` 500 and 503 descriptions say so.

### Not changed

- **Residues.** A consolidation that completes and then fails on the query-cache invalidation in the lifecycle `consolidate` is not annotated, so its error makes no commit claim. A consolidation run by the background job scheduler has no response to carry the report; the job record keeps the failure text and not the commit report. A `marker-write-failed` message still says the marker was not advanced, which an uncertain marker commit does not establish. `committed` can hold with every count zero (the file sync or the run's own row committed). `kbImport` counts are acknowledged work only. An error object that cannot take properties (frozen) cannot carry a report; that is logged. No real MongoDB or Atlas test covers these paths: the tests use the stateful in-memory fake.

## T11 follow-up: failure-matrix test gaps (#121)

Test gaps in the failure matrix (#121). This work adds tests only; no production behavior changed.

### Changed in the failure matrix

- **Decision needed 10 is removed.** `buildContextBundle` now has tests for its episode-summary health gate: an episodes Search index that is STALE or missing is a typed `index-stale` or `index-unavailable` row on the `episode-summary` section, the index is never queried, and the healthy sections survive. The consolidator's reasoning-chain trace is now tested: it carries the candidate event's own `agentId`, `scope` and `scopeRef`, and a candidate without a full tenant is promoted but not traced (E-37, E-41).
- **Decision needed 9 loses H-07 and H-08.** `POST /v1/discovery-projection` and `POST /v1/context-bundle` now have tests that map an `index-stale` and an `index-unavailable` failure to 503 `SEARCH_LANES_UNAVAILABLE` with the failure row in the body. Eighteen rows still read `no test:`.

## M2 final review fixes (review 1237)

### Retry hint on a denied `/v1/search`

- `POST /v1/search` and `POST /v1/search-detailed` now send `Retry-After` on the 503 `SEARCH_BUDGET_EXHAUSTED` that a denied admission produces, computed from the admission's `retryAfterMs`. The status and body are unchanged. The tests that pinned a 200 `degradation` marker for a throttled search used an envelope the engine never emits; they now use the engine's real shape, a failed `budget-denied` row beside the marker.

### No-fallback source guard

- `bun run check-no-fallbacks` follows a RegExp through aliases, later assignments and conditional or `??`/`||` picks, in any declaration order, before it judges a filter value. `const alias = pattern; collection.find({ body: alias })` is now rejected as `regexp-in-query`.

### Test-only cleanup

- `waitForSearchIndexesQueryable` moved out of the engine's production source into `packages/memory-engine/src/test-helpers/search-index-wait.ts`. Only e2e tests call it, and the engine no longer exports it.
- The e2e suite no longer expects the retired `idx_chunks_text` text index or a `$text` search. It now asserts that the chunks collection has no text index.

## Review fixes R1, R2, R5 (1237)

Fixes for the reviewer's blocking findings on #122. No index or collection is dropped, and no failure is relabeled as an empty success.

### R1: one request ledger at every retrieval boundary

- **Discovery, the context bundle and novelty.** `buildDiscoveryProjection`, `buildContextBundle` and `scanNovelty` each run on one request ledger with the configured `searchBudget` limits (12 aggregations and 5 embeds by default). Sibling sections and a nested search share it; the nested search still takes its admission token. A caller that already holds a ledger joins it. Previously each section, and each nested search, charged a ledger of its own or none.
- **An exhausted ledger is typed.** In discovery and the bundle, a section the ledger cannot pay for is a `budget-denied` failure row, as T8 defines. Novelty throws `SearchBudgetDeniedError`, and `POST /v1/novelty-scan` answers 503 `SEARCH_BUDGET_EXHAUSTED` with the row in the body and no `Retry-After`.
- **Novelty reserves every probe first, on a ledger sized to its work.** Each candidate's k-NN probe is one aggregation and one embed, and the scan reserves all of them before the first one runs. A public scan opens its own ledger of 30 aggregations and 30 embeds, its fixed candidate ceiling, as consolidation does for its probes, so the 12/5 request default never refuses it. A scan that joins a caller's ledger without room for every probe is refused with `budget-reservation`, and no probe runs.
- **Graph and episode Search are charged.** The graph lane's entity lookups and the episodic lane's episode Search run through the charged executor. Each attempt is one aggregation. Both lanes now retry an index warmup error, and a warmup that never ends is a typed `index-not-ready`; previously the driver error surfaced. The graph lane looks up at most 4 candidate entities and reserves that many aggregations; the episodic lane reserves 1. A multi-pass search whose ledger cannot also fit the graph reservation gets a typed reservation denial on the graph lane. The graph traversal (`$graphLookup`) is not a Search operation and is not charged.

### R2: index health for jobs and write decisions

- **One snapshot per request or job.** Public `scanNovelty` and `consolidate`, each background extraction job and each consolidation job take one request-local index-health snapshot. A job's search-budget row on the job now includes the health checks it made.
- **Every native probe checks its index.** Each check happens before the probe runs, against the snapshot:
  - novelty's k-NN probes check the events vector index;
  - the consolidator's similarity, dedup and prune probes check the structured-memory vector index;
  - its entity Search checks the events text index;
  - the supporting-event Search of a promotion decision checks the events text index.
- **What a failed check does.** An index that is STALE, missing or unreadable fails typed `index-stale` or `index-unavailable` at the `index-health` stage, and no probe runs. A job fails with retry state and keeps its events unacknowledged. A later request or job reads health again and recovers once the index is healthy.

### R5: the health metadata read is bounded

- **Bounded at the client.** The `$listSearchIndexes` read behind a health snapshot carries the driver's `timeoutMS` (5 s) and a local deadline of the same length, so a read that never settles cannot hang the request.
- **Expiry is typed.** A read that misses its bound is `index-unavailable` (`metadata-read-failed`), like any other failed metadata read. Previously the read carried only a server `maxTimeMS`, which does not bound a client that never gets a reply.

### Lead follow-ups at merge

- **Novelty's own ledger.** See R1 above: a default scan is no longer refused for having more than five candidates.
- **Manager creation errors are scrubbed.** A driver or boot error raised while `getMemorySearchManager` creates a manager, and a failure while it closes one, is logged and returned with any URI, host or database removed, as configuration refusals already were.
