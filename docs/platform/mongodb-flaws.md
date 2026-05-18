# MongoDB Flaws And Fix Ledger

This ledger records MongoDB-specific issues found during the world-class replay
work. It is intentionally blunt: fixed means patched and tested; blocked means
Memongo must not publish or advance benchmark gates until it is resolved.

## Fixed In `codex/memory-world-class-replay`

| Area | Finding | Resolution |
| --- | --- | --- |
| Atlas model rerank routing | `al-...` Atlas model keys and `pa-...` direct Voyage keys require different rerank hosts. | Canary preflight and engine rerank now route `al-...` to `https://ai.mongodb.com/v1/rerank` and `pa-...` to `https://api.voyageai.com/v1/rerank`. Strict mode fails on auth errors. |
| Auto-embed query model | Some MongoDB auto-embed `$vectorSearch` stages relied on the index model implicitly. | Query-time `$vectorSearch` stages now send `model: "voyage-4-large"` explicitly, matching the autoEmbed index model documented by MongoDB. |
| Atlas vector search limits | Managed Atlas rejected `$vectorSearch` pipelines where `limit` exceeded ANN `numCandidates`. Atlas Local Preview did not surface this as clearly. | `buildVectorSearchStage` now normalizes `limit` and `numCandidates` so ANN queries always satisfy `limit <= numCandidates <= 10000`, with a focused regression test. |
| Benchmark artifacts | `benchmark:status` pointed at a missing script. | Added `scripts/check-benchmark-status.ts` and tests so canary/full artifacts can be gated for warnings, degradations, empty results, partial scoring, parity envelope, and miss ledger presence. |
| Branch and artifact inventory | Branch state was tracked in chat instead of a repeatable command. | Added `bun run memory:inventory` to print truth/replay/source branch classification, merge-base status, dirty-file counts, and recent benchmark artifacts. |
| Cloud/local parity | Atlas cloud became the benchmark control lane, but docs and budget metadata still read as local-preview-only. | Added `bun run mongodb:parity`, documented managed Atlas cloud and Atlas Local Preview as first-class runtimes, and changed search-index budget reporting from `self-managed` to `unbounded`. |
| Fresh-prefix runtime preparation | A clean benchmark prefix could pass capability detection but fail parity because collections and Search/Vector indexes had not been created yet. | Added `bun run mongodb:prepare` to create collections, standard indexes, and all 14 Search/Vector indexes, then wait until they are queryable before a serious benchmark. |
| Search-index parity coverage | The runtime parity script checked 12 expected Search/Vector indexes, but the full product profile creates 14 including `query_cache_vector` and `entity_autocomplete`. | `getExpectedSearchIndexTargets` now matches the full product profile so parity checks validate all 14 live Search/Vector indexes. |
| Prefix/index visibility | Managed Atlas query-targeting alerts were hard to interpret because live namespace and index sprawl were not visible from a repeatable repo command. | Added `bun run mongodb:prefix-inventory`, a read-only inventory that reports collection prefixes, classic indexes, Search/Vector indexes, and active `mongot` COLLSCAN operations. |
| Benchmark background work | Raw/session retrieval canaries were blocked by product-grade post-write derivation jobs that belong in dogfood stress lanes, not raw retrieval scoring lanes. | Added `MEMONGO_BENCHMARK_DERIVED_WORK_MODE=disabled` for benchmark/canary agents only. It skips post-write extraction, entity graph updates, structured/procedure promotion checks, and episode triggers while preserving raw event/chunk projection and lane coverage. Non-benchmark agents still run full derived work. |
| Miss analysis | Failed retrieval cases did not expose enough candidate-level evidence. | Miss ledger now captures top-50 candidate traces with lane, canonical id, raw/fusion/rerank/final scores, and survival reason. |
| Lane crowding | Graph/procedure/structured evidence could crowd out session evidence in personal recall queries. | Added generic lane-aware controls: boost session/conversation evidence for personal and preference-style queries, cap graph/procedure/structured lanes unless query intent asks for them, and preserve lane metadata. |
| Result identity | Fusion/dedup could collapse results by snippet text instead of stable memory identity. | Added stable search-result identity keys for dedup and RRF. |
| Search index type drift | Existing Atlas Search index names with the wrong type could be treated as ready. | `ensureNamedSearchIndex` now verifies search vs vectorSearch compatibility and treats incompatible existing indexes as not ready. Auto-embed vector indexes are accepted as vectorSearch-compatible. |
| Graph fanout | `$graphLookup` was bounded, but dense direct relation sets could grow before the app-side trim. | Added a direct-root relation `$limit` before graph expansion branches. |
| Session evidence duplicates | Dedicated `session_chunks` mode could crash strict benchmarks when one scenario contained repeated records for the same session id. | Session-evidence document building now merges repeated conversation records into one document per session before writing to the unique `(agentId, sessionId)` index. |
| Atlas Local preview telemetry | Benchmark Atlas Local exited with a runner telemetry panic after shutdown. | Disabled Atlas Local telemetry in preview and benchmark compose files with `MONGODB_ATLAS_TELEMETRY_ENABLE=false`. |
| Preview config volume | The preview compose file mounted `/data/db` only; the image can require `/data/configdb` for key material. | Added a dedicated preview config volume. |
| Driver freshness | Memory engine was behind the requested MongoDB Node driver release. | Upgraded `mongodb` in `packages/memory-engine` to `7.2.0`. |
| Managed Atlas index sprawl | Live Atlas contained 22 Memongo collection prefixes and 700 collections, mostly old canary/diag/strict benchmark namespaces. A healthy managed prefix currently has about 30 collections, 115 classic indexes including `_id`, and 14 Search/Vector indexes. | Treat high total index counts as prefix sprawl until proven otherwise. Keep benchmark prefixes inventoried and clean stale namespaces only through an explicit cleanup policy; do not drop live prefixes ad hoc. |
| Managed Atlas hard reset | User approved starting from scratch after Atlas query-targeting alerts and prefix sprawl. Pre-reset state was 700 collections and 2,527 classic indexes in the `memongo` database. | Dropped the `memongo` database, then recreated one clean product prefix through the benchmark API path. Post-reset inventory has one prefix, 30 collections, 115 classic indexes, and parity `14/14` Search/Vector indexes ready. |
| Preference/advice evidence routing | Advice-style personal queries such as tips, suggestions, and "what should I..." did not trigger event-level conversation evidence, leaving session summaries to rank alone. | Route advice/recommendation/preference queries through the MongoDB Search/Vector conversation-evidence event lane. |
| Duplicate session crowding | Top-k could contain many event hits from the same session, wasting session-level recall slots in temporal/knowledge-update queries. | Added session diversity inside lane-aware controls so personal-memory top-k avoids duplicate-session flooding while preserving overflow evidence after the diverse top set. |

## Still Blocked

| Gate | Blocking Fact | Required Next Move |
| --- | --- | --- |
| Strict 48-case canary on reused local Atlas Preview volumes | Atlas Local Preview can OOM when many prior canary/e2e autoEmbed indexes and change streams accumulate in the same benchmark volume. A reused-volume smoke died with `OOMKilled=true` and the Atlas Local runner telemetry shutdown panic; fresh-volume strict smokes completed cleanly. | Run serious local benchmarks on a fresh benchmark volume (`docker compose ... down -v && ... up -d`) and keep the benchmark compose memory budget high enough. Do not interpret reused-volume OOM as retrieval quality. |
| Session evidence mode B as default | Dedicated `session_chunks` completed after the duplicate fix, but on the same strict 6-case slice it lowered internal R@5 from `0.5000` to `0.1389`. It helped multi-session and temporal cases, but hurt knowledge-update, preference, and single-session user/assistant cases. | Keep `MEMONGO_SESSION_EVIDENCE_MODE=B` as an ablation lane only. Do not enable by default until ranking can blend session docs without suppressing turn-level evidence. |
| Full 500 benchmark | Full run is locked until two strict 48-case runs pass the full-unlock gate. | Run two consecutive strict canaries with internal R@5 >= 0.85, official session RecallAny@5 >= 0.90, and every category >= 0.75. |
| Managed Atlas comparison | Local Atlas Preview is the target for local dogfood, but it is still a preview runtime. | Use managed Atlas as a control lane for serious benchmark comparison and to separate Memongo bugs from Atlas Local Preview runtime issues. |
| Managed Atlas query-targeting alert | Atlas reported `Query Targeting: Scanned Objects / Returned > 1000`. Live `$currentOp` showed active `mongot steady state sync` COLLSCAN operations on old canary namespaces, which MongoDB docs call out as a possible contributor to query-targeting alerts when Search indexes are maintained. | Do not add random indexes. First run `bun run mongodb:prefix-inventory`, preserve the active benchmark prefix, then clean stale benchmark prefixes only through an explicit approved cleanup step. |
| MongoDB MCP live cluster connection | Codex's MongoDB MCP server did not retain the supplied Atlas connection string in this session; `list-databases` still reports not connected. | Configure Codex MCP with `MDB_MCP_CONNECTION_STRING` or Atlas service-account credentials, then rerun MCP `list-databases`, index inspection, and `bun run mongodb:parity`. |

## Endpoint Verification

| Credential family | Correct endpoint | Verified result |
| --- | --- | --- |
| MongoDB Atlas model API key (`al-...`) | `https://ai.mongodb.com/v1/rerank` | Accepted by the rerank API. |
| Direct Voyage API key (`pa-...`) | `https://api.voyageai.com/v1/rerank` | Accepted by the rerank API. |
| MongoDB Atlas model API key (`al-...`) against direct Voyage | `https://api.voyageai.com/v1/rerank` | Rejected. |
| Direct Voyage API key (`pa-...`) against MongoDB Voyage API | `https://ai.mongodb.com/v1/rerank` | Rejected. |

The app and canary now route by key family. A disposable Atlas Local probe
created an `autoEmbed` index on `voyage-4-large` and returned query-time
`$vectorSearch` results. Fresh-volume strict 6-case canaries completed on local
Atlas Preview with no warnings or degradations after the endpoint/model fixes.
The remaining local risk is volume/resource hygiene and ranking quality, not
endpoint auth.

## Fresh Local Preview Smoke Results

| Run | Mode | Result | Notes |
| --- | --- | --- | --- |
| `strict-6-20260517-fresh-local-preview-model-explicit` | default turn/conversation evidence | `benchmark:status PASS`, 6/6 scored, emptyRate `0`, warnings `[]`, degradations `[]`, internal R@5 `0.5000`, session RecallAny@5 `0.5000` | Proves Atlas Local Preview + autoEmbed + rerank work with strict local infrastructure. Full-500 remains locked. |
| `strict-6-20260517-fresh-local-preview-session-b` | `MEMONGO_SESSION_EVIDENCE_MODE=B` before duplicate fix | failed strict | Correctly failed on duplicate `session_chunks` unique key; fixed by merging repeated session records. |
| `strict-6-20260517-fresh-local-preview-session-b-fixed` | `MEMONGO_SESSION_EVIDENCE_MODE=B` after duplicate fix | `benchmark:status PASS`, 6/6 scored, emptyRate `0`, warnings `[]`, degradations `[]`, internal R@5 `0.1389`, session RecallAny@5 `0.3333` | Infrastructure healthy, but ranking worse on this slice. Keep as ablation only. |

## Fresh Managed Atlas Control Results

| Run | Mode | Result | Notes |
| --- | --- | --- | --- |
| `targeted-misses-20260518T083000Z-atlas-cloud-vector-limit-fix-built` | managed Atlas, derived work disabled, session evidence B, JS merge, rerank off | 6/6 scored, emptyRate `0`, warnings `[]`, degradations `[]`, internal R@5 `0.6667`, internal R@10 `0.9167`, session RecallAny@5 `0.8333`, session RecallAny@10 `1.0000` | Infrastructure is clean after the vector limit fix. This targeted hard-miss slice still fails the full-500 unlock gate, so do not run full 500 yet. |
| `clean-start-smoke-20260518` | managed Atlas hard reset, one clean prefix, derived work disabled, session evidence B, JS merge, rerank off | 1/1 scored, emptyRate `0`, warnings `[]`, degradations `[]`, internal R@5 `1.0000`, session RecallAny@5 `1.0000` | Proves the post-reset database can recreate collections and all 14 Search/Vector indexes through the product benchmark path. Not publishable because build identity env was intentionally absent. |

## Verified With MongoDB Docs And MCP

- MongoDB Voyage docs confirm Atlas model API auth uses `Authorization: Bearer <model-api-key>`.
- MongoDB Voyage docs confirm MongoDB-hosted rerank requests use `https://ai.mongodb.com/v1/rerank`.
- MongoDB Vector Search docs describe automated embedding as Atlas-hosted and managed Voyage embedding models.
- MongoDB Voyage docs list `rerank-2.5`, `rerank-2.5-lite`, `rerank-2`, and `rerank-2-lite` as valid reranker models.
- MongoDB docs require `$vectorSearch` filter fields to be declared in the vector index for prefiltering.
- MongoDB docs constrain `$rankFusion` and `$scoreFusion` to supported same-collection input pipelines with explicit limits.
- MongoDB docs recommend bounded `$graphLookup`; Memongo now applies both MongoDB-side bounds and app-side lane caps.
- MongoDB MCP verified the local benchmark deployment is reachable after the compose fixes.

## Benchmark Rule

Fallback is failure. A run with missing indexes, rerank auth failure, auto-embed
failure, empty results, hidden degraded search, or a crashed MongoDB runtime is
not a retrieval result. It is an infrastructure failure artifact.
