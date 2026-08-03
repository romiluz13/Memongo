# Performance & Scalability — Deep Review Findings

Scope: application-level request-path cost. Hot paths traced with round-trip (RT) counts.
A default `/v1/search` (cache miss, hybrid mode, rerank on) costs ~7 sequential network
phases: cache-exact findOne → estimatedDocumentCount → [semantic probe: 1 agg + 1 server-side
embed, ≤1.5s] → lane-coverage findOne → lanes (parallel, 2-6 aggs + 2-6 server-side embeds)
→ conversation-evidence (2 parallel aggs + 1 embed) → Voyage rerank HTTP → ~6 fire-and-forget
writes (telemetry ×2-3, recall trace, cache upsert, hit counters). Embedding mode is FORCED
to "automated" (`backend-config.ts:175-176`), so every `$vectorSearch` pipeline embeds the
query text server-side, independently.

## Findings

- [SEV: high] Empty-result "search storm": one sparse-query search can fire 30+ aggregations
  - Where: `packages/memory-engine/src/mongodb-search.ts:1098-1320` (waterfall), `packages/memory-engine/src/mongodb-manager.ts:10556-10700` (backstops), `packages/memory-engine/src/mongodb-manager.ts:3106`, `:3140`, `:3418` (legacySearch re-run)
  - What: `mongoSearch` waterfalls rankFusion → js-merge (2 parallel aggs, `mongodb-search.ts:1191`) → vector-only (`mongodb-search.ts:1242`, re-running the SAME vectorSearch js-merge already ran) → keyword → `$text` — up to 6 sequential aggregations for one lane when results are empty. On top, searchV2 adds a procedural-exact backstop, a procedural backstop, and a RECURSIVE hybrid backstop searchV2 (`mongodb-manager.ts:10660-10696`, which re-reads lane coverage and re-runs lanes). Then `search()`/`searchDetailed` re-run the entire thing via `legacySearch` (3-4 more mongoSearch waterfalls in parallel).
  - Why it matters: cost is inverse to data presence — cold tenants, fresh scopes, and hard queries (exactly the traffic a memory system must be cheap for) trigger the maximum possible work: dozens of aggregations and repeated server-side embeddings per user request. Under load this is an amplifier: the queries that return nothing burn the most mongo CPU and embedding quota.
  - Recommendation: stop after rankFusion returns empty for a lane (empty ≠ error); make the legacySearch fallback opt-in (or single cheap vector-only pass); dedupe the js-merge→vector-only double vector search; gate the recursive hybrid backstop behind "first pass returned zero AND lane coverage says data exists".

- [SEV: high] Query embedding amplified 4-6x per search, zero reuse
  - Where: `packages/memory-engine/src/backend-config.ts:175-176` (embeddingMode forced "automated"), `packages/memory-engine/src/mongodb-query-cache.ts:219-263` (probe embed), `packages/memory-engine/src/mongodb-manager.ts:10285-10460` (chunks+bridge lanes), `:10702` (evidence lane)
  - What: `embeddingMode` is hardcoded to the default regardless of config (`const embeddingMode: MemoryMongoDBEmbeddingMode = DEFAULT_MONGODB_EMBEDDING_MODE` — the `rawEmbeddingMode` above it is validated then ignored). Every `$vectorSearch` stage with `query: {text}` embeds the identical query string server-side: cache semantic probe, chunks pipeline, bridge pipeline, evidence pipeline, plus any structured/procedural/kb lane. Code comments measure one autoEmbed round trip at ~2.4s on Atlas (`mongodb-query-cache.ts:17-19`).
  - Why it matters: 4-6 paid embedding calls of the same text per user search. At 10x traffic the Voyage/mongot embedding rate limit is the first cliff, and each embed adds tail latency. There is no client-side query-embedding cache anywhere in the codebase (`.embedQuery(` is never called on request paths).
  - Recommendation: support passing a client-computed query vector (`queryVector` params already exist but are always `null` on the v2 path — e.g. `mongodb-manager.ts:2666`, `:10295`), embed once per request (or cache by normalized-query hash with TTL), and fan the vector out to all lanes; or collapse the chunks/bridge/evidence pipelines into one aggregation with `$facet`/`$rankFusion` so autoEmbed runs once.

- [SEV: high] Per-agent MongoClient fleet + 1s idle polling per agent
  - Where: `packages/memory-engine/src/search-manager.ts:15` (unbounded manager cache), `packages/memory-engine/src/mongodb-manager.ts:2186-2190` (`new MongoClient` per manager), `packages/memory-engine/src/backend-config.ts:253-257` (maxPoolSize 10, min 2), `packages/memory-engine/src/mongodb-manager.ts:331` (`MEMORY_JOB_POLL_MS = 1_000`), `:8633-8650` (drain: repairExtractionOutbox + claimMemoryJob per wake), `:8677-8688` (interval started at create, `:2394`)
  - What: each agentId gets a permanently cached manager with its OWN MongoClient (violates the one-client-per-process rule) and a job worker that, every second, runs `repairExtractionOutbox` (a find on events) plus `claimMemoryJob` (findOneAndUpdate with `w: "majority"`, `mongodb-memory-jobs.ts:15-18`) even when there is no work.
  - Why it matters: 50 agents = 50 clients × (10+2) connections = 600 server connections (~600MB mongod RAM) and ~100 ops/s of pure idle polling with majority write concern. This breaks first at 10x multi-tenant scale, before any query path does.
  - Recommendation: share ONE MongoClient across managers (db/collection prefix already isolates tenants); evict idle managers from `MONGODB_MANAGER_CACHE` (LRU + TTL, closing the worker); replace 1s polling with wake-on-write (the wake channel exists — `wakeMemoryJobWorker`) plus a slow (30-60s) backstop sweep, or a change stream on the jobs collection.

- [SEV: high] Write path: ~9-13 sequential RTs per event, all writes globally serialized
  - Where: `packages/memory-engine/src/mongodb-manager.ts:8838-9057` (writeConversationEvent), `:9096` (`this.writeQueue.then(execute, execute)`), `packages/memory-engine/src/mongodb-derived-memory.ts:492-510` (per-candidate findOne + findSupportingEventIds N+1)
  - What: one event write serially awaits: transaction(insert event + insert job, majority) → chunk upsert + markProjected (2 RT, `mongodb-events.ts:517-539`) → entity bulkWrite → `releaseStagedMemoryJob` (`:8966`) → `clearEventExtractionJobPending` → `schedulePostWriteDerivations` (`:9006`) → `invalidateQueryCache` deleteMany (`:9017`) → per-candidate existence findOne + supporting-event query loop (just to COUNT lane coverage) → `updateLaneCoverage` (`:9080`). Every write for an agent funnels through a single promise queue.
  - Why it matters: single-writer throughput ≈ 10-20 events/s/agent, and `/v1/import/conversations` (`mongodb-manager.ts:6290-6321`) pushes every turn through this same serial pipeline — no bulk insert path exists for production ingest (fastIngest is benchmark-gated). Bulk-loading 10k turns = ~100k sequential RTs.
  - Recommendation: add a batch write API (`/v1/write-events`) that does insertMany for events + one bulkWrite for chunks/jobs/coverage; make lane-coverage counting regex-only (skip the per-candidate DB existence checks — the counts only feed planner hints); make cache invalidation debounced/scope-level instead of per-write deleteMany.

- [SEV: medium] Query cache: semantic probe serialized before every miss; no stampede protection
  - Where: `packages/memory-engine/src/mongodb-query-cache.ts:202-263`, called from `packages/memory-engine/src/mongodb-manager.ts:2925-2970`
  - What: on every exact-miss with a non-empty cache, the search pays estimatedDocumentCount + a full autoEmbed `$vectorSearch` probe (up to `SEMANTIC_PROBE_MAX_TIME_MS = 1_500`, line 17) BEFORE retrieval starts. There is no single-flight: N concurrent identical queries all miss, all run full searches, and only the writeCache upsert dedups. Invalidation is a per-write deleteMany for the whole agent+scope (`mongodb-manager.ts:9017`), so write-heavy agents hold the cache permanently near-empty (hit rate → 0) while still paying 2 extra RTs per miss.
  - Why it matters: worst case adds ~1.5s + 2 RTs to every cache-miss search; under concurrent load the same expensive search is computed redundantly.
  - Recommendation: run the semantic probe concurrently with the retrieval lanes and cancel on lane success (or drop tier-2 to opt-in); add an in-flight request coalescing map keyed by the cache hash; skip tier-2 probe when recent invalidation rate exceeds a threshold.

- [SEV: medium] No upper cap on result limits for the main search endpoints
  - Where: `apps/api/src/routes/v1.ts:105-111` (`readLimit` passes any number through), `:819-845` (/search), `:846-877` (/search-kb), `:1228` (/search-detailed); `packages/memory-engine/src/mongodb-manager.ts:2895` (`maxResults = opts?.maxResults ?? 10`, no clamp)
  - What: `/v1/search` with `{"limit": 100000}` flows straight into aggregation `$limit` and the JSON response (full snippets). Admin/list endpoints are clamped (MAX_LIST_LIMIT=100, `v1.ts:59-89`; recall-conversation MAX_LIMIT=200, `mongodb-conversation-recall.ts:32-40`) — the main endpoints are not.
  - Why it matters: one unbounded request can move hundreds of MB through mongo → API → client; trivially weaponizable past the 1MB body cap since the limit is output-side.
  - Recommendation: clamp to a hard max (e.g. 100) at readLimit/manager level, consistent with the admin endpoints.

- [SEV: medium] Background extraction is strictly serial per agent
  - Where: `packages/memory-engine/src/mongodb-manager.ts:8633-8650` (claim ONE job per drain iteration), `packages/memory-engine/src/mongodb-derived-memory.ts:853` (per-event LLM call, 30s timeout per `mongodb-manager.ts:9343` comment)
  - What: the worker claims a single job at a time; each job does multiple majority-writeConcern updates (`mongodb-memory-jobs.ts:79-190`) plus entity/structured/procedure promotions, and — when an enrichment provider is configured — one LLM `extractSessionEnrichment` call per event.
  - Why it matters: with LLM extraction on, each job takes seconds; a chatty agent writing 1 event/s accumulates an unbounded extraction backlog that the 1s poll can never drain. Cost amplification is also per-event LLM spend with no batching (contrast: benchmark ingest batches sessions with a concurrency pool, `mongodb-llm-enrichment.ts:909-952`).
  - Recommendation: claim up to K jobs concurrently per worker (K=3-5), and batch LLM extraction across pending events of the same session like `enrichSessionsWithLLM` does.

- [SEV: medium] Episodic lane runs `$regex` scans on the request path
  - Where: `packages/memory-engine/src/mongodb-episodes.ts:542-544` (`$or: [{title: {$regex}}, {summary: {$regex}}]`), invoked from the searchV2 episodic lane `packages/memory-engine/src/mongodb-manager.ts:10251`
  - What: keyword-aware regex over title+summary; limit 50 caps output but the scan itself is unindexed (regex is not prefix-anchored).
  - Why it matters: every search whose planner picks the episodic path COLLSCANs the episodes collection; violates the never-`$regex`-for-search rule and grows linearly with episode count.
  - Recommendation: Atlas Search `$search` on title/summary (an index exists pattern-wise for other lanes), or a prefilter on agentId/scope with an indexed sort before regex.

- [SEV: medium] Telemetry/recall-trace write amplification on the read path
  - Where: `packages/memory-engine/src/mongodb-telemetry.ts:62-70` (insertOne per op), `packages/memory-engine/src/mongodb-manager.ts:2937-2970` (cache-check telemetry + recall trace per search), `:3039-3078` (search telemetry + trace), `mongodb-query-cache.ts:167-178,292-304` (hit-count update + cache upsert per check/write)
  - What: one read search issues ~5-7 fire-and-forget writes: cache-check telemetry, search telemetry, query-rewrite telemetry, rerank telemetry, recall trace insert, cache upsert, hit-count update. Access tracking is properly batched (flush 60s/10 items, `mongodb-access-tracker.ts:88-96`) — telemetry is not.
  - Why it matters: at 10x read load, telemetry+trace write throughput exceeds the event write path these systems were built to observe; time-series collections churn on every request.
  - Recommendation: batch telemetry like the access tracker, or sample (e.g. 10%) outside benchmark mode.

- [SEV: low] Sequential phases that could be parallel inside searchV2 and context-bundle
  - Where: `packages/memory-engine/src/mongodb-manager.ts:10702-10744` (conversationEvidence → temporalCoverage → turnPrecision awaited in series; the first two are independent), `packages/memory-engine/src/mongodb-context-bundle.ts:768-800` (discovery-projection and profile awaited after the main Promise.all though independent)
  - What: main lanes are correctly parallel (`mongodb-manager.ts:10556`), but the follow-on evidence searches serialize 1-2 extra aggregation+embed phases; context-bundle's optional sections add a serial RT each.
  - Recommendation: launch conversationEvidence and temporalCoverage in one Promise.all; fold discovery/profile into the bundle's first Promise.all gated on their flags.

- [SEV: low] Fixed numCandidates default 500 = 50x limit; recipes override but ad-hoc calls don't
  - Where: `packages/memory-engine/src/mongodb-manager.ts:9858` (`numCandidates ?? 500`), `packages/memory-engine/src/backend-config.ts:318-324` (env default 500)
  - What: default maxResults 10 with numCandidates 500 = 50x, above the 10-20x recall guidance; `resolveProfileNumCandidates` only helps recipe-driven requests.
  - Recommendation: derive numCandidates from the effective limit (20x, min 100) instead of a flat 500.

- [SEV: low] Unbounded collection loads off the hot path
  - Where: `packages/memory-engine/src/mongodb-sync.ts:85` (`getStoredFiles` loads ALL file-metadata docs per namespace into a Map every sync), `packages/memory-engine/src/mongodb-kb.ts:570` (`listKBDocuments` unbounded find — currently only used by `scripts/real-capability-stress.ts:723`), `packages/memory-engine/src/mongodb-analytics.ts:127` (all file paths for /v1/stats)
  - Recommendation: cursor-stream the sync diff; add limits/pagination to listKBDocuments before it gets a route.

## Positive notes (verified, do not "fix")

- Lanes execute concurrently with deterministic merge order: `mongodb-manager.ts:10556`.
- Hybrid sub-searches (chunks + bridge + session_chunks + memory_evidence) run in one Promise.all: `mongodb-manager.ts:10460`.
- Graph expansion is NOT N+1: 4 parallel autocomplete aggs + parallel forward/reverse $graphLookup + one `$in` entity fetch: `mongodb-graph.ts:939-1160`.
- Entity upserts batched via bulkWrite: `mongodb-graph.ts:1479`.
- Reranker is a single batched HTTP call with 2s timeout and order-preserving fallback: `mongodb-reranker.ts:120-145`.
- Query rewriter is deterministic, zero-RT: `mongodb-query-rewriter.ts:98-152`.
- LLM enrichment batches sessions with a bounded worker pool + retry/backoff: `mongodb-llm-enrichment.ts:784-952`; LLM extraction is kept OFF the synchronous write path: `mongodb-manager.ts:9343`.
- Job queue uses atomic findOneAndUpdate claim + lease + backoff: `mongodb-memory-jobs.ts:79-140`.
- Consolidator bounds its batch and its $facet orient scan: `mongodb-consolidator.ts:354-360,407-440`.
- API auth/rate-limit middleware is pure CPU (no per-request DB hit); body parse cached across layers: `apps/api/src/scope-identity.ts:40-63`. MCP server reuses ONE module-level client: `apps/mcp/src/server.ts:10-14`. Manager init is single-flighted: `search-manager.ts:69-86`.

## Top 5

1. Empty-result search storm — waterfalls + backstops + legacy re-run: `mongodb-search.ts:1098-1320`, `mongodb-manager.ts:3106`.
2. Query embedding amplified 4-6x per search, mode forced server-side: `backend-config.ts:175-176`.
3. Per-agent MongoClient fleet + 1s idle polling: `search-manager.ts:15`, `mongodb-manager.ts:331,2186`.
4. Serial ~9-13 RT write path behind a global per-agent write queue: `mongodb-manager.ts:8838-9096`.
5. Cache semantic probe (≤1.5s embed) serialized before every miss, no single-flight: `mongodb-query-cache.ts:202-263`.

## Harmony note

The performance pieces are individually well-engineered — parallel lanes, batched writes, atomic job claims, careful timeouts — but they are all ON by default and they stack multiplicatively: cache probe → planner → lanes → evidence → rerank → telemetry each add phases to one request, and the fallback machinery (mongoSearch waterfall → backstops → legacySearch) multiplies worst-case cost exactly when data is absent. The seams that fight each other: the forced "automated" embedding mode blocks the query-vector reuse the lane fan-out needs; the query cache's freshness correctness (invalidate on every write) fights its own hit rate; per-agent managers give clean tenant isolation but fragment connections and pollers against the shared mongo they all talk to. A single shared client, one query embedding per request, and a budget (max RTs/embeds per search) enforced in searchV2 would realign the parts into one organism.

## Out-of-scope sightings

- `packages/memory-engine/src/mongodb-consolidator.ts` and `mongodb-episodes.ts` contain literal NUL bytes (offset ~29443 / ~5003) — ripgrep treats them as binary; whatever injected those bytes may affect tooling (for the code-quality agent).
- `packages/memory-engine/src/mongodb-manager.ts` is 334KB / 11,266 LOC — the search orchestrator, write path, benchmark harness, and job worker all live in one file (for the maintainability agent; guideline says ~500 LOC).
- `$graphLookup` fan-out, index shapes, and ESR order are the indexing agent's depth; noted here only where the app triggers them per request (graph lane: up to 7 aggregations per graph-path search).
