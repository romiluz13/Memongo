# SuperMemory Audit Fixes Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Audit Source:** Two audit agents found 12 dead code issues (3 HIGH) and 19 improvement findings (3 CRITICAL, 5 HIGH, 6 MEDIUM).
> **Research:** See `docs/research/2026-03-23-supermemory-audit-fixes-mongodb-research.md` for MongoDB documentation research.

**Goal:** Fix all CRITICAL + HIGH issues from the supermemory audit, plus quick-win MEDIUMs. 15 fixes total across 9 files.

**Architecture:** Surgical fixes to existing modules. No new collections, no new files (except tests). Manual RRF for score normalization. `bulkWrite` for N+1 entity upserts. `$percentile` for server-side latency stats.

**Tech Stack:** TypeScript ESM, MongoDB latest (atlas-local:preview — always latest version, currently 8.2+), Vitest

**MongoDB Version Policy:** Memongo targets ONLY `mongodb-atlas-local:preview` which always ships the latest MongoDB. No version fallbacks, no backward compatibility concerns, no feature-gating by version. Use the most innovative features available.

**Prerequisites:** All existing tests pass. `pnpm test -- src/memory` green baseline.

---

## Plan: SuperMemory Audit Fixes

### Request Summary

- Fix 15 audit findings (3 CRITICAL, 5 HIGH, 7 MEDIUM quick-wins) to harden the supermemory subsystem.

### Requirements Snapshot

- C1: Add `AbortSignal.timeout(10_000)` to Voyage rerank API fetch
- C2: Add `synthesizeProfile()` method to manager; split `$or` in `$lookup` to two indexed `$eq` lookups
- C3: Implement manual RRF in `searchV2` to normalize scores across paths
- H1: Replace sequential entity/relation upserts with `bulkWrite({ ordered: false })`
- H2: Remove `LLMEntityExtractor` config false bridge; add explicit log warning for `graph.entityExtraction` config
- H3: Throw validation error for "llm"/"hyde" query rewrite methods instead of silent fallback
- H4: Derive cache TTL from `pathsExecuted` (per-document TTL) instead of static config
- H5: Filter empty snippets before sending to reranker
- H6: Entity-extraction telemetry: add `emitTelemetry` to `extractAndUpsertEntities`
- H7: Clean up aggressive synonym expansions, add max expansion ratio
- M1: Emit reranker telemetry on failure path
- M2: Default limit for `getEventsByTimeRange` raw-window path in searchV2 (50)
- M3: Split profile entity `$lookup` `$or` into two `$eq` lookups (merged with C2)
- M4: Replace `$push` + client-side percentiles with `$percentile` aggregation

### Constraints Snapshot

- MongoDB-only (Community + mongot + atlas-local:preview)
- No new collections or search indexes
- Must not break existing 81/81 e2e tests or ~600+ unit tests
- TDD: write test first, then implement
- Fire-and-forget telemetry pattern via `emitTelemetry`
- `=== true` for disabled-by-default features
- DO NOT USE mongodb-agent-skills; use ONLY mcp**mongodb**search-knowledge MCP

### In Scope

- All 15 fixes listed in Requirements Snapshot
- Tests for each fix
- Score normalization via manual RRF across search paths
- `bulkWrite` batch optimization for entity extraction
- `$percentile` server-side aggregation for latency stats

### Out Of Scope

- Change Stream watcher for async LLM enrichment (deferred — needs separate design phase)
- `$rankFusion`/`$scoreFusion` for cross-path fusion (not a version issue — these operators only work on a single collection; Memongo merges results from multiple collections, so manual RRF remains the correct approach)
- LLM function injection from agent runtime (architectural seam — runtime doesn't expose LLM callable to memory layer yet)
- New collections, new search indexes

### Planning Mode

- Plan mode: `execution_plan`
- Verification rigor: `standard`

### Open Decisions

- None

### Differences From Agreement

- None

### Recommended Defaults

- RRF constant k=60 (standard from original RRF paper, matches existing `mongodb-hybrid.ts`)
- Rerank fetch timeout: 10 seconds (generous for cross-encoder API call over network)
- Raw-window event limit: 50 (balances context window budget vs recency)
- Cache TTL mapping: vector/hybrid -> `conversationTtlSec`, kb -> `kbTtlSec`, structured/episodic/graph -> `conversationTtlSec`, profile -> `kbTtlSec`
- Synonym expansion max ratio: 3x (original word count)

### Current State

- `src/memory/mongodb-reranker.ts:81` — `fetch()` with no timeout or AbortSignal
- `src/memory/mongodb-manager.ts:2688-3026` — `searchV2` merges raw scores from different paths (vector 0-1, BM25 0-inf, episode 0.85-synthetic, graph 0.25-0.9 synthetic)
- `src/memory/mongodb-profile.ts:165-183` — `$lookup` with `$or` in `$expr` (cannot use index)
- `src/memory/mongodb-manager.ts` — no `synthesizeProfile` delegation method
- `src/memory/mongodb-graph.ts:898-913` — sequential `upsertEntity()` in loop (N+1)
- `src/memory/mongodb-graph.ts:917-955` — sequential `upsertRelation()` + `upsertEntityLink()` in loop
- `src/memory/mongodb-entity-extractor.ts:170-207` — `LLMEntityExtractor` class exists but config never creates it
- `src/memory/backend-config.ts:354-363` — `entityExtraction` config fields resolved but never consumed
- `src/memory/mongodb-query-rewriter.ts:137-143` — "llm"/"hyde" silently fall back to synonym-expansion
- `src/memory/mongodb-manager.ts:817-818` — cache TTL uses static `kbTtlSec` vs `conversationTtlSec` based on `kb.enabled`, not actual paths used
- `src/memory/mongodb-reranker.ts:78` — sends all candidate snippets to reranker including empty graph strings
- `src/memory/mongodb-telemetry.ts:20` — `"entity-extraction"` operation defined but never emitted
- `src/memory/mongodb-query-rewriter.ts:32-45` — `api: ["endpoint", "route", "rest"]` cross-domain expansion
- `src/memory/mongodb-reranker.ts:141-143` — catch block doesn't emit telemetry
- `src/memory/mongodb-telemetry.ts:89-112` — `getLatencyStats` loads all durations into client memory

### Alternatives

- Score normalization: Could use min-max normalization per batch instead of RRF. RRF is simpler, more robust, and already implemented in `mongodb-hybrid.ts`.
- Entity batch: Could use transactions instead of `bulkWrite`. `bulkWrite` is simpler and sufficient for independent upserts.

### Drawbacks

- Manual RRF discards magnitude information (a score of 0.99 vs 0.50 both become rank-based). Acceptable tradeoff — raw scores were already incomparable across paths.
- `$percentile` is approximate (t-digest algorithm). Acceptable — telemetry stats don't need exact values.
- Removing aggressive synonym expansions may slightly reduce recall for abbreviated queries. Acceptable — false positives were worse than missed expansions.

### Critical-Path Verification Design

- Behavior contract: Not required
- Edge-case catalog: Concise — empty results, single-result paths, all-paths-fail, empty snippets, zero-entity extraction
- Provable properties: None
- Purity boundary map: Not required
- Verification strategy: Unit tests per fix + existing e2e regression

---

## Relevant Codebase Files

### Files to Modify

- `src/memory/mongodb-reranker.ts` — timeout + empty snippet filter + failure telemetry (C1, H5, M1)
- `src/memory/mongodb-manager.ts` — RRF normalization in searchV2 + cache TTL from paths + raw-window limit + synthesizeProfile method (C3, H4, M2, C2-manager)
- `src/memory/mongodb-profile.ts` — split $or $lookup into two indexed $eq lookups (C2/M3)
- `src/memory/mongodb-graph.ts` — bulkWrite for entity/relation upserts + entity-extraction telemetry (H1, H6)
- `src/memory/mongodb-entity-extractor.ts` — document LLM stub clearly (H2)
- `src/memory/backend-config.ts` — add log warning for entity extraction config (H2)
- `src/memory/mongodb-query-rewriter.ts` — throw on unimplemented methods + clean synonym map (H3, H7)
- `src/memory/mongodb-telemetry.ts` — $percentile aggregation (M4)
- `src/memory/mongodb-query-cache.ts` — no changes needed (TTL logic change is in manager)

### Test Files to Modify/Create

- `src/memory/mongodb-reranker.test.ts` — new or extended (C1, H5, M1)
- `src/memory/mongodb-manager.test.ts` — extended (C3, H4, M2, C2-manager)
- `src/memory/mongodb-profile.test.ts` — new (C2/M3)
- `src/memory/mongodb-graph.test.ts` — extended (H1, H6)
- `src/memory/mongodb-entity-extractor.test.ts` — extended (H2)
- `src/memory/backend-config.test.ts` — extended (H2)
- `src/memory/mongodb-query-rewriter.test.ts` — new or extended (H3, H7)
- `src/memory/mongodb-telemetry.test.ts` — extended (M4)

### Patterns to Follow

- `src/memory/mongodb-hybrid.ts` (lines 48-66) — existing RRF scoring functions (rrfScore, normalizeVectorScore, normalizeBM25Score)
- `src/memory/mongodb-telemetry.ts` (lines 58-65) — fire-and-forget emitTelemetry pattern
- `src/memory/mongodb-graph.ts` (lines 182-229) — upsertEntity pattern (convert to bulkWrite)

---

## Phase 1: CRITICAL Fixes (C1 + C2 + C3)

> **Exit Criteria:** Reranker fetch has timeout. Profile $lookup uses indexed queries. searchV2 normalizes scores via RRF. All existing tests pass.

### Task 1.1: Reranker Fetch Timeout (C1)

**Files:**

- Modify: `src/memory/mongodb-reranker.ts:81`
- Test: `src/memory/mongodb-reranker.test.ts`

**Step 1: Write failing test**

Test that `crossEncoderRerank` aborts when the fetch takes longer than 10 seconds.
Use a mock server or mock `fetch` that never resolves, verify the function returns fallback results within a reasonable timeframe.

```typescript
test("crossEncoderRerank aborts on fetch timeout", async () => {
  // Mock fetch that hangs
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(() => new Promise(() => {})); // never resolves
  try {
    const result = await crossEncoderRerank({
      db: mockDb,
      prefix: "test_",
      agentId: "agent1",
      query: "test query",
      results: twoResults,
      config: { ...defaultConfig, enabled: true, voyageApiKey: "pa-test" },
    });
    // Should fall back gracefully, not hang
    expect(result.reranked).toBe(false);
    expect(result.results).toEqual(twoResults);
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 15_000); // test timeout > rerank timeout
```

**Step 2: Run test, verify it fails (hangs or times out)**

Run: `pnpm test -- src/memory/mongodb-reranker.test.ts`
Expected: Test hangs/times out because fetch has no timeout.

**Step 3: Implement `AbortSignal.timeout(10_000)` on fetch**

In `src/memory/mongodb-reranker.ts`, add signal to the fetch call at line 81:

```typescript
const response = await fetch(rerankUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.voyageApiKey}`,
  },
  body: JSON.stringify({
    model: config.model,
    query: config.instruction ? `${config.instruction}\n${query}` : query,
    documents,
    top_k: candidates.length,
  }),
  signal: AbortSignal.timeout(10_000),
});
```

**Step 4: Run test, verify it passes**

Run: `pnpm test -- src/memory/mongodb-reranker.test.ts`
Expected: PASS — function returns fallback within timeout.

### Task 1.2: Profile $lookup Index Fix (C2/M3)

**Files:**

- Modify: `src/memory/mongodb-profile.ts:165-183`
- Test: `src/memory/mongodb-profile.test.ts` (new or extend)

**Step 1: Write test**

Test that `synthesizeProfile` returns correct `topEntities` when relations reference entities via both `fromEntityId` and `toEntityId`. Verify the pipeline produces the same results as before (functional equivalence).

**Step 2: Implement the split**

Replace the single `$lookup` with `$or` (lines 165-183 of `mongodb-profile.ts`) with two separate `$lookup` stages, each using `$count` inside the sub-pipeline (memory-efficient — no full relation docs materialized):

```typescript
// Lookup 1: outgoing relations count (uses index on fromEntityId)
{
  $lookup: {
    from: `${prefix}relations`,
    let: { eid: "$entityId" },
    pipeline: [
      { $match: { $expr: { $eq: ["$fromEntityId", "$$eid"] }, ...scopeFilter } },
      { $count: "cnt" },
    ],
    as: "outRels",
  },
},
// Lookup 2: incoming relations count (uses index on toEntityId)
{
  $lookup: {
    from: `${prefix}relations`,
    let: { eid: "$entityId" },
    pipeline: [
      { $match: { $expr: { $eq: ["$toEntityId", "$$eid"] }, ...scopeFilter } },
      { $count: "cnt" },
    ],
    as: "inRels",
  },
},
// Sum the two counts (no full relation docs in memory)
{
  $addFields: {
    relationCount: {
      $add: [
        { $ifNull: [{ $arrayElemAt: ["$outRels.cnt", 0] }, 0] },
        { $ifNull: [{ $arrayElemAt: ["$inRels.cnt", 0] }, 0] },
      ],
    },
  },
},
```

**IMPORTANT:** This requires a compound index on `{ toEntityId: 1, agentId: 1, scope: 1, scopeRef: 1 }` in the relations collection. The existing index only covers `fromEntityId`. See Task 1.2b below.

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-profile.test.ts`
Expected: PASS

### Task 1.2b: Add toEntityId Compound Index to Relations Collection

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (RELATIONS_INDEXES array)
- Test: `src/memory/mongodb-schema.test.ts`

**Why:** The existing relations index covers `{ agentId, scope, scopeRef, fromEntityId, type }` but the new split $lookup for incoming relations needs `toEntityId` as a prefix key. Without this, the incoming lookup still does a COLLSCAN. Research ref: M4 — "$expr in $lookup only uses indexes for $eq comparisons."

**Step 1: Add index**

Add to `RELATIONS_INDEXES` in `mongodb-schema.ts`:

```typescript
{ key: { toEntityId: 1, agentId: 1, scope: 1, scopeRef: 1 }, name: "idx_relations_to_entity_scope" },
```

**Step 2: Update EXPECTED_STANDARD_INDEX_COUNT**

Increment the count in schema tests and e2e tests (currently 58 → 59).

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-schema.test.ts`
Expected: PASS

### Task 1.3: Add synthesizeProfile to Manager (C2-manager)

**Files:**

- Modify: `src/memory/mongodb-manager.ts`
- Test: `src/memory/mongodb-manager.test.ts`

**Step 1: Write test**

```typescript
test("synthesizeProfile delegates to standalone function", async () => {
  // Mock the standalone synthesizeProfile
  const result = await manager.synthesizeProfile({ scope: "agent", scopeRef: "agent1" });
  expect(result).toBeDefined();
  expect(result.agentId).toBe("agent1");
});
```

**Step 2: Implement delegation**

Add a `synthesizeProfile` method to `MongoDBMemoryManager` that delegates to the standalone `synthesizeProfile` function from `mongodb-profile.ts`:

```typescript
async synthesizeProfile(params: {
  scope?: MemoryScope;
  scopeRef?: string;
  maxPerType?: number;
  maxEntities?: number;
  maxEpisodes?: number;
  activityWindowMs?: number;
}): Promise<ProfileSynthesis> {
  return synthesizeProfile({
    db: this.db,
    prefix: this.prefix,
    agentId: this.agentId,
    scope: params.scope ?? "agent",
    scopeRef: params.scopeRef ?? this.agentScopeRef,
    maxPerType: params.maxPerType,
    maxEntities: params.maxEntities,
    maxEpisodes: params.maxEpisodes,
    activityWindowMs: params.activityWindowMs,
  });
}
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts`
Expected: PASS

### Task 1.4: Score Normalization via Manual RRF (C3)

**Files:**

- Modify: `src/memory/mongodb-manager.ts:2688-2996` (searchV2 function)
- Test: `src/memory/mongodb-manager.test.ts`

**IMPORTANT:** `MemorySearchResult.filePath` is OPTIONAL. The deduplication function `deduplicateSearchResults` uses `result.snippet` as the dedup key. Use `snippet` (not `filePath`) as the RRF map key.

**Step 1: Structural change — preserve per-path result lists**

Currently `searchV2` accumulates all results into a flat `results: MemorySearchResult[]` array. To apply per-path RRF, we must also keep per-path lists:

```typescript
// Add alongside existing `const results: MemorySearchResult[] = []`
const perPathResults: Record<string, MemorySearchResult[]> = {};

// In each path's try/catch block, after `results.push(...pathResults)`, also:
perPathResults[path.path] = pathResults;
```

This applies to ALL paths including backstop paths (procedural backstop ~line 2943-2967, hybrid backstop ~line 2969-2996). Backstop paths must also track their results in `perPathResults`.

**Step 2: Write tests**

```typescript
describe("searchV2 score normalization", () => {
  test("results from different paths are RRF-normalized", async () => {
    // Setup: mock paths to return results with different score ranges
    const result = await searchV2(...);
    // All final scores should be RRF-based, in (0, 1] range
    for (const r of result.results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  test("single-path results preserve relative ordering", async () => {
    // When only one path returns results, rank ordering is preserved
  });

  test("backstop path results are also RRF-normalized", async () => {
    // When backstop fires, its results should also get RRF scores
  });
});
```

**Step 3: Implement RRF normalization AFTER ALL paths (including backstops)**

Place this code AFTER the hybrid backstop block (~line 2996) and BEFORE the final `rerankResults` call:

```typescript
import { rrfScore } from "./mongodb-hybrid.js";

// RRF normalization: replace raw scores with rank-based scores, summed across paths
// Uses `snippet` as the dedup key (matches deduplicateSearchResults behavior)
const rrfMap = new Map<string, number>();
for (const [_pathName, pathResults] of Object.entries(perPathResults)) {
  // Each path's results are already sorted by native score descending
  for (let rank = 0; rank < pathResults.length; rank++) {
    const key = pathResults[rank].snippet;
    rrfMap.set(key, (rrfMap.get(key) ?? 0) + rrfScore(rank + 1));
  }
}

// Apply fused RRF scores back to the flat results array before dedup
for (const r of results) {
  const rrfVal = rrfMap.get(r.snippet);
  if (rrfVal !== undefined) r.score = rrfVal;
}

// Dedup then re-sort by fused score (existing deduplicateSearchResults call)
const deduped = deduplicateSearchResults(results);
deduped.sort((a, b) => b.score - a.score);
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts`
Expected: PASS

**Step 4: Commit Phase 1**

```bash
scripts/committer "Fix(memory): CRITICAL audit fixes — rerank timeout, profile $lookup index, RRF score normalization, synthesizeProfile delegation" \
  src/memory/mongodb-reranker.ts \
  src/memory/mongodb-profile.ts \
  src/memory/mongodb-manager.ts \
  src/memory/mongodb-reranker.test.ts \
  src/memory/mongodb-profile.test.ts \
  src/memory/mongodb-manager.test.ts
```

---

## Phase 2: HIGH Fixes — Dead Code + Config (H2, H3)

> **Exit Criteria:** LLM entity extractor config is honest about stub status. Query rewriter throws on unimplemented methods. Entity extraction config logs warning.

### Task 2.1: LLMEntityExtractor Config Honesty (H2)

**Files:**

- Modify: `src/memory/backend-config.ts:354-363`
- Modify: `src/memory/mongodb-entity-extractor.ts` (add clear documentation)
- Test: `src/memory/backend-config.test.ts`

**Step 1: Write test**

```typescript
test("resolveMongoDBConfig logs warning when entityExtraction.method is 'llm' but no LLM function available", () => {
  // Config with method: "llm" should produce a resolved config with a warning log
  const spy = vi.spyOn(log, "warn");
  const resolved = resolveMongoDBConfig({
    graph: { entityExtraction: { method: "llm" } },
  });
  expect(spy).toHaveBeenCalledWith(
    expect.stringContaining(
      "entity extraction method 'llm' configured but LLM function not injected",
    ),
  );
  // Config field stays as-is (method: "llm") for future injection
  expect(resolved.graph.entityExtraction.method).toBe("llm");
});
```

**Step 2: Implement warning**

In `backend-config.ts`, after resolving `graph.entityExtraction`, add:

```typescript
if (resolved.graph.entityExtraction.method === "llm") {
  log.warn(
    "entity extraction method 'llm' configured but LLM function not injected — regex extractor will be used at runtime. " +
      "Set graph.entityExtraction.method to 'regex' to suppress this warning.",
  );
}
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/backend-config.test.ts`
Expected: PASS

### Task 2.2: Query Rewriter Validation Error (H3)

**Files:**

- Modify: `src/memory/mongodb-query-rewriter.ts:131-148`
- Test: `src/memory/mongodb-query-rewriter.test.ts` (new or extend)

**Step 1: Write tests**

```typescript
test("rewriteQuery throws ConfigValidationError for 'llm' method", async () => {
  await expect(
    rewriteQuery({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      query: "test",
      config: { enabled: true, method: "llm", maxTokens: 128 },
    }),
  ).rejects.toThrow(/not yet implemented/);
});

test("rewriteQuery throws ConfigValidationError for 'hyde' method", async () => {
  await expect(
    rewriteQuery({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      query: "test",
      config: { enabled: true, method: "hyde", maxTokens: 128 },
    }),
  ).rejects.toThrow(/not yet implemented/);
});
```

**Step 2: Implement validation error**

Replace the silent fallback in `mongodb-query-rewriter.ts` lines 137-143:

```typescript
case "llm":
case "hyde":
  throw new Error(
    `Query rewrite method "${config.method}" is not yet implemented. ` +
    `Use "synonym-expansion" or disable query rewriting (queryRewriting.enabled: false).`,
  );
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-query-rewriter.test.ts`
Expected: PASS

### Task 2.3: Clean Up Aggressive Synonym Expansions (H7)

**Files:**

- Modify: `src/memory/mongodb-query-rewriter.ts:32-45`
- Test: `src/memory/mongodb-query-rewriter.test.ts`

**Step 1: Write tests**

```typescript
test("'api' does not expand to unrelated domains", () => {
  const result = expandSynonyms("api");
  expect(result).not.toContain("route");
  expect(result).not.toContain("rest");
  // Should only contain api (original) + direct abbreviation expansions
});

test("expansion respects max ratio of 3x original word count", () => {
  const result = expandSynonyms("auth db api");
  const originalCount = 3;
  const expandedCount = result.split(/\s+/).length;
  expect(expandedCount).toBeLessThanOrEqual(originalCount * 3);
});
```

**Step 2: Implement**

1. Remove cross-domain expansions from SYNONYM_MAP:
   - `api: ["endpoint", "route", "rest"]` -> REMOVE entirely (api is not a synonym of route/rest)
   - `ui: ["interface", "frontend", "component"]` -> REMOVE (too broad)
   - Keep domain-specific: `auth`, `db`, `bug`, `perf`, `config`, `deps`, `deploy`, `docs`, `test`, `refactor`

**NOTE:** Existing tests in `mongodb-query-rewriter.test.ts` likely assert "api" expands to include "endpoint". Those tests MUST be updated to match the new SYNONYM_MAP. This is expected — the old behavior was wrong (cross-domain false positives).

2. Add max expansion ratio cap (3x):

```typescript
export function expandSynonyms(query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const expanded = new Set(words);
  const maxExpanded = words.length * 3;

  for (const word of words) {
    if (expanded.size >= maxExpanded) break;
    const abbr = ABBREVIATION_MAP[word];
    if (abbr) expanded.add(abbr);
    const syns = SYNONYM_MAP[word];
    if (syns) {
      for (const syn of syns) {
        if (expanded.size >= maxExpanded) break;
        expanded.add(syn);
      }
    }
  }

  return [...expanded].join(" ");
}
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-query-rewriter.test.ts`
Expected: PASS

**Step 4: Commit Phase 2**

```bash
scripts/committer "Fix(memory): HIGH audit fixes — entity extractor config honesty, query rewriter validation, synonym cleanup" \
  src/memory/backend-config.ts \
  src/memory/mongodb-entity-extractor.ts \
  src/memory/mongodb-query-rewriter.ts \
  src/memory/backend-config.test.ts \
  src/memory/mongodb-query-rewriter.test.ts
```

---

## Phase 3: HIGH Fixes — Performance + Telemetry (H1, H4, H5, H6)

> **Exit Criteria:** Entity upserts use bulkWrite. Cache TTL derived from paths. Empty snippets filtered from reranker. Entity-extraction telemetry emitted.

### Task 3.1: bulkWrite for Entity Upserts (H1)

**Files:**

- Modify: `src/memory/mongodb-graph.ts:896-955` (extractAndUpsertEntities)
- Test: `src/memory/mongodb-graph.test.ts`

**Step 1: Write test**

```typescript
test("extractAndUpsertEntities uses bulkWrite for entities", async () => {
  const bulkWriteSpy = vi.spyOn(entitiesCol, "bulkWrite");
  await extractAndUpsertEntities({
    db: mockDb,
    prefix: "test_",
    agentId: "a1",
    eventContent: "@alice mentioned @bob working on #projectX",
    scope: "agent",
    sourceEventId: "ev1",
  });
  // Should call bulkWrite once instead of N sequential upsertEntity calls
  expect(bulkWriteSpy).toHaveBeenCalledTimes(1);
  const ops = bulkWriteSpy.mock.calls[0][0];
  expect(ops.length).toBeGreaterThanOrEqual(2); // at least alice + bob
  // Each op should be updateOne with upsert: true
  for (const op of ops) {
    expect(op).toHaveProperty("updateOne");
    expect(op.updateOne.upsert).toBe(true);
  }
});
```

**Step 2: Implement bulkWrite**

Replace the sequential entity upsert loop (lines 898-913) with:

```typescript
// Batch upsert entities via bulkWrite
const entityOps = extracted.map((entity) => ({
  updateOne: {
    filter: { entityId: entity.entityId, agentId, scope, scopeRef },
    update: {
      $set: {
        entityId: entity.entityId,
        name: entity.name,
        type: entity.type,
        agentId,
        scope,
        scopeRef,
        updatedAt: new Date(),
        ...(sourceEventId ? { sourceEventIds: [sourceEventId] } : {}),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    upsert: true,
  },
}));
if (entityOps.length > 0) {
  await entitiesCollection(db, prefix).bulkWrite(entityOps, { ordered: false });
}
```

Similarly, batch the relation + entity-link upserts into two `bulkWrite` calls.

**CRITICAL: Preserve existing logic.** The pairwise loop (lines 918-955) uses `inferEntityLinkType`, `canonicalizeEntityPair`, `makeEntityLinkId`, and the 6-field compound filter for entity links. The bulkWrite conversion must replicate the EXACT filter/update from `upsertRelation` and `upsertEntityLink` — just batch them. Also preserve the bounded loop indices (`i < 5`, `j < 6`).

```typescript
// Build ops from the pairwise loop (same logic, batched)
const relationOps = [];
const linkOps = [];
for (let i = 0; i < Math.min(extracted.length - 1, 5); i++) {
  for (let j = i + 1; j < Math.min(extracted.length, 6); j++) {
    // ... inferEntityLinkType, canonicalizeEntityPair, makeEntityLinkId ...
    // ... same filter/update as existing upsertRelation/upsertEntityLink ...
    relationOps.push({
      updateOne: {
        filter: {
          /* existing fields */
        },
        update: {
          /* existing $set/$setOnInsert */
        },
        upsert: true,
      },
    });
    linkOps.push({
      updateOne: {
        filter: {
          /* existing 6-field filter */
        },
        update: {
          /* existing fields */
        },
        upsert: true,
      },
    });
  }
}
if (relationOps.length > 0) {
  await relationsCollection(db, prefix).bulkWrite(relationOps, { ordered: false });
}
if (linkOps.length > 0) {
  await entityLinksCollection(db, prefix).bulkWrite(linkOps, { ordered: false });
}
```

**Error handling for partial failures:** `bulkWrite` with `ordered: false` may succeed partially. Wrap in try/catch and log `BulkWriteError.writeErrors` with `log.warn`.

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-graph.test.ts`
Expected: PASS

### Task 3.2: Cache TTL from Path (H4)

**Files:**

- Modify: `src/memory/mongodb-manager.ts:816-831`
- Test: `src/memory/mongodb-manager.test.ts`

**Step 1: Write test**

```typescript
test("cache TTL uses kbTtlSec when kb path was executed", () => {
  // When pathsExecuted includes "kb", TTL should use kbTtlSec
});

test("cache TTL uses conversationTtlSec when only conversation paths executed", () => {
  // When pathsExecuted is ["hybrid", "structured"], TTL should use conversationTtlSec
});
```

**Step 2: Implement**

Replace the static TTL derivation at line 817-818:

```typescript
// Derive TTL from actual paths executed (not static config)
const hasKbPath = v2.metadata.pathsExecuted.includes("kb");
const ttlSec = hasKbPath ? mongoCfg.cache.kbTtlSec : mongoCfg.cache.conversationTtlSec;
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts`
Expected: PASS

### Task 3.3: Filter Empty Snippets Before Reranking (H5)

**Files:**

- Modify: `src/memory/mongodb-reranker.ts:78`
- Test: `src/memory/mongodb-reranker.test.ts`

**Step 1: Write test**

```typescript
test("crossEncoderRerank filters out results with empty/blank snippets", async () => {
  const results = [
    { snippet: "Alice works on ProjectX", score: 0.9 /* ... */ },
    { snippet: "", score: 0.8 /* ... */ }, // empty — should be filtered
    { snippet: "   ", score: 0.7 /* ... */ }, // blank — should be filtered
    { snippet: "Bob manages TeamY", score: 0.6 /* ... */ },
  ];
  // Mock fetch to return reranked indices for non-empty docs only
  // Verify only 2 documents sent to API, empty results appended at end
});
```

**Step 2: Implement**

Before building the `documents` array for the API call, filter empty snippets:

```typescript
// Filter out candidates with empty/blank snippets (graph relations can produce near-empty text)
const validCandidates = candidates.filter((r) => r.snippet.trim().length > 0);
const emptySnippetCandidates = candidates.filter((r) => r.snippet.trim().length === 0);

if (validCandidates.length <= 1) {
  return { results, reranked: false, latencyMs: 0 };
}

const documents = validCandidates.map((r) => r.snippet);
```

After reranking, append emptySnippetCandidates before overflow and below:

```typescript
return {
  results: [...reranked, ...emptySnippetCandidates, ...overflow, ...below],
  reranked: true,
  latencyMs,
};
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-reranker.test.ts`
Expected: PASS

### Task 3.4: Entity-Extraction Telemetry (H6)

**Files:**

- Modify: `src/memory/mongodb-graph.ts` (extractAndUpsertEntities)
- Test: `src/memory/mongodb-graph.test.ts`

**Step 1: Write test**

```typescript
test("extractAndUpsertEntities emits entity-extraction telemetry", async () => {
  const telemetrySpy = vi.spyOn(telemetryModule, "emitTelemetry");
  await extractAndUpsertEntities({
    db: mockDb,
    prefix: "test_",
    agentId: "a1",
    eventContent: "@alice",
    scope: "agent",
  });
  expect(telemetrySpy).toHaveBeenCalledWith(
    mockDb,
    "test_",
    expect.objectContaining({
      meta: { agentId: "a1", operation: "entity-extraction" },
      ok: true,
      extractionMethod: "regex",
      entitiesExtracted: 1,
    }),
  );
});
```

**Step 2: Implement**

Add `emitTelemetry` calls to `extractAndUpsertEntities` in both success and failure paths:

```typescript
// After successful extraction + upsert:
emitTelemetry(db, prefix, {
  meta: { agentId, operation: "entity-extraction" },
  durationMs: Date.now() - startMs,
  ok: true,
  extractionMethod: extractorResults[0]?.extractionMethod ?? "regex", // use result's method, not instanceof
  entitiesExtracted: extracted.length,
});

// In catch block:
emitTelemetry(db, prefix, {
  meta: { agentId, operation: "entity-extraction" },
  durationMs: Date.now() - startMs,
  ok: false,
  extractionMethod: extractor instanceof RegexEntityExtractor ? "regex" : "llm",
  entitiesExtracted: 0,
});
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-graph.test.ts`
Expected: PASS

**Step 4: Commit Phase 3**

```bash
scripts/committer "Fix(memory): HIGH audit fixes — bulkWrite entity upserts, path-based cache TTL, empty snippet filter, entity-extraction telemetry" \
  src/memory/mongodb-graph.ts \
  src/memory/mongodb-manager.ts \
  src/memory/mongodb-reranker.ts \
  src/memory/mongodb-graph.test.ts \
  src/memory/mongodb-manager.test.ts \
  src/memory/mongodb-reranker.test.ts
```

---

## Phase 4: MEDIUM Quick-Wins (M1, M2, M4)

> **Exit Criteria:** Reranker emits telemetry on failure. Raw-window events capped at 50. getLatencyStats uses $percentile.

### Task 4.1: Reranker Failure Telemetry (M1)

**Files:**

- Modify: `src/memory/mongodb-reranker.ts:141-143`
- Test: `src/memory/mongodb-reranker.test.ts`

**Step 1: Write test**

```typescript
test("crossEncoderRerank emits telemetry on failure", async () => {
  globalThis.fetch = vi.fn(() => Promise.reject(new Error("network error")));
  const telemetrySpy = vi.spyOn(telemetryModule, "emitTelemetry");
  const result = await crossEncoderRerank({
    /* valid params with enabled config */
  });
  expect(result.reranked).toBe(false);
  expect(telemetrySpy).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ ok: false }),
  );
});
```

**Step 2: Implement**

Add `emitTelemetry` to the catch block in `crossEncoderRerank`:

```typescript
} catch (err) {
  log.warn("rerank failed, falling back to input order", { error: err });
  emitTelemetry(db, prefix, {
    meta: { agentId, operation: "rerank" },
    durationMs: Date.now() - rerankStart,
    ok: false,
    rerankModel: config.model,
    rerankLatencyMs: Date.now() - rerankStart,
  });
  return { results, reranked: false, latencyMs: Date.now() - rerankStart };
}
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-reranker.test.ts`
Expected: PASS

### Task 4.2: Raw-Window Event Cap (M2)

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (searchV2, raw-window case)
- Test: `src/memory/mongodb-manager.test.ts`

**Step 1: Write test**

```typescript
test("searchV2 raw-window path caps events at 50", async () => {
  // Mock getEventsByTimeRange to return 100 events
  // Verify only 50 are used in pathResults
});
```

**Step 2: Implement**

In the `raw-window` case of searchV2 (around line 2744), pass an explicit limit:

```typescript
case "raw-window": {
  const rawWindowLimit = 50;
  const events = await getEventsByTimeRange({
    db,
    prefix,
    agentId,
    start: timeRange?.start ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
    end: timeRange?.end ?? new Date(),
    scope,
    scopeRef: agentScopeRef,
    limit: rawWindowLimit,
  });
```

Note: `getEventsByTimeRange` already accepts a `limit` parameter (default 1000). We just pass 50.

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts`
Expected: PASS

### Task 4.3: Server-Side $percentile for Latency Stats (M4)

**Files:**

- Modify: `src/memory/mongodb-telemetry.ts:89-112` (getLatencyStats)
- Test: `src/memory/mongodb-telemetry.test.ts`

**Step 1: Write test**

```typescript
test("getLatencyStats uses $percentile aggregation", async () => {
  // Insert telemetry documents
  // Verify the aggregation pipeline uses $percentile instead of $push
  const spy = vi.spyOn(collection, "aggregate");
  await getLatencyStats({ db, prefix, agentId: "a1" });
  const pipeline = spy.mock.calls[0][0];
  // Verify no $push in $group, and $percentile is used
  const groupStage = pipeline.find((s) => s.$group);
  expect(groupStage.$group).not.toHaveProperty("durations");
  expect(groupStage.$group.p50).toBeDefined();
});
```

**Step 2: Implement**

Replace the current `$push` + client-side percentile calculation with server-side `$percentile`:

```typescript
const pipeline = [
  { $match: matchStage },
  {
    $group: {
      _id: null,
      count: { $sum: 1 },
      p50: {
        $percentile: {
          input: "$durationMs",
          p: [0.5],
          method: "approximate",
        },
      },
      p95: {
        $percentile: {
          input: "$durationMs",
          p: [0.95],
          method: "approximate",
        },
      },
      p99: {
        $percentile: {
          input: "$durationMs",
          p: [0.99],
          method: "approximate",
        },
      },
    },
  },
];

const results = await telemetryCollection(db, prefix).aggregate(pipeline).toArray();
if (results.length === 0 || results[0].count === 0) {
  return { p50: 0, p95: 0, p99: 0, count: 0 };
}

return {
  p50: results[0].p50?.[0] ?? 0,
  p95: results[0].p95?.[0] ?? 0,
  p99: results[0].p99?.[0] ?? 0,
  count: results[0].count,
};
```

Note: `$percentile` returns an array (one value per percentile requested). Since we request one percentile per field, we take index [0].

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-telemetry.test.ts`
Expected: PASS

**Step 4: Commit Phase 4**

```bash
scripts/committer "Fix(memory): MEDIUM audit fixes — reranker failure telemetry, raw-window event cap, $percentile latency stats" \
  src/memory/mongodb-reranker.ts \
  src/memory/mongodb-manager.ts \
  src/memory/mongodb-telemetry.ts \
  src/memory/mongodb-reranker.test.ts \
  src/memory/mongodb-manager.test.ts \
  src/memory/mongodb-telemetry.test.ts
```

---

## Phase 5: Final Validation

> **Exit Criteria:** All memory tests pass. Build succeeds. No regressions.

### Task 5.1: Full Test Suite

**Step 1: Run full memory test suite**

Run: `pnpm test -- src/memory`
Expected: All tests pass (baseline + new tests)

**Step 2: Run build**

Run: `pnpm build`
Expected: Exit 0

**Step 3: Run lint/format**

Run: `pnpm check`
Expected: Clean (or baseline-only issues)

**Step 4: Run e2e tests (if MONGODB_TEST_URI available)**

Run: `MONGODB_TEST_URI=... pnpm test -- --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts`
Expected: All scenarios pass

**Step 5: Final commit if any cleanup needed**

---

## Risks And Mitigations

| Risk                                                    | P   | I   | Score | Mitigation                                                                             |
| ------------------------------------------------------- | --- | --- | ----- | -------------------------------------------------------------------------------------- |
| RRF normalization changes result ordering               | 3   | 3   | 9     | Existing heuristic reranker + cross-encoder reranker run AFTER RRF, preserving quality |
| `$percentile` mock complexity                           | 1   | 2   | 2     | atlas-local:preview always has latest MongoDB with $percentile; mock in unit tests     |
| bulkWrite partial failure                               | 2   | 3   | 6     | `ordered: false` continues on error; log failures from BulkWriteError                  |
| Removing synonym expansions reduces recall              | 2   | 2   | 4     | Only removing cross-domain (api->route); keeping domain-specific                       |
| Profile $lookup split changes entity count due to dedup | 2   | 2   | 4     | Test for functional equivalence; relations with same entity on both sides are rare     |

## Acceptance Checks

- `pnpm test -- src/memory` — all tests pass
- `pnpm build` — exit 0
- `pnpm check` — clean (or baseline-only)
- Each CRITICAL fix has at least 2 unit tests
- Each HIGH fix has at least 1 unit test
- Score normalization produces scores in [0, 1] range
- Reranker fetch aborts within 10 seconds on timeout
- Entity upserts use bulkWrite (verify via spy or mock)
- `entity-extraction` telemetry is emitted

## Summary

- Plan saved: `docs/plans/2026-03-23-supermemory-audit-fixes-plan.md`
- Phases: 5
- Risks: 5 identified
- Key decisions: Manual RRF for score normalization, bulkWrite for entity batching, $percentile for server-side stats, throw on unimplemented query rewrite methods

## Recommended Skills for BUILD (SKILL_HINTS for Router)

- `cc10x:architecture-patterns` (multi-file schema/integration work)

## Confidence Score: 88/100

- Context References included with file:line (+25)
- All edge cases documented (+20)
- Test commands specific (+20)
- Risk mitigations defined (+20)
- File paths exact (+15)
- Minor uncertainty: mock complexity for RRF normalization tests (-6), profile test setup for split $lookup (-6)

**Key Assumptions:**

- atlas-local:preview always ships latest MongoDB — all features ($percentile, $scoreFusion, etc.) are available
- `AbortSignal.timeout()` available in Node 22+ runtime (confirmed: Node 18+)
- Existing `rrfScore()` function from `mongodb-hybrid.ts` is correct and reusable
- bulkWrite `ordered: false` is safe because entity/relation upserts are independent

## Findings

- `mongodb-hybrid.ts` already has RRF scoring, normalization utilities, and OR-join FTS — well-positioned for searchV2 integration
- `getEventsByTimeRange` already has a `limit` parameter (default 1000) — M2 fix is trivial
- `LLMEntityExtractor` class is well-structured with timeout + fallback — the dead code is only the config-to-instance bridge in `backend-config.ts`
- Profile synthesis `$lookup` with `$or` is the only non-indexed aggregation in the supermemory subsystem

## Task Status

- Follow-up tasks created: None
- **CRITICAL:** Now execute the `TaskUpdate` tool to mark task as completed.

## Router Contract (MACHINE-READABLE)

```yaml
STATUS: PLAN_CREATED
PLAN_MODE: execution_plan
VERIFICATION_RIGOR: standard
CONFIDENCE: 88
PLAN_FILE: "docs/plans/2026-03-23-supermemory-audit-fixes-plan.md"
PHASES: 5
RISKS_IDENTIFIED: 5
SCENARIOS:
  - name: "Reranker fetch timeout"
    given: "Voyage API is unresponsive"
    when: "crossEncoderRerank is called"
    then: "Returns fallback results within 10s, emits ok:false telemetry"
  - name: "RRF score normalization"
    given: "searchV2 returns results from vector (0-1), graph (synthetic), and episode (synthetic) paths"
    when: "Results are merged and deduplicated"
    then: "All final scores are RRF-normalized in [0,1] range, sorted by fused RRF score"
  - name: "bulkWrite entity upserts"
    given: "extractAndUpsertEntities receives content with 5 entities"
    when: "Entities and relations are persisted"
    then: "One bulkWrite call for entities, one for relations, one for links (3 round-trips, not 25)"
  - name: "Empty snippet filtering"
    given: "Reranker receives results with empty graph snippets"
    when: "Candidates are prepared for API call"
    then: "Empty snippets are excluded from API call and appended after reranked results"
  - name: "Query rewriter validation"
    given: "Config sets queryRewriting.method to 'llm'"
    when: "rewriteQuery is called"
    then: "Throws Error with clear message about unimplemented method"
  - name: "Server-side percentile stats"
    given: "Telemetry collection has 100+ latency documents"
    when: "getLatencyStats is called"
    then: "Pipeline uses $percentile aggregation, no client-side array processing"
  - name: "Cache TTL from paths"
    given: "searchV2 executed kb path"
    when: "Cache write fires"
    then: "TTL uses kbTtlSec, not static config"
  - name: "Profile $lookup indexed"
    given: "Entity has relations via both fromEntityId and toEntityId"
    when: "synthesizeProfile is called"
    then: "Two separate indexed $eq lookups are used instead of $or in $expr"
ASSUMPTIONS:
  [
    "atlas-local 8.2 supports $percentile",
    "AbortSignal.timeout available in Node 22+",
    "rrfScore from mongodb-hybrid.ts is correct",
    "bulkWrite ordered:false safe for independent upserts",
  ]
DECISIONS:
  [
    "Manual RRF for cross-path score normalization",
    "bulkWrite for entity batching",
    "$percentile for server-side stats",
    "Throw on unimplemented query rewrite methods",
    "Remove cross-domain synonym expansions",
  ]
OPEN_DECISIONS: []
DIFFERENCES_FROM_AGREEMENT: []
RECOMMENDED_DEFAULTS:
  ["RRF k=60", "Rerank timeout 10s", "Raw-window limit 50", "Synonym max ratio 3x"]
ALTERNATIVES: ["Min-max normalization instead of RRF", "Transactions instead of bulkWrite"]
DRAWBACKS:
  [
    "RRF discards score magnitude information",
    "$percentile is approximate",
    "Removing synonym expansions may reduce recall",
  ]
PROVABLE_PROPERTIES: []
BLOCKING: false
NEXT_ACTION: "build"
REMEDIATION_NEEDED: false
REQUIRES_REMEDIATION: false
REMEDIATION_REASON: null
GATE_PASSED: true
USER_INPUT_NEEDED: []
MEMORY_NOTES:
  learnings:
    [
      "15 audit fixes planned across 9 source files",
      "mongodb-hybrid.ts RRF utilities reusable in searchV2",
      "getEventsByTimeRange already has limit param",
      "Profile $lookup with $or is only non-indexed aggregation",
    ]
  patterns:
    [
      "Manual RRF for cross-path score normalization",
      "bulkWrite ordered:false for independent entity upserts",
      "$percentile GA since MongoDB 7.0",
      "AbortSignal.timeout for external API calls",
    ]
  verification:
    ["Plan: docs/plans/2026-03-23-supermemory-audit-fixes-plan.md with 88/100 confidence"]
```
