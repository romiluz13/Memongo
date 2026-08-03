# MEMONGO DEEP REVIEW — MASTER SYNTHESIS (2026-08-02)

9 sub-agents, code-only review (no docs/markdown read anywhere). Findings: 80+ across
`mongodb-usage.md`, `competitor-comparison.md`, `architecture-leanness.md`, `cross-package-harmony.md`,
`installability-production.md`, `agent-connectivity.md`, `correctness-concurrency.md`,
`performance-scalability.md`, `security.md`.

## VERDICT

Memongo's core engine is at or past the field's frontier — server-side hybrid fusion, an 8-lane
retrieval planner with traces, injection quarantine, and a genuinely excellent extraction-job
subsystem exist in no competitor. The single-store MongoDB bet is validated by the field
(the only equally-simple rival, hindsight, made the same bet with Postgres). The problems are
not conceptual. They are **seam problems**: individually well-built pieces that leak where they
hand off — engine→bridge→API→client→MCP — and **generational accretion**: god files, three eval
generations, and four hand-copied contract surfaces that were never reintegrated. The system
works end-to-end only in the exact shape the author runs it.

## WHAT IS GENUINELY STRONG (do not regress)

1. Server-side `$scoreFusion`/`$rankFusion` hybrid in one round trip + principled RRF fallback — `packages/memory-engine/src/mongodb-search.ts:777,910,1038`. Best in field.
2. Textbook `$vectorSearch`: always first stage, numCandidates 20x clamped, every prefilter field declared in index defs, capability-detected graceful degradation, ENN mode correct.
3. Extraction job subsystem: atomic `findOneAndUpdate` claims, server-time leases, token fencing, staged outbox + repair, serialized queues — `mongodb-memory-jobs.ts`, `mongodb-manager.ts:8367-8699`.
4. Injection quarantine before promotion + candidate-derived scope isolation (refuses cross-scope merges) — `mongodb-consolidator.ts:582-641`. Unique in the field.
5. Auth perimeter: timing-safe bearer, global `/v1/*` coverage with zero route gaps, fail-closed scoped keys, capped fail-closed rate limiter, 1MB body cap — `apps/api/src/app.ts`.
6. Graph expansion done right: parallel lanes, separate fwd/rev aggregations to dodge the 100MB `$facet` abort, `$graphLookup` with as-of temporal clause — `mongodb-graph.ts:939-1160`.
7. Zero `replaceOne`, zero `.skip()`, zero `$where`, centralized collection access in one schema module, clean acyclic package DAG (lib→engine→bridge→api; client→tools/mcp/web/pi).
8. atlas-local preview docker stack matches engine expectations exactly; init scripts idempotent.
9. Client has 43/43 route coverage; MCP 42/43; identical 6-value scope enum in four layers; uniform Bearer auth on every surface. The bones of one organism are there.

## THE SEVEN DISHARMONIES (each found independently by 2-4 agents)

### D1. Multi-tenancy triple-pays for isolation it already has free
`search-manager.ts:14` (one MongoClient+pool per agentId, unbounded cache, shutdown race leaks
managers) × `backend-config.ts:228` (default prefix `memongo_<agentId>_` → ~30 collections +
~14 search indexes PER AGENT) × per-document agentId scoping (already in every index lead).
100 agents ≈ 1,400 search indexes + 600+ connections + ~100 ops/s of 1s idle majority-write
polling. Found by: mongodb-usage, correctness, performance. **The single highest-leverage fix.**
→ One shared MongoClient, one shared default prefix (per-agent prefix becomes opt-in hard
isolation), LRU-evict idle managers, wake-on-write + slow sweep instead of 1s polling.

### D2. The client SDK is a lossy filter at the choke point
`packages/client/src/client.ts:463-477` silently DROPS `scope`/`scopeRef` on search, add,
searchDetailed, searchKB, recall, scanNovelty, extract — fields the API's auth layer can REQUIRE
(scoped keys get guaranteed 403 on `/v1/search-kb`). Tenant isolation requested by agents
evaporates silently. Proof in the wild: pi-extension bypasses the client with raw fetch, comment
in code (`packages/pi-extension/extensions/index.ts:185-198`). Errors: client stringifies the
API's clean `{error:{code,message}}`; MCP re-wraps the string into another JSON envelope —
error codes unreachable. No timeout, retries a status the API never sends (503), ignores
`Retry-After`. Found by: harmony, connectivity, correctness.
→ One contract source: client inputs extend engine types, parse error envelope, honor
Retry-After, add AbortSignal timeout; fail loudly on unserializable fields instead of dropping.

### D3. Idempotency instinct is right but never reaches the transport boundary
Engine has `$setOnInsert` upserts and `sourceEventsHash` dedupe — then: client retries
non-idempotent POSTs with fresh `randomUUID` eventIds; `mongodb-manager.ts:8984` throws AFTER
commit → 500 → retry → duplicate memory. Consolidator gate is TOCTOU findOne-then-insert with
no lease → double promotion across replicas. Episode trigger summarizes a re-queried superset
but marks the original subset → duplicate episodes. Sync's non-transactional path masks partial
bulkWrite failure with the new metadata hash → chunks permanently lost. Found by: correctness
(all five top bugs are this theme), performance, harmony.
→ Idempotency keys at `/v1/add` + `/v1/write-event`; never throw after commit; consolidator +
episode triggers use the same lease primitive memory-jobs already has; sync retries writeErrors
before writing the new hash.

### D4. Forced server-side autoEmbed blocks the reuse the fan-out needs
`backend-config.ts:175-176` hardcodes `embeddingMode = "automated"` (config validated then
ignored) → every `$vectorSearch` pipeline embeds the identical query text server-side, 4-6x per
search at ~2.4s per embed on Atlas; `queryVector` params exist but are always null on the v2
path; `numDimensions`/`quantization` knobs accepted, warned, discarded (`mongodb-schema.ts:3186`).
Found by: performance, mongodb-usage.
→ Unforce the mode (or compute one query vector per request and fan it out via the existing
queryVector params); delete or error on the dead knobs.

### D5. The empty-result search storm — cost is inverse to data presence
One sparse query can fire 30+ aggregations + repeated embeds: rankFusion → js-merge (2 aggs) →
vector-only (re-runs the SAME vectorSearch) → keyword → `$text`, per lane; then procedural
backstops + a RECURSIVE hybrid backstop (`mongodb-manager.ts:10660-10696`); then `legacySearch`
re-runs everything (`mongodb-manager.ts:3106`). Cold tenants — exactly who a memory system must
be cheap for — burn the most. Plus: cache semantic probe (≤1.5s embed) serialized before every
miss, no single-flight; per-write deleteMany invalidation drives hit rate to 0 under write load.
Found by: performance (top finding), mongodb-usage.
→ Empty ≠ error: stop the waterfall after the first empty; make legacySearch opt-in; budget
max RTs/embeds per search in searchV2; single-flight the cache; run probe concurrent with lanes.

### D6. Installability breaks at the last mile — works only as the author runs it
CRITICAL: MCP server unpublished, no `bin`, runs via tsx from source (`apps/mcp/package.json:4-11`).
CRITICAL: `wrangler.jsonc` points Workers at a Node `serve()` entry that cannot run there;
Dockerfile is the only real target. CRITICAL: `docker-compose.minimal.yml` is plain `mongo:7` —
no vector search, no transactions; silently the weakest product. HIGH: community fullstack never
runs `rs.initiate` (mongot has no oplog; possibly-invalid `--replSetMember` flag). HIGH: default
credential `local-dev-secret` shipped in published pi-extension and compose. HIGH: `/health` is
liveness-only; missing URI surfaces as per-request 500s. HIGH: web console CORS-broken out of
box. Found by: installability, connectivity, mongodb-usage, security.
→ Publish `@memongo/mcp` (bin, prebuilt JS, `npx -y @memongo/mcp`); delete wrangler.jsonc or
write a real Workers entry; minimal.yml → atlas-local image; add rs.initiate hook; pin all
images; never default secrets; validate env at boot + `/ready` probing Mongo; default dev CORS.

### D7. Generational accretion inside the layers (lean-ness debt)
`mongodb-manager.ts` 11,265 LOC / ~50 methods incl. ~2,500 LOC of benchmark harness
(`:3810-6296`) on the production hot class; `mongodb-schema.ts` 4,296 LOC / 99 createIndex sites.
Dead shipped code: entire `batch-*` cluster (~600 LOC + tests, zero production importers),
`embedding-model-limits.ts` (dead twin), `fact-extraction-eval.ts`, `benchmark-failure-taxonomy.ts`.
Test LOC (66,349) exceeds source LOC (56,715) across THREE eval generations — while
`packages/lib` (ssrf/redact/retry — security-critical), `client` (public SDK), pi-extension have
ZERO tests and the 40-tool MCP server has one 355-line test. Wire contract hand-maintained in 4
places (routes, openapi-spec, MCP tools, zod tools) and already diverged. Engine's
`MemorySearchManager` interface lies (all-optional methods for a one-backend world) → bridge
compensates with 18 `*CapableManager` casts + ~190 LOC re-declared types — third structural
copy of the same domain objects. Found by: leanness, competitor, harmony, correctness.
→ Cut list / keep list / thicken list in `architecture-leanness.md` (Verdict section) — follow it.

## FIELD COMPARISON — where Memongo stands

AHEAD: server-side fusion; retrieval planner + follow-up passes + evidence coverage + recall
traces (unique observability); lifecycle breadth (queue → quarantine → consolidation → LLM
deduction/induction → revisions/feedback); safety engineering (quarantine, scope isolation);
single-store operational simplicity with graph+vector+transactions in one deployment.

BEHIND (adopt, in value order — details in competitor-comparison.md):
1. Multiplicative post-rerank boosts (recency/access proof count) — from hindsight
   `reranking.py:58-100`; ~20 lines in `mongodb-reranker.ts`, large relevance win.
2. LLM-adjudicated dedup with union synthesis — hindsight `consolidator.py:178-285`; kills
   near-duplicate drift ("prefers tabs"/"likes tabs"/"uses tab indentation" as separate facts).
3. TTL expiration via MongoDB TTL index — mem0 `main.py:388-403`; ~10 lines, nearly free.
4. Temporal-proximity scoring in windowed lanes — hindsight `retrieval.py:557-577`.
5. Batch UPDATE/DELETE consolidation actions; wire the existing unwired `mongodb-contradiction.ts`
   into the consolidator's conflict path (contradictions are currently SKIPPED, stale facts persist).
6. Core/admin MCP split — supermemory ships 7 tools; Memongo's 40 (8 aliases + ~10 admin) cost
   every agent prompt tokens and selection accuracy.
7. UUID→int anti-hallucination mapping when rendering memory IDs to LLMs — mem0 `main.py:889`.

## PRIORITIZED ACTION PLAN

### P0 — correctness & safety (data integrity, do first, all small diffs)
1. Idempotency keys on `/v1/add` + `/v1/write-event`; client retries only with same key; never
   throw after commit (`client.ts:124-131`, `mongodb-manager.ts:8984`, `mongodb-events.ts:191` already `$setOnInsert`-ready).
2. Consolidator atomic lease (`findOneAndUpdate` + lease token fencing + stale-running reaper) — `mongodb-consolidator.ts:313-336`.
3. Sync: retry/fail on `writeErrors` before writing new metadata hash — `mongodb-sync.ts:204-213,299-310`.
4. Episodes: materialize from the selected event set, don't re-query — `mongodb-episodes.ts:754,205,786`.
5. Remove `local-dev-secret` defaults (pi-extension, compose, .env.example placeholder).
6. Wire `allowedRoots` on `/v1/import/conversations`; map route errors to safe codes (stop leaking `err.message` on ~30 routes).
7. Replace the two literal NUL bytes with `"\0"` escapes (`mongodb-consolidator.ts:894`, `mongodb-episodes.ts:176`) — they make both files invisible to grep.

### P1 — harmony & real-world usability (the big leverage)
8. ONE shared MongoClient + shared default collection prefix; LRU-evict managers; wake-on-write
   instead of 1s majority-write idle polling. (D1)
9. One contract source: client gains scope/scopeRef everywhere + error-envelope parsing +
   timeout + Retry-After; `MemorySearchManager` made concrete (delete 18 bridge casts + type
   re-declarations); OpenAPI generated from or conformance-tested against routes (fix
   `/v1/self-edit` gap, bearer scheme, ApiError refs). (D2)
10. Publish `@memongo/mcp` with bin + prebuilt dist; core/admin tool split (admin behind env
    flag); drop alias tools; add `memongo_extract`; `structuredContent` everywhere. (D6/D7)
11. Docker truth: rs.initiate hook; pin images; minimal.yml → atlas-local; refuse default
    passwords; bind 127.0.0.1. Boot validation + `/ready` (mongo ping + vector probe) wired to
    HEALTHCHECK; default dev CORS for the web console. (D6)
12. Delete `apps/api/wrangler.jsonc` (or write a genuine Workers entry). One deploy target per app.
13. `packages/client`: guard `process.env` for browser/edge; add tests. `packages/lib`: add
    tests for ssrf/redact/retry/auth. MCP per-tool smoke tests. (thicken list)
14. Route-level zod validation on write bodies (`entry`, `filter`, metadata `$`/`.`-key
    rejection); 400 INVALID_JSON instead of `{}` swallow (`v1.ts:69-80`); clamp search `limit` (100).

### P2 — lean-ness & field parity
15. Search budget: kill waterfall-after-empty, recursive backstop, legacySearch re-run;
    one query embedding per request via existing `queryVector` params; single-flight cache;
    probe concurrent with lanes. (D4/D5)
16. Execute the cut list: `batch-*` cluster, benchmark/eval out of shipped src (~3,900 LOC) into
    one canonical eval home, dead modules, duplicate compose file, barrel-export trim;
    drop duplicate/redundant indexes (`mongodb-schema.ts:1643,1763,1780,2051,2155`), add missing
    ESR compounds (chunks `{agentId,path,startLine}`, episodes/entities `updatedAt`), route
    entity/episode `$regex` → `$search` autocomplete, scoreFusion gate 8.3→8.2 (`:4210`),
    create `$text` indexes only when search-index management is unavailable.
17. Adopt from the field (value order): post-rerank recency/access boosts → TTL index →
    LLM-adjudicated dedup → wire contradiction module → temporal proximity lane →
    UUID→int mapping for LLM-facing ID lists.
18. Split `mongodb-manager.ts` along existing subsystem seams (search orchestration / writes /
    jobs / benchmarks already exist as sibling modules); split `mongodb-schema.ts` per domain.
19. Version harmony: derive OpenAPI + MCP server versions from workspace version; send
    `x-memongo-client-version`; un-pin `mongodb: "7.2.0"` → `^7.2.0`; add `engines` to all
    published packages; `prepublishOnly` build guards; publint/attw in check-publishability.

## THE ONE-PARAGRAPH HARMONY VERDICT

The skeleton of one organism is genuinely present: a clean acyclic ladder, a single bridge
facade, a single client choke point, identical scope vocabulary in four layers, uniform auth,
textbook MongoDB primitives. What fights the harmony is never the architecture's shape — it is
the handoffs (client drops fields, errors get flattened and re-wrapped, interface lies to the
bridge) and the un-reintegrated generations (god files, three eval systems, four contract
copies, per-agent infra triple-stack). Every top fix is a *collapse* — one client, one contract
source, one lease primitive, one error envelope, one eval home, one deploy target — not an
addition. Lean and good here are the same motion.
