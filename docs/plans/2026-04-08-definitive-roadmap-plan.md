# Memongo: Definitive Implementation Plan

> **Date:** 2026-04-08
> **Status:** CC10x execution_plan — verified source-code level, all 5 phases
> **Workflow:** wf-20260408-c7d2a1b4
> **Vision:** Memongo is THE BRAIN for ANY AI agent. One `npm install`, one MongoDB.
> **Deployment target:** `mongodb/mongodb-atlas-local:preview` (MongoDB 8.2.6, FCV 8.2). Non-negotiable.
> **Plan mode:** `execution_plan`
> **Verification rigor:** `standard`

---

## Durable Principles

1. **Universal, not framework-specific.** Every API, SDK, MCP tool, and middleware must work with ANY agent framework — Pi, Claude Code, Vercel AI SDK, OpenAI SDK, LangChain, LlamaIndex, custom. Never assume coding agent.
2. **MongoDB-native.** Use `$vectorSearch`, `$graphLookup`, `$rankFusion`, `$search`, Change Streams, Time Series, `$facet`, `$setWindowFields`, autoEmbed. One database replaces seven services.
3. **Compress for presentation, never storage.** All compression operates on output, never on stored data.
4. **Respect event-sourcing.** Everything enters as events; everything else is derived.
5. **Zero-garbage DX.** Every file, every export, every endpoint must justify its existence.
6. **Conservative extraction, aggressive consolidation.** False negatives OK during extraction. False positives NOT OK (pollute memory forever).
7. **Ship simple, evolve if needed.** 2 modes before 4 tiers. Prove value, then add sophistication.

## Companion Roadmap And Harmony Guardrails

This file remains the active execution plan for the current build wave.

Read it together with `docs/plans/2026-04-10-harmony-memory-roadmap.md`, which captures the stable architecture thesis and the exact reference-corpus evidence behind it.

Every roadmap item in this file must strengthen the same runtime invariants:

1. **One temporal truth model.** Structured memory, graph relations, procedures, episodes, and recall must agree on what is true now and what was true at `asOf` time.
2. **One lifecycle model.** Public CRUD ergonomics must map to Memongo-native invalidation, revisions, mutations, and history. Default delete means invalidate-with-history, not hard removal.
3. **One identity and namespace model.** `agentId`, `scope`, `scopeRef`, `sourceRef`, stable handles, and any future perspective dimensions must compose instead of fragmenting memory identity.
4. **One recall plane.** `profile`, `active-slate`/`memory_blocks`, `context-bundle`, and conversation recall are one family, not separate products.
5. **One feedback plane.** Trust, access, novelty, corrections, review scheduling, and procedure outcomes must converge instead of drifting into parallel lanes.
6. **One scheduler owner.** Consolidation, extraction, feedback, and re-materialization should share one auditable orchestration policy instead of growing separate background controllers.
7. **Provenance everywhere.** Every durable belief should remain traceable to events, source references, and supersession chains.
8. **Wrappers are wrappers.** Hooks, IDE adapters, and framework integrations must stay thin over the same API/MCP/runtime truth.

If an item adds surface area without strengthening one of those invariants, it is a bolt-on and should be reworked before implementation.

---

## Phase 0: Fix the Foundation
**Timeline:** Days (blocks all other phases)
**Objective:** Eliminate all bugs, dead code, and legacy references that silently degrade production behavior.

### 0.1 — Create Missing `idx_events_vector` Search Index
**Classification:** CRITICAL BUG  
**File:** `packages/memory-engine/src/mongodb-schema.ts`, function `ensureSearchIndexes()`  
**Evidence:** `mongodb-novelty.ts:34` originally declared `const EVENTS_VECTOR_INDEX = "idx_events_vector"` — hardcoded name that never appears in `mongodb-schema.ts`, and the centroid+`queryVector` approach is incompatible with autoEmbed indexes.  
**Impact:** Novelty detection (`$vectorSearch` on events) silently returns empty results. 40% of Dreamer's combined score is always zero. `$vectorSearch` on events fails silently with graceful degradation masking the failure.  
**Fix (two parts):**

**(a) Index creation** — In `ensureSearchIndexes()`, add events text + vector search indexes (same pattern as structured_mem/procedures). Update index budget from 9 to 11. Add events to `getExpectedSearchIndexTargets()`. Index name follows `${prefix}events_vector` convention (not hardcoded `idx_`).

**(b) Novelty detector adaptation** — The novelty detector at `mongodb-novelty.ts` uses a centroid+`queryVector` approach which is **incompatible with autoEmbed**. autoEmbed indexes require `query: { text: "..." }` (MongoDB docs: "Run Vector Search Queries"), NOT `queryVector`. The `path` must be the source text field (`body`), not an embedding field. Rewrite `scanNovelty()` to use a text-representative approach: fetch recent event body texts, build a representative text string, and query with `query: { text: representativeText }` against `path: "body"`. This is semantically equivalent to the centroid approach — events farthest from the representative text are most novel.

**Reference pipeline syntax:** `docs/plans/2026-04-07-mongodb-feature-mining.md` §autoEmbed indexes  
**Exit criteria:** `ensureSearchIndexes()` creates `${prefix}events_text` + `${prefix}events_vector` indexes; novelty scan uses `query: { text }` (not `queryVector`); novelty scan returns non-empty results for a seeded agent.

### 0.2 — Wire AccessTracker into Production
**Classification:** CRITICAL BUG  
**File:** `packages/memory-engine/src/mongodb-manager.ts`, `MongoDBMemoryManager` constructor  
**Evidence:** `mongodb-access-tracker.ts:42` exports `class AccessTracker` but grep finds zero `new AccessTracker` calls anywhere in `mongodb-manager.ts`. The class exists, was fixed for race conditions, but is never instantiated.  
**Impact:** `accessCount` is always 0 on all documents. 30% of Dreamer combined-score input is dead. Dreamer sorts by access but all values are equal.  
**Actual constructor signature** (`mongodb-access-tracker.ts:49-58`):
`constructor(private readonly db: Db, private readonly prefix: string, config?: AccessTrackerConfig)`
where `AccessTrackerConfig` has `flushThreshold` (not `batchSize`) and `flushIntervalMs`.

**Fix:**
```typescript
// In MongoDBMemoryManager constructor (after this.db is assigned):
this.accessTracker = new AccessTracker(
  this.db,                              // Db instance, NOT a collection
  "memongo",                            // collection name prefix
  { flushThreshold: 50, flushIntervalMs: 5_000 }
)

// In search result handlers — call after every hit with collection name:
this.accessTracker.recordAccess(hit._id.toString(), "structured_mem")

// In close()/shutdown():
await this.accessTracker.close()
```
**Exit criteria:** `accessCount` increments on retrieved memories; Dreamer candidates show non-zero `accessCount` values in test runs.

### 0.3 — Remove All Legacy References
**Classification:** HIGH  
**Files and exact locations:**
- `packages/memory-engine/src/backend-config.ts:149` — `process.env.OPENCLAW_MONGODB_URI?.trim()` (active fallback)
- `packages/memory-engine/src/backend-config.ts:154` — OPENCLAW mentioned in error message
- `packages/memory-engine/src/embeddings-debug.ts:4` — `process.env.OPENCLAW_DEBUG_MEMORY_EMBEDDINGS`
- `packages/memory-engine/src/batch-voyage.ts:121` — `source: "clawdbot-memory"` sent to Voyage API
- `packages/memory-engine/src/backend-config.test.ts` — 9+ test lines referencing OPENCLAW env vars
- `packages/memory-engine/src/__tests__/real-e2e-v2.e2e.test.ts:93` — OPENCLAW reference
- `packages/memory-engine/src/__tests__/session-files.test.ts:33` — OPENCLAW reference
- `packages/memory-engine/src/__tests__/e2e-evaluation.e2e.test.ts:2` — OPENCLAW reference

**Fix:** 
- Replace `OPENCLAW_MONGODB_URI` → `MEMONGO_MONGODB_URI` (keep backward-compat comment, not code)
- Replace `OPENCLAW_DEBUG_MEMORY_EMBEDDINGS` → `MEMONGO_DEBUG_EMBEDDINGS`
- Replace `clawdbot-memory` → `memongo` in Voyage source attribution
- Update all test fixtures to use `MEMONGO_*` env var names
- Search for any remaining `clawtest_`, `claw` prefix strings in test DB names

**Exit criteria:** `grep -r "OPENCLAW\|clawdbot" packages/` returns zero results.

### 0.4 — Delete Dead Code (~1000 lines)
**Classification:** HIGH  
**Files to delete:**
- `packages/memory-engine/src/read-file.ts` — 112 lines, orphaned, no imports
- `packages/memory-engine/src/batch-gemini.ts` — orphaned batch provider, never used
- `packages/memory-engine/src/batch-openai.ts` — orphaned batch provider, never used
- `packages/memory-engine/src/runtime-write.ts` — 169 lines, vestigial agent runtime
- `packages/memory-engine/src/mongodb-watcher.test.ts` — 563 lines, tests nonexistent source
- `packages/memory-engine/src/mongodb-perf.test.ts` — orphan performance test
- `apps/memory-graph-playground/` — ghost directory, no source files

**Also remove** unused barrel exports from:
- `packages/memory-engine/src/index.ts` — remove exports for deleted files
- `packages/lib/src/index.ts` — remove any orphan re-exports

**Exit criteria:** `bun run build` passes; `bun run check-types` passes; no imports of deleted files.

### 0.5 — Fix API Completeness Gaps
**Classification:** HIGH  
**Problem:** 3 intelligence routes exist in production but are missing from OpenAPI spec, contract fixtures, and API tests.  
**Files:**
- `apps/api/src/openapi-spec.ts` — add `/v1/chain-trace`, `/v1/novelty-scan`, `/v1/consolidate`
- `apps/api/src/__fixtures__/contract-fixtures.ts` — add request/response fixtures for all 3
- `apps/api/src/app.test.ts` — add contract tests for all 3 routes

**Exit criteria:** `bun run test` in `apps/api/` includes tests for all 3 new routes and passes.

### 0.6 — Fix Docker Compose Trap
**Classification:** HIGH  
**Problem:** `docker/docker-compose.yml` uses `mongo:7` (plain MongoDB, no Atlas Search/Vector Search). `docker compose up` from `docker/` silently degrades every feature.  
**Fix:**
- Rename `docker/docker-compose.yml` → `docker/docker-compose.minimal.yml`
- Add `docker/docker-compose.yml` symlink → `docker/mongodb/docker-compose.mongodb.yml` (Atlas Local Preview)
- Update README.md and CONTRIBUTING.md to point to correct compose file

**Exit criteria:** `docker compose up` from `docker/` starts `mongodb/mongodb-atlas-local:preview`; Atlas Search and Vector Search are available.

### 0.7 — Fix Consolidator Default Score Gate
**Classification:** MEDIUM  
**File:** `packages/memory-engine/src/mongodb-consolidator.ts:45`  
**Evidence:** `const DEFAULT_MIN_COMBINED_SCORE = 0` — scoring never gates anything. Comment says "Pattern matching is the primary gate" but that means the scoring system (which consumed 10 agent-months to build) has no effect.  
**Fix:** Change to `const DEFAULT_MIN_COMBINED_SCORE = 0.15` after 0.1 and 0.2 are fixed (all 3 scoring inputs now live).  
**Exit criteria:** Dreamer candidates below 0.15 combined score are filtered out in test runs.

### 0.8 — Fix Dependency Version Protocol
**Classification:** MEDIUM  
**Problem:** Apps use `workspace:*`; libraries use pinned internal versions (e.g., `"@memongo/lib": "0.1.0"`), causing version drift on publish.  
**Fix:** Standardize all workspace internal deps to `workspace:*` in all `package.json` files.  
**Exit criteria:** `grep -r '"@memongo/' packages/*/package.json apps/*/package.json` shows only `workspace:*` for cross-package deps.

---

## Phase 1: Intelligence Upgrade
**Timeline:** 1-2 weeks (after Phase 0)
**Objective:** Upgrade search and consolidation from "working prototype" to "the most sophisticated in any memory system."

### 1.1 — Replace Manual RRF with `$rankFusion`
**Source:** `docs/plans/2026-04-07-mongodb-feature-mining.md` §$rankFusion  
**Current:** `packages/memory-engine/src/mongodb-hybrid.ts` — 279 lines of manual Reciprocal Rank Fusion with separate vector and text queries, application-level merge, and custom scoring.  
**New:** Single `$rankFusion` pipeline (one server round trip):
```typescript
// In mongodb-hybrid.ts, replace the manual RRF merge with:
const pipeline = [
  {
    $rankFusion: {
      input: {
        pipelines: {
          vectorPipeline: [
            { $vectorSearch: {
              index: "chunks_vector",
              path: "body",                      // autoEmbed: path is the source text field
              query: { text: queryText },        // autoEmbed: pass text, server generates embedding
              numCandidates: 150,
              limit: 50
            }}
          ],
          textPipeline: [
            { $search: {
              index: "chunks_search",
              text: { query: queryText, path: ["body", "title"] }
            }},
            { $limit: 50 }
          ]
        }
      },
      combination: { weights: { vectorPipeline: 0.7, textPipeline: 0.3 } }
    }
  },
  { $limit: 20 },
  // Note: $rankFusion score is directly in each result document (no $meta accessor needed).
  // Access ranking position via document order; score field exposed as "score" if projected:
  { $project: { body: 1, score: 1 } }
]
```
**Impact:** ~200 lines of application code → 1 pipeline stage. One round trip instead of two.  
**Exit criteria:** Hybrid search returns results; `$rankFusion` is visible in query explain plan; existing hybrid search tests pass.

### 1.2 — Upgrade Dreamer to Five-Phase + LLM-Driven Decisions
**Sources:**
- Claude Code 4-phase structure (Orient→Gather→Consolidate→Prune): `/Users/rom.iluz/Downloads/claude-code-leak/source-read-only/services/autoDream/consolidationPrompt.ts`
- mem0 ADD/UPDATE/DELETE/NOOP: `/Dev/memory-referance/mem0/mem0/memory/main.py`
- Honcho deduction+induction: `/Dev/memory-referance/honcho/src/routers/sessions.py`
- Letta `rethink_memory`: `/Dev/memory-referance/letta/letta/tools/builtins/memory.py`

**Current:** `packages/memory-engine/src/mongodb-consolidator.ts` — 435 lines with 2 regex patterns (lines 56-60), `DEFAULT_MIN_COMBINED_SCORE = 0` (line 45), no LLM decisions.

**New Dreamer Pipeline:**

**Phase 0 — Gate (debounced idle-timer):**
```typescript
// Replace fixed-interval polling with Change Streams:
const changeStream = events.watch([], { fullDocument: "updateLookup" })
let idleTimer: ReturnType<typeof setTimeout> | null = null
changeStream.on("change", () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => triggerDream(), IDLE_MINUTES * 60_000)
})
// Trigger only when: idle N minutes AND unprocessed count >= MIN_EVENTS AND hours since last dream >= MIN_INTERVAL
```

**Phase 1 — Orient (`$facet` parallel stats):**
```typescript
const [stats] = await events.aggregate([{
  $facet: {
    unprocessed: [{ $match: { dreamerProcessedAt: { $exists: false } } }, { $count: "n" }],
    byType: [{ $group: { _id: "$type", count: { $sum: 1 } } }],
    topTopics: [{ $group: { _id: "$topic", lastActivity: { $max: "$createdAt" } } },
                { $sort: { lastActivity: -1 } }, { $limit: 5 }]
  }
}]).toArray()
```

**Phase 2 — Extract + Decide (ADD/UPDATE/DELETE/NOOP from mem0):**
```typescript
// For each unprocessed event batch:
// 1. Regex fast-path (8 categories, ~115 patterns from mempalace):
const categories = ["decision", "preference", "fact", "contact", "todo", "milestone", "problem", "emotional"]

// 2. For regex matches: $vectorSearch to find top-5 similar existing memories
const similar = await structuredMem.aggregate([{
  $vectorSearch: {
    index: "structured_mem_vector",
    path: "body",                          // autoEmbed: path is the source text field
    query: { text: candidateText },        // autoEmbed: pass text, server generates embedding
    numCandidates: 20,
    limit: 5
  }
}]).toArray()

// 3. Map ObjectIds to integers (anti-hallucination from mem0):
const idMap = new Map(similar.map((m, i) => [i, m._id]))

// 4. LLM decides ADD/UPDATE/DELETE/NOOP — structured output schema:
type DreamerDecision = {
  action: "ADD" | "UPDATE" | "DELETE" | "NOOP"
  targetId?: number        // integer map ref for UPDATE/DELETE
  content?: string         // normalized content for ADD/UPDATE
  category?: "decision" | "preference" | "fact" | "contact" | "todo" | "milestone" | "problem" | "emotional"
  importance?: number      // 0.0–1.0
  reason: string
}

// LLM prompt (Phase 2 — Extract+Decide):
// System: "You are a memory consolidation agent. Given a new observation and existing
// similar memories, choose the correct action.
// Rules: ADD=genuinely new info | UPDATE=adds detail/corrects (provide targetId) |
// DELETE=directly contradicts (targetId; old memory invalidated, not erased) |
// NOOP=already known. Be conservative: prefer NOOP over noisy ADDs."
// User: "New observation: {observation.body}\nExisting memories:\n{idMap as numbered list}"
// Output: JSON matching DreamerDecision schema.

// 5. Execute atomically:
if (decision.action === "UPDATE") {
  await structuredMem.findOneAndUpdate(
    { _id: idMap.get(decision.targetId!) },
    { $set: { body: decision.content, updatedAt: new Date() } }
  )
}
```

**Phase 3 — Deduction Specialist (from Honcho):**
LLM agent with search tools. Structured output schema:
```typescript
type DeductionOutput = {
  deductions: Array<{ body: string; sourceIds: number[]; confidence: number }>
  contradictions: Array<{ contradictedId: number; reason: string }>
}
```
LLM prompt: *"Find logical implications of explicit facts. Detect contradictions. For each deduction, provide sourceIds and confidence 0.7–0.9. For contradictions, provide the ID of the older/superseded fact."*  
Creates `level: "deductive"` observations with `sourceIds`. Sets `invalidAt` on contradicted facts. Updates peer cards.

**Phase 4 — Induction Specialist (from Honcho, runs AFTER Phase 3):**
Structured output schema:
```typescript
type InductionOutput = {
  patterns: Array<{
    body: string
    patternType: "preference" | "behavior" | "skill" | "relationship" | "goal" | "habit"
    confidence: "low" | "medium" | "high"   // low=2 sources, medium=3-4, high=5+
    sourceIds: number[]
  }>
}
```
LLM prompt: *"Identify behavioral patterns from explicit and deductive memories. Require ≥2 source observations of DIFFERENT types per pattern. Do not invent patterns — only report what the evidence clearly supports."*

**Phase 5 — Prune + Profile (from Claude Code):**
```typescript
// Near-duplicate merge via $vectorSearch similarity > 0.92
// Convert relative dates to absolute
// Update user/agent profile document (static + dynamic split)
// Archive: accessCount < 3 AND lastAccessedAt > 30 days ago
```

**Scoring model (enabled after 0.1 + 0.2 fix):**
- Novelty: 40% (now live — vector index exists)
- Importance decay: 30% (always worked)
- Access count: 30% (now live — AccessTracker wired)
- `minCombinedScore`: 0.15 (up from 0 per Phase 0.7)

**Exit criteria:** Dreamer runs 5 phases; LLM decisions are logged; `accessCount` and novelty scores feed into candidate selection; test with seeded events shows ADD/UPDATE/DELETE/NOOP decisions in logs.

### 1.3 — Multi-Hop Reasoning Chains via `$graphLookup`
**Source:** `docs/plans/2026-04-07-honcho-native-port-design.md` §graph traversal  
**Current:** `packages/memory-engine/src/mongodb-reasoning-chain.ts:85` — single-hop `$lookup` from observations → events. `maxDepth` parameter (line 60) is cosmetic; depth never exceeds 1.  
**New:**
```typescript
// Replace $lookup with $graphLookup:
{
  $graphLookup: {
    from: "observations",
    startWith: "$sourceIds",
    connectFromField: "sourceIds",
    connectToField: "_id",
    as: "premises",
    maxDepth: options?.maxDepth ?? 3,
    depthField: "hopDistance",
    restrictSearchWithMatch: { agentId: agentId }
  }
}
// Also add reverse traversal (find conclusions that depend on a given fact):
// startWith: "$_id", connectFromField: "_id", connectToField: "sourceIds"
```
**MongoDB feature:** `$graphLookup` with `maxDepth`, `depthField`, `restrictSearchWithMatch` (verified 8.2.6)  
**Exit criteria:** Chain trace with `maxDepth: 3` returns multi-hop premises; `hopDistance` field present on results; existing chain-trace tests pass.

### 1.4 — Fix Novelty Detection (k-NN Surprisal)
**Evidence:** `mongodb-novelty.ts:34` — `idx_events_vector` never created (fixed in 0.1). Also: centroid-based approach has correctness issues (centroid of diverse topics sits in meaningless embedding space).  
**New approach (after 0.1 creates the index):**
```typescript
// For each observation, compute k-NN average distance = surprisal.
// idx_events_vector is an autoEmbed index — use query: "text", NOT queryVector: []
const knn = await events.aggregate([
  {
    $vectorSearch: {
      index: "idx_events_vector",
      path: "body",                       // autoEmbed path is the source text field
      query: { text: observationBody },   // autoEmbed: pass text, server generates embedding
      numCandidates: 50,
      limit: 10
    }
  },
  // IMPORTANT: $meta: "vectorSearchScore" is NOT valid inside $group.
  // Must $project the score into a named field FIRST, then $group on it.
  {
    $project: { _id: 1, vectorScore: { $meta: "searchScore" } }
  },
  {
    $group: { _id: null, avgScore: { $avg: "$vectorScore" } }
  }
]).toArray()
// surprisal = 1 - avgScore (low similarity to neighbours = high novelty)
```
**Exit criteria:** `scanNovelty` API returns non-empty results; novel memories score higher than routine ones in test scenarios.

### 1.5 — Temporal Fact Invalidation
**Source:** `graphiti/graphiti/edges/base.py` — `valid_at` / `invalid_at` on edges  
**Current:** `active → conflicted → invalidated` state machine exists but Dreamer never triggers it.  
**New schema additions:**
```typescript
// Add to structured_mem and graph edge schemas:
validAt: Date           // when this fact became true (default: createdAt)
invalidAt?: Date        // when superseded (never delete; query with partial index)
factLineage?: ObjectId  // points to superseding fact
```
**Add partial index:**
```typescript
await structuredMem.createIndex(
  { agentId: 1, category: 1, importance: -1 },
  { partialFilterExpression: { invalidAt: { $exists: false } } }
)
```
**Deduction specialist triggers invalidation:** When contradiction detected → `$set: { invalidAt: new Date() }` on old fact + create new fact with `factLineage` reference.  
**Exit criteria:** Contradicting events produce `invalidAt` on old fact; queries with partial index filter return only current facts; revision history accessible via `factLineage` chain.

### 1.6 — `sourceRef` Idempotency Field
**Source:** Supermemory's `customId` pattern; Mem0's `metadata.external_id`  
**What:** Optional caller-owned idempotency key for external sync/dedup. Enables agents to say "write this fact with key X" and guarantee exactly-once semantics on retry.

**Schema additions** (`packages/memory-engine/src/mongodb-schema.ts`):
- `EVENTS_SCHEMA` (line 570): add `sourceRef: { bsonType: "string", description: "Caller-owned idempotency key for external sync" }`
- `STRUCTURED_MEM_SCHEMA` (line 237): add `sourceRef: { bsonType: "string", description: "Caller-owned idempotency key for external sync" }`
- `PROCEDURES_SCHEMA` (line 359): add `sourceRef: { bsonType: "string", description: "Caller-owned idempotency key for external sync" }`

**Sparse unique compound index** on each collection — add to `ensureStandardIndexes()`:
```typescript
// sourceRef dedup index — sparse because sourceRef is optional.
// Sparse index only indexes documents where sourceRef EXISTS.
// Combined with unique: enforces uniqueness among docs that have sourceRef,
// while allowing unlimited docs without sourceRef (they are simply not in the index).
// MongoDB behavior confirmed: sparse+unique+compound is valid and well-defined.
// Existing pattern in this codebase: line 1490 (uq_structured_agent_scope_scoperef_type_key_v2).
await structuredMemCol.createIndex(
  { agentId: 1, sourceRef: 1 },
  { unique: true, sparse: true, name: "idx_sourceRef_dedup" }
)
applied++
await eventsCol.createIndex(
  { agentId: 1, sourceRef: 1 },
  { unique: true, sparse: true, name: "idx_sourceRef_dedup" }
)
applied++
await proceduresCol.createIndex(
  { agentId: 1, sourceRef: 1 },
  { unique: true, sparse: true, name: "idx_sourceRef_dedup" }
)
applied++
```

**Write path change** — in API route handlers (`apps/api/src/routes/v1.ts`):
```typescript
// If sourceRef is provided, use upsert instead of insertOne.
// MongoDB upsert: atomically insert-or-update in one round trip.
if (doc.sourceRef) {
  await col.updateOne(
    { agentId: doc.agentId, sourceRef: doc.sourceRef },
    { $set: doc },
    { upsert: true }
  )
} else {
  await col.insertOne(doc)
}
```

**Exposed through:**
- API: `POST /v1/events`, `POST /v1/structured`, `POST /v1/procedures` — add optional `sourceRef` field
- MCP: `memongo_write_event`, `memongo_write_structured`, `memongo_write_procedure` — add `sourceRef` param
- Client SDK: `.writeEvent()`, `.writeStructured()`, `.writeProcedure()` — add `sourceRef` option
- Types: Add `sourceRef?: string` to `MemoryEvent`, `StructuredMemoryRecord`, `ProcedureRecord` in `types.ts`

**Exit criteria:** Duplicate writes with same `sourceRef` produce one document (upsert); writes without `sourceRef` proceed as normal `insertOne`; sparse index visible in `listIndexes()`; `bun run test` passes.

### 1.7 — Scoped Enrichment for Dreamer
**Source:** Cognee's scoped enrichment pattern  
**What:** Consolidator runs on a bounded subgraph instead of all unprocessed events. Enables targeted consolidation (e.g., "consolidate only events from the last hour about project X").

**Where** (`packages/memory-engine/src/types.ts:557`): Extend `ConsolidationOptions`:
```typescript
export type ConsolidationOptions = {
  // ... existing fields (maxEvents, minCombinedScore, minIntervalMs, weights, scope)
  scopeRef?: string           // filter to specific namespace
  timeRange?: { from: Date; to: Date }  // bounded time window
  entitySet?: string[]        // filter events mentioning these entities (post-query filter)
}
```

**Where** (`packages/memory-engine/src/mongodb-consolidator.ts:228`): Apply in filter construction:
```typescript
const filter: Document = {
  agentId,
  dreamerProcessedAt: { $exists: false },
}
if (options?.scope) {
  filter.scope = options.scope
}
// NEW: scoped enrichment filters
if (options?.scopeRef) {
  filter.scopeRef = options.scopeRef
}
if (options?.timeRange) {
  // Standard MongoDB date range query — uses existing idx_events_agent_scope_scoperef_ts index
  filter.timestamp = {
    $gte: options.timeRange.from,
    $lte: options.timeRange.to,
  }
}
// entitySet is post-query: filter events by body content match after retrieval.
// Not a MongoDB index filter because entity mention is substring/semantic, not exact field match.
```

**After query, apply entitySet filter:**
```typescript
let filteredEvents = events
if (options?.entitySet?.length) {
  const entityPattern = new RegExp(
    options.entitySet.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i'
  )
  filteredEvents = events.filter(e => entityPattern.test(e.body))
}
```

**Exposed through:**
- API: `POST /v1/consolidate` — add `scopeRef`, `timeRange`, `entitySet` to request body
- MCP: `memongo_consolidate` — add same params
- Client SDK: `.consolidate()` — add same options
- Bridge: `memongoBridgeConsolidate()` — pass through options

**Exit criteria:** Consolidation with `timeRange` processes only events in that window; `scopeRef` narrows to specific namespace; `entitySet` filters post-query; existing consolidation without new params works unchanged; `bun run test` passes.

### 1.8 — Universal Temporal Validity for Procedures
**Source:** Graphiti's temporal knowledge graph; Honcho's temporal validity model  
**What:** Extend `validFrom`/`validTo` to procedures schema. Relations already have them (line 694-695). Procedure revisions already have them (line 461-462). The main procedures collection is the only gap.

**Evidence from codebase:**
- `RELATIONS_SCHEMA` (line 694-695): `validFrom`/`validTo` PRESENT
- `PROCEDURE_REVISIONS_SCHEMA` (line 461-462): `validFrom`/`validTo` PRESENT
- `STRUCTURED_MEM_SCHEMA` (line 279-280): `validFrom`/`validTo` PRESENT
- `PROCEDURES_SCHEMA` (line 359-421): `validFrom`/`validTo` MISSING

**Schema change** (`packages/memory-engine/src/mongodb-schema.ts`): Add to `PROCEDURES_SCHEMA.properties`:
```typescript
validFrom: { bsonType: "date", description: "When this procedure became valid" },
validTo: { bsonType: "date", description: "When this procedure was invalidated (null = still valid)" },
```

**Temporal invalidation logic** — in procedure update path (`packages/memory-engine/src/mongodb-manager.ts`):
```typescript
// When a procedure is superseded (new version created):
// 1. Set validTo = now on old version
await procedures.updateOne(
  { procedureId, agentId },
  { $set: { validTo: new Date(), state: "invalidated", updatedAt: new Date() } }
)
// 2. Create revision from old version (revision already has validFrom/validTo)
// 3. Insert new version with validFrom = now, validTo absent (still valid)
```

**Query filter** — active procedures query should filter:
```typescript
// Active procedures: validTo does not exist OR validTo is in the future
const activeProcedures = await procedures.find({
  agentId,
  state: "active",
  $or: [
    { validTo: { $exists: false } },
    { validTo: { $gt: new Date() } }
  ]
}).toArray()
```

**No new index needed:** Existing `idx_procedures_scope_state_updated` covers the primary query pattern. `validTo` filter is a low-cardinality secondary filter applied in-memory on the already-filtered result set.

**Exit criteria:** `PROCEDURES_SCHEMA` includes `validFrom`/`validTo`; superseded procedures get `validTo` set; active procedure queries exclude expired ones; existing procedure tests pass; temporal validity is now consistent across all 4 schemas (structured_mem, relations, procedures, procedure_revisions).

---

## Phase 2: Packaging for Viral Adoption
**Timeline:** 1-2 weeks (parallel with or after Phase 1)
**Objective:** Make Memongo the easiest memory to integrate. The DX is the product.

### 2.1 — `withMemongo()` Middleware for Vercel AI SDK
**Source:** `supermemory/packages/supermemory-sdk/src/middleware/` — `withSupermemory()` using `wrapLanguageModel`  
**Package:** `packages/tools/src/vercel/index.ts` (new file)  
**TypeScript interface:**
```typescript
export interface MemongoCoreOptions {
  apiUrl: string
  apiKey: string
  userId: string
  agentId?: string
  mode?: "wake-up" | "full"  // default: "full"
}

export function withMemongo(
  model: LanguageModel,
  options: MemongoCoreOptions
): LanguageModel

// Usage:
const model = withMemongo(openai("gpt-4o"), { apiUrl, apiKey, userId })
// Done. Every call now has memory context injected + extraction queued.
```
**Implementation hooks:**
1. `transformParams` — intercept before LLM call, fetch `/v1/profile` with `mode` param, inject into system prompt
2. `wrapStream` / `wrapGenerate` — after response, async fire `/v1/events` with conversation turn
3. Turn-level LRU cache (key: `userId + query embedding`) — prevent redundant profile fetches
**Exit criteria:** Unit test shows system prompt contains memory context; conversation is saved to events after each turn; LRU cache hit on second identical call.

### 2.2 — `createOpenAIMiddleware()` for OpenAI SDK
**Source:** `supermemory/packages/supermemory-sdk/src/integrations/openai.ts`  
**Package:** `packages/tools/src/openai/index.ts` (new file)
```typescript
export function createOpenAIMiddleware(
  client: OpenAI,
  options: MemongoCoreOptions
): OpenAI
// Wraps client.chat.completions.create() with same inject/extract pattern
```
**Exit criteria:** OpenAI SDK calls include memory context; same unit test pattern as 2.1.

### 2.3 — Add `/v1/profile` Endpoint (Static + Dynamic)
**Sources:** supermemory profile API, mempalace 4-layer progressive loading  
**File:** `apps/api/src/app.ts` (new route) + `packages/memory-bridge/src/memongo-bridge.ts` (new bridge fn)  
**MongoDB implementation — single `$facet` round trip:**
```typescript
const [result] = await structuredMem.aggregate([{
  $facet: {
    static: [
      { $match: { agentId, temporalScope: { $in: ["permanent", "ongoing"] },
                  importance: { $gt: 0.7 }, "invalidAt": { $exists: false } } },
      { $sort: { importance: -1, trustScore: -1 } },
      { $limit: 10 }
    ],
    dynamic: [
      { $match: { agentId, lastAccessedAt: { $gt: thirtyDaysAgo } } },
      { $sort: { accessCount: -1, lastAccessedAt: -1 } },
      { $limit: 10 }
    ],
    search: query ? [
      { $vectorSearch: { index: "structured_mem_vector", path: "body",
                         query: { text: query }, numCandidates: 50, limit: 5 } }
    ] : []
  }
}]).toArray()
```
**Response shape:**
```typescript
{ static: Memory[], dynamic: Memory[], searchResults: Memory[], tokenCount: number }
```
**Exit criteria:** GET `/v1/profile?agentId=x` returns all 3 facets; token count is accurate; single MongoDB round trip (verify via explain).

### 2.4 — Expand MCP + AI SDK from 41% to 100%
**Audit finding:** 11 of 27 API routes currently exposed via MCP/AI SDK.  
**File:** `apps/mcp/src/index.ts` (add 16 tools)  
**Priority additions (in order):**
1. `memongo_search_detailed` — full CRAG pipeline, returns scored results with sources
2. `memongo_write_structured` — write a structured memory directly
3. `memongo_write_procedure` — write a step-by-step procedure
4. `memongo_profile` — get the wake-up context (calls `/v1/profile`)
5. `memongo_hydrate_active_slate` — load high-salience active memories
6. `memongo_discovery_projection` — discovery-mode search
7. `memongo_stats` — agent memory statistics
8. `memongo_status_detailed` — detailed health + guidance (Protocol self-teaching added here)
9. All remaining `/v1/probes/*` tools

**Protocol self-teaching (from mempalace PALACE_PROTOCOL):**
Add `guidance` object to `memongo_status` response:
```typescript
guidance: {
  quickStart: "Call memongo_profile first. Then memongo_search_detailed for queries. Use memongo_remember to save insights.",
  bestPractices: ["Call memongo_profile at session start", "Save decisions with memongo_remember", "Use memongo_search_detailed before answering knowledge questions"],
  capabilities: ["semantic search", "graph traversal", "memory consolidation", "profile loading"]
}
```
**Exit criteria:** All 27 API routes have corresponding MCP tools; AI SDK tool array matches; `memongo_status` includes guidance object.

### 2.5 — Type All `unknown`-Returning Client Methods
**File:** `packages/client/src/index.ts`  
**Fix:** Add typed response interfaces for `status`, `stats`, `profile`, `traceChain`, `scanNovelty`, `consolidate`, and all `relevance*` methods. Remove all `Promise<unknown>` return types.  
**Exit criteria:** `bun run check-types` passes with no `unknown` return types on public client methods.

### 2.6 — Formalize `memory_blocks` Type
**Source:** Letta's block-based core memory with labeled sections  
**What:** Name and type what active-slate already does. Add token budgets and block labels so agents can reason about memory capacity.

**Current type** (`packages/memory-engine/src/types.ts:329`):
```typescript
export type MemoryActiveSlateItem = {
  kind: MemoryActiveSlateKind  // "active-critical" | "procedure" | "decision" | "current-state" | "recent-anchor"
  source: MemoryActiveSlateSource
  title: string
  summary: string
  // ... 8 more fields
}
```

**New types to add** (`packages/memory-engine/src/types.ts`):
```typescript
export type MemoryBlockLabel =
  | "persona"
  | "user-profile"
  | "current-work"
  | "active-risks"
  | "procedure-hints"
  | "recent-context"
  | "custom"

export type MemoryBlock = {
  label: MemoryBlockLabel
  tokenBudget: number          // target max tokens for this block
  items: MemoryActiveSlateItem[]
  actualTokens?: number        // computed after materialization
}

export type MemoryBlocks = {
  blocks: MemoryBlock[]
  totalTokenBudget: number
  totalActualTokens: number
}
```

**How it works:**
1. `hydrateActiveSlate()` returns `MemoryActiveSlate` as today (no breaking change)
2. New `materializeBlocks()` function groups slate items by `kind` into labeled blocks with token budgets:
   - `active-critical` → `"active-risks"` block
   - `procedure` → `"procedure-hints"` block
   - `decision` → `"current-work"` block
   - `current-state` → `"user-profile"` block
   - `recent-anchor` → `"recent-context"` block
3. Context-bundle uses blocks internally for budget allocation

**File:** `packages/memory-engine/src/mongodb-active-slate.ts` (new `materializeBlocks()` function)  
**Export from:** `packages/memory-engine/src/index.ts` — add `MemoryBlock`, `MemoryBlocks`, `MemoryBlockLabel`

**Exit criteria:** `materializeBlocks()` groups active-slate items into labeled blocks; `totalActualTokens` sums correctly; types exported and pass `bun run check-types`.

### 2.7 — Unify State Surface Naming
**Source:** Supermemory's unified profile+recall+context surface  
**What:** Treat profile/active-slate/context-bundle as one state family in docs and types. No code restructure — add a type alias and a convenience endpoint.

**New type** (`packages/memory-engine/src/types.ts`):
```typescript
/** The Memongo State Family — three coordinated views over the same memory system.
 * - `profile`: synthesized summary of structured memory (preferences, decisions, facts)
 * - `blocks`: always-loaded hot context for the current session (materialized from active-slate)
 * - `bundle`: token-budgeted assembly of all state views for LLM consumption
 */
// NOTE: Place in index.ts (not types.ts) to avoid circular import — ProfileSynthesis
// is defined in mongodb-profile.ts and re-exported from index.ts.
export type MemoryStateFamily = {
  profile: ProfileSynthesis
  blocks: MemoryBlocks
  bundle: MemoryContextBundle
}
```

**New API endpoint** (`apps/api/src/routes/v1.ts`):
```typescript
// GET /v1/state?agentId=X&scope=user&scopeRef=Y
// Returns all three state surfaces in one call (syntactic sugar over 3 existing calls).
v1.get("/state", async (c) => {
  const { agentId, scope, scopeRef } = c.req.query()
  const [profile, slate, bundle] = await Promise.all([
    memongoBridgeProfile(agentId, scope, scopeRef),
    memongoBridgeHydrateActiveSlate({ scope, scopeRef }),
    memongoBridgeBuildContextBundle({ agentId, scope, scopeRef }),
  ])
  const blocks = materializeBlocks(slate)
  return c.json({ profile, blocks, bundle })
})
```

**MCP tool:** Add `memongo_state_unified` to `apps/mcp/src/server.ts` — calls `/v1/state` internally.  
**Bridge function:** Add `memongoBridgeGetState()` to `packages/memory-bridge/src/memongo-bridge.ts`.

**Exit criteria:** `GET /v1/state` returns all 3 surfaces in one response; `MemoryStateFamily` type exported; `bun run check-types` passes.

### 2.8 — Wake-up Mode for Context Bundle
**Source:** Mempalace progressive loading; wake-up layering pattern  
**What:** Compact 150-250 token projection in context-bundle for session start. Avoids expensive search queries when the agent just needs "who am I talking to?"

**Where** (`packages/memory-engine/src/types.ts:416`): Add to `MemoryContextBundleRequest`:
```typescript
export type MemoryContextBundleRequest = {
  // ... existing fields
  mode?: "full" | "wake-up"   // default: "full"
}
```

**Where** (`packages/memory-engine/src/mongodb-context-bundle.ts:508`): In `buildContextBundle()`:
```typescript
if (request.mode === "wake-up") {
  // Override budget to compact session-start projection
  tokenBudget = 250
  // Skip expensive query evidence and discovery projection
  skipQueryEvidence = true
  skipDiscoveryProjection = true
  // Guaranteed resume slice (never omitted in wake-up mode):
  // 1. Current work (active-critical items from active-slate)
  // 2. Active risks (conflicted/high-salience structured memories)
  // 3. Last anchor event (most recent conversation anchor)
  // Plus: profile slice (top 3 critical facts) + top 2 procedures
  maxActiveItems = 5
  maxRecentEvents = 1
  includeProfile = true
}
```

**Integration:**
- **API:** `/v1/context-bundle` already accepts request body — add `mode` field to OpenAPI spec
- **MCP:** `memongo_build_context_bundle` tool already accepts parameters — add `mode` to input schema
- **Middleware:** `withMemongo()` (Phase 2.1) uses `mode: "wake-up"` for initial `transformParams` call, `mode: "full"` when query is present
- **Phase 3.3 `mode` parameter:** Phase 3.3 (Progressive Context Loading) already references `mode: "wake-up"` vs `mode: "full"` — this phase implements the underlying mechanism that 3.3 builds on

**Exit criteria:** `mode: "wake-up"` returns <=250 tokens; `mode: "full"` returns full search-augmented context; token count is accurate; `bun run test` passes.

---

## Phase 3: Deepen Intelligence
**Timeline:** 2-4 weeks (after Phase 1)
**Objective:** Features that make Memongo smarter than anything else.

### 3.1 — Self-Editing Memory Tools (from Letta)
**Source:** `letta/letta/tools/builtins/memory.py` — `core_memory_append`, `core_memory_replace`, `rethink_memory`  
**New MCP tool:** `memongo_self_edit`
```typescript
// Agent can directly edit its own core memory blocks:
memongo_self_edit({
  block: "user" | "persona" | "instructions",
  action: "append" | "replace" | "prepend",
  content: string
})
// MongoDB: findOneAndUpdate with $set/$push — atomic, faster than Letta's string replacement
```
**Also add:** Include core memory blocks in system prompt at session start (Letta's pattern: `<memory_blocks><user>...</user><persona>...</persona></memory_blocks>`).  
**Exit criteria:** Agent can call `memongo_self_edit`; block is updated atomically; changes visible in next session's system prompt.

### 3.2 — Multi-Level Prefetching (from Honcho)
**Source:** `honcho/src/routers/sessions.py` — two-pass observation search  
**Change:** In hybrid search, always run TWO separate `$vectorSearch` calls:
1. `level: "explicit"` observations only
2. `level: { $in: ["deductive", "inductive"] }` observations only

Combine in prompt with clear section headers. Prevents retrieval dilution (explicit facts and derived insights compete for the same result slots in single-pass search).  
**Exit criteria:** Search results show distinct explicit/derived sections; both sections populated after Dreamer has run.

### 3.3 — Progressive Context Loading (4-Layer MemoryStack)
**Sources:** mempalace `layers.py` — L0/L1/L2/L3 progressive loading  
**API (2 modes, not 4 tiers — keep simple):**
- `mode: "wake-up"` — L0 (identity, ~100 tokens) + L1 (profile, ~500 tokens). Cheap. Call at session start.
- `mode: "full"` — L0+L1+L2 (dynamic context via hybrid search). Expensive. Call per query.

**MongoDB:** `$facet` computes L1+L2 in parallel in one aggregation.  
**`/v1/profile` already implements this** (Phase 2.3). This phase adds the `mode` parameter gating.  
**Exit criteria:** `mode=wake-up` returns ≤600 tokens; `mode=full` returns search-augmented context; token count is accurate.

### 3.4 — Entity Registry with Disambiguation
**Sources:** mempalace entity registry, Graphiti LLM entity resolution: `/Dev/memory-referance/graphiti/graphiti/nodes.py`  
**Schema additions to `entities` collection:**
```typescript
interface EntityDocument {
  name: string
  aliases: string[]           // "NYC" → "New York City"
  confidenceSource: "onboarding" | "learned" | "inferred"
  ambiguousFlags: string[]    // ["Grace", "Will"] — common word names
  mentionCount: number        // $inc on every reference
  wikiUrl?: string
}
```
**MongoDB features:** Atlas Search `autocomplete` type on `name` + `aliases` for fuzzy entity lookup; `$inc: { mentionCount: 1 }` atomic upserts on entity reference.  
**Gate:** Require 2 different signal types for confident person classification (reduces false positives on common words).  
**Exit criteria:** Entities are created/updated during Dreamer runs; fuzzy search finds "NYC" when searching "New York"; ambiguous names flagged correctly.

### 3.5 — Confidence Scoring on Memories
**Source:** `langmem/langmem/memory/manager.py` — `p(x)` confidence approach  
**Add `confidence: number` (0-1) to memory documents.**  
**Source attribution hierarchy:**
- `user_stated` (1.0) — explicit user statement
- `agent_extracted` (0.7) — agent extracted from conversation
- `inferred` (0.4) — Dreamer deduction/induction

**Use in:** `$sort` scoring, Dreamer consolidation candidate ranking, trust scoring as 10th signal.  
**Exit criteria:** All new memories have `confidence` field; confidence propagates through Dreamer revisions; trust scoring uses confidence as input.

### 3.6 — Knowledge Artifacts (Code as First-Class Memory)
**Source:** `mengram/mengram/memory/knowledge.py` — `artifact` type  
**Add `artifact` field to `structured_mem`:**
```typescript
artifact?: {
  type: "solution" | "formula" | "command" | "config" | "snippet"
  title: string
  content: string  // the actual code/config
}
```
Surface artifacts with priority during technical queries. Index with Atlas Search language-specific analyzer (code).  
**Exit criteria:** Code snippets saved as `artifact` type; appear in technical query results with priority boost.

### 3.7 — "Not Derivable from Code" Quality Filter
**Source:** Claude Code memory `extractMemories` — explicit quality filter  
**Add pre-write classification step:** Before storing a memory, score whether it's derivable from the current agent context (git, files, conversation history). If derivable, ask "what was surprising about it?" rather than storing redundant info.  
**Implementation:** Simple LLM classification prompt as a pre-write gate in the Dreamer Extract phase.  
**Exit criteria:** Routine facts that duplicate what's in code/context are filtered; test shows filter catches "uses TypeScript" but not "prefers tabs over spaces".

### 3.8 — Background Forked Extraction (from Claude Code)
**Source:** Claude Code Layer 5 (`extractMemories`) — `/Users/rom.iluz/Downloads/claude-code-leak/source-read-only/services/extractMemories/extractMemories.ts`  
**The gap:** The Dreamer (Phase 1.2) runs periodically on batches. Nothing extracts memories *immediately* after each conversation turn. Claude Code called this "the highest impact gap" — a forked background process that analyses every single turn at zero main-agent cost.

**How it differs from the Dreamer:**
- Dreamer: periodic, batched, idle-triggered, full 5-phase pipeline
- Forked extraction: per-turn, single-event, fires immediately after every assistant response

**Implementation:**
```typescript
// New endpoint: POST /v1/extract  (fire-and-forget, async)
// Called by withMemongo() middleware after each turn (non-blocking):
fetch(`${apiUrl}/v1/extract`, {
  method: "POST",
  body: JSON.stringify({ agentId, turnEventId }),
  // No await — zero main-agent cost
})

// Server side: runs Phase 2 of Dreamer (Extract+Decide) scoped to ONE turn:
// 1. Load the single new event by turnEventId
// 2. Run regex fast-path (Phase 1.2 patterns)  
// 3. For matches: $vectorSearch top-5 similar, LLM ADD/UPDATE/DELETE/NOOP
// 4. Apply 3.7 quality filter ("not derivable from code/context")
// 5. Execute decisions atomically
// sourceAgent: { id: agentId, name: "extractor", runId: turnEventId }
```

**Dedup rule:** If the main conversation path already wrote structured memory for this turn (check `sourceEventIds` contains `turnEventId`), the background extractor MUST skip — no duplicate writes. This is cheap: one `countDocuments({ sourceEventIds: turnEventId })` before running extraction.

**Scope rule:** Forked extraction is always scoped to the single triggering turn/event. Never batch or widen scope — keep it cheap and predictable.

**OR via Change Streams** (server-push alternative):
```typescript
// Watch for new events; auto-trigger extraction with debounce:
events.watch([{ $match: { "fullDocument.role": "assistant" } }])
  .on("change", (change) => scheduleExtraction(change.fullDocument._id))
```

**MongoDB feature:** Change Streams for real-time event detection; reuses Phase 1.2 extraction pipeline.  
**Exit criteria:** After each assistant turn, extraction runs in background; new memories appear without explicit Dreamer cycle; main agent latency unaffected; `sourceAgent.name = "extractor"` on extracted memories.

### 3.9 — Agent Attribution Chain (from paprwork)
**Source:** `paprwork` — `sourceAgentId`, `sourceAgentName`, `runId`, `jobId` on every memory  
**Why it flows naturally here:** Phase 3.8 introduced `sourceAgent` on extracted memories — now we formalize it as a first-class schema field on ALL memory documents, propagated through every write path including the Dreamer, deduction specialist, and induction specialist.

**Schema addition** (add to `structured_mem`, `observations`, `episodes` schemas):
```typescript
sourceAgent?: {
  id: string      // agentId that created this memory  
  name: "user" | "dreamer" | "extractor" | "deduction-specialist" | "induction-specialist" | string
  runId?: string  // specific Dreamer run or extraction turn ID
}
```

**Propagation rules:**
| Memory origin | sourceAgent.name |
|---|---|
| User writes via API | `"user"` |
| Background forked extraction (3.8) | `"extractor"` |
| Dreamer Phase 2 (ADD/UPDATE) | `"dreamer"` |
| Deduction specialist (Phase 3) | `"deduction-specialist"` |
| Induction specialist (Phase 4) | `"induction-specialist"` |

**Why it matters:**
- "Which agent told me this?" queries: `{ $match: { "sourceAgent.name": "user" } }`
- Multi-agent swarms: each agent's memories stay traceable
- Trust calibration: `confidence` score (Phase 3.5) starts lower for `"induction-specialist"` memories vs `"user"` memories
- Per-agent memory analytics: `{ $group: { _id: "$sourceAgent.name", count: { $sum: 1 } } }`

**Exit criteria:** All new memory writes include `sourceAgent`; Dreamer propagates attribution through derived observations; `$match` on `sourceAgent.name` returns correct filtered sets.

### 3.10 — Operator Trace Surfaces
**Source:** MemOS operator console; Claude-mem trace infrastructure  
**What:** Per-query recall traces for operators to debug search quality, lane usage, and latency. Enables "why did recall return these results?" visibility.

**New collection `recall_traces`** — add to `mongodb-schema.ts`:
```typescript
const RECALL_TRACES_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["traceId", "agentId", "query", "timestamp"],
    properties: {
      traceId: { bsonType: "string" },
      agentId: { bsonType: "string" },
      query: { bsonType: "string" },
      timestamp: { bsonType: "date" },
      lanesUsed: {
        bsonType: "array",
        items: { bsonType: "string" },
        description: "Search lanes activated (vector, text, graph, etc.)"
      },
      lanesSkipped: {
        bsonType: "array",
        items: { bsonType: "string" },
        description: "Search lanes skipped and why"
      },
      totalHits: { bsonType: "number" },
      latencyMs: { bsonType: "number" },
      hitsByLane: {
        bsonType: "object",
        description: "Hit count per search lane"
      },
      topHitIds: {
        bsonType: "array",
        items: { bsonType: "string" },
        description: "IDs of top results returned"
      },
      tokenBudgetUsed: { bsonType: "number" },
      bundleMode: {
        enum: ["full", "wake-up"],
        description: "Context bundle mode used"
      },
    },
  },
}
```
**MongoDB validation:** `$jsonSchema` with `enum` for `bundleMode` — confirmed valid (same pattern as existing `state` and `scope` enums across 25 collections). `required` array enforces minimum trace metadata.

**Indexes in `ensureStandardIndexes()`:**
```typescript
const recallTraces = recallTracesCollection(db, prefix)
await recallTraces.createIndex(
  { agentId: 1, timestamp: -1 },
  { name: "idx_recall_traces_agent_ts" }
)
applied++
await recallTraces.createIndex(
  { traceId: 1 },
  { name: "uq_recall_traces_traceid", unique: true }
)
applied++
```

**Integration points:**
- **File:** `packages/memory-engine/src/mongodb-hybrid.ts` — after search execution, write trace document with lane stats
- **File:** `packages/memory-engine/src/mongodb-context-bundle.ts` — after bundle assembly, append `tokenBudgetUsed` and `bundleMode`
- **Collection helper:** Add `recallTracesCollection()` to `mongodb-schema.ts`

**API endpoints:**
- `GET /v1/admin/traces?agentId=X&limit=20` — paginated trace list
- `GET /v1/admin/traces/:traceId` — single trace detail
- Routes in `apps/api/src/routes/v1.ts` under `/v1/admin/` prefix (operator-only)

**Exit criteria:** Search calls produce trace documents in `recall_traces`; `GET /v1/admin/traces` returns paginated results; trace includes lane breakdown and latency; `bun run test` passes.

### 3.11 — Durable Ingest-Job Visibility
**Source:** Mem0 and Supermemory job status APIs  
**What:** General-purpose job collection for background work status. Operators can track consolidation, extraction, import, and materialization jobs.

**New collection `memory_jobs`** — add to `mongodb-schema.ts`:
```typescript
const MEMORY_JOBS_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["jobId", "jobType", "agentId", "status", "createdAt"],
    properties: {
      jobId: { bsonType: "string" },
      jobType: {
        enum: ["consolidation", "extraction", "import", "materialization", "enrichment"],
        description: "Type of background job"
      },
      agentId: { bsonType: "string" },
      status: {
        enum: ["pending", "running", "completed", "failed", "cancelled"],
        description: "Current job status"
      },
      createdAt: { bsonType: "date" },
      startedAt: { bsonType: "date" },
      completedAt: { bsonType: "date" },
      error: { bsonType: "string" },
      inputCount: { bsonType: "number", minimum: 0 },
      outputCount: { bsonType: "number", minimum: 0 },
      durationMs: { bsonType: "number", minimum: 0 },
      metadata: { bsonType: "object" },
    },
  },
}
```
**MongoDB validation:** `enum` for `jobType` and `status` — confirmed valid per MongoDB `$jsonSchema` specification. Same pattern as existing `scope` enum validation on 6+ collections in this codebase.

**Indexes in `ensureStandardIndexes()`:**
```typescript
const memoryJobs = memoryJobsCollection(db, prefix)
await memoryJobs.createIndex(
  { jobId: 1 },
  { name: "uq_memory_jobs_jobid", unique: true }
)
applied++
await memoryJobs.createIndex(
  { agentId: 1, status: 1, createdAt: -1 },
  { name: "idx_memory_jobs_agent_status_created" }
)
applied++
```
**Index rationale:** The compound index `{ agentId: 1, status: 1, createdAt: -1 }` follows ESR (Equality-Sort-Range): `agentId` + `status` are equality filters, `createdAt` descending for sort. Supports the primary query pattern `find({ agentId, status: "running" }).sort({ createdAt: -1 })`.

**Integration with Consolidator** — `mongodb-consolidator.ts`:
```typescript
// At consolidation start (after Step 2: Record run start):
const jobsCol = memoryJobsCollection(db, prefix)
const jobId = `consolidation-${runId}`
await jobsCol.insertOne({
  jobId,
  jobType: "consolidation",
  agentId,
  status: "running",
  createdAt: new Date(),
  startedAt: new Date(),
  inputCount: events.length,
})

// At consolidation end (in the finally block):
await jobsCol.updateOne(
  { jobId },
  {
    $set: {
      status: error ? "failed" : "completed",
      completedAt: new Date(),
      outputCount: result.factsPromoted,
      durationMs: result.durationMs,
      ...(error ? { error: String(error) } : {}),
    },
  }
)
```

**API endpoints:**
- `GET /v1/jobs?status=running&agentId=X` — list jobs with filter
- `GET /v1/jobs/:jobId` — single job detail
- Routes in `apps/api/src/routes/v1.ts`
- **Collection helper:** Add `memoryJobsCollection()` to `mongodb-schema.ts` and register in `ensureCollections()`

**Exit criteria:** Consolidator creates `memory_jobs` entries; `GET /v1/jobs` returns job list; job status transitions (pending→running→completed/failed) are tracked; `bun run test` passes.

### 3.12 — Projection Fabric
**Sources:** MongoDB Change Streams, on-demand materialized views, `collMod` schema evolution  
**What:** Formalize how Memongo derives read-heavy projections without creating a second canonical memory system.

**Rules:**
- Change Streams remain the primary materialization bus for runtime-derived updates.
- Standard views are read-layer normalization only — never canonical write targets.
- On-demand materialized views are allowed only for expensive read-heavy projections that need cached results.
- If a derived projection must remain visible to downstream change-stream consumers, use `$merge`, not `$out`.
- Validator hardening and schema-evolution changes use `collMod` discipline instead of ad hoc collection rewrites.

**Why it belongs here:** Phase 3 already introduced `recall_traces`, `memory_jobs`, and scoped enrichment. This is the right point to define how future derived projections stay harmonized with MongoDB-first runtime truth.

**Exit criteria:** Projection rules are documented in code comments and maintainer docs; any new derived read model names its source collection, trigger path, and schema migration path; no projection is treated as canonical truth.

---

## Phase 4: Distribution
**Timeline:** 4-8 weeks (parallel with Phase 3)

### 4.1 — Time Series AccessTracker
**Replace dead in-memory buffer with Time Series collection:**
```typescript
// Create collection with TTL at root level (NOT nested inside timeseries object):
await db.createCollection("access_events", {
  timeseries: {
    timeField: "ts",
    metaField: "memoryId",
    granularity: "minutes"
  },
  expireAfterSeconds: 30 * 24 * 3600   // 30-day rolling window — must be at options root
})
// Aggregate with $setWindowFields for rolling averages and trend detection
```
**10x storage compression vs flat collection. 30-day rolling window automatic via TTL.**  
**Exit criteria:** Access events write to Time Series collection; `$setWindowFields` rolling-7-day aggregation returns access trends; old in-memory buffer removed.

### 4.2 — Benchmark Suite (Credibility Gate)
**Sources:** Honcho (LoCoMo, BEAM), mempalace (LongMemEval)  
**Datasets:** LongMemEval (500 QA), LoCoMo (1,986 QA pairs)  
**Architecture:** JSON dataset → `writeConversationEvent()` pipeline → query runner → metrics (R@5, R@10, NDCG@10)  
**Target:** Publish R@5 > 95% on LongMemEval. This is the credibility gate for "state of the art."  
**Exit criteria:** Automated benchmark runner produces R@5/R@10/NDCG@10 scores; results publishable.

### 4.2A — Query Governance
**Sources:** MongoDB `setQuerySettings` / `removeQuerySettings`  
**What:** Pin only the benchmarked hot query shapes that prove worth stabilizing in production.

**Rules:**
- Use query settings only after Phase 4.2 benchmarks identify stable high-value query shapes.
- Keep governance cluster-wide and minimal; do not scatter ad hoc hinting through application code.
- Treat query settings as an operational refinement, not a substitute for correct schema/index design.
- Every governed query shape must cite the benchmark or operator trace evidence that justified it.

**Exit criteria:** Hot query shapes are enumerated from benchmark/trace evidence; query-setting candidates are documented with rollback notes; no application code depends on hidden query-shape assumptions.

### 4.3 — Composable Search Recipes (from Graphiti)
**Source:** `graphiti/graphiti/search/search_config_recipes.py` — 17 named search configurations  
**Named presets:**
- `fast` — vector only, 20 candidates
- `hybrid` — vector + BM25 via `$rankFusion`
- `deep` — hybrid + `$graphLookup` expansion + LLM reranking
- `temporal` — hybrid + time-range filter
- `chain-of-thought` — iterative search with LLM validation (from Cognee's `GRAPH_COMPLETION_COT`, max 4 iterations)

**MongoDB watchlist note:** Lexical prefilters for Vector Search stay an experimental recipe variant behind a feature flag. They can be tested inside `hybrid`/`temporal` recipes, but they must not replace the default `$rankFusion` path until benchmark evidence shows they improve recall without hiding relevant evidence.

**Exit criteria:** All 5 recipes return results; `SearchConfig` type is exported from `@memongo/client`.

### 4.4 — Conversation Import Pipeline
**Source:** mempalace-adoption-plan Phase 2A  
**Format adapters:** Claude Code JSONL, Claude.ai JSON, ChatGPT conversations.json, Slack JSON, plain text  
**Critical constraint:** ALL events MUST flow through `writeConversationEvent()` — not raw `bulkWrite`. Each event triggers full downstream pipeline (Dreamer, trust scoring, graph).  
**Exit criteria:** Import from each format produces events in the correct schema; Dreamer processes imported events like normal ones.

### 4.5 — `@memongo/pi` Extension for Pi Framework
**Source:** Pi framework source: `/Dev/pi-mono/`  
**Package:** `packages/pi/` (new package)  
**Hooks registered:**
- `before_agent_start` — inject wake-up context into system prompt
- `context` — augment every LLM call with relevant memories
- `turn_end` — call `/v1/extract` fire-and-forget (Phase 3.8 forked extraction)
- `session_before_compact` — rescue memories before Pi context compaction
- `tool_result` — track file/command usage as knowledge artifacts
- `agent_end` — flush AccessTracker

**Exit criteria:** `pi --extension @memongo/pi` works; memories injected at session start; turn-end extraction fires non-blocking.

### 4.6 — Procedure Feedback Loops (from mengram)
**Source:** `mengram/mengram/memory/procedures.py` — `successCount`/`failCount` on procedures  
**Why it belongs in Phase 4:** Procedure tracking is operational intelligence — the same theme as Phase 4.1 Time Series access tracking. Both answer "what's actually working?" rather than just "what's stored?"

**Schema additions to `procedures` collection:**
```typescript
// ALREADY EXIST in PROCEDURES_SCHEMA (mongodb-schema.ts:400-403):
// successCount, failCount, lastSuccessAt, lastFailureAt
// NET-NEW fields only:
lastOutcome?: "success" | "failure"    // most recent outcome (new)
reliabilityScore?: number              // computed: successCount / (successCount + failCount) (new)
// Stored and updated on each $inc for efficient sorting
```

**New MCP tool:** `memongo_report_outcome`
```typescript
// Agent reports whether a procedure worked:
memongo_report_outcome({ procedureId: string, outcome: "success" | "failure", notes?: string })
// MongoDB: findOneAndUpdate with $inc + $set on lastOutcome/lastOutcomeAt + recompute reliabilityScore
```

**Dreamer integration:**
- Auto-archive procedures where `reliabilityScore < 0.3` AND `(successCount + failCount) >= 10`
- Boost search ranking for `reliabilityScore > 0.8` via `$multiply` in trust scoring
- Surface unreliable procedures as warnings: "This procedure has a 20% success rate"

**Exit criteria:** Agent can call `memongo_report_outcome`; `reliabilityScore` updates atomically; Dreamer archives low-reliability procedures; high-reliability procedures rank higher in `/v1/search`.

### 4.7 — Semantic MCP Aliases
**Source:** Honcho's `observe/recall/state` semantic contract; Supermemory unified surface naming  
**What:** Intent-based tool names alongside existing tools. Agents can use semantic verbs (`recall`, `observe`, `state`) instead of memorizing internal tool names.  
**Mapping:**

| Semantic alias | Maps to existing tool(s) | Purpose |
|---|---|---|
| `memongo_recall` | `memongo_search` + `memongo_build_context_bundle` | Unified recall — semantic search with context assembly |
| `memongo_state` | `memongo_profile` + `memongo_status` | Unified state view — profile + health in one call |
| `memongo_observe` | `memongo_write_event` | Canonical ingest — single verb for "I noticed something" |
| `memongo_trace` | `memongo_chain_trace` | Reasoning chain traversal |
| `memongo_feedback` | NEW endpoint: `/v1/feedback` | Reinforcement/correction signal for memory quality |

**Implementation in `apps/mcp/src/server.ts`:**
```typescript
// Add alias tools that delegate to existing handlers.
// Each alias tool has the same input schema as its target, plus optional
// convenience defaults (e.g., memongo_recall auto-bundles search + context).
// Keep old tool names for backward compatibility — aliases are additive.

server.tool("memongo_recall", {
  description: "Search memory and assemble context in one call",
  inputSchema: { /* union of search + context-bundle params */ },
  handler: async (params) => {
    const searchResults = await callSearch(params)
    const bundle = await callContextBundle({ ...params, query: params.query })
    return { searchResults, bundle }
  }
})

server.tool("memongo_observe", {
  description: "Record an observation into memory",
  inputSchema: { /* same as memongo_write_event */ },
  handler: async (params) => callWriteEvent(params)
})

// memongo_feedback — NEW handler, not just an alias:
server.tool("memongo_feedback", {
  description: "Provide reinforcement or correction on a memory",
  inputSchema: {
    memoryId: { type: "string" },
    signal: { enum: ["confirm", "correct", "irrelevant"] },
    correction?: { type: "string" }
  },
  handler: async (params) => {
    // confirm: $inc reinforcementCount
    // correct: create revision + update value
    // irrelevant: $set salience to "low"
  }
})
```
**Why semantic aliases matter for adoption:**
- AI agents with MCP discover tools by name. `memongo_recall` is instantly understood; `memongo_search_detailed` requires documentation.
- Reduces cognitive load from 27+ tools to 5 primary verbs.
- Backward compatible: old names continue to work.

**Exit criteria:** All 5 alias tools registered in MCP server; `memongo_recall` returns combined search+context; `memongo_feedback` updates memory with reinforcement signal; old tool names still function.

---

## Phase 5: Polish (Ongoing)

### 5.1 — Mode-Configurable Extraction
**Source:** `claude-mem/src/extraction/modes.ts` — `ModeConfig` profiles  
**Extraction mode profiles:** `development`, `personal`, `sales`, `support`, `research` — each with different regex pattern sets and LLM extraction prompts.

### 5.2 — Team Memory with Secret Scanning
**Source:** Claude Code `teamMemorySync` — delta sync + gitleaks-based secret scanning  
**Add:** Shared MongoDB collection per org/team. Pre-write middleware scans for 30+ secret patterns before any memory is stored.

### 5.3 — Hallucination Grounding Pass
**Source:** `MemOS/memos/memory/extraction/grounding.py` — two-pass extraction with source attribution  
**Add:** After extraction, validate each memory against original user messages. Source attribution: `user` | `assistant` | `inferred`. Assistant-generated memories deprioritized in trust scoring.

### 5.4 — Human-Readable Memory Age
**Source:** Claude Code `memoryAge.ts`  
**Surface** "47 days ago" alongside ISO timestamps. Add staleness warning for memories older than 90 days.

### 5.5 — Cross-Collection Vector Search
### 5.5 — Views-Backed Retrieval Projections
**Sources:** MongoDB Search/Vector Search on views; `docs/plans/2026-04-07-mongodb-feature-mining.md` §$unionWith  
**What:** Normalize future unified retrieval through standard views first, then materialize only the expensive projections.

**Approach:**
- Use standard views as the normalized read layer for cross-collection retrieval experiments.
- Keep canonical writes in base collections (`events`, `structured_mem`, `episodes`, procedures, graph).
- Use `$unionWith` + `$vectorSearch` where direct pipeline composition is sufficient.
- Promote a read path to an on-demand materialized view only when repeated operator/benchmark evidence shows the projection is expensive enough to cache.

**Guardrails:**
- Views and materialized projections are read surfaces, not a second memory model.
- If change-stream visibility matters for a derived projection, materialize with `$merge`.
- Keep view-backed retrieval compatible with existing trust scoring and recall trace instrumentation.

### 5.6 — Retrieval Storage Efficiency
**Sources:** MongoDB Vector Search quantization  
**What:** Use vector quantization as an opt-in capacity/performance move once `mongot` memory or storage becomes a measured bottleneck.

**Rules:**
- Gate quantization behind benchmark evidence, operator telemetry, and a planned index rebuild window.
- Compare recall/latency before and after quantization on the benchmark suite before enabling by default.
- Treat quantization as an infrastructure optimization, not a product-surface change.

### 5.7 — Optional Provider and Tooling Paths
**Sources:** Atlas Embedding and Reranking API; MongoDB MCP server tools  
**What:** Keep provider and tooling alternatives available without making them runtime dependencies.

**Rules:**
- Atlas Embedding/Reranking stays optional provider plumbing until the provider abstraction is fully settled.
- MongoDB MCP server search/vector tooling is useful for validation, demos, and natural-language operator workflows, but not the canonical source of advanced runtime behavior.
- Any provider/tooling swap must preserve Memongo’s existing write-path, trust, and retrieval contracts.

---

## CC10x Normalized Phases

| phase_id | title | objective | key files | checks | exit_criteria |
|----------|-------|-----------|-----------|--------|---------------|
| P0 | Fix Foundation | Eliminate all silent failures and legacy cruft | `mongodb-schema.ts`, `mongodb-manager.ts`, `backend-config.ts`, `mongodb-consolidator.ts`, `mongodb-hybrid.ts` | `bun run test`, `bun run check-types`, `grep -r "OPENCLAW"` | All 8 items complete; zero OPENCLAW refs; AccessTracker wired; idx_events_vector created; dead files deleted |
| P1 | Intelligence Upgrade | Replace manual/broken implementations with MongoDB-native; add sourceRef, scoped enrichment, temporal validity | `mongodb-hybrid.ts`, `mongodb-consolidator.ts`, `mongodb-reasoning-chain.ts`, `mongodb-novelty.ts`, `mongodb-schema.ts`, `types.ts` | `bun run test`, Dreamer integration test, chain-trace depth test, sourceRef dedup test | $rankFusion serving; 5-phase Dreamer; $graphLookup multi-hop; novelty scores; sourceRef dedup works; scoped consolidation works; procedures have validFrom/validTo |
| P2 | Packaging | Make Memongo installable in any SDK with one function; formalize memory blocks, state surface, wake-up mode | `packages/tools/src/vercel/`, `packages/tools/src/openai/`, `apps/api/src/`, `apps/mcp/src/`, `types.ts` | `bun run test`, MCP tool count = 27+, type-check on middleware, wake-up mode ≤250 tokens | withMemongo() works; /v1/profile responds; /v1/state responds; memory_blocks typed; wake-up mode ≤250 tokens; zero unknown return types |
| P3 | Deepen Intelligence | Self-editing memory, entity registry, confidence scoring, forked extraction, agent attribution, operator traces, job visibility | `apps/mcp/src/`, `packages/memory-engine/src/mongodb-manager.ts`, entity schema, `/v1/extract` route, `recall_traces` schema, `memory_jobs` schema | `bun run test`, self-edit tool test, entity disambiguation test, trace endpoints, job status test | self-edit works; entities deduped; confidence propagates; extraction non-blocking; sourceAgent on all; recall_traces populated; memory_jobs tracked |
| P4 | Distribution | Benchmarks, Time Series AccessTracker, import pipeline, Pi extension, procedure feedback, semantic MCP aliases | `packages/pi/`, `packages/memory-engine/src/mongodb-access-tracker.ts`, benchmark runner, procedures schema, `apps/mcp/src/server.ts` | Benchmark R@5 score; Pi loads; `memongo_report_outcome` works; 5 alias tools registered | Benchmark passes; Time Series live; import handles 3+ formats; procedure reliability tracked; semantic aliases functional |

---

## Cross-Phase Dependency Map

```
Phase 0 (must ship first — unblocks everything)
  ├── 0.1 idx_events_vector ──────────────────► 1.4 novelty detection
  ├── 0.2 AccessTracker wired ────────────────► 1.2 Dreamer scoring (30% input live)
  │   0.1 + 0.2 combined ─────────────────────► 0.7 set minCombinedScore to 0.15
  └── 0.3 OPENCLAW cleanup ──────────────────► clean open-source release

Phase 1 (intelligence)
  ├── 1.2 Dreamer 5-phase ────────────────────► 3.1 self-edit, 3.4 entity registry
  ├── 1.3 $graphLookup chains ───────────────► 4.3 search recipes (deep mode)
  ├── 1.5 temporal invalidation ─────────────► 3.4 entity disambiguation
  ├── 1.6 sourceRef field ───────────────────► 4.4 conversation import (idempotent replay)
  ├── 1.7 scoped enrichment ─────────────────► 3.8 forked extraction (scoped to one turn)
  └── 1.8 procedures temporal validity ──────► 4.6 procedure feedback (temporal lifecycle)

Phase 2 (packaging) — can run parallel to Phase 1
  ├── 2.3 /v1/profile ────────────────────────► 2.1 withMemongo() middleware
  ├── 2.4 100% MCP coverage ──────────────────► 3.1 self-edit tool exposed
  ├── 2.6 memory_blocks ─────────────────────► 2.7 state surface (blocks in MemoryStateFamily)
  ├── 2.7 state surface ─────────────────────► 4.7 semantic MCP aliases (memongo_state maps to /v1/state)
  └── 2.8 wake-up mode ─────────────────────► 3.3 progressive context loading (implements underlying mechanism)

Phase 3 — after Phase 1
  ├── 1.2 Dreamer extract+decide ─────────────► 3.8 forked extraction (reuses same pipeline, scoped to one turn)
  ├── 3.8 forked extraction ──────────────────► 3.9 agent attribution (sourceAgent on all extracted memories)
  ├── 3.10 recall_traces ────────────────────► operator visibility (standalone)
  ├── 3.11 memory_jobs ──────────────────────► operator visibility; consolidator writes job entries
  └── 3.12 projection fabric ────────────────► Phase 5 retrieval projections (views/materialized views)

Phase 4 — after Phase 2 (mostly parallel)
  ├── 4.2 benchmarks ────────────────────────► 4.2A query governance (only benchmarked hot shapes)
  ├── 3.6 knowledge artifacts ────────────────► 4.6 procedure feedback (same procedures collection)
  └── 2.4 + 2.7 MCP + state surface ────────► 4.7 semantic MCP aliases (delegates to existing handlers)

Phase 5 — ongoing polish
  ├── 3.12 projection fabric ────────────────► 5.5 views-backed retrieval projections
  ├── 4.2 benchmarks + traces ──────────────► 5.6 vector quantization decisions
  └── 4.3 search recipes ───────────────────► lexical prefilter watchlist experiments
```

---

## MongoDB Feature Usage Map

| MongoDB Feature | Memongo Capability | Phase | Replaces |
|---|---|---|---|
| `$vectorSearch` + autoEmbed | Semantic search, novelty detection | Existing + P0 | Qdrant, Pinecone |
| `$search` (Atlas Search) | Full-text, fuzzy, autocomplete | Existing | Elasticsearch |
| `$rankFusion` | Hybrid search (vector + text) | P1.1 | 200 lines manual RRF |
| `$graphLookup` | Multi-hop reasoning chains | P1.3 | Neo4j, single-hop $lookup |
| Change Streams | Dreamer idle-timer trigger + forked extraction trigger | P1.2, P3.8 | Polling timer, manual post-turn calls |
| `$facet` | Parallel profile assembly + unified state | P2.3, P2.7 | Multiple round trips |
| autoEmbed (voyage-4-large) | Server-side embeddings | Existing | 13+ embedding libraries |
| Partial Indexes | Current-facts-only queries | P1.5 | Full scan + filter |
| Sparse Unique Compound Indexes | sourceRef idempotency dedup | P1.6 | App-level dedup logic |
| `updateOne` + `upsert: true` | Idempotent writes via sourceRef | P1.6 | Insert + conflict handling |
| `$gte`/`$lte` date range queries | Scoped enrichment time windows | P1.7 | Unbounded full-table scans |
| Time Series Collections | Access tracking + analytics | P4.1 | Redis counters |
| `$setWindowFields` | Rolling averages, trend detection | P4.1 | App-level analytics |
| Standard Views + Search / Vector Search on views | Normalized retrieval read layer | P5.5 | Ad hoc cross-collection glue |
| On-Demand Materialized Views | Cached read-heavy retrieval projections | P3.12, P5.5 | Recomputing heavy read paths every query |
| `$unionWith` + `$vectorSearch` | Cross-collection search composition | P5.5 | Separate queries |
| `setQuerySettings` | Query governance for benchmarked hot shapes | P4.2A | Ad hoc hints in app code |
| Vector Quantization | Retrieval storage and `mongot` efficiency | P5.6 | Full-precision vectors everywhere |
| `collMod` | Validator/schema evolution discipline | P3.12 | Drop-and-recreate collection migrations |
| JSON Schema Validation | Document structure + new collections (recall_traces, memory_jobs) | Existing + P3.10, P3.11 | App-level checks |
| TTL Indexes | Auto-expire caches + old access events | Existing + P4.1 | Manual cleanup |
| `findOneAndUpdate` + operators | Atomic memory edits + feedback signals | P3.1, P4.7 | String replacement (Letta) |

**Total: 7 services replaced by 1 MongoDB instance.**

---

## Package Map

```
@memongo/memory-engine    Core MongoDB memory (existing — Phases 0, 1, 3)
@memongo/memory-bridge    Stable facade (existing — new bridge fns for Phase 2, 3)
@memongo/client           HTTP client SDK (existing — Phase 2.5 type fixes)
@memongo/tools            AI SDK tools + middleware
  /vercel                 withMemongo() for Vercel AI SDK (NEW — Phase 2.1)
  /openai                 createOpenAIMiddleware() (NEW — Phase 2.2)
@memongo/pi               Pi framework extension (NEW — Phase 4.5)
@memongo/api              HTTP API server (existing — new routes Phase 2.3, 2.4, 2.7, 3.10, 3.11)
@memongo/mcp              MCP server (existing — expand 11→27+ tools Phase 2.4, +5 aliases Phase 4.7)
@memongo/web              Web console (existing)
@memongo/ui               Graph + profile React components (NEW — future)
```

---

## Competitive Intelligence Attribution

| System | Idea Adopted | Reference Path |
|--------|-------------|----------------|
| Claude Code | Forked subagent extraction, 4-phase Dream (Orient→Gather→Consolidate→Prune), "not derivable from code" filter, Why+How body structure, team memory | `/Users/rom.iluz/Downloads/claude-code-leak/source-read-only/` |
| Honcho | Deduction+induction specialists, surprisal sampling, debounced Change Streams trigger, multi-level prefetch (explicit vs derived), peer cards, `observe/recall/state` semantic contract (P4.7), temporal validity model (P1.8) | `/Dev/memory-referance/honcho/src/routers/sessions.py` |
| mem0 | ADD/UPDATE/DELETE/NOOP LLM decisions, integer ID anti-hallucination, dual-mode extraction, graph soft delete, `metadata.external_id` sourceRef pattern (P1.6), job status API (P3.11) | `/Dev/memory-referance/mem0/mem0/memory/main.py` |
| Letta (MemGPT) | Self-editing memory tools, sleep-time agents, block-based core memory in system prompt, memory_blocks formalization (P2.6) | `/Dev/memory-referance/letta/letta/tools/builtins/memory.py` |
| Graphiti | Temporal edge invalidation (valid_at/invalid_at), composable search recipes, LLM entity resolution, procedures temporal validity (P1.8) | `/Dev/memory-referance/graphiti/graphiti/edges/base.py` |
| supermemory | `withSupermemory()` middleware pattern, static/dynamic profile split, turn-level LRU cache, `customId` sourceRef pattern (P1.6), unified state surface naming (P2.7) | `/Dev/memory-referance/supermemory/packages/supermemory-sdk/src/middleware/` |
| MemOS | Multi-stage deep search, hallucination grounding, working memory tier, operator trace console (P3.10) | `/Dev/memory-referance/MemOS/` |
| mempalace | 4-layer progressive loading, entity registry, zero-LLM regex fast-path, Protocol self-teaching in status, wake-up mode (P2.8) | `/Dev/memory-referance/mempalace/layers.py` |
| mengram | Knowledge artifacts (code as memory), procedure feedback loops | `/Dev/memory-referance/mengram/mengram/memory/knowledge.py` |
| paprwork | Agent attribution chain (`sourceAgent` on every memory) | `/Dev/memory-referance/paprwork/` |
| claude-mem | Hook injection pattern, observation typing, mode-configurable extraction | `/Dev/memory-referance/claude-mem/src/extraction/modes.ts` |
| Cognee | Chain-of-thought graph retrieval (iterative validation, max 4 iterations), scoped enrichment pattern (P1.7) | `/Dev/memory-referance/cognee/cognee/modules/search/` |
| LangMem | Confidence scoring `p(x)`, prompt optimization from memory patterns | `/Dev/memory-referance/langmem/langmem/memory/manager.py` |
| Zep | Pre-formatted context blocks, temporal truth tracking | cloud-only |
| OpenAI Agents SDK | Gap analysis: no real memory — Memongo fills it | SDK, no clone needed |
| Letta / OpenAI | Self-editing memory tools | see Letta above |

---

## The Bottom Line

Every AI agent needs a brain. Every competitor assembles 2-5 databases:
- mem0: Qdrant + Neo4j + SQLite
- MemOS: Qdrant + Neo4j + Redis
- Honcho: PostgreSQL + pgvector + TurboPuffer + Redis
- mempalace: ChromaDB + SQLite + JSON files

**Memongo: MongoDB (one database).**

`$vectorSearch` + `$search` + `$rankFusion` + `$graphLookup` + `Change Streams` + `Time Series` + `autoEmbed` + `JSON Schema` — all in one `mongodb-atlas-local:preview` container.

Ship Phase 0 this week. Ship Phase 1-2 this month. By then, no other memory system will combine everyone's best ideas running on one database.

```bash
npm install @memongo/tools
docker compose up  # starts mongodb-atlas-local:preview
```

Your agent now has a brain. Powered by MongoDB.
