# Behavior changes

Each entry names a behavior that changed or was removed, what replaces it, and
what a caller sees. Sections are per ticket; merge them in ticket order.

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
  where the call used to be a 200 with a throttle marker.
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
