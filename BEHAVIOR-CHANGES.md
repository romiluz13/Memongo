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
