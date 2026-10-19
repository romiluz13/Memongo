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
