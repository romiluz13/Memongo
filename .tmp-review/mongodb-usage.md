# MongoDB Usage — Deep Review Findings

Status: COMPLETE

## Findings

### mongodb-schema.ts (DONE — full file read, every index cataloged)

Index catalog (standard, per collection): chunks 4, files 1(TTL), knowledge_base 5, kb_chunks 4, structured_mem 11, structured_mem_revisions 1-2, relevance_runs 3, relevance_artifacts 2, relevance_regressions 2, events 10, entities 6, relations 6, entity_links 2, episodes 5, ingest_runs 1, projection_runs 1, procedures 6, procedure_revisions 1, query_cache 3, telemetry 2, access_events 2, memory_mutations 3, lane_coverage 1, consolidation_runs 1, recall_traces 2, memory_jobs 4, session_chunks 3, memory_evidence 4. Search indexes: 14-16 per prefix (text+vector on chunks/kb_chunks/structured_mem/procedures/events/session_chunks + query_cache vector + entities autocomplete), all autoEmbed (voyage-4-large).

- [SEV: medium] Duplicate identical-key unique indexes on structured_mem
  - Where: `packages/memory-engine/src/mongodb-schema.ts:1763` and `packages/memory-engine/src/mongodb-schema.ts:2155`
  - What: `uq_structured_agent_scope_scoperef_type_key` ({agentId,scope,scopeRef,type,key}, unique) and `uq_structured_agent_scope_scoperef_type_key_v2` (identical key pattern, unique, sparse) are BOTH created on the same collection. The drops at 1755-1762 target the older names only; the v1 5-field index is never dropped.
  - Why it matters: two indexes with identical key patterns on one collection is pure write-amplification — every insert/update maintains both B-trees. MongoDB docs: a compound index makes its own duplicate redundant; this is the most expensive collection (hot writes).
  - Recommendation: drop the non-sparse v1 index after the v2 sparse index exists (or drop v2 — but keep exactly one).

- [SEV: medium] Redundant prefix indexes: idx_chunks_path, idx_structured_agentid, idx_relations_agent_scope_scoperef
  - Where: `packages/memory-engine/src/mongodb-schema.ts:1643` ({path:1} vs {path:1,hash:1} at 1646), `packages/memory-engine/src/mongodb-schema.ts:1780` ({agentId:1} vs {agentId:1,scope:1,scopeRef:1,type:1,key:1} at 1763), `packages/memory-engine/src/mongodb-schema.ts:2051` ({agentId,scope,scopeRef} vs uq_relations_identity {agentId,scope,scopeRef,fromEntityId,...} at 2022)
  - What: three indexes whose full key pattern is a strict prefix of another index on the same collection.
  - Why it matters: MongoDB official guidance — {a,b} makes {a} redundant; each extra index costs write throughput and RAM. structured_mem already carries 11 indexes, near the practical per-collection ceiling.
  - Recommendation: drop the three prefix indexes; the compound indexes serve the same queries.

- [SEV: low] Dead index-budget machinery
  - Where: `packages/memory-engine/src/mongodb-schema.ts:4118` (PROFILE_BUDGETS typed Record<profile,"unbounded">), used at 2875 and 3196
  - What: `assertIndexBudget` can never return withinBudget=false because every profile maps to "unbounded"; the reducedBudget fallback path (create only chunks indexes) is unreachable code.
  - Why it matters: the safety valve it claims to provide (free-tier index cap) does not exist; dead branches mislead operators reading logs.
  - Recommendation: either give community/free profiles a numeric budget or delete the budget layer.

- [SEV: low] scoreFusion version gate one minor too strict
  - Where: `packages/memory-engine/src/mongodb-schema.ts:4210` (`hasServerVersionAtLeast(versionArray, 8, 3)`)
  - What: $scoreFusion is documented as new in MongoDB 8.2, but the gate requires 8.3, so 8.2 clusters needlessly fall back. (rankFusion gate at 8.1 matches the docs.)
  - Recommendation: gate scoreFusion at >= 8.2.

- [SEV: info/good] Search-index hygiene is otherwise strong: drift detection via code-owned signature (2749), per-collection filter fields declared in every vector index definition, idempotent ensureNamedSearchIndex with updateSearchIndex, readiness polling, graceful degradation when Search Index Management is unavailable.

### mongodb-manager.ts (DONE — connection factory, transaction, close, and all query/write shapes covered via targeted reads of an 11,266-line file)

- [SEV: high] One MongoClient (and pool) per agentId — unbounded client/pool growth in multi-tenant API use
  - Where: `packages/memory-engine/src/search-manager.ts:14` (MONGODB_MANAGER_CACHE keyed by agentId+config), `packages/memory-engine/src/mongodb-manager.ts:2192` (`new MongoClient` inside `MongoDBMemoryManager.create`)
  - What: every distinct agentId gets its own `MongoDBMemoryManager`, each creating its own MongoClient with its own connection pool (default maxPoolSize 100). The cache is only emptied by `closeAllMemorySearchManagers()` (search-manager.ts:113); there is no eviction.
  - Why it matters: MongoDB official guidance — ONE MongoClient per process. With N agents the process holds N clients × (maxPoolSize+2) connections; server RAM cost ≈ 1MB per connection. An API server serving many agents can exhaust mongod connections. Each new agent also re-runs ensureCollections/ensureStandardIndexes/ensureSearchIndexes (mongodb-manager.ts:2211-2240) on first touch.
  - Recommendation: share one MongoClient/Db across managers (factory accepts a shared client), keep per-agent state in the manager object; only per-agent caches remain.


- [SEV: medium] readConversationChunk/readBridgeChunk query shape has no supporting index
  - Where: `packages/memory-engine/src/mongodb-manager.ts:6958-6976` and `7055-7066` — filter `{path, source: {$in:...}, agentId, ...}` sorted by `{startLine: 1}`; chunks indexes are only `{path:1}`, `{path:1,hash:1}`, `{updatedAt:-1}`, `{text:"text"}` (mongodb-schema.ts:1643-1655)
  - What: agentId and startLine are not indexed on chunks; every chunk read filters on path (indexed) then in-memory-filters agentId and in-memory-sorts startLine.
  - Why it matters: not a COLLSCAN, but read amplification proportional to chunks-per-path across ALL agents sharing that path; violates "every hot query shape needs a supporting index" (ESR: agentId+path equality, startLine sort).
  - Recommendation: add `{agentId:1, path:1, startLine:1}` (or `{path:1, agentId:1, startLine:1}`) on chunks.

- [SEV: medium] relation: locator scans and JS-matches up to 50 relations per read
  - Where: `packages/memory-engine/src/mongodb-manager.ts:6735-6755`
  - What: `find({agentId, scope, scopeRef}, sort {updatedAt:-1}, limit 50)` then JS string-matches `${fromEntityId}-${toEntityId}`. updatedAt is not in any relations index, so the server sorts the tenant's full relation set in memory before limiting.
  - Why it matters: O(tenant relations) in-memory sort per locator read; the string-concat identity can also collide/miss when ids contain "-".
  - Recommendation: store a relationId field, index it, and findOne by it.

- [SEV: info/good] Connection lifecycle otherwise exemplary: timeouts/pool all configurable (2166-2190), ping-verify on connect with cleanup on failure (2193-2207), outbox write wrapped in session.withTransaction with MAJORITY_TRANSACTION_OPTIONS and graceful fallback to non-transactional writes on standalone (8890-8925), thorough ordered shutdown draining queues before client.close() (9157-9228), batched insertMany in sync (4379, 5652). Targeted $set/$inc used for counters (6504-6509, 6654-6659).

### Search pipeline: mongodb-search.ts, mongodb-search-executor.ts, mongodb-retrieval-planner.ts (DONE)

- [SEV: info/good] $vectorSearch usage is textbook: always first pipeline stage (mongodb-search.ts:643, 833, 963; mongodb-query-cache.ts:233), numCandidates defaults to 20× limit and is clamped to [limit, 10000] (mongodb-search.ts:518-540, 632), every prefilter field is declared as type:"filter" in the index definitions (mongodb-schema.ts:3520+, 3600+, 3708+, 3803+, 3904+), ENN mode correctly omits numCandidates with exact:true (mongodb-search.ts:566). Hybrid search uses $scoreFusion / $rankFusion gated on detected server capabilities with a documented JS-merge fallback chain and a $text last resort for community/no-mongot (mongodb-search.ts:1090-1355). Embedding is server-managed autoEmbed (voyage-4-large) so numDimensions/similarity consistency cannot drift — and the manual embedding path is rejected at config time (backend-config.ts:195-201).

- [SEV: low] "fast" recipe numCandidates=20 with maxResults=5 is a 4× ratio
  - Where: `packages/memory-engine/src/mongodb-search-executor.ts:88-99`
  - What: the fast recipe sets numCandidates 20, limit 5 (4×); MongoDB guidance is 10-20× limit for HNSW recall.
  - Why it matters: on the recipe explicitly tuned for latency this may be intentional, but recall silently degrades vs other lanes using 20×.
  - Recommendation: raise to ≥ 10× (50) or document the trade-off.

- [SEV: low] Six BSON $text indexes kept as fallback despite Atlas Search being the primary lane
  - Where: `packages/memory-engine/src/mongodb-schema.ts:1655, 1746, 1798, 1979, 2131, 2215`
  - What: every text-searchable collection carries a legacy BSON $text index used only by the last-resort fallback (mongodb-search.ts:1318-1355) and getEpisodesByType-style paths never use it.
  - Why it matters: $text indexes are among the most expensive indexes to maintain on writes; six of them exist for a fallback that only fires on mongot-less community deployments.
  - Recommendation: create the $text indexes only when search index management is unavailable (they are created unconditionally today, even on Atlas-managed).

### Graph / procedures / episodes / query-cache (DONE)

- [SEV: medium] $regex used for entity and episode search despite dedicated Atlas Search indexes
  - Where: `packages/memory-engine/src/mongodb-graph.ts:861-878` (`$or: [{name: {$regex}}, {aliases: {$regex}}]` case-insensitive), `packages/memory-engine/src/mongodb-episodes.ts:538-566` (`$or: [{title: {$regex}}, {summary: {$regex}}]`)
  - What: findEntitiesByName and searchEpisodes run non-anchored case-insensitive regexes. An `entity_autocomplete` Atlas Search index (mongodb-schema.ts:2855-2880) and episodes text indexes exist specifically for these lookups but are not used here.
  - Why it matters: MongoDB official guidance — never $regex for search use cases; non-prefix regex cannot use indexes, so each query scans the agent's full entity/episode set. The regexes are also user-influenced (escaped, so no injection, but unbounded alternation cost).
  - Recommendation: route entity lookup through $search autocomplete (fall back to regex only when textSearch capability is false); same for episodes via idx_episodes_text/$search.

- [SEV: low] getEpisodesByType / getEpisodesByTimeRange / findEntitiesByName sort by updatedAt:-1 with no supporting index
  - Where: `packages/memory-engine/src/mongodb-episodes.ts:495-501, 566-572`; episodes indexes have no updatedAt key (mongodb-schema.ts:2099-2135); entities likewise (mongodb-graph.ts:876, 911)
  - What: in-memory sort of the agent's full episode/entity set per query before limit.
  - Recommendation: add `{agentId:1, type:1, updatedAt:-1}` on episodes (or reuse ESR-ordered compound) and `{agentId:1, updatedAt:-1}` on entities, or drop the sorts.

- [SEV: info/good] Graph expansion avoids the $facet 100MB-per-branch trap with two separate aggregations and puts $match+$limit before $graphLookup with restrictSearchWithMatch (mongodb-graph.ts:1015-1109). Entity/relation ingestion uses unordered bulkWrite upserts (mongodb-graph.ts:1592-1717). Procedures evolutionHistory is bounded with $push+$slice:-20 (mongodb-procedures.ts:1109-1119). Query cache: exact tier hits the unique index precisely; semantic tier is maxTimeMS-capped; writes are fire-and-forget upserts with TTL via expiresAt:0-index. Zero replaceOne and zero .skip() anywhere in the engine — no full-document read-modify-write replaces, no deep-skip pagination.

### Consistency & config (DONE)

- [SEV: high] Default collectionPrefix is per-agent → collection and search-index sprawl per tenant
  - Where: `packages/memory-engine/src/backend-config.ts:228` (`collectionPrefix ?? \`memongo_${sanitizeName(params.agentId)}_\``)
  - What: by default every agentId gets its own full set of ~30 collections AND ~14 search indexes, while every document already carries agentId/scope/scopeRef and every index leads with agentId.
  - Why it matters: MongoDB's unnecessary-collections anti-pattern at scale. N agents = 30N collections + 14N search indexes; mongot search-index count and WiredTiger catalog scale linearly with tenant count. Atlas clusters have practical search-index ceilings; a 100-agent deployment would attempt 1,400 search indexes and 3,000 collections. The per-agent MongoClient fan-out (search-manager.ts) compounds it.
  - Recommendation: default to a single shared prefix and rely on the already-present agentId document-level isolation; keep per-agent prefix as an opt-in hard-isolation mode.

- [SEV: low] Dead config surface: numDimensions/quantization accepted and warned on, then ignored
  - Where: `packages/memory-engine/src/backend-config.ts:247-252` (default 1024, F22 warning at 533-545) vs `packages/memory-engine/src/mongodb-schema.ts:3186-3189` (`void embeddingMode; void quantization; void numDimensions`)
  - What: config validates numDimensions against known models but ensureSearchIndexes discards all three values because autoEmbed is server-managed.
  - Why it matters: operators can set numDimensions and believe it does something; only a startup warning hints otherwise.
  - Recommendation: remove the knobs or make the warning an error-level "ignored" log.

- [SEV: info/good] Collection access is centralized: every module uses the mongodb-schema.ts accessors; only 3 ad-hoc db.collection() calls outside it (mongodb-reasoning-chain.ts:138, mongodb-novelty.ts:118, benchmark cleanup in mongodb-manager.ts:5092). Pool defaults are deliberately small (maxPoolSize 10, minPoolSize 2, connectTimeout/serverSelection 10s — backend-config.ts:253-317) which is sane for a library client.

### Docker stack & scripts (DONE — all compose files, mongod.conf, mongot.conf, init-mongo.sh, setup-generator.sh, start*.sh, and the three scripts read)

- [SEV: high] docker-compose.mongodb.yml replicaset/fullstack tiers never initiate the replica set
  - Where: `docker/mongodb/docker-compose.mongodb.yml:64-68` (mongod launched with `--config /etc/mongod.conf` where mongod.conf:9 sets `replSetName: rs0`), `docker/mongodb/init-mongo.sh` (creates users only — no rs.initiate), and a repo-wide search finds NO `rs.initiate`/`replSetInitiate` anywhere in scripts/, docker/, or packages/
  - What: mongod starts with a replSet name configured but the set is never initiated. `mongot.conf:3-9` declares `syncSource.replicaSet` pointing at this mongod — mongot replicates via the oplog, which does not exist until initiation.
  - Why it matters: the replicaset and fullstack tiers of the documented community stack cannot deliver transactions, change streams, or (for fullstack) any search index sync — the exact features start.sh:44-76 advertises. Additionally `--replSetMember=memongo-mongod.memongo-net:27017` (compose line 67) is not a documented mongod option (`--replSet` is); if the server rejects it, mongod fails to start at all — verify against the pinned image.
  - Recommendation: add an init container/healthcheck hook that runs `mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"memongo-mongod.memongo-net:27017"}]}])'` (idempotent), and drop or verify `--replSetMember`.

- [SEV: medium] No image version pinning anywhere in the docker stack
  - Where: `docker/mongodb/docker-compose.mongodb.yml:41,58` (`mongodb/mongodb-community-server:latest`, `mongodb/mongodb-community-search:latest`), `docker/mongodb/docker-compose.mongodb.yml:19` (`alpine:latest`), `docker/mongodb/docker-compose.preview.yml:21` and `docker/docker-compose.full.yml:53` (`mongodb/mongodb-atlas-local:preview` — a floating preview tag), `docker/docker-compose.minimal.yml:5` (`mongo:7`)
  - What: every image floats on latest/preview. Engine capabilities are version-gated (rankFusion 8.1+, scoreFusion 8.3+ gates in mongodb-schema.ts:4210-4211), so a floating tag can silently change which retrieval lanes exist between two `compose up` runs.
  - Recommendation: pin digests/minor tags (e.g. `:8.0.x`, and a dated atlas-local tag) and record the tested matrix in compose comments.

- [SEV: medium] Local-dev parity trap: docker-compose.minimal.yml ships mongo:7 standalone — silently the worst backend
  - Where: `docker/docker-compose.minimal.yml:5`
  - What: mongo:7 standalone: no mongot (no $search/$vectorSearch/hybrid — capability detection degrades every query to the $text last-resort), no replica set (no transactions/change streams), and two major versions behind the 8.x the engine is tuned for (autoEmbed voyage-4-large indexes cannot even be created — ensureSearchIndexes will warn and return vector:false).
  - Why it matters: a user following the minimal path gets a "working" deployment with semantic memory silently disabled; the only signal is log warnings.
  - Recommendation: delete minimal.yml or make it the atlas-local:preview image; if kept, print a loud startup banner listing the disabled capabilities.

- [SEV: low] Weak default credentials + bindIpAll in the community stack
  - Where: `docker/mongodb/docker-compose.mongodb.yml:27-29` (ADMIN_PASSWORD default "admin", MONGOT_PASSWORD default "mongotPassword"), `docker/mongodb/mongod.conf:5` (`bindIpAll: true`) with `authorization: enabled` (mongod.conf:16)
  - What: port 27017 is published to the host and mongod binds all interfaces with guessable default passwords.
  - Why it matters: dev-only, but one `compose up` on a shared network exposes a writable mongod. init-mongo.sh itself is otherwise good: idempotent user creation (11000-tolerant), password passed via temp JS file not shell interpolation.
  - Recommendation: refuse to start when ADMIN_PASSWORD is unset/default outside CI, or bind the published port to 127.0.0.1 by default.

- [SEV: info/good] The canonical preview stack (docker-compose.preview.yml, docker-compose.full.yml local profile) is genuinely one-container correct: mongodb-atlas-local bundles mongod+mongot as a single-node replica set with search, matching the engine's capability detection. setup-generator.sh is idempotent (skips existing keyfile), validates the al- key prefix against the provider endpoint, and writes key files with 400/600 perms. scripts/prepare-mongodb-runtime.ts, mongodb-cluster-preflight.ts, check-mongodb-runtime-parity.ts are clean single-client scripts with proper close() and real readiness polling.

## Top 5

1. [high] Per-agent MongoClient fan-out — `packages/memory-engine/src/search-manager.ts:14` + `packages/memory-engine/src/mongodb-manager.ts:2192`: one MongoClient+pool per agentId, unbounded cache, violates one-client-per-process; an API server with N agents holds N×(pool+2) connections.
2. [high] Per-agent collection/search-index sprawl — `packages/memory-engine/src/backend-config.ts:228`: default prefix `memongo_<agentId>_` creates ~30 collections + ~14 search indexes per agent even though every document and index already leads with agentId (unnecessary-collections anti-pattern at scale).
3. [high] Community docker tiers never initiate the replica set — `docker/mongodb/docker-compose.mongodb.yml:64` + `docker/mongodb/mongot.conf:4`: no rs.initiate anywhere in the repo, so the replicaset/fullstack tiers cannot form rs0 and mongot has no oplog to sync; plus an undocumented `--replSetMember` flag that may abort mongod startup.
4. [medium] Duplicate + redundant-prefix index bloat — `packages/memory-engine/src/mongodb-schema.ts:1763,2155` (two identical-key unique indexes on structured_mem), 1643, 1780, 2051 (three strict-prefix-redundant indexes): pure write amplification on the hottest collections.
5. [medium] $regex used for search despite purpose-built Atlas Search indexes — `packages/memory-engine/src/mongodb-graph.ts:867` and `packages/memory-engine/src/mongodb-episodes.ts:546`: entity/episode lookups run non-anchored case-insensitive regexes while the entity_autocomplete and episodes text indexes sit unused.

## Harmony note

The MongoDB layer is the most disciplined part of this codebase and simultaneously the source of its biggest scale risk. At the single-agent level everything harmonizes beautifully: one schema module owns every collection/index definition, capability detection drives graceful lane degradation (hybrid → vector → keyword → $text), transactions have majority write concern with a standalone fallback, shutdown drains queues in order, and the docker preview stack matches the engine's expectations exactly — the system feels like one organism tuned for `atlas-local:preview`. The seams misalign at multi-tenancy: three independent per-agent mechanisms (per-agent MongoClient, per-agent collection prefix, per-document agentId scoping) stack on top of each other, so the API server pays quadratic infrastructure cost for isolation it already gets for free from the agentId-leading indexes. The second misalignment is between the engine's 8.x/autoEmbed assumptions and the two non-canonical docker paths (mongo:7 minimal, uninitiated community fullstack), which degrade silently into a much weaker product than the code is capable of. Fixing the client-sharing and shared-prefix defaults would let one process serve any number of agents on one pool and one set of 14 search indexes — leaner AND more capable, which is exactly the balance the project is aiming for.

## Out-of-scope sightings

- `packages/memory-engine/src/mongodb-manager.ts` is 11,266 LOC and `mongodb-schema.ts` 4,296 LOC vs the repo's own ~500 LOC guideline — size/ownership issue for the architecture reviewer.
- `apps/api/src/routes/v1.ts` resolves a memory manager per request-scoped agentId via the bridge (`packages/memory-bridge/src/memongo-bridge.ts:362-369`) — multi-tenancy reviewer should confirm agentId cardinality expectations.
- `docker/mongodb/README.md` exists but was not read per the no-prose rule; the docs reviewer should verify it matches the actual compose behavior (especially the rs.initiate gap).
