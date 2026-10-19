# Memongo Capability Matrix

This matrix maps the supported Memongo memory engine to the standalone product surface that ships in this repo.

## Public contract

- Canonical HTTP request fields:
  - `query`
  - `limit`
  - `sessionKey` for search
  - `sessionId` for writes
  - `scopeRef` for profile synthesis
  - `agentId`
- Deprecated compatibility aliases still accepted during stabilization:
  - `q`
  - `maxResults`
  - `containerTag`

## Surface map

| Capability | Engine | Bridge | HTTP | SDK | Verification |
|---|---|---|---|---|---|
| Memory search | `packages/memory-engine/src/mongodb-manager.ts` `search()` | `packages/memory-bridge/src/memongo-bridge.ts` `memongoBridgeSearch()` | `POST /v1/search` | `packages/client/src/client.ts` `search()` | `apps/api/src/app.test.ts`, `packages/memory-engine` unit suite |
| Memory search (detailed) | `searchDetailed()` | `memongoBridgeSearchDetailed()` | `POST /v1/search-detailed` | `client.searchDetailed()` | production readiness E2E |
| KB search | `packages/memory-engine/src/mongodb-manager.ts` `searchKB()` | `memongoBridgeSearchKB()` | `POST /v1/search-kb` | `searchKB()` | `packages/memory-engine` unit suite |
| Memory reopen | `packages/memory-engine/src/types.ts` `readFile()` contract | `memongoBridgeReadFile()` | `POST /v1/read-file` | `readFile()` | `packages/memory-engine` unit suite |
| Conversation ingest | `writeConversationEvent()` | `memongoBridgeWriteConversationEvent()` | `POST /v1/write-event` | `writeEvent()` | `packages/memory-engine` unit suite |
| User-message shortcut | `writeConversationEvent({ role: "user" })` | `memongoBridgeAdd()` | `POST /v1/add` | `add()` | `apps/api/src/app.test.ts` |
| Structured memory | `packages/memory-engine/src/mongodb-structured-memory.ts` | `memongoBridgeWriteStructuredMemory()` | `POST /v1/write-structured` | `writeStructured()` | `packages/memory-engine` unit suite |
| Procedures | `packages/memory-engine/src/mongodb-procedures.ts` | `memongoBridgeWriteProcedure()` | `POST /v1/write-procedure` | `writeProcedure()` | `packages/memory-engine` unit suite |
| Profile synthesis | `packages/memory-engine/src/mongodb-profile.ts` | `memongoBridgeProfile()` | `POST /v1/profile` | `profile()` | `apps/api/src/app.test.ts`, `packages/memory-engine` unit suite |
| Context bundle | `packages/memory-engine/src/mongodb-context-bundle.ts` | `memongoBridgeBuildContextBundle()` | `POST /v1/context-bundle` | `buildContextBundle()` | `packages/memory-engine/src/mongodb-context-bundle.test.ts`, `apps/api/src/app.test.ts`, `scripts/proof-pack.ts`, `scripts/real-agent-smoke.ts` |
| Status | `status()` | `memongoBridgeStatus()` | `GET /v1/status` | `status()` | `apps/api/src/app.test.ts`, `scripts/proof-pack.ts` |
| Detailed status | `getDetailedStatus()` | `memongoBridgeGetDetailedStatus()` | `GET /v1/status/detailed` | `getDetailedStatus()` | `packages/memory-engine` unit suite |
| Stats | `stats()` | `memongoBridgeStats()` | `GET /v1/stats` | `stats()` | `scripts/proof-pack.ts` |
| Sync | `sync()` | `memongoBridgeSync()` | `POST /v1/sync` | `sync()` | `packages/memory-engine` unit suite |
| Embedding probe | `probeEmbeddingAvailability()` | `memongoBridgeProbeEmbedding()` | `GET /v1/probes/embedding` | `probeEmbedding()` | `scripts/proof-pack.ts` |
| Vector probe | `probeVectorAvailability()` | `memongoBridgeProbeVector()` | `GET /v1/probes/vector` | `probeVector()` | `scripts/proof-pack.ts` |
| Relevance explain | `packages/memory-engine/src/mongodb-relevance.ts` | `memongoBridgeRelevanceExplain()` | `POST /v1/admin/relevance/explain` | `relevanceExplain()` | `packages/memory-engine` unit suite |
| Relevance benchmark | `scripts/benchmark/mongodb-manager-benchmark.ts` | -- | -- | -- | `scripts/benchmark/*.test.ts` |
| Relevance report | `relevanceReport()` | `memongoBridgeRelevanceReport()` | `GET /v1/admin/relevance/report` | `relevanceReport()` | `scripts/proof-pack.ts` |
| Relevance sample rate | `relevanceSampleRate()` | `memongoBridgeRelevanceSampleRate()` | `GET /v1/admin/relevance/sample-rate` | `relevanceSampleRate()` | `packages/memory-engine` unit suite |
| Reasoning chain trace | `packages/memory-engine/src/mongodb-reasoning-chain.ts` | `memongoBridgeTraceChain()` | `POST /v1/chain-trace` | `traceChain()` | `packages/memory-engine` unit suite |
| Novelty scan | `packages/memory-engine/src/mongodb-novelty.ts` | `memongoBridgeScanNovelty()` | `POST /v1/novelty-scan` | `scanNovelty()` | `packages/memory-engine` unit suite |
| Consolidate (Dreamer) | `packages/memory-engine/src/mongodb-consolidator.ts` | `memongoBridgeConsolidate()` | `POST /v1/consolidate` | `consolidate()` | `packages/memory-engine` unit suite |
| Access tracking | `packages/memory-engine/src/mongodb-access-tracker.ts` (`AccessTracker`) | -- | -- | -- | `packages/memory-engine` unit suite |
| Importance decay | `computeImportanceDecay()` in `packages/memory-engine/src/mongodb-trust.ts` | -- | -- | -- | `packages/memory-engine` unit suite |
| Wiki source categorization | `wikiSource`/`vault`/`section` fields on KB schema | -- | -- | -- | `packages/memory-engine` unit suite |

## Memory coverage

| Memongo memory area | Active modules |
|---|---|
| Event sourcing and projection | `packages/memory-engine/src/mongodb-events.ts`, `packages/memory-engine/src/mongodb-manager.ts` |
| Retrieval planning | `packages/memory-engine/src/mongodb-retrieval-planner.ts` |
| Native hybrid search and fusion | `packages/memory-engine/src/mongodb-search.ts` (`$scoreFusion`, `$rankFusion`), `packages/memory-engine/src/mongodb-hybrid.ts` (query-side helpers) |
| Structured memory | `packages/memory-engine/src/mongodb-structured-memory.ts` |
| Procedures | `packages/memory-engine/src/mongodb-procedures.ts` |
| Profile synthesis | `packages/memory-engine/src/mongodb-profile.ts` |
| Context assembly | `packages/memory-engine/src/mongodb-context-bundle.ts`, `packages/memory-engine/src/mongodb-active-slate.ts`, `packages/memory-engine/src/mongodb-discovery-projections.ts` |
| Knowledge base | `packages/memory-engine/src/mongodb-kb.ts`, `packages/memory-engine/src/mongodb-kb-search.ts` |
| Graph and entities | `packages/memory-engine/src/mongodb-graph.ts`, `packages/memory-engine/src/mongodb-entity-extractor.ts` |
| Episodes | `packages/memory-engine/src/mongodb-episodes.ts` |
| Relevance and telemetry | `packages/memory-engine/src/mongodb-relevance.ts`, `packages/memory-engine/src/mongodb-telemetry.ts` |
| Reasoning chains | `packages/memory-engine/src/mongodb-reasoning-chain.ts` |
| Novelty detection | `packages/memory-engine/src/mongodb-novelty.ts` |
| Access tracking | `packages/memory-engine/src/mongodb-access-tracker.ts` |
| Importance decay | `packages/memory-engine/src/mongodb-trust.ts` |
| Consolidation (Dreamer) | `packages/memory-engine/src/mongodb-consolidator.ts` |
| Migration | `packages/memory-engine/src/mongodb-migration.ts` |

Search results are always produced by live retrieval. The legacy
`query_cache` collection remains only for TTL cleanup, write-side invalidation,
and tenant erasure while old rows age out.

## Retrieval capabilities

Retrieval needs MongoDB 8.3 or later with Search and Automated Embedding
(see [Deployment contract](self-host.md#deployment-contract)). Every retrieval
surface runs one native operation per lane: `$search`, `$vectorSearch`,
`$scoreFusion` or `$rankFusion`. A collection's text and vector inputs are
fused by the server. There is no classic `$text` stage, no `$regex` retrieval,
no merge of one collection's text and vector results in application code and
no tier ladder that answers with a weaker query when the planned one is
unavailable. The planner still ranks the results of different lanes against
each other with rank-based scores after each lane has answered.

| Surface | Lanes | Required Search indexes (default profile) | Native operation |
|---|---|---|---|
| Conversation memory | `hybrid:chunks`, `backstop:hybrid` | `chunks_text`, `chunks_vector` | `$scoreFusion` or `$rankFusion` over `$search` and `$vectorSearch`, chosen by `fusionMethod` |
| Session chunks | `hybrid:session_chunks` | `session_chunks_text`, `session_chunks_vector` | same fusion |
| Evidence mirror (when enabled) | `hybrid:memory_evidence` | `memory_evidence_text`, `memory_evidence_vector` | same fusion |
| Events | `raw-window`, `conversation-evidence`, `temporal-coverage`, `turn-precision` | `events_text`, `events_vector` | One `$search`, `$vectorSearch` or `$rankFusion` aggregate per lane |
| Structured memory | `structured`, `active-critical` | `structured_mem_text`, `structured_mem_vector`, `structured_mem_revisions_text` | `$vectorSearch`, then the planned `$search` follow-up below |
| Procedures | `procedural`, `backstop:procedural-exact`, `backstop:procedural` | `procedures_text`, `procedures_vector` | `$vectorSearch`, then the planned `$search` follow-up below |
| Knowledge base | `kb` | `kb_chunks_text`, `kb_chunks_vector` | `$scoreFusion` (minMaxScaler) or `$rankFusion` |
| Graph entities | `graph` | `entity_autocomplete` | `$search` autocomplete |
| Episodes | `episodic` | `episode_autocomplete` | `$search` autocomplete |

The LongMemEval search-index profile builds only the chunk, structured,
procedure and event indexes (plus the evidence mirror when enabled). A lane
whose collections the profile declares no index for is reported
`not-applicable` before it runs, never queried against an index that does not
exist.

### When a lane cannot run

| Condition | Result |
|---|---|
| Boot: an index is absent, building past the 180 s deadline, FAILED, STALE, of the wrong type or serving another definition | The process refuses to start with a typed `MemongoBootError` code. The API does not bind. |
| Request: an index the lane uses is observed absent, building, stale or unreadable | The lane fails typed (`index-missing`, `index-not-ready`, `index-stale` or `index-unavailable`). The route answers 503 `SEARCH_LANES_UNAVAILABLE`. |
| Request: the query or the driver fails | The lane fails typed (`query-error`, `query-timeout`, `dependency-unavailable` or `internal-error`). The route answers 500 `SEARCH_LANES_FAILED`, or 503 for a dependency outage. |
| Request: the search ledger denies the lane | The outcome row is `budget-denied`. The route answers 503 `SEARCH_BUDGET_EXHAUSTED` with `Retry-After` when the denial carries a retry hint. `/v1/search` keeps a 200 and carries the `degradation` marker instead. |
| Reranking is requested | Boot fails with `rerank-unsupported` when `reranking.enabled` or `MEMONGO_RERANKING_ENABLED` is true, and a request with `rerank: true` is rejected with the same code. Reranking is not part of the contract. |
| A healthy answer with no hits | `ok-empty` with reason `zero-hits`, a 200 and an empty result list. It is final, except for the planned follow-ups below. |

The two routes that are not search routes but run engine Search underneath,
`/v1/consolidate` and `/v1/probes/vector`, answer a typed Search failure with
the same statuses, codes and `outcomes` body. Any other error on them stays the
route's own generic 500.

A partial answer keeps every row: a lane that failed stays visible as a failed
row beside the lanes that answered, and the response `outcomes.status` is
`partial`. Per-route behavior and its tests are in
[`docs/m2/FAILURE-MATRIX.md`](../m2/FAILURE-MATRIX.md).

### Planned follow-ups after a healthy zero

These are the only operations that run after a lane answered with zero or few
hits. Each is a native Search operation listed in the plan, is charged to the
request's search ledger and appears as its own row in `outcomes`. None runs
after a failure or a budget denial.

| Follow-up | Runs when | Visible as |
|---|---|---|
| Structured `$search` tier | The `$vectorSearch` tier succeeded with zero hits | The vector tier row `ok-empty` with `zero-hits`, then an `atlas-search` tier row |
| Procedure `$search` tier | The `$vectorSearch` tier succeeded with zero hits | Same pair of rows |
| `backstop:procedural-exact` | The procedural path was available and no procedure hit was found, with no lane failed | A lane row of that name |
| `backstop:procedural` | The procedural path was not planned, the answer is short of `max(2, ceil(maxResults / 3))` results, the lane holds data and no lane failed | A lane row of that name |
| `backstop:hybrid` | The hybrid path did not run, the answer is short of `max(2, ceil(maxResults / 3))` results, the lane holds data, no lane failed, and the request is not itself a backstop | A lane row of that name |

## AutoEmbed quantization

`mongodb.quantization: "none"` omits the AutoEmbed field's `quantization`
option and preserves the server default. It does not request or guarantee
full-precision vectors. The existing configuration default is unchanged.

Explicit `"scalar"` or `"binary"` values are sent unchanged. A quantization
rejection during index creation or update now fails index setup instead of
silently retrying with the option omitted. Check the target deployment's
support before selecting an explicit value.

An accepted index definition alone does not prove retrieval readiness. Target
qualification must check READY/queryable state and each host's active
`statusDetail[].mainIndex.definition`, then exercise native text retrieval.
`latestDefinition` describes the submitted definition and is insufficient
as active-definition evidence. See MongoDB's [Automated Embedding](https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/)
and [List Search Indexes](https://www.mongodb.com/docs/manual/reference/operator/aggregation/listsearchindexes/).

## Proof path

- MongoDB runtime parity: `bun run mongodb:parity` with managed Atlas cloud, Atlas Local Preview, or both configured.
- `repo-foundation`: `bun run check-types`, `bun run lint`, `bun run build`, `bun run test`
- `api-contract`: `bun run proof-pack`
- `package-publishability`: `bun run check-publishability`
- `live-core`: `packages/memory-engine/src/production-readiness.e2e.test.ts`
- `live-capability`:
  - auto-embed/search: `packages/memory-engine/src/real-e2e-v2.e2e.test.ts` with managed Atlas cloud or `docker/docker-compose.yml` and an `al-...` Atlas Model key; MongoDB Automated Embedding is Preview and not for production use
  - replica-set-only features: `packages/memory-engine/src/mongodb-e2e.e2e.test.ts` with `docker/mongodb/docker-compose.mongodb.yml` `replicaset` or `fullstack`
- Benchmark methodology: [benchmark-pack.md](benchmark-pack.md)
