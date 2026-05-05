# Supermemory-Inspired Features: Profile Synthesis, Cross-Encoder Re-ranking, Query Rewriting, LLM Entity Extraction

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Research:** 4 sub-agents (Supermemory deep-dive, Memongo deep-dive, architecture-fit analysis, MongoDB best-practices research).

**Goal:** Add 4 high-value features inspired by Supermemory research into Memongo's memory system. All validated as native fits with zero conflicts, zero new collections, zero breaking changes.

**Architecture:** All features integrate at different stages of the existing pipeline — profile is read-only aggregation, reranking is post-search, query rewriting is pre-search, entity extraction is write-side. No feature touches another's stage.

**Tech Stack:** MongoDB Community + mongot, TypeScript ESM, Vitest, Voyage AI (autoEmbed + rerank-2.5 API), fire-and-forget telemetry.

**Prerequisites:** All v2 base + enhancements + consolidation + cache + telemetry COMPLETE. 22 collections, 58 standard indexes, 9 search indexes. Published @romiluz/memongo@2026.3.22.

**Plan Mode:** execution_plan
**Verification Rigor:** standard

---

## Relevant Codebase Files

### Files to Modify

- `src/memory/mongodb-manager.ts` — searchV2() hook points for rewriting + reranking, synthesizeProfile() delegation
- `src/memory/mongodb-graph.ts` — extractAndUpsertEntities() gets optional extractor parameter
- `src/memory/mongodb-telemetry.ts` — add new TelemetryOperation values
- `src/config/types.memory.ts` — add queryRewriting, reranking, graph.entityExtraction config sections
- `src/memory/backend-config.ts` — resolve new config sections with defaults
- `src/memory/index.ts` — barrel exports for new modules

### New Files to Create

- `src/memory/mongodb-profile.ts` — profile synthesis
- `src/memory/mongodb-profile.test.ts` — tests
- `src/memory/mongodb-reranker.ts` — cross-encoder reranking
- `src/memory/mongodb-reranker.test.ts` — tests
- `src/memory/mongodb-query-rewriter.ts` — query expansion
- `src/memory/mongodb-query-rewriter.test.ts` — tests
- `src/memory/mongodb-entity-extractor.ts` — pluggable extraction interface
- `src/memory/mongodb-entity-extractor.test.ts` — tests

### Patterns to Follow

- `src/memory/mongodb-ops.ts` — standalone function pattern (db, prefix, ...)
- `src/memory/mongodb-query-cache.ts` — fire-and-forget writes, telemetry emission
- `src/memory/mongodb-structured-memory.ts` — scope-aware queries, revision pattern
- `src/memory/mongodb-graph.ts` — entity CRUD, $graphLookup, extractAndUpsertEntities
- `src/memory/mongodb-search.ts` — buildVectorSearchStage, fusion methods
- `src/memory/mongodb-hybrid.ts` — score normalization, RRF merge
- `src/memory/mongodb-retrieval-planner.ts` — pure-function retrieval path planner
- `src/memory/mongodb-telemetry.ts` — emitTelemetry fire-and-forget pattern

### Validated MongoDB Syntax (from research)

**$facet for multi-collection profile synthesis:**

```typescript
// $facet sub-pipelines run sequentially (NOT parallel)
// Pre-filter aggressively with $match BEFORE $facet to stay under 100MB RAM limit
// Use correlated $lookup with pipeline + $limit for bounded joins
const pipeline = [
  { $match: { agentId, scope, scopeRef, state: "active" } },
  {
    $facet: {
      preferences: [{ $match: { type: "preference" } }, { $limit: 20 }],
      decisions: [{ $match: { type: "decision" } }, { $limit: 20 }],
      facts: [{ $match: { type: "fact" } }, { $limit: 20 }],
      todos: [{ $match: { type: "todo", state: "active" } }, { $limit: 10 }],
    },
  },
];
```

**Voyage rerank-2.5 API call:**

```typescript
const response = await fetch("https://api.voyageai.com/v1/rerank", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${voyageApiKey}`,
  },
  body: JSON.stringify({
    model: "rerank-2.5",
    query: queryText,
    documents: candidateTexts,
    top_k: topK,
  }),
});
// Response: { object: "list", data: [{ index: number, relevance_score: number }], model: "..." }
```

**EntityExtractor interface pattern:**

```typescript
export interface EntityExtractor {
  extract(content: string, context?: EntityExtractionContext): Promise<ExtractedEntity[]>;
}
```

---

## Open Decisions

None — all decisions pre-answered by research.

## Differences from Agreement

- Previous decision (activeContext.md ## Decisions) rejected cross-encoder reranking and LLM entity extraction. User explicitly REVERSED this after Supermemory deep-dive research.
- Previous deferred item "reranked scores not exposed in search results metadata" — this plan addresses it via the reranker.

---

## Phase 1: Config Foundation + Telemetry Operations

> **Exit Criteria:** New config sections for queryRewriting, reranking, graph.entityExtraction added to types and resolved with defaults. New TelemetryOperation values added. 15+ tests pass.

### Task 1.1: Add queryRewriting config to MemoryMongoDBConfig

**Files:**

- Modify: `src/config/types.memory.ts` (inside MemoryMongoDBConfig type, after `cache` section)

```typescript
/** Query rewriting configuration */
queryRewriting?: {
  /** Enable query rewriting before search. Default: false */
  enabled?: boolean;
  /** Rewriting strategy. Default: "synonym-expansion" */
  method?: "synonym-expansion" | "llm" | "hyde";
  /** Maximum rewritten query length in tokens. Default: 128 */
  maxTokens?: number;
};
```

### Task 1.2: Add reranking config to MemoryMongoDBConfig

**Files:**

- Modify: `src/config/types.memory.ts` (after queryRewriting section)

```typescript
/** Cross-encoder re-ranking configuration */
reranking?: {
  /** Enable cross-encoder re-ranking. Default: false */
  enabled?: boolean;
  /** Re-ranking model. Default: "rerank-2.5" */
  model?: "rerank-2.5" | "rerank-2.5-lite";
  /** Maximum documents to send to reranker. Default: 20 */
  topN?: number;
  /** Minimum retrieval score to be eligible for re-ranking. Default: 0.1 */
  minScore?: number;
  /** Voyage API key. Env fallback: VOYAGE_API_KEY */
  voyageApiKey?: string;
  /** Optional instruction prepended to query for rerank-2.5 instruction-following (8-11% accuracy boost). */
  instruction?: string;
};
```

### Task 1.3: Add entityExtraction config to graph section

**Files:**

- Modify: `src/config/types.memory.ts` (expand existing `graph` section)

```typescript
/** Graph projection config */
graph?: {
  /** Enable graph projection. Default: true */
  enabled?: boolean;
  /** Max depth for $graphLookup. Default: 2 */
  maxGraphDepth?: number;
  /** Entity extraction configuration */
  entityExtraction?: {
    /** Extraction strategy. Default: "regex" */
    method?: "regex" | "llm";
    /** LLM model for extraction (when method="llm"). Uses agent default if omitted */
    model?: string;
    /** Timeout for LLM extraction in ms. Default: 5000 */
    timeoutMs?: number;
  };
};
```

### Task 1.4: Add resolved config sections to ResolvedMongoDBConfig

**Files:**

- Modify: `src/memory/backend-config.ts` (add to ResolvedMongoDBConfig type)

```typescript
queryRewriting: {
  enabled: boolean;
  method: "synonym-expansion" | "llm" | "hyde";
  maxTokens: number;
};
reranking: {
  enabled: boolean;
  model: "rerank-2.5" | "rerank-2.5-lite";
  topN: number;
  minScore: number;
  voyageApiKey: string;
};
// Expand existing graph section:
graph: {
  enabled: boolean;
  maxGraphDepth: number;
  entityExtraction: {
    method: "regex" | "llm";
    model?: string;
    timeoutMs: number;
  };
};
```

### Task 1.5: Resolve new config sections with defaults

**Files:**

- Modify: `src/memory/backend-config.ts` (in resolveMemoryBackendConfig, after `cache` resolution)

```typescript
queryRewriting: {
  enabled: mongoCfg?.queryRewriting?.enabled === true, // disabled by default
  method: mongoCfg?.queryRewriting?.method ?? "synonym-expansion",
  maxTokens: mongoCfg?.queryRewriting?.maxTokens ?? 128,
},
reranking: {
  enabled: mongoCfg?.reranking?.enabled === true, // disabled by default
  model: mongoCfg?.reranking?.model ?? "rerank-2.5",
  topN: mongoCfg?.reranking?.topN ?? 20,
  minScore: mongoCfg?.reranking?.minScore ?? 0.1,
  voyageApiKey: mongoCfg?.reranking?.voyageApiKey ?? process.env.VOYAGE_API_KEY ?? "",
},
// Expand existing graph resolution:
graph: {
  enabled: mongoCfg?.graph?.enabled !== false,
  maxGraphDepth: mongoCfg?.graph?.maxGraphDepth ?? 2,
  entityExtraction: {
    method: mongoCfg?.graph?.entityExtraction?.method ?? "regex",
    model: mongoCfg?.graph?.entityExtraction?.model,
    timeoutMs: mongoCfg?.graph?.entityExtraction?.timeoutMs ?? 5000,
  },
},
```

**Note:** `queryRewriting` and `reranking` use `=== true` (disabled by default), unlike `cache`/`graph`/`episodes` which use `!== false` (enabled by default). This is intentional — these features add latency and cost.

### Task 1.6: Add new TelemetryOperation values

**Files:**

- Modify: `src/memory/mongodb-telemetry.ts` (expand TelemetryOperation union)

```typescript
export type TelemetryOperation =
  | "search"
  | "event-write"
  | "projection-run"
  | "cache-check"
  | "graph-expansion"
  | "profile-synthesis"
  | "rerank"
  | "query-rewrite"
  | "entity-extraction";
```

Add optional fields to TelemetryDocument:

```typescript
export type TelemetryDocument = {
  // ... existing fields ...
  rerankModel?: string;
  rerankLatencyMs?: number;
  queryRewritten?: boolean;
  rewriteMethod?: string;
  extractionMethod?: string;
  entitiesExtracted?: number;
};
```

### Task 1.7: Write config tests

**Files:**

- Modify: `src/memory/backend-config.test.ts`

**Tests:**

1. `resolves queryRewriting defaults (disabled, synonym-expansion, 128)`
2. `resolves queryRewriting with explicit values`
3. `resolves reranking defaults (disabled, rerank-2.5, topN=20, minScore=0.1)`
4. `resolves reranking with explicit values`
5. `resolves reranking.voyageApiKey from env fallback`
6. `resolves graph.entityExtraction defaults (regex, timeoutMs=5000)`
7. `resolves graph.entityExtraction with llm method`
8. `preserves existing graph.enabled and maxGraphDepth behavior`

```bash
pnpm test -- src/memory/backend-config.test.ts
```

**Commit after Phase 1:**

```
Feat: add config sections for query rewriting, cross-encoder reranking, and LLM entity extraction
```

---

## Phase 2: Profile Synthesis

> **Exit Criteria:** `mongodb-profile.ts` module with synthesizeProfile() function. Reads structured_mem, entities, relations, episodes, events. Returns ProfileSynthesis object. Telemetry emitted. 18+ tests pass.

### Task 2.1: Create mongodb-profile.ts with types

**Files:**

- Create: `src/memory/mongodb-profile.ts`

```typescript
import type { Db, Document } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemoryScope } from "../config/types.memory.js";
import {
  structuredMemCollection,
  entitiesCollection,
  relationsCollection,
  episodesCollection,
  eventsCollection,
} from "./mongodb-schema.js";
import { emitTelemetry } from "./mongodb-telemetry.js";

const log = createSubsystemLogger("memory:mongodb:profile");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileSynthesis = {
  agentId: string;
  scope: MemoryScope;
  scopeRef: string;
  /** Structured memory grouped by type */
  preferences: ProfileMemoryItem[];
  decisions: ProfileMemoryItem[];
  facts: ProfileMemoryItem[];
  todos: ProfileMemoryItem[];
  /** Top entities by relation count */
  topEntities: ProfileEntity[];
  /** Most recent episode summaries */
  recentEpisodes: ProfileEpisode[];
  /** Activity patterns derived from events */
  activityPatterns: ActivityPatterns;
  /** Synthesis timestamp */
  synthesizedAt: Date;
};

export type ProfileMemoryItem = {
  key: string;
  value: string;
  salience: string;
  updatedAt: Date;
};

export type ProfileEntity = {
  name: string;
  type: string;
  relationCount: number;
};

export type ProfileEpisode = {
  title: string;
  summary: string;
  type: string;
  timeRange: { start: Date; end: Date };
};

export type ActivityPatterns = {
  /** Distribution of events by role (user, assistant, system, tool) */
  roleDistribution: Record<string, number>;
  /** Total event count in the analysis window */
  totalEvents: number;
  /** Most recent event timestamp */
  lastActive: Date | null;
};
```

### Task 2.2: Implement synthesizeProfile()

**Files:**

- Modify: `src/memory/mongodb-profile.ts`

**Implementation approach:**

1. Query structured_mem with $facet for 4 types (preferences, decisions, facts, todos) — pre-filtered by {agentId, scope, scopeRef, state: "active"}, each sub-pipeline limited to 20 items, sorted by salience priority then updatedAt desc
2. Query entities with $lookup on relations to get relation count — find top 10 entities by relation count for this agent/scope
3. Query episodes — find most recent 10 episodes sorted by timeRange.start desc
4. Query events with $group — aggregate roleDistribution and totalEvents for activity patterns (last 30 days window)
5. Assemble ProfileSynthesis object
6. Emit telemetry (profile-synthesis operation)

**Salience sort order:** critical > high > normal > low (use a priority map: { critical: 0, high: 1, normal: 2, low: 3 })

**Key patterns:**

- All queries filter by `{ agentId, scope, scopeRef }`
- Use existing collection accessors from mongodb-schema.ts
- $facet on structured_mem for the 4 types (most efficient — single pass)
- $lookup + $group on entities → relations for relation count
- Simple find + sort + limit for episodes
- $group on events for activity patterns
- Pre-filter aggressively before $facet to stay under 100MB RAM limit

```typescript
export async function synthesizeProfile(params: {
  db: Db;
  prefix: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef: string;
  /** Max items per structured memory type. Default: 20 */
  maxPerType?: number;
  /** Max entities to return. Default: 10 */
  maxEntities?: number;
  /** Max episodes to return. Default: 10 */
  maxEpisodes?: number;
  /** Activity window in ms. Default: 30 days */
  activityWindowMs?: number;
}): Promise<ProfileSynthesis> {
  const profileStart = Date.now();
  const {
    db,
    prefix,
    agentId,
    scope,
    scopeRef,
    maxPerType = 20,
    maxEntities = 10,
    maxEpisodes = 10,
    activityWindowMs = 30 * 24 * 60 * 60 * 1000,
  } = params;

  const scopeFilter = { agentId, scope, scopeRef };

  // 1. Structured memory via $facet (single pass over collection)
  const structuredResults = await structuredMemCollection(db, prefix)
    .aggregate([
      { $match: { ...scopeFilter, state: "active" } },
      {
        $facet: {
          preferences: [
            { $match: { type: "preference" } },
            { $sort: { updatedAt: -1 } },
            { $limit: maxPerType },
            { $project: { key: 1, value: 1, salience: 1, updatedAt: 1 } },
          ],
          decisions: [
            { $match: { type: "decision" } },
            { $sort: { updatedAt: -1 } },
            { $limit: maxPerType },
            { $project: { key: 1, value: 1, salience: 1, updatedAt: 1 } },
          ],
          facts: [
            { $match: { type: "fact" } },
            { $sort: { updatedAt: -1 } },
            { $limit: maxPerType },
            { $project: { key: 1, value: 1, salience: 1, updatedAt: 1 } },
          ],
          todos: [
            { $match: { type: "todo" } },
            { $sort: { updatedAt: -1 } },
            { $limit: maxPerType },
            { $project: { key: 1, value: 1, salience: 1, updatedAt: 1 } },
          ],
        },
      },
    ])
    .toArray();

  const structured = structuredResults[0] ?? {
    preferences: [],
    decisions: [],
    facts: [],
    todos: [],
  };

  // 2. Top entities by relation count
  const entityResults = await entitiesCollection(db, prefix)
    .aggregate([
      { $match: scopeFilter },
      {
        $lookup: {
          from: `${prefix}relations`,
          let: { eid: "$entityId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [{ $eq: ["$fromEntityId", "$$eid"] }, { $eq: ["$toEntityId", "$$eid"] }],
                },
                ...scopeFilter,
              },
            },
            { $count: "cnt" },
          ],
          as: "rels",
        },
      },
      {
        $addFields: {
          relationCount: { $ifNull: [{ $arrayElemAt: ["$rels.cnt", 0] }, 0] },
        },
      },
      { $sort: { relationCount: -1 } },
      { $limit: maxEntities },
      { $project: { name: 1, type: 1, relationCount: 1 } },
    ])
    .toArray();

  // 3. Recent episodes
  const episodeResults = await episodesCollection(db, prefix)
    .find(scopeFilter)
    .sort({ "timeRange.start": -1 })
    .limit(maxEpisodes)
    .project({ title: 1, summary: 1, type: 1, timeRange: 1 })
    .toArray();

  // 4. Activity patterns from events (last N days)
  const activitySince = new Date(Date.now() - activityWindowMs);
  const activityResults = await eventsCollection(db, prefix)
    .aggregate([
      { $match: { ...scopeFilter, timestamp: { $gte: activitySince } } },
      {
        $group: {
          _id: "$role",
          count: { $sum: 1 },
          lastTs: { $max: "$timestamp" },
        },
      },
    ])
    .toArray();

  const roleDistribution: Record<string, number> = {};
  let totalEvents = 0;
  let lastActive: Date | null = null;
  for (const r of activityResults) {
    roleDistribution[r._id as string] = r.count as number;
    totalEvents += r.count as number;
    const ts = r.lastTs as Date;
    if (!lastActive || ts > lastActive) lastActive = ts;
  }

  const durationMs = Date.now() - profileStart;
  emitTelemetry(db, prefix, {
    meta: { agentId, operation: "profile-synthesis" },
    durationMs,
    ok: true,
    resultCount: totalEvents,
  });

  return {
    agentId,
    scope,
    scopeRef,
    preferences: mapMemoryItems(structured.preferences),
    decisions: mapMemoryItems(structured.decisions),
    facts: mapMemoryItems(structured.facts),
    todos: mapMemoryItems(structured.todos),
    topEntities: entityResults.map((e) => ({
      name: e.name as string,
      type: e.type as string,
      relationCount: e.relationCount as number,
    })),
    recentEpisodes: episodeResults.map((e) => ({
      title: e.title as string,
      summary: e.summary as string,
      type: e.type as string,
      timeRange: e.timeRange as { start: Date; end: Date },
    })),
    activityPatterns: { roleDistribution, totalEvents, lastActive },
    synthesizedAt: new Date(),
  };
}

function mapMemoryItems(items: Document[]): ProfileMemoryItem[] {
  return items.map((i) => ({
    key: i.key as string,
    value: i.value as string,
    salience: (i.salience as string) ?? "normal",
    updatedAt: i.updatedAt as Date,
  }));
}
```

### Task 2.3: Write tests for mongodb-profile.ts

**Files:**

- Create: `src/memory/mongodb-profile.test.ts`

**Tests (18+):**

1. `synthesizeProfile returns empty profile when no data exists`
2. `synthesizeProfile groups structured memory by type via $facet`
3. `synthesizeProfile limits items per type to maxPerType`
4. `synthesizeProfile sorts structured memory by updatedAt desc`
5. `synthesizeProfile filters by state: active only`
6. `synthesizeProfile returns top entities by relation count`
7. `synthesizeProfile limits entities to maxEntities`
8. `synthesizeProfile returns recent episodes sorted by timeRange.start desc`
9. `synthesizeProfile limits episodes to maxEpisodes`
10. `synthesizeProfile calculates activity patterns from events`
11. `synthesizeProfile uses activityWindowMs for event filter`
12. `synthesizeProfile returns null lastActive when no events`
13. `synthesizeProfile filters all queries by agentId, scope, scopeRef`
14. `synthesizeProfile emits profile-synthesis telemetry`
15. `synthesizeProfile handles empty structured_mem collection`
16. `synthesizeProfile handles empty entities collection`
17. `synthesizeProfile handles empty episodes collection`
18. `synthesizeProfile handles empty events collection`

**Mock pattern:** Mock all 5 collection accessors (structuredMemCollection, entitiesCollection, relationsCollection, episodesCollection, eventsCollection) with vi.fn() returning mock aggregate/find chains.

```bash
pnpm test -- src/memory/mongodb-profile.test.ts
```

### Task 2.4: Export from barrel and verify build

**Files:**

- Modify: `src/memory/index.ts`

```typescript
export {
  synthesizeProfile,
  type ProfileSynthesis,
  type ProfileMemoryItem,
  type ProfileEntity,
  type ProfileEpisode,
  type ActivityPatterns,
} from "./mongodb-profile.js";
```

```bash
pnpm build
```

**Commit after Phase 2:**

```
Feat: add profile synthesis from structured memory, entities, episodes, and events
```

---

## Phase 3: Cross-Encoder Re-ranking

> **Exit Criteria:** `mongodb-reranker.ts` module with crossEncoderRerank() function. Calls Voyage rerank-2.5 API. Falls back to input order on failure. Wired into searchV2() after heuristic reranking. 15+ tests pass.

### Task 3.1: Create mongodb-reranker.ts with types

**Files:**

- Create: `src/memory/mongodb-reranker.ts`

```typescript
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Db } from "mongodb";
import { emitTelemetry } from "./mongodb-telemetry.js";
import type { MemorySearchResult } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:reranker");

export type RerankConfig = {
  enabled: boolean;
  model: "rerank-2.5" | "rerank-2.5-lite";
  topN: number;
  minScore: number;
  voyageApiKey: string;
  /** Optional instruction prepended to query for rerank-2.5 instruction-following. */
  instruction?: string;
};

export type RerankResult = {
  results: MemorySearchResult[];
  reranked: boolean;
  latencyMs: number;
};
```

### Task 3.2: Implement crossEncoderRerank()

**Files:**

- Modify: `src/memory/mongodb-reranker.ts`

**Implementation:**

1. If config.enabled is false or no results, return input unchanged
2. Filter results above config.minScore
3. Slice to config.topN candidates
4. Extract snippet text from each candidate
5. Call Voyage rerank API: POST https://api.voyageai.com/v1/rerank
6. Map Voyage response scores back onto MemorySearchResult objects (update .score field)
7. Re-sort by new score descending
8. Append any results that were below minScore (not sent to reranker) at the end
9. On ANY error: log.warn, return input unchanged (never crash search)
10. Emit rerank telemetry

```typescript
const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";

export async function crossEncoderRerank(params: {
  db: Db;
  prefix: string;
  agentId: string;
  query: string;
  results: MemorySearchResult[];
  config: RerankConfig;
}): Promise<RerankResult> {
  const { db, prefix, agentId, query, results, config } = params;
  const rerankStart = Date.now();

  if (!config.enabled || results.length === 0 || !config.voyageApiKey) {
    return { results, reranked: false, latencyMs: 0 };
  }

  // Split into candidates (above minScore) and remainder
  const candidates = results.filter((r) => r.score >= config.minScore).slice(0, config.topN);
  const remainder = results.filter((r) => r.score < config.minScore);

  if (candidates.length <= 1) {
    return { results, reranked: false, latencyMs: 0 };
  }

  try {
    const documents = candidates.map((r) => r.snippet);
    const response = await fetch(VOYAGE_RERANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.voyageApiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        // rerank-2.5 supports instruction-following: prepend instruction to query for 8-11% accuracy boost
        // Example instruction: "This is agent conversation memory. Prioritize recent and contextually relevant results."
        query: config.instruction ? `${config.instruction}\n${query}` : query,
        documents,
        top_k: candidates.length,
      }),
    });

    if (!response.ok) {
      log.warn("rerank API returned non-OK status", { status: response.status });
      return { results, reranked: false, latencyMs: Date.now() - rerankStart };
    }

    const body = (await response.json()) as {
      data: Array<{ index: number; relevance_score: number }>;
    };

    if (!body.data || !Array.isArray(body.data)) {
      log.warn("rerank API returned unexpected response shape");
      return { results, reranked: false, latencyMs: Date.now() - rerankStart };
    }

    // Map scores back onto candidate results (clamp to [0,1] — docs don't guarantee range)
    const reranked = body.data
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((r) => {
        const original = candidates[r.index];
        return { ...original, score: Math.min(1, Math.max(0, r.relevance_score)) };
      });

    const latencyMs = Date.now() - rerankStart;
    emitTelemetry(db, prefix, {
      meta: { agentId, operation: "rerank" },
      durationMs: latencyMs,
      ok: true,
      resultCount: reranked.length,
      rerankModel: config.model,
      rerankLatencyMs: latencyMs,
    });

    return {
      results: [...reranked, ...remainder],
      reranked: true,
      latencyMs,
    };
  } catch (err) {
    log.warn("rerank failed, falling back to input order", { error: err });
    return { results, reranked: false, latencyMs: Date.now() - rerankStart };
  }
}
```

### Task 3.3: Add rerankConfig + queryRewriteConfig to searchV2 context and V2SearchMetadata

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**CRITICAL: searchV2() is a standalone function with NO access to resolvedConfig.** Config must be passed via the existing `context.searchOptions` parameter.

**Step 1:** Add to V2SearchMetadata type (line ~2467):

```typescript
export type V2SearchMetadata = {
  plan: RetrievalPlan;
  pathsExecuted: RetrievalPath[];
  resultsByPath: Record<string, number>;
  reranked?: boolean; // NEW
  queryRewritten?: boolean; // NEW
};
```

**Step 2:** Add to searchV2's `context.searchOptions` type:

```typescript
// Inside the context parameter of searchV2():
searchOptions?: {
  // ... existing fields (numCandidates, capabilities, fusionMethod, etc.) ...
  rerankConfig?: import("./mongodb-reranker.js").RerankConfig;
  queryRewriteConfig?: import("./mongodb-query-rewriter.js").QueryRewriteConfig;
};
```

**Step 3:** Pass config from the caller in MongoDBMemoryManager.search() (line ~770):

```typescript
// In MongoDBMemoryManager.search(), where context is constructed:
const v2 = await searchV2(this.db, this.prefix, cleaned, this.agentId, {
  // ... existing context fields ...
  searchOptions: {
    // ... existing searchOptions ...
    rerankConfig: mongoCfg.reranking,
    queryRewriteConfig: mongoCfg.queryRewriting,
  },
});
```

### Task 3.4: Wire crossEncoderRerank into searchV2()

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**Hook location:** In searchV2(), AFTER `const reranked = rerankResults(deduped, query)` (line ~2966) and BEFORE the return.

```typescript
import { crossEncoderRerank } from "./mongodb-reranker.js";

// After heuristic reranking, before final slice:
const rerankCfg = context.searchOptions?.rerankConfig;
let finalResults = reranked;
let wasReranked = false;
if (rerankCfg?.enabled) {
  const rerankResult = await crossEncoderRerank({
    db,
    prefix,
    agentId,
    query,
    results: reranked,
    config: rerankCfg,
  });
  if (rerankResult.reranked) {
    finalResults = rerankResult.results;
    wasReranked = true;
  }
}
return {
  results: finalResults.slice(0, maxResults),
  metadata: { ...metadata, reranked: wasReranked },
};
```

### Task 3.4: Write tests for mongodb-reranker.ts

**Files:**

- Create: `src/memory/mongodb-reranker.test.ts`

**Tests (15+):**

1. `crossEncoderRerank returns input unchanged when disabled`
2. `crossEncoderRerank returns input unchanged when no results`
3. `crossEncoderRerank returns input unchanged when no API key`
4. `crossEncoderRerank returns input unchanged when single result`
5. `crossEncoderRerank calls Voyage API with correct payload`
6. `crossEncoderRerank maps scores back onto correct results`
7. `crossEncoderRerank re-sorts by relevance_score descending`
8. `crossEncoderRerank appends below-minScore results at end`
9. `crossEncoderRerank slices candidates to topN`
10. `crossEncoderRerank falls back on API error (non-OK status)`
11. `crossEncoderRerank falls back on network error`
12. `crossEncoderRerank falls back on JSON parse error`
13. `crossEncoderRerank emits rerank telemetry on success`
14. `crossEncoderRerank reports reranked:false on fallback`
15. `crossEncoderRerank uses correct model from config`

**Mock pattern:** Mock global fetch with vi.fn(). Mock emitTelemetry.

```bash
pnpm test -- src/memory/mongodb-reranker.test.ts
```

### Task 3.5: Export from barrel and verify build

**Files:**

- Modify: `src/memory/index.ts`

```typescript
export { crossEncoderRerank, type RerankConfig, type RerankResult } from "./mongodb-reranker.js";
```

```bash
pnpm build
```

**Commit after Phase 3:**

```
Feat: add cross-encoder re-ranking via Voyage rerank-2.5 with fallback
```

---

## Phase 4: Query Rewriting

> **Exit Criteria:** `mongodb-query-rewriter.ts` module with rewriteQuery() function. Synonym-expansion tier is deterministic (zero latency). Wired into searchV2() AFTER planRetrieval() but BEFORE path execution. Cache key uses original query. 16+ tests pass.

### Task 4.1: Create mongodb-query-rewriter.ts with types and synonym map

**Files:**

- Create: `src/memory/mongodb-query-rewriter.ts`

```typescript
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Db } from "mongodb";
import { emitTelemetry } from "./mongodb-telemetry.js";

const log = createSubsystemLogger("memory:mongodb:query-rewriter");

export type QueryRewriteConfig = {
  enabled: boolean;
  method: "synonym-expansion" | "llm" | "hyde";
  maxTokens: number;
};

export type QueryRewriteResult = {
  originalQuery: string;
  rewrittenQuery: string;
  rewritten: boolean;
  method: string;
};

/**
 * Domain-specific synonym map for agent memory queries.
 * Bidirectional: each key expands to its values.
 */
const SYNONYM_MAP: Record<string, string[]> = {
  auth: ["authentication", "login", "oauth"],
  db: ["database", "mongodb", "collection"],
  api: ["endpoint", "route", "rest"],
  ui: ["interface", "frontend", "component"],
  bug: ["issue", "error", "defect"],
  perf: ["performance", "latency", "speed"],
  config: ["configuration", "settings", "options"],
  deps: ["dependencies", "packages", "modules"],
  deploy: ["deployment", "release", "publish"],
  docs: ["documentation", "readme", "guide"],
  test: ["testing", "tests", "spec"],
  refactor: ["restructure", "reorganize", "cleanup"],
};

/** Abbreviation expansions (unidirectional: abbreviation -> full form) */
const ABBREVIATION_MAP: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  env: "environment",
  var: "variable",
  fn: "function",
  cb: "callback",
  req: "request",
  res: "response",
  err: "error",
  msg: "message",
  ctx: "context",
  impl: "implementation",
  repo: "repository",
};
```

### Task 4.2: Implement rewriteQuery() with synonym-expansion tier

**Files:**

- Modify: `src/memory/mongodb-query-rewriter.ts`

```typescript
/**
 * Rewrite a query for improved vector search recall.
 *
 * CRITICAL: The retrieval planner must ALWAYS see the ORIGINAL query.
 * This function is called AFTER planRetrieval() and BEFORE search execution.
 * The cache key must also use the ORIGINAL query.
 *
 * Tier 1 (synonym-expansion): Deterministic, zero latency.
 *   - Expand known abbreviations
 *   - Add synonyms for recognized terms
 *   - Preserve original terms (expansion, not replacement)
 */
export async function rewriteQuery(params: {
  db: Db;
  prefix: string;
  agentId: string;
  query: string;
  config: QueryRewriteConfig;
}): Promise<QueryRewriteResult> {
  const { db, prefix, agentId, query, config } = params;
  const rewriteStart = Date.now();

  if (!config.enabled || !query.trim()) {
    return { originalQuery: query, rewrittenQuery: query, rewritten: false, method: "none" };
  }

  let rewritten: string;
  let method: string;

  switch (config.method) {
    case "synonym-expansion":
      rewritten = expandSynonyms(query);
      method = "synonym-expansion";
      break;
    case "llm":
    case "hyde":
      // LLM and HyDE tiers are future work — fall back to synonym expansion
      log.warn(
        `query rewrite method "${config.method}" not yet implemented, falling back to synonym-expansion`,
      );
      rewritten = expandSynonyms(query);
      method = "synonym-expansion-fallback";
      break;
    default:
      rewritten = query;
      method = "none";
  }

  const wasRewritten = rewritten !== query;
  if (wasRewritten) {
    // Truncate to maxTokens (rough approximation: 1 token ≈ 4 chars)
    const maxChars = config.maxTokens * 4;
    if (rewritten.length > maxChars) {
      rewritten = rewritten.slice(0, maxChars).trimEnd();
    }
  }

  emitTelemetry(db, prefix, {
    meta: { agentId, operation: "query-rewrite" },
    durationMs: Date.now() - rewriteStart,
    ok: true,
    queryRewritten: wasRewritten,
    rewriteMethod: method,
  });

  return { originalQuery: query, rewrittenQuery: rewritten, rewritten: wasRewritten, method };
}

/**
 * Deterministic synonym expansion.
 * For each word in the query:
 *   1. Check if it's an abbreviation → add full form
 *   2. Check if it matches a synonym group → add all synonyms
 * Original words are always preserved.
 */
export function expandSynonyms(query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const expanded = new Set(words);

  for (const word of words) {
    // Abbreviation expansion
    if (ABBREVIATION_MAP[word]) {
      expanded.add(ABBREVIATION_MAP[word]);
    }
    // Synonym expansion
    if (SYNONYM_MAP[word]) {
      for (const syn of SYNONYM_MAP[word]) {
        expanded.add(syn);
      }
    }
  }

  return [...expanded].join(" ");
}
```

### Task 4.3: Wire rewriteQuery into searchV2()

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**Hook location:** In searchV2(), AFTER `const plan = planRetrieval(query, ...)` (line ~2625) and BEFORE the path execution `for` loop (line ~2669).

**Note:** searchV2 receives queryRewriteConfig via `context.searchOptions.queryRewriteConfig` (added in Phase 3 Task 3.3).

```typescript
import { rewriteQuery } from "./mongodb-query-rewriter.js";

// After planRetrieval (planner sees ORIGINAL query):
const plan = planRetrieval(query, { entities: knownEntityNames });

// Rewrite query for search execution (NOT for planner or cache key):
const qrConfig = context.searchOptions?.queryRewriteConfig;
let searchQuery = query;
let wasRewritten = false;
if (qrConfig?.enabled) {
  const rewriteResult = await rewriteQuery({
    db,
    prefix,
    agentId,
    query,
    config: qrConfig,
  });
  if (rewriteResult.rewritten) {
    searchQuery = rewriteResult.rewrittenQuery;
    wasRewritten = true;
  }
}
```

**CRITICAL: Two variables, two purposes:**

- `query` (original) → used for: `planRetrieval()` (already called above), `checkCache()`, `writeCache()`
- `searchQuery` (rewritten) → used for: all path search calls

**Step 2: Replace `query` with `searchQuery` in EVERY path execution call (6 locations):**

- Line ~2677: `searchStructuredMemory(db, prefix, searchQuery, ...)` (active-critical path)
- Line ~2697: `searchStructuredMemory(db, prefix, searchQuery, ...)` (structured path)
- Line ~2790: `searchEpisodes(db, prefix, searchQuery, ...)` (episodic path)
- Line ~2835: `mongoSearch({ ..., query: searchQuery, ... })` (hybrid path)
- Line ~2879: `searchKB({ ..., query: searchQuery, ... })` (kb path)
- Line ~2948: `mongoSearch({ ..., query: searchQuery, ... })` (hybrid BACKSTOP recursive call — don't miss this one!)

**Step 3: Add to metadata return:**

```typescript
metadata: { ...metadata, reranked: wasReranked, queryRewritten: wasRewritten },
```

### Task 4.4: Write tests for mongodb-query-rewriter.ts

**Files:**

- Create: `src/memory/mongodb-query-rewriter.test.ts`

**Tests (16+):**

1. `rewriteQuery returns original when disabled`
2. `rewriteQuery returns original for empty query`
3. `expandSynonyms expands known abbreviations`
4. `expandSynonyms adds synonyms for recognized terms`
5. `expandSynonyms preserves original words`
6. `expandSynonyms handles multiple words`
7. `expandSynonyms is case-insensitive`
8. `expandSynonyms returns unchanged query when no matches`
9. `expandSynonyms deduplicates expanded terms`
10. `rewriteQuery truncates to maxTokens`
11. `rewriteQuery emits query-rewrite telemetry`
12. `rewriteQuery reports rewritten:false when no expansion`
13. `rewriteQuery falls back to synonym-expansion for llm method`
14. `rewriteQuery falls back to synonym-expansion for hyde method`
15. `rewriteQuery handles single-word query`
16. `rewriteQuery handles query with all known abbreviations`

```bash
pnpm test -- src/memory/mongodb-query-rewriter.test.ts
```

### Task 4.5: Export from barrel and verify build

**Files:**

- Modify: `src/memory/index.ts`

```typescript
export {
  rewriteQuery,
  expandSynonyms,
  type QueryRewriteConfig,
  type QueryRewriteResult,
} from "./mongodb-query-rewriter.js";
```

```bash
pnpm build
```

**Commit after Phase 4:**

```
Feat: add query rewriting with synonym expansion for improved search recall
```

---

## Phase 5: LLM Entity Extraction

> **Exit Criteria:** `mongodb-entity-extractor.ts` module with EntityExtractor interface, RegexEntityExtractor (extracted from mongodb-graph.ts), and LLMEntityExtractor stub. extractAndUpsertEntities() accepts optional extractor param. 14+ tests pass.

### Task 5.1: Create mongodb-entity-extractor.ts with interface and regex implementation

**Files:**

- Create: `src/memory/mongodb-entity-extractor.ts`

**Implementation:**

1. Define `EntityExtractor` interface with `extract(content, context?)` method
2. Define `EntityExtractionContext` type (agentId, scope, scopeRef, existingEntities?)
3. Define `ExtractedEntity` type (matches existing shape in mongodb-graph.ts)
4. Extract `RegexEntityExtractor` from the existing regex logic in mongodb-graph.ts (lines 867-871: MENTION_REGEX, TAG_REGEX, URL_REGEX, FILE_PATH_REGEX, QUOTED_NAME_REGEX)
5. Create `LLMEntityExtractor` stub that accepts a callable LLM function, with timeout and fallback to regex

```typescript
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:entity-extractor");

// Import the canonical EntityType from mongodb-graph.ts — do NOT redefine it
import type { EntityType } from "./mongodb-graph.js";

// Extended types for LLM extraction (beyond the base EntityType union)
// These are accepted by MongoDB since ENTITIES_SCHEMA validates type as bsonType:"string" (not enum)
// The TypeScript EntityType union in mongodb-graph.ts should be expanded to include these
export type ExtendedEntityType = EntityType | "location" | "system" | "concept";

export type ExtractedEntity = {
  name: string;
  type: string; // string (not EntityType) to allow LLM-extracted extended types
  confidence?: number;
  extractionMethod: "regex" | "llm";
};

export type EntityExtractionContext = {
  agentId: string;
  scope: string;
  scopeRef: string;
  existingEntityNames?: string[];
};

export interface EntityExtractor {
  extract(content: string, context?: EntityExtractionContext): Promise<ExtractedEntity[]>;
}

// Regex patterns (extracted from mongodb-graph.ts)
const MENTION_REGEX = /@(\w{3,})/g;
const TAG_REGEX = /#(\w{3,})/g;
const URL_REGEX = /https?:\/\/[^\s)]+/g; // Excludes ) — matches actual mongodb-graph.ts
const FILE_PATH_REGEX = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g; // + quantifier — matches actual
const QUOTED_NAME_REGEX = /"([^"]{3,})"/g;

// STOP_WORDS: MUST be copied VERBATIM from mongodb-graph.ts (lines 803-864) at build time.
// DO NOT hardcode a different list here — the original source is the single source of truth.
// At implementation time: read the exact STOP_WORDS set from mongodb-graph.ts and paste it here.
// This ensures RegexEntityExtractor filters identically to the original inline extraction.
import { STOP_WORDS } from "./mongodb-graph.js";
// NOTE: STOP_WORDS must be exported from mongodb-graph.ts first (it's currently module-private).
// Add `export` to the existing `const STOP_WORDS = new Set([...])` in mongodb-graph.ts.

export class RegexEntityExtractor implements EntityExtractor {
  async extract(content: string): Promise<ExtractedEntity[]> {
    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    const addEntity = (name: string, type: string) => {
      // Apply stop-word filter for non-URL/non-path entities (matches original behavior)
      if (type !== "document" && STOP_WORDS.has(name.toLowerCase())) return;
      const key = `${name.toLowerCase()}:${type}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type, confidence: 0.5, extractionMethod: "regex" });
      }
    };

    for (const match of content.matchAll(MENTION_REGEX)) {
      addEntity(match[1], "person");
    }
    for (const match of content.matchAll(TAG_REGEX)) {
      addEntity(match[1], "topic");
    }
    for (const match of content.matchAll(URL_REGEX)) {
      addEntity(match[0], "document");
    }
    for (const match of content.matchAll(FILE_PATH_REGEX)) {
      addEntity(match[1], "document");
    }
    for (const match of content.matchAll(QUOTED_NAME_REGEX)) {
      addEntity(match[1], "person");
    }

    return entities;
  }
}

export type LLMFunction = (prompt: string) => Promise<string>;

export class LLMEntityExtractor implements EntityExtractor {
  private llmFn: LLMFunction;
  private timeoutMs: number;
  private fallback: RegexEntityExtractor;

  constructor(llmFn: LLMFunction, timeoutMs = 5000) {
    this.llmFn = llmFn;
    this.timeoutMs = timeoutMs;
    this.fallback = new RegexEntityExtractor();
  }

  async extract(content: string, context?: EntityExtractionContext): Promise<ExtractedEntity[]> {
    try {
      const result = await Promise.race([
        this.extractWithLLM(content, context),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("LLM extraction timeout")), this.timeoutMs),
        ),
      ]);
      return result;
    } catch (err) {
      log.warn("LLM entity extraction failed, falling back to regex", { error: err });
      return this.fallback.extract(content, context);
    }
  }

  private async extractWithLLM(
    content: string,
    context?: EntityExtractionContext,
  ): Promise<ExtractedEntity[]> {
    const prompt = buildExtractionPrompt(content, context);
    const response = await this.llmFn(prompt);
    return parseExtractionResponse(response);
  }
}

export function buildExtractionPrompt(content: string, context?: EntityExtractionContext): string {
  const existingHint = context?.existingEntityNames?.length
    ? `\nKnown entities in this context: ${context.existingEntityNames.join(", ")}`
    : "";

  return `Extract named entities from the following text. Return a JSON array of objects with "name", "type", and "confidence" fields.

Valid types: person, org, project, topic, feature, issue, document, location, system, concept

Rules:
- Only extract entities explicitly mentioned in the text
- Do not invent entities that are not present
- Confidence should be 0.0-1.0 based on how certain you are
- Normalize names (capitalize properly, no leading/trailing whitespace)
${existingHint}

Text:
${content}

Response (JSON array only):`;
}

export function parseExtractionResponse(response: string): ExtractedEntity[] {
  try {
    // Find JSON array in response (may be wrapped in markdown code block)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      name?: string;
      type?: string;
      confidence?: number;
    }>;

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((e) => e.name && typeof e.name === "string" && e.name.trim().length >= 2)
      .map((e) => ({
        name: e.name!.trim(),
        type: (e.type as EntityType) ?? "custom",
        confidence: typeof e.confidence === "number" ? Math.min(1, Math.max(0, e.confidence)) : 0.7,
        extractionMethod: "llm" as const,
      }));
  } catch {
    log.warn("failed to parse LLM extraction response");
    return [];
  }
}
```

### Task 5.2: Modify extractAndUpsertEntities() to accept optional extractor

**Files:**

- Modify: `src/memory/mongodb-graph.ts`

**CRITICAL: The extractor returns `{name, type}` but the existing code needs `{entityId, name, type}`.** The `entityId` is computed by `makeEntityId()` INSIDE `extractAndUpsertEntities()`, NOT by the extractor. The bridge pattern:

1. Extractor returns: `{ name, type, confidence?, extractionMethod }`
2. `extractAndUpsertEntities()` calls extractor, then computes entityId for each result via existing `makeEntityId()` logic
3. Everything downstream (upsertEntity, upsertRelation, upsertEntityLink) is unchanged

**Change the function signature:**

```typescript
import {
  type EntityExtractor,
  RegexEntityExtractor,
  type ExtractedEntity as ExtractorResult,
} from "./mongodb-entity-extractor.js";

const defaultExtractor = new RegexEntityExtractor();

export async function extractAndUpsertEntities(params: {
  db: Db;
  prefix: string;
  agentId: string;
  eventContent: string;
  scope: MemoryScope;
  scopeRef?: string;
  sourceEventId?: string;
  extractor?: EntityExtractor; // NEW optional param
}): Promise<{ entities: ExtractedEntity[]; relationsCreated: number }> {
  const extractor = params.extractor ?? defaultExtractor;

  // Replace the existing inline regex extraction with:
  const extractorResults = await extractor.extract(params.eventContent);

  // Bridge: compute entityId for each extracted entity (existing makeEntityId logic)
  const entities: ExtractedEntity[] = extractorResults.map((r) => ({
    entityId: makeEntityId(r.name, r.type, params.agentId, params.scope, params.scopeRef ?? ""),
    name: r.name,
    type: r.type as EntityType,
  }));

  // ... rest of the function unchanged (upsertEntity, upsertRelation, upsertEntityLink) ...
}
```

**Note:** Remove the existing inline regex patterns (MENTION_REGEX, TAG_REGEX, URL_REGEX, FILE_PATH_REGEX, QUOTED_NAME_REGEX) from mongodb-graph.ts — they now live in RegexEntityExtractor. Keep `makeEntityId()` in mongodb-graph.ts since it's used for the bridge.

**IMPORTANT: Use the EXACT regex from mongodb-graph.ts in RegexEntityExtractor:**

```typescript
// Copy these EXACTLY from mongodb-graph.ts lines 867-871:
const MENTION_REGEX = /@(\w{3,})/g;
const TAG_REGEX = /#(\w{3,})/g;
const URL_REGEX = /https?:\/\/[^\s)]+/g; // Note: excludes ) — matches actual code
const FILE_PATH_REGEX = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
const QUOTED_NAME_REGEX = /"([^"]{3,})"/g;
```

### Task 5.3: Wire extractor into writeEventAndProject()

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**CRITICAL: writeEventAndProject() is a standalone function with NO access to resolvedConfig.** The extractor instance must be passed as a new optional parameter.

**Step 1:** Add optional `extractor` parameter to writeEventAndProject:

```typescript
export async function writeEventAndProject(
  db: Db, prefix: string, event: CanonicalEventInput,
  options?: { extractor?: EntityExtractor },  // NEW
): Promise<...> {
```

**Step 2:** Pass it through to extractAndUpsertEntities:

```typescript
await extractAndUpsertEntities({
  db, prefix,
  agentId: event.agentId,
  eventContent: event.body,
  scope: event.scope as MemoryScope,
  scopeRef: written.scopeRef,
  sourceEventId: written.eventId,
  extractor: options?.extractor,  // NEW — passes through, defaults to regex inside
}).catch((projErr) => { ... });
```

**Step 3:** The MongoDBMemoryManager class creates the extractor once during initialization and passes it through calls:

```typescript
// In MongoDBMemoryManager constructor or create():
import { RegexEntityExtractor, LLMEntityExtractor } from "./mongodb-entity-extractor.js";

// NOTE: LLMEntityExtractor requires an LLMFunction (prompt: string) => Promise<string>.
// For now, the LLM path is a stub — the manager does not currently have an LLM callable.
// When method="llm" is configured but no LLM function is available, fall back to regex.
// The LLM function injection point will be wired when the agent runtime's LLM interface
// is formalized (deferred — regex is the working default).
const extractorInstance =
  mongoCfg.graph.entityExtraction.method === "llm"
    ? new RegexEntityExtractor() // TODO: wire LLM function from agent runtime when available
    : new RegexEntityExtractor();

// In any call to writeEventAndProject:
await writeEventAndProject(this.db, this.prefix, event, {
  extractor: this.extractorInstance,
});
```

### Task 5.4: Write tests for mongodb-entity-extractor.ts

**Files:**

- Create: `src/memory/mongodb-entity-extractor.test.ts`

**Tests (14+):**

1. `RegexEntityExtractor extracts @mentions as person`
2. `RegexEntityExtractor extracts #tags as topic`
3. `RegexEntityExtractor extracts URLs as document`
4. `RegexEntityExtractor extracts file paths as document`
5. `RegexEntityExtractor extracts quoted names as person`
6. `RegexEntityExtractor deduplicates entities`
7. `RegexEntityExtractor returns empty array for no matches`
8. `RegexEntityExtractor sets extractionMethod to regex`
9. `LLMEntityExtractor calls LLM function with extraction prompt`
10. `LLMEntityExtractor parses JSON array response`
11. `LLMEntityExtractor falls back to regex on LLM error`
12. `LLMEntityExtractor falls back to regex on timeout`
13. `LLMEntityExtractor handles markdown-wrapped JSON`
14. `parseExtractionResponse filters invalid entries`
15. `parseExtractionResponse clamps confidence to [0,1]`
16. `buildExtractionPrompt includes existing entity names`

```bash
pnpm test -- src/memory/mongodb-entity-extractor.test.ts
```

### Task 5.5: Export from barrel and verify build

**Files:**

- Modify: `src/memory/index.ts`

```typescript
export {
  type EntityExtractor,
  type ExtractedEntity as ExtractedEntityV2,
  type EntityExtractionContext,
  type LLMFunction,
  RegexEntityExtractor,
  LLMEntityExtractor,
  buildExtractionPrompt,
  parseExtractionResponse,
} from "./mongodb-entity-extractor.js";
```

```bash
pnpm build
```

**Commit after Phase 5:**

```
Feat: add pluggable entity extraction with regex default and LLM upgrade path
```

---

## Phase 6: Final Integration + Validation

> **Exit Criteria:** All 4 features integrated, all tests pass, build clean. README updated. Barrel exports complete.

### Task 6.1: Update README.md capabilities table

**Files:**

- Modify: `README.md`

Add 4 new rows to the capabilities table:

```markdown
| 15 | **Profile Synthesis** | Dynamic agent profile from structured memory, entities, episodes, and events | $facet + $lookup aggregation across 5 collections, ~5-50ms |
| 16 | **Cross-Encoder Re-ranking** | Voyage rerank-2.5 precision pass on search results | Two-stage: $vectorSearch recall → rerank-2.5 precision, 13.89% accuracy improvement |
| 17 | **Query Rewriting** | Synonym expansion for improved vector search recall | Deterministic abbreviation + synonym expansion before embedding |
| 18 | **Pluggable Entity Extraction** | Regex default with LLM upgrade path for richer knowledge graphs | EntityExtractor interface, RegexEntityExtractor + LLMEntityExtractor |
```

Update capability count from 14 to 18.

### Task 6.2: Run full validation

```bash
# All new test files pass
pnpm test -- src/memory/mongodb-profile.test.ts src/memory/mongodb-reranker.test.ts src/memory/mongodb-query-rewriter.test.ts src/memory/mongodb-entity-extractor.test.ts

# Backend config tests pass with new sections
pnpm test -- src/memory/backend-config.test.ts

# Existing tests not regressed
pnpm test -- src/memory/mongodb-manager.test.ts src/memory/mongodb-graph.test.ts

# Build clean
pnpm build

# Full test suite
pnpm test
```

**Commit after Phase 6:**

```
Docs: update README with 18 capabilities including profile, reranking, query rewriting, entity extraction
```

---

## Risks

| Risk                                          | P (1-5) | I (1-5) | Score | Mitigation                                                           |
| --------------------------------------------- | ------- | ------- | ----- | -------------------------------------------------------------------- |
| Voyage rerank API unavailable/slow            | 3       | 2       | 6     | Fallback to heuristic order on any error                             |
| LLM entity extraction hallucination           | 3       | 3       | 9     | Validate extracted entities, confidence threshold, fallback to regex |
| Query rewriting false expansions              | 2       | 2       | 4     | Planner never sees rewritten query, cache key uses original          |
| $facet 100MB RAM limit on profile             | 1       | 3       | 3     | Pre-filter with $match, limit each sub-pipeline to 20 items          |
| LLM extraction timeout on slow models         | 3       | 2       | 6     | Configurable timeout (default 5s), fallback to regex                 |
| Existing extractAndUpsertEntities tests break | 3       | 2       | 6     | RegexEntityExtractor preserves exact same behavior as default        |
| Score semantics confusion (rerank vs vector)  | 2       | 2       | 4     | Rerank scores replace .score field, both [0,1] range                 |

---

## Success Criteria

- [ ] Profile synthesis returns ProfileSynthesis from 5 collections via $facet + $lookup
- [ ] Cross-encoder reranking calls Voyage rerank-2.5 and improves precision
- [ ] Cross-encoder falls back gracefully on any error
- [ ] Query rewriting expands abbreviations and synonyms before search
- [ ] Query rewriting never affects retrieval planner or cache key
- [ ] Pluggable EntityExtractor interface with regex default
- [ ] LLMEntityExtractor with timeout and regex fallback
- [ ] All 4 features disabled-by-default (except profile which is on-demand)
- [ ] Config sections added with sensible defaults
- [ ] Telemetry emitted for all 4 operations
- [ ] 60+ new tests pass
- [ ] `pnpm build` exit 0
- [ ] `pnpm test` — no regressions
- [ ] Barrel exports complete in index.ts

---

## Acceptance Checks

```bash
# Phase 1: Config tests
pnpm test -- src/memory/backend-config.test.ts

# Phase 2: Profile synthesis tests
pnpm test -- src/memory/mongodb-profile.test.ts

# Phase 3: Reranker tests
pnpm test -- src/memory/mongodb-reranker.test.ts

# Phase 4: Query rewriter tests
pnpm test -- src/memory/mongodb-query-rewriter.test.ts

# Phase 5: Entity extractor tests
pnpm test -- src/memory/mongodb-entity-extractor.test.ts

# Phase 6: Full validation
pnpm build
pnpm test
```
