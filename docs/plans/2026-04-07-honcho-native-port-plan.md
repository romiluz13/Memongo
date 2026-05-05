# Honcho Native Memory Intelligence Port — Implementation Plan

> **For Claude:** REQUIRED: Follow this plan phase-by-phase using TDD.
> **Design:** See `docs/plans/2026-04-07-honcho-native-port-design.md` for full specification.

**Goal:** Port 6 Honcho memory intelligence features (reasoning chain, novelty detection, access tracking, importance decay, wiki categorization, consolidation agent) to Memongo as native features with production-grade 10-dimension E2E evaluation.

**Architecture:** Each feature is implemented as a standalone function module in the memory-engine package (`packages/memory-engine/src/mongodb-*.ts`), then wired through 5 layers: Engine -> Bridge -> API -> MCP -> Client SDK + AI SDK Tools. The E2E evaluation harness seeds 450+ events across 3 real-world scenarios and scores across 10 dimensions.

**Tech Stack:** TypeScript ESM, MongoDB (atlas-local:preview), Vitest, Hono (API), MCP SDK, Vercel AI SDK tools, Bun.

**Prerequisites:**
- Docker with `mongodb/mongodb-atlas-local:preview` running on port 27017
- `bun install` completed in Memongo root
- Familiarity with `packages/memory-engine/src/mongodb-schema.ts` collection accessors
- Familiarity with `packages/memory-bridge/src/memongo-bridge.ts` bridge function pattern

**Durable Decisions:**
- All new schema fields are OPTIONAL — no breaking changes to existing documents
- Standalone function pattern: `(db, prefix, agentId, ...)` — NOT class methods
- Manager wrapper methods delegate to standalone functions with `this.db`, `this.prefix`, `this.agentId`
- Bridge functions use `memongoBridge*` prefix and resolve agentId via `memongoBridgeGetManager()`
- MCP tools use `memongo_*` prefix
- Client SDK methods are camelCase on the `MemongoClient` class
- AI SDK tools use `memongo_*` prefix in `createMemongoTools()`
- Access tracking is SERVER-SIDE batched (no in-process timers exposed to callers)
- Events are LEAF NODES — no `sourceEventIds` on events. Derived objects (structured_mem, entities, etc.) have `sourceEventIds`
- `markEventsDreamerProcessed()` uses `dreamerProcessedAt`/`dreamerRunId`, NOT `markEventsConsolidated()` (which requires `episodeId`)
- KB wiki index uses `docId`, NOT `agentId` (KB docs have docId as their primary key)
- No references to "Honcho", "ClawMongo", or "ported from" anywhere in code
- Collection prefix always: `${prefix}${collectionName}`

```
SKILL HINTS (MANDATORY for all sub-agents):
- DO NOT USE mongodb-agent-skills
- For MongoDB best practices: use `mcp__mongodb__search-knowledge` MCP tool
- For web validation: use Bright Data MCP (`mcp__brightdata__scrape_as_markdown`, `mcp__brightdata__search_engine`)
- MongoDB skill references at: /Users/rom.iluz/.claude/skills/mongodb-schema-design/references/
- CC10x skills: architecture-patterns, code-review-patterns, test-driven-development, verification-before-completion
- ClawMongo source (reference only): /Users/rom.iluz/Dev/ClawMongo-v2/src/memory/
- Memongo target: /Users/rom.iluz/Dev/Memongo/
- Key gotchas:
  - Events do NOT have sourceEventIds — derived objects have them
  - markEventsConsolidated requires episodeId — use markEventsDreamerProcessed instead
  - KB has no agentId — use docId in indexes
  - Access tracking is SERVER-SIDE (batched), not in-process timers
  - All new schema fields are OPTIONAL — no breaking changes
  - Standalone function pattern: (db, prefix, agentId, ...) — NOT class methods
  - Manager db/prefix are private — use wrapper methods
  - Bridge functions use memongoBridge* prefix
  - MCP tools use memongo_* prefix
  - E2E requires Docker mongodb/mongodb-atlas-local:preview running
  - Test command: bun run test (Vitest via Turborepo)
  - Build command: bun run build
  - Type check: bun run check-types
  - GAP REVIEW FIXES:
    - EXPECTED_COLLECTION_SUFFIXES baseline is 24 (not 25), becomes 25 after adding consolidation_runs
    - consolidation_runs MUST be added to ensureCollections() needed array (not just the accessor)
    - ensureStandardIndexes uses IMPERATIVE createIndex calls, NOT declarative arrays
    - mongodb-trust.ts exports are NOT in index.ts barrel yet — must be added unconditionally
    - Phase 9 (MCP) depends on Phase 10 (client) — MCP calls client methods
```

---

## Relevant Codebase Files

### Target Files (Memongo)

#### Patterns to Follow
- `packages/memory-engine/src/mongodb-active-slate.ts` — standalone function pattern (`(db, prefix, agentId, ...)`)
- `packages/memory-engine/src/mongodb-trust.ts` — `computeResultTrust()` function (add `computeImportanceDecay` here)
- `packages/memory-engine/src/mongodb-schema.ts:33-145` — collection accessor pattern (`function col(db, prefix, name)`)
- `packages/memory-engine/src/mongodb-manager.ts:2938-2949` — manager wrapper pattern (delegates to standalone function)
- `packages/memory-bridge/src/memongo-bridge.ts:230-243` — bridge function pattern (`memongoBridgeSearch`)
- `packages/memory-bridge/src/memongo-bridge.ts:355-372` — bridge function with capability cast pattern (`ActiveSlateCapableManager`)
- `apps/api/src/routes/v1.ts:125-147` — API route pattern (Hono POST with readAgentId/readQuery helpers)
- `apps/mcp/src/server.ts:14-144` — MCP tool definition pattern (toolList array + CallToolRequestSchema handler)
- `packages/client/src/client.ts:350-363` — client SDK method pattern (uses `apiPost(this._opts, path, body)` module-level helper)
- `packages/tools/src/index.ts:84-139` — AI SDK tool pattern (`tool()` from `ai` with zod schema)
- `packages/memory-engine/src/mongodb-e2e.e2e.test.ts:1-100` — E2E test setup pattern (EXPECTED_ constants, MongoClient, cleanup)

#### Schema Files
- `packages/memory-engine/src/mongodb-schema.ts` — add `consolidationRunsCollection()` accessor + new indexes
- `packages/memory-engine/src/mongodb-e2e.e2e.test.ts` — bump EXPECTED_COLLECTION_SUFFIXES and EXPECTED_STANDARD_INDEX_COUNT

#### Configuration
- `docker/mongodb/docker-compose.preview.yml` — Docker setup for E2E
- `packages/memory-engine/vitest.e2e.config.ts` — E2E Vitest config

### Source Files (ClawMongo — reference only, do NOT modify)
- `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-reasoning-chain.ts` — reasoning chain (162 LOC)
- `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-novelty.ts` — novelty detection (194 LOC)
- `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-access-tracker.ts` — access tracker class (145 LOC)
- `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-consolidator.ts` — consolidation agent (424 LOC)
- `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-result-trust.ts:164-177` — `computeImportanceDecay()` function

---

## Phase 0: Schema Changes

> **Exit Criteria:** `consolidationRunsCollection()` accessor exists. All 3 new indexes defined. EXPECTED_COLLECTION_SUFFIXES includes `consolidation_runs`. EXPECTED_STANDARD_INDEX_COUNT bumped by 3. `bun run check-types` passes.

**Objective:** Add the `consolidation_runs` collection accessor, new optional fields to existing schemas (events, episodes, KB), and 3 new standard indexes.

**Files:**
- Modify: `packages/memory-engine/src/mongodb-schema.ts`
- Modify: `packages/memory-engine/src/mongodb-e2e.e2e.test.ts`

### Task 0.1: Add consolidationRunsCollection accessor

In `packages/memory-engine/src/mongodb-schema.ts`, after the `laneCoverageCollection` function (around line 144), add:

```typescript
export function consolidationRunsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "consolidation_runs")
}
```

### Task 0.1b: Add "consolidation_runs" to ensureCollections needed array

In `packages/memory-engine/src/mongodb-schema.ts`, find the `ensureCollections()` function (around line 960). Add `"consolidation_runs"` to the `needed` array. WITHOUT this, the collection will never be auto-created at runtime.

### Task 0.2: Add 3 new indexes to ensureStandardIndexes (IMPERATIVE pattern)

Find the `ensureStandardIndexes` function in `packages/memory-engine/src/mongodb-schema.ts`. This function uses IMPERATIVE `createIndex` calls (NOT a declarative array). Add these 3 indexes using the existing pattern:

```typescript
// Episodes promotion index (consolidation queries for promotable episodes)
const episodesCol = episodesCollection(db, prefix); // may already be declared — check first
await episodesCol.createIndex(
  { agentId: 1, importance: -1 },
  { name: "idx_episodes_promotion" },
);
applied++;

// Consolidation runs tracking
const consolidationRunsCol = consolidationRunsCollection(db, prefix);
await consolidationRunsCol.createIndex(
  { agentId: 1, startedAt: -1 },
  { name: "idx_consolidation_runs_agent_time" },
);
applied++;

// KB chunks wiki source filter
const kbChunksCol = kbChunksCollection(db, prefix); // may already be declared — check first
await kbChunksCol.createIndex(
  { docId: 1, wikiSource: 1 },
  { name: "idx_kb_chunks_wiki", sparse: true },
);
applied++;
```

**CRITICAL:** Use the IMPERATIVE pattern (await createIndex + applied++), NOT declarative objects. The KB chunks index uses `docId`, NOT `agentId`.

### Task 0.3: Export consolidationRunsCollection from barrel

In `packages/memory-engine/src/index.ts`, find the existing schema exports line:
```typescript
export {
	queryCacheCollection,
	telemetryCollection,
	mutationsCollection,
	laneCoverageCollection,
} from "./mongodb-schema.js"
```

Add `consolidationRunsCollection` to this export block.

### Task 0.4: Update EXPECTED_ constants in E2E test

In `packages/memory-engine/src/mongodb-e2e.e2e.test.ts`:

1. Add `"consolidation_runs"` to the `EXPECTED_COLLECTION_SUFFIXES` array (after `"lane_coverage"`)
2. Bump `EXPECTED_STANDARD_INDEX_COUNT` from `63` to `66` (+3 new indexes)

### Task 0.5: Verify

Run: `bun run check-types`
Expected: PASS (0 errors related to new changes)

**Commit:** `engine: add consolidation_runs collection + 3 new indexes`

---

## Phase 1: Reasoning Chain Engine

> **Exit Criteria:** `traceReasoningChain()` function works with unit tests. 10 unit tests pass. `bun run check-types` passes.

**Objective:** Create `mongodb-reasoning-chain.ts` — a standalone function that traces provenance from derived facts back to source events via `$lookup` on `sourceEventIds`.

**Files:**
- Create: `packages/memory-engine/src/mongodb-reasoning-chain.ts`
- Create: `packages/memory-engine/src/mongodb-reasoning-chain.test.ts`
- Modify: `packages/memory-engine/src/index.ts`
- Modify: `packages/memory-engine/src/types.ts`

### Task 1.1: Add types to types.ts

In `packages/memory-engine/src/types.ts`, add at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// Reasoning Chain
// ---------------------------------------------------------------------------

export type ReasoningChainNode = {
	type: "event" | "fact" | "gap"
	id: string
	collection: string
	body?: string
	role?: string
	timestamp?: Date
	depth: number
	reason?: string
}

export type ReasoningChain = {
	factId: string
	collection: string
	nodes: ReasoningChainNode[]
	chainComplete: boolean
	maxDepthReached: boolean
	agentId: string
}

export type ReasoningChainOptions = {
	maxDepth?: number
}
```

### Task 1.2: Create mongodb-reasoning-chain.ts

Create `packages/memory-engine/src/mongodb-reasoning-chain.ts`.

**Adapt from:** `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-reasoning-chain.ts`

**Key adaptations from ClawMongo:**
- Import types from `./types.js` (not `../types.js`)
- Remove ClawMongo logging import — use `@memongo/lib` createSubsystemLogger if needed (but this module has no logging in ClawMongo, so none needed)
- Keep the `COLLECTION_ID_FIELDS` map (structured_mem, entities, relations, procedures, entity_links)
- Keep the `$lookup` pipeline approach (NOT `$graphLookup` — events are leaf nodes)
- Keep agentId multi-tenant isolation in both `$match` and `$lookup` pipeline `$match`
- Keep gap node detection for deleted/missing sourceEventIds
- The function signature MUST be: `(params: { db: Db; prefix: string; agentId: string; factId: string; collection: string; options?: ReasoningChainOptions }) => Promise<ReasoningChain>`

The full implementation is 162 LOC in ClawMongo. Copy the logic, adapting only imports.

### Task 1.3: Write 10 unit tests

Create `packages/memory-engine/src/mongodb-reasoning-chain.test.ts` with these test cases:

1. `returns empty chain for unknown collection` — pass `collection: "invalid"`, expect `{ nodes: [], chainComplete: true }`
2. `returns empty chain when fact not found` — pass valid collection but non-existent factId
3. `traces single-hop chain from structured_mem to events` — insert a structured_mem doc with `sourceEventIds: ["evt1", "evt2"]`, insert 2 events. Verify 3 nodes: 2 event nodes + 1 fact node
4. `orders events by timestamp ascending` — insert events with mixed timestamps, verify event nodes are timestamp-sorted
5. `produces gap nodes for missing sourceEventIds` — insert structured_mem with `sourceEventIds: ["evt1", "missing"]`, insert only evt1. Verify gap node for "missing"
6. `sets chainComplete=false when gaps exist` — verify `chainComplete` is false when gap nodes are produced
7. `handles fact with no sourceEventIds` — insert structured_mem with no sourceEventIds field. Verify single fact node, `chainComplete: true`
8. `isolates by agentId` — insert facts for two different agents, verify chain only returns events for the requested agent
9. `traces from entities collection` — insert entity with sourceEventIds, verify lookup works
10. `traces from procedures collection` — insert procedure with sourceEventIds, verify lookup works

**Test pattern:** Use `vi.mock("mongodb")` or in-memory mock approach matching existing Memongo test patterns. Each test should create mock Db/Collection with `aggregate().toArray()` returning expected documents.

### Task 1.4: Export from barrel

In `packages/memory-engine/src/index.ts`, add:

```typescript
export {
	traceReasoningChain,
	type ReasoningChain,
	type ReasoningChainNode,
	type ReasoningChainOptions,
} from "./mongodb-reasoning-chain.js"
```

### Task 1.5: Verify

Run: `bun run test -- packages/memory-engine/src/mongodb-reasoning-chain.test.ts`
Expected: 10 tests PASS

Run: `bun run check-types`
Expected: PASS

**Commit:** `engine: add reasoning chain traversal`

---

## Phase 2: Novelty Detection Engine

> **Exit Criteria:** `scanNovelty()` function works with unit tests. 8 unit tests pass. Graceful degradation verified. `bun run check-types` passes.

**Objective:** Create `mongodb-novelty.ts` — centroid-based novelty detection using Atlas Vector Search.

**Files:**
- Create: `packages/memory-engine/src/mongodb-novelty.ts`
- Create: `packages/memory-engine/src/mongodb-novelty.test.ts`
- Modify: `packages/memory-engine/src/types.ts`
- Modify: `packages/memory-engine/src/index.ts`

### Task 2.1: Add types to types.ts

```typescript
// ---------------------------------------------------------------------------
// Novelty Detection
// ---------------------------------------------------------------------------

export type NoveltyEvent = {
	eventId: string
	body: string
	noveltyScore: number
	timestamp: Date
	role: string
	nearestNeighborDistance: number
}

export type NoveltyReport = {
	events: NoveltyEvent[]
	scannedCount: number
	error?: string
	agentId: string
}

export type NoveltyOptions = {
	limit?: number
	kNeighbors?: number
	scope?: string
	timeRange?: {
		start: Date
		end: Date
	}
}
```

### Task 2.2: Create mongodb-novelty.ts

Adapt from `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-novelty.ts` (194 LOC).

**Key adaptations:**
- Import `createSubsystemLogger` from `@memongo/lib` (not `../logging/subsystem.js`)
- Import types from `./types.js`
- Keep `computeCentroid()` helper (element-wise average of embedding vectors)
- Keep the `$vectorSearch` pipeline with `EVENTS_VECTOR_INDEX = "idx_events_vector"`
- Keep novelty scoring: `1 - vectorSearchScore` (higher = more novel)
- Keep graceful degradation: catch `$vectorSearch` errors and return `{ events: [], error: "mongot_unavailable" }`
- Function signature: `(params: { db: Db; prefix: string; agentId: string; options?: NoveltyOptions }) => Promise<NoveltyReport>`

### Task 2.3: Write 8 unit tests

1. `returns empty report when no events have embeddings`
2. `returns empty report when events collection is empty`
3. `computes centroid correctly` — test the pure `computeCentroid` function (export it for testing)
4. `ranks events by novelty descending` — mock vectorSearch results, verify highest novelty first
5. `applies limit to results` — set limit=3, verify at most 3 results
6. `degrades gracefully when vectorSearch fails` — mock aggregate to throw, verify `{ error: "mongot_unavailable" }`
7. `filters by agentId` — verify agentId is in both the find filter and $vectorSearch filter
8. `filters by scope when provided` — verify scope is added to filter

### Task 2.4: Export from barrel

```typescript
export {
	scanNovelty,
	type NoveltyEvent,
	type NoveltyReport,
	type NoveltyOptions,
} from "./mongodb-novelty.js"
```

### Task 2.5: Verify

Run: `bun run test -- packages/memory-engine/src/mongodb-novelty.test.ts`
Expected: 8 tests PASS

**Commit:** `engine: add novelty detection with centroid scoring`

---

## Phase 3: Access Tracker Engine

> **Exit Criteria:** `AccessTracker` class works with server-side batched writes. 6 unit tests pass. Timer cleanup verified. `bun run check-types` passes.

**Objective:** Create `mongodb-access-tracker.ts` — server-side batched access count writes using the approximation pattern.

**Files:**
- Create: `packages/memory-engine/src/mongodb-access-tracker.ts`
- Create: `packages/memory-engine/src/mongodb-access-tracker.test.ts`
- Modify: `packages/memory-engine/src/index.ts`

### Task 3.1: Create mongodb-access-tracker.ts

Adapt from `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-access-tracker.ts` (145 LOC).

**Key adaptations:**
- Import `createSubsystemLogger` from `@memongo/lib`
- Keep the `AccessTracker` class with `recordAccess()`, `flush()`, `close()` methods
- Keep the `COLLECTION_ID_FIELDS` map for ID resolution
- Keep the approximation pattern: buffer `$inc` operations, flush when threshold reached or timer fires
- **CRITICAL for standalone:** The `AccessTracker` instance will be managed by the bridge/API layer, NOT by callers. The bridge creates ONE tracker per manager and flushes on search returns.

**Export:** `AccessTracker` class and `AccessTrackerConfig` type.

### Task 3.2: Write 6 unit tests

1. `buffers access without touching MongoDB` — recordAccess 5 times, verify no updateOne calls
2. `flushes when threshold reached` — set threshold=3, recordAccess 3 times, verify flush occurs
3. `accumulates counts for same document` — recordAccess same id 5 times, flush, verify `$inc: { accessCount: 5 }`
4. `flushes multiple documents in one batch` — record accesses to 3 different ids, flush, verify 3 updateOne calls
5. `close() clears timer and flushes remaining` — call close(), verify clearInterval called and flush triggered
6. `skips flush when buffer is empty` — call flush() with empty buffer, verify 0 updateOne calls

**IMPORTANT for tests:** Use `vi.useFakeTimers()` to control setInterval. Call `vi.useRealTimers()` in afterEach. Always call `tracker.close()` in afterEach to prevent timer leaks.

### Task 3.3: Export from barrel

```typescript
export {
	AccessTracker,
	type AccessTrackerConfig,
} from "./mongodb-access-tracker.js"
```

### Task 3.4: Verify

Run: `bun run test -- packages/memory-engine/src/mongodb-access-tracker.test.ts`
Expected: 6 tests PASS

**Commit:** `engine: add server-side batched access tracker`

---

## Phase 4: Importance Decay Engine

> **Exit Criteria:** `computeImportanceDecay()` exists in `mongodb-trust.ts`. 4 new unit tests pass. `bun run check-types` passes.

**Objective:** Add `computeImportanceDecay()` to the existing `mongodb-trust.ts` module — a pure function computing time-weighted importance with exponential decay.

**Files:**
- Modify: `packages/memory-engine/src/mongodb-trust.ts`
- Modify: `packages/memory-engine/src/mongodb-trust.test.ts`

### Task 4.1: Add computeImportanceDecay to mongodb-trust.ts

Add this function to `packages/memory-engine/src/mongodb-trust.ts` (adapt from ClawMongo `mongodb-result-trust.ts:164-177`):

```typescript
const DAY_MS = 86_400_000

// NOTE: `clamp(value, min=0, max=1)` already exists at the top of this file.
// Do NOT add a duplicate `clamp01` — reuse the existing `clamp()`.

/**
 * Time-weighted importance decay using exponential half-life.
 * importance=1.0 at t=0 decays to ~0.5 at t=halfLife, ~0.25 at t=2*halfLife.
 *
 * @param importance - raw importance (0-1), defaults to 0.5 if missing
 * @param createdAt - creation timestamp
 * @param now - current time (injectable for testing)
 * @param recencyHalfLifeDays - half-life in days (default 7)
 */
export function computeImportanceDecay(
	importance: number | undefined,
	createdAt: Date | undefined,
	now: Date = new Date(),
	recencyHalfLifeDays: number = 7,
): number {
	const raw =
		typeof importance === "number" && Number.isFinite(importance) ? clamp(importance) : 0.5
	if (!(createdAt instanceof Date)) {
		return raw
	}
	const daysSinceCreation = Math.max(0, (now.getTime() - createdAt.getTime()) / DAY_MS)
	return clamp(raw * Math.pow(0.5, daysSinceCreation / recencyHalfLifeDays))
}
```

**NOTE:** `clamp(value, min=0, max=1)` already exists in this file (line 16). Use it instead of `clamp01`. `DAY_MS` and `roundScore` do NOT exist — you must add `DAY_MS`.

### Task 4.2: Write 4 new tests in mongodb-trust.test.ts

Add these tests to the existing test file:

1. `computeImportanceDecay returns raw importance when no createdAt` — `computeImportanceDecay(0.8, undefined)` returns 0.8
2. `computeImportanceDecay returns 0.5 when importance is undefined` — `computeImportanceDecay(undefined, undefined)` returns 0.5
3. `computeImportanceDecay applies half-life decay` — importance=1.0, createdAt=7 days ago, halfLife=7 -> result ~0.5 (within 5%)
4. `computeImportanceDecay at 28 days is ~6%` — importance=1.0, createdAt=28 days ago, halfLife=7 -> result ~0.0625 (within 5%)

### Task 4.3: Export from barrel (if not already exported)

Check if `mongodb-trust.ts` exports are already in `packages/memory-engine/src/index.ts`. If not, add:

```typescript
export { computeImportanceDecay } from "./mongodb-trust.js"
```

### Task 4.4: Verify

Run: `bun run test -- packages/memory-engine/src/mongodb-trust.test.ts`
Expected: All existing tests + 4 new tests PASS

**Commit:** `engine: add importance decay with exponential half-life`

---

## Phase 5: Wiki Source Categorization

> **Exit Criteria:** KB_SCHEMA and KB_CHUNKS_SCHEMA extended with wiki fields. `bun run check-types` passes.

**Objective:** Add `wikiSource`, `vault`, and `section` optional fields to KB schemas.

**Files:**
- Modify: `packages/memory-engine/src/mongodb-schema.ts`

### Task 5.1: Extend KB_SCHEMA

In `packages/memory-engine/src/mongodb-schema.ts`, find the `KB_SCHEMA` object (around line 155). Add these properties inside the `properties` object:

```typescript
wikiSource: { bsonType: "string", description: "Wiki source identifier (e.g., obsidian, notion, confluence)" },
vault: { bsonType: "string", description: "Vault or workspace name" },
section: { bsonType: "string", description: "Section or page path within vault" },
```

### Task 5.2: Extend KB_CHUNKS_SCHEMA

Find `KB_CHUNKS_SCHEMA` (around line 182). Add the same 3 fields inside the `properties` object:

```typescript
wikiSource: { bsonType: "string", description: "Wiki source identifier" },
vault: { bsonType: "string", description: "Vault or workspace name" },
section: { bsonType: "string", description: "Section within vault" },
```

### Task 5.3: Verify

Run: `bun run check-types`
Expected: PASS

**Commit:** `engine: add wiki source fields to KB schemas`

---

## Phase 6: Consolidation Agent Engine

> **Exit Criteria:** `consolidateMemory()` and `markEventsDreamerProcessed()` work with unit tests. 12 unit tests pass. `bun run check-types` passes.

**Objective:** Create `mongodb-consolidator.ts` — the Dreamer pipeline that reads unprocessed events, scores them using novelty + importance + access, deduces structured facts via pattern matching, and records runs.

**Files:**
- Create: `packages/memory-engine/src/mongodb-consolidator.ts`
- Create: `packages/memory-engine/src/mongodb-consolidator.test.ts`
- Modify: `packages/memory-engine/src/types.ts`
- Modify: `packages/memory-engine/src/index.ts`

### Task 6.1: Add types to types.ts

```typescript
// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export type ConsolidationCandidate = {
	eventId: string
	body: string
	timestamp: Date
	noveltyScore: number
	importanceDecay: number
	accessCount: number
	combinedScore: number
}

export type ConsolidationOptions = {
	maxEvents?: number
	minCombinedScore?: number
	minIntervalMs?: number
	noveltyWeight?: number
	importanceWeight?: number
	accessWeight?: number
	scope?: string
}

export type ConsolidationResult = {
	runId: string
	agentId: string
	eventsProcessed: number
	factsPromoted: number
	factsPruned: number
	conflictsResolved: number
	durationMs: number
	candidates: ConsolidationCandidate[]
}
```

### Task 6.2: Create mongodb-consolidator.ts

Adapt from `/Users/rom.iluz/Dev/ClawMongo-v2/src/memory/mongodb-consolidator.ts` (424 LOC).

**Key adaptations:**
- Import `createSubsystemLogger` from `@memongo/lib` (not `../logging/subsystem.js`)
- Import `scanNovelty` from `./mongodb-novelty.js`
- Import `traceReasoningChain` from `./mongodb-reasoning-chain.js`
- Import `computeImportanceDecay` from `./mongodb-trust.js` (not `./mongodb-result-trust.js`)
- Import `computeResultTrust` from `./mongodb-trust.js` (for conflict detection)
- Import `eventsCollection`, `consolidationRunsCollection` from `./mongodb-schema.js`
- Import `writeStructuredMemory` from `./mongodb-structured-memory.js`
- Import types from `./types.js`
- Keep the `PREFERENCE_PATTERN` and `DECISION_PATTERN` regexes for rule-based extraction
- Keep the `hasConflict()` helper using `computeResultTrust` contradiction dimension
- Keep the `markEventsDreamerProcessed()` function (NOT `markEventsConsolidated`)
- Keep the full 9-step consolidation pipeline

**Function signatures:**
- `markEventsDreamerProcessed(params: { db, prefix, eventIds, runId })`: marks events with `dreamerProcessedAt` + `dreamerRunId`
- `consolidateMemory(params: { db, prefix, agentId, options? })`: full pipeline

### Task 6.3: Write 12 unit tests

1. `markEventsDreamerProcessed marks events with dreamerProcessedAt and runId`
2. `markEventsDreamerProcessed returns 0 for empty eventIds`
3. `consolidateMemory rate-limits within minIntervalMs`
4. `consolidateMemory returns empty result when no unprocessed events`
5. `consolidateMemory extracts preference pattern` — event body "I prefer TypeScript" -> promoted as preference
6. `consolidateMemory extracts decision pattern` — event body "I decided to use Bun" -> promoted as decision
7. `consolidateMemory skips events below minCombinedScore`
8. `consolidateMemory skips promotion when conflict detected`
9. `consolidateMemory records run start and completion`
10. `consolidateMemory marks all processed events as dreamer-processed`
11. `consolidateMemory handles novelty scan failure gracefully` — scanNovelty returns empty, consolidation still runs
12. `consolidateMemory is idempotent` — re-run produces 0 new facts (events already marked)

### Task 6.4: Export from barrel

```typescript
export {
	consolidateMemory,
	markEventsDreamerProcessed,
	type ConsolidationCandidate,
	type ConsolidationOptions,
	type ConsolidationResult,
} from "./mongodb-consolidator.js"
```

### Task 6.5: Verify

Run: `bun run test -- packages/memory-engine/src/mongodb-consolidator.test.ts`
Expected: 12 tests PASS

**Commit:** `engine: add consolidation agent (Dreamer) pipeline`

---

## Phase 7: Bridge Functions

> **Exit Criteria:** 3 new `memongoBridge*` functions exist. They delegate to engine standalone functions via manager wrapper. `bun run check-types` passes.

**Objective:** Add bridge functions for the 3 user-facing features: chain trace, novelty scan, consolidation.

**Files:**
- Modify: `packages/memory-bridge/src/memongo-bridge.ts`

### Task 7.1: Add memongoBridgeTraceChain

After the existing `memongoBridgeRelevanceSampleRate` function (around line 610), add:

```typescript
export async function memongoBridgeTraceChain(params: {
	agentId?: string
	factId: string
	collection: string
	maxDepth?: number
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return (m as any).traceChain({
		factId: params.factId,
		collection: params.collection,
		options: params.maxDepth !== undefined ? { maxDepth: params.maxDepth } : undefined,
	})
}
```

**NOTE:** The `(m as any)` cast is needed because the manager type does not yet include the new methods. This follows the same pattern as `ActiveSlateCapableManager` — create a type intersection for cleanliness if preferred:

```typescript
type ChainCapableManager = MongoDBMemoryManager & {
	traceChain?: (params: {
		factId: string
		collection: string
		options?: { maxDepth?: number }
	}) => Promise<unknown>
}
```

### Task 7.2: Add memongoBridgeScanNovelty

```typescript
export async function memongoBridgeScanNovelty(params: {
	agentId?: string
	limit?: number
	scope?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return (m as any).scanNovelty({
		limit: params.limit,
		scope: params.scope,
	})
}
```

### Task 7.3: Add memongoBridgeConsolidate

```typescript
export async function memongoBridgeConsolidate(params: {
	agentId?: string
	maxEvents?: number
	minCombinedScore?: number
	scope?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return (m as any).consolidate({
		maxEvents: params.maxEvents,
		minCombinedScore: params.minCombinedScore,
		scope: params.scope,
	})
}
```

### Task 7.4: Verify

Run: `bun run check-types`
Expected: PASS

**Commit:** `bridge: add chain-trace, novelty-scan, consolidate bridge functions`

---

## Phase 8: API Routes

> **Exit Criteria:** 3 new POST endpoints exist in v1.ts. Routes use existing helper functions. `bun run check-types` passes.

**Objective:** Add 3 new Hono POST routes: `/v1/chain-trace`, `/v1/novelty-scan`, `/v1/consolidate`.

**Files:**
- Modify: `apps/api/src/routes/v1.ts`

### Task 8.1: Import new bridge functions

Add to the import block at the top of `apps/api/src/routes/v1.ts`:

```typescript
import {
	memongoBridgeTraceChain,
	memongoBridgeScanNovelty,
	memongoBridgeConsolidate,
} from "@memongo/memory-bridge"
```

**NOTE:** The memory-bridge package barrel will need to export these. Check `packages/memory-bridge/src/index.ts` (or wherever the barrel is) and add re-exports if needed.

### Task 8.2: Add POST /v1/chain-trace route

Add after the last existing route (before `return v1`):

```typescript
v1.post("/chain-trace", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>
	const factId = typeof body.factId === "string" ? body.factId : ""
	const collection = typeof body.collection === "string" ? body.collection : ""
	if (!factId.trim()) {
		return jsonError(c, 400, "VALIDATION_ERROR", "factId is required")
	}
	if (!collection.trim()) {
		return jsonError(c, 400, "VALIDATION_ERROR", "collection is required")
	}
	try {
		const chain = await memongoBridgeTraceChain({
			agentId: readAgentId(body),
			factId,
			collection,
			maxDepth: typeof body.maxDepth === "number" ? body.maxDepth : undefined,
		})
		return c.json(chain)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return jsonError(c, 500, "CHAIN_TRACE_FAILED", message)
	}
})
```

### Task 8.3: Add POST /v1/novelty-scan route

```typescript
v1.post("/novelty-scan", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>
	try {
		const report = await memongoBridgeScanNovelty({
			agentId: readAgentId(body),
			limit: typeof body.limit === "number" ? body.limit : undefined,
			scope: typeof body.scope === "string" ? body.scope : undefined,
		})
		return c.json(report)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return jsonError(c, 500, "NOVELTY_SCAN_FAILED", message)
	}
})
```

### Task 8.4: Add POST /v1/consolidate route

```typescript
v1.post("/consolidate", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>
	try {
		const result = await memongoBridgeConsolidate({
			agentId: readAgentId(body),
			maxEvents: typeof body.maxEvents === "number" ? body.maxEvents : undefined,
			minCombinedScore: typeof body.minCombinedScore === "number" ? body.minCombinedScore : undefined,
			scope: typeof body.scope === "string" ? body.scope : undefined,
		})
		return c.json(result)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return jsonError(c, 500, "CONSOLIDATE_FAILED", message)
	}
})
```

### Task 8.5: Verify

Run: `bun run check-types`
Expected: PASS

**Commit:** `api: add chain-trace, novelty-scan, consolidate endpoints`

---

## Phase 9: MCP Tools

> **Exit Criteria:** 3 new MCP tool definitions exist in server.ts. `bun run check-types` passes.

**Objective:** Add `memongo_chain_trace`, `memongo_novelty_scan`, `memongo_consolidate` MCP tools.

**Files:**
- Modify: `apps/mcp/src/server.ts`

### Task 9.1: Add tool definitions to toolList

Add these 3 entries to the `toolList` array (after the existing `memongo_status` entry):

```typescript
{
	name: "memongo_chain_trace",
	description: "Trace the provenance chain of a derived fact back to its source events",
	inputSchema: {
		type: "object",
		properties: {
			factId: { type: "string" },
			collection: { type: "string", enum: ["structured_mem", "entities", "relations", "procedures", "entity_links"] },
			agentId: { type: "string" },
			maxDepth: { type: "number" },
		},
		required: ["factId", "collection"],
	},
},
{
	name: "memongo_novelty_scan",
	description: "Scan for the most novel/surprising events using vector distance scoring",
	inputSchema: {
		type: "object",
		properties: {
			agentId: { type: "string" },
			limit: { type: "number" },
			scope: { type: "string" },
		},
	},
},
{
	name: "memongo_consolidate",
	description: "Run the consolidation pipeline to promote high-value events to structured facts",
	inputSchema: {
		type: "object",
		properties: {
			agentId: { type: "string" },
			maxEvents: { type: "number" },
			minCombinedScore: { type: "number" },
			scope: { type: "string" },
		},
	},
},
```

### Task 9.2: Add CallToolRequestSchema handlers

Inside the `server.setRequestHandler(CallToolRequestSchema, ...)` callback, add handlers before the `throw new Error("unknown tool")`:

```typescript
if (name === "memongo_chain_trace") {
	const out = await memongo.traceChain({
		factId: typeof args.factId === "string" ? args.factId : "",
		collection: typeof args.collection === "string" ? args.collection : "",
		agentId: typeof args.agentId === "string" ? args.agentId : undefined,
		maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
	})
	return { content: [{ type: "text", text: JSON.stringify(out) }] }
}
if (name === "memongo_novelty_scan") {
	const out = await memongo.scanNovelty({
		agentId: typeof args.agentId === "string" ? args.agentId : undefined,
		limit: typeof args.limit === "number" ? args.limit : undefined,
		scope: typeof args.scope === "string" ? args.scope : undefined,
	})
	return { content: [{ type: "text", text: JSON.stringify(out) }] }
}
if (name === "memongo_consolidate") {
	const out = await memongo.consolidate({
		agentId: typeof args.agentId === "string" ? args.agentId : undefined,
		maxEvents: typeof args.maxEvents === "number" ? args.maxEvents : undefined,
		minCombinedScore: typeof args.minCombinedScore === "number" ? args.minCombinedScore : undefined,
		scope: typeof args.scope === "string" ? args.scope : undefined,
	})
	return { content: [{ type: "text", text: JSON.stringify(out) }] }
}
```

**NOTE:** The `memongo.traceChain()`, `memongo.scanNovelty()`, `memongo.consolidate()` methods will be added to the client SDK in Phase 10.

### Task 9.3: Verify

Run: `bun run check-types`
Expected: PASS (or expected TS errors for client methods not yet added — Phase 10 fixes them)

**Commit:** `mcp: add chain-trace, novelty-scan, consolidate tools`

---

## Phase 10: Client SDK + AI SDK Tools

> **Exit Criteria:** 3 new methods on `MemongoClient`. 3 new AI SDK tools in `createMemongoTools()`. `bun run check-types` passes.

**Objective:** Add `traceChain()`, `scanNovelty()`, `consolidate()` to the client SDK and AI SDK tools.

**Files:**
- Modify: `packages/client/src/client.ts`
- Modify: `packages/client/src/types.ts`
- Modify: `packages/tools/src/index.ts`

### Task 10.1: Add input types to client types

In `packages/client/src/types.ts`, add:

```typescript
export type MemongoTraceChainInput = {
	factId: string
	collection: string
	agentId?: string
	maxDepth?: number
}

export type MemongoScanNoveltyInput = {
	agentId?: string
	limit?: number
	scope?: string
}

export type MemongoConsolidateInput = {
	agentId?: string
	maxEvents?: number
	minCombinedScore?: number
	scope?: string
}
```

### Task 10.2: Add methods to MemongoClient

In `packages/client/src/client.ts`, add these methods to the `MemongoClient` class.

**CRITICAL pattern:** The client uses `apiPost(this._opts, path, body)` — a module-level helper function, NOT an instance method. Follow the same pattern as `add()`, `search()`, etc.:

```typescript
async traceChain(input: MemongoTraceChainInput): Promise<unknown> {
	return apiPost(this._opts, "/v1/chain-trace", {
		factId: input.factId,
		collection: input.collection,
		agentId: input.agentId,
		maxDepth: input.maxDepth,
	})
}

async scanNovelty(input?: MemongoScanNoveltyInput): Promise<unknown> {
	return apiPost(this._opts, "/v1/novelty-scan", {
		agentId: input?.agentId,
		limit: input?.limit,
		scope: input?.scope,
	})
}

async consolidate(input?: MemongoConsolidateInput): Promise<unknown> {
	return apiPost(this._opts, "/v1/consolidate", {
		agentId: input?.agentId,
		maxEvents: input?.maxEvents,
		minCombinedScore: input?.minCombinedScore,
		scope: input?.scope,
	})
}
```

### Task 10.3: Export new types from client barrel

In `packages/client/src/index.ts`, add to the type exports:

```typescript
export type {
	MemongoTraceChainInput,
	MemongoScanNoveltyInput,
	MemongoConsolidateInput,
} from "./types.js"
```

### Task 10.4: Add AI SDK tools

In `packages/tools/src/index.ts`, add 3 new tools to the `createMemongoTools()` return object:

```typescript
memongo_chain_trace: tool({
	description: "Trace the provenance chain of a derived fact back to source events.",
	inputSchema: z.object({
		factId: z.string(),
		collection: z.string(),
		agentId: z.string().optional(),
		maxDepth: z.number().optional(),
	}),
	execute: async (input) => client.traceChain(input),
}),
memongo_novelty_scan: tool({
	description: "Scan for the most novel/surprising events using vector distance scoring.",
	inputSchema: z.object({
		agentId: z.string().optional(),
		limit: z.number().optional(),
		scope: z.string().optional(),
	}),
	execute: async (input) => client.scanNovelty(input),
}),
memongo_consolidate: tool({
	description: "Run consolidation pipeline to promote high-value events to structured facts.",
	inputSchema: z.object({
		agentId: z.string().optional(),
		maxEvents: z.number().optional(),
		minCombinedScore: z.number().optional(),
		scope: z.string().optional(),
	}),
	execute: async (input) => client.consolidate(input),
}),
```

### Task 10.5: Verify

Run: `bun run check-types`
Expected: PASS

**Commit:** `client+tools: add chain-trace, novelty-scan, consolidate`

---

## Phase 11: Manager Wiring

> **Exit Criteria:** 3 new wrapper methods on `MongoDBMemoryManager`. Bridge functions use typed casts. `bun run check-types` passes.

**Objective:** Wire the standalone engine functions into the manager class so bridge functions can call them via the manager instance.

**Files:**
- Modify: `packages/memory-engine/src/mongodb-manager.ts`

### Task 11.1: Import new engine functions

At the top of `packages/memory-engine/src/mongodb-manager.ts`, add imports:

```typescript
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { scanNovelty } from "./mongodb-novelty.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
```

### Task 11.2: Add wrapper methods to MongoDBMemoryManager class

Find the class body (after the existing `buildContextBundle` method around line 3000). Add:

```typescript
async traceChain(params: {
	factId: string
	collection: string
	options?: { maxDepth?: number }
}) {
	return traceReasoningChain({
		db: this.db,
		prefix: this.prefix,
		agentId: this.agentId,
		factId: params.factId,
		collection: params.collection,
		options: params.options,
	})
}

async scanNovelty(params?: {
	limit?: number
	scope?: string
}) {
	return scanNovelty({
		db: this.db,
		prefix: this.prefix,
		agentId: this.agentId,
		options: params,
	})
}

async consolidate(params?: {
	maxEvents?: number
	minCombinedScore?: number
	scope?: string
}) {
	return consolidateMemory({
		db: this.db,
		prefix: this.prefix,
		agentId: this.agentId,
		options: params,
	})
}
```

### Task 11.3: Update bridge function types

Go back to `packages/memory-bridge/src/memongo-bridge.ts` and update the bridge functions from Phase 7 to use proper typed casts instead of `(m as any)`:

```typescript
type ChainCapableManager = MongoDBMemoryManager & {
	traceChain: (params: {
		factId: string
		collection: string
		options?: { maxDepth?: number }
	}) => Promise<unknown>
}

type NoveltyCapableManager = MongoDBMemoryManager & {
	scanNovelty: (params?: {
		limit?: number
		scope?: string
	}) => Promise<unknown>
}

type ConsolidateCapableManager = MongoDBMemoryManager & {
	consolidate: (params?: {
		maxEvents?: number
		minCombinedScore?: number
		scope?: string
	}) => Promise<unknown>
}
```

And update the bridge functions to cast using these types (same pattern as `ActiveSlateCapableManager`).

### Task 11.4: Verify

Run: `bun run check-types`
Expected: PASS

Run: `bun run build`
Expected: PASS

**Commit:** `engine+bridge: wire manager wrappers for new features`

---

## Phase 12: E2E Evaluation Harness [HITL]

> **Exit Criteria:** E2E evaluation test seeds 450+ events across 3 scenarios, runs 10-phase evaluation, and produces a score card with >= 90/100 overall score and no dimension below 70. Docker `mongodb/mongodb-atlas-local:preview` running.

**Objective:** Build a comprehensive E2E evaluation harness that validates all 6 features end-to-end with real seeded data.

**Files:**
- Create: `packages/memory-engine/src/e2e-evaluation.e2e.test.ts`

### Docker Setup (prerequisite)

```bash
docker compose -f docker/mongodb/docker-compose.preview.yml up -d
# Wait for healthy status:
docker compose -f docker/mongodb/docker-compose.preview.yml ps
# Verify connection:
mongosh "mongodb://localhost:27017" --eval "db.runCommand({ping:1})"
```

### Task 12.1: Test file structure

Create `packages/memory-engine/src/e2e-evaluation.e2e.test.ts` with this structure:

```typescript
/**
 * E2E Evaluation Harness — validates all 6 Honcho-ported features
 * against 3 real-world scenarios with 450+ seeded events.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_MONGODB_URI="mongodb://localhost:27017" vitest run src/e2e-evaluation.e2e.test.ts --reporter=verbose
 *
 * Or from repo root:
 *   MEMONGO_MONGODB_URI="mongodb://localhost:27017" bun run --filter @memongo/memory-engine test:e2e
 */
import { randomUUID } from "node:crypto"
import { MongoClient, type Db } from "mongodb"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeEvent } from "./mongodb-events.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { scanNovelty } from "./mongodb-novelty.js"
import { AccessTracker } from "./mongodb-access-tracker.js"
import { consolidateMemory, markEventsDreamerProcessed } from "./mongodb-consolidator.js"
import { computeImportanceDecay } from "./mongodb-trust.js"
import { ensureCollections, ensureStandardIndexes, kbChunksCollection } from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri("mongodb://localhost:27017")
const TEST_DB = "memongo_evaluation"
const TEST_PREFIX = "eval_"
```

### Task 12.2: Seed data structure (Phase A)

Seed 3 scenarios with distinct agentIds:

**Scenario 1: AI Coding Assistant** (agentId: `coding-agent-{uuid}`)
- 3 sub-agents: `coding-agent-arch`, `coding-agent-impl`, `coding-agent-review`
- 200+ events across 4 simulated weeks
- Preferences: "I prefer TypeScript", "always use dark mode", "tabs over spaces"
- Decisions: "decided to use Bun", "chose MongoDB Atlas", "picked GitHub Actions"
- Facts: "deployment uses Docker", "staging is on AWS", "prod budget is $5k/mo"
- Anomalies: "switching to Rust for performance" (novel), "considering Supabase" (novel)

**Scenario 2: Customer Support** (agentId: `support-agent-{uuid}`)
- 2 agents: `support-agent-tier1`, `support-agent-tier2`
- 150+ events across 50 sessions
- Customer preferences: "prefers email", "timezone is PST"
- Procedures: "reinstall driver to fix error X", "escalate after 3 failed attempts"
- Anomalies: "customer threatening legal action" (novel)

**Scenario 3: Personal Productivity** (agentId: `prod-agent-{uuid}`)
- 1 agent
- 100+ events across 3 weeks
- Preferences: "morning meetings before 10am", "no calls on Friday"
- Decisions: "cancel newsletter subscription", "switch to standing desk"
- Anomalies: "considering career change" (novel)

Each event is seeded via `writeEvent()` with timestamps spread across the time range. Structured memory entries are written with `sourceEventIds` pointing to relevant events.

### Task 12.3: Evaluation phases (B through J)

**Phase B: BASELINE** — Verify seeded data counts and basic search works.
```typescript
it("Phase B: baseline verification", async () => {
	// Verify event counts per scenario
	// Verify structured memory entries exist
	// Verify search returns results for each agent
})
```

**Phase C: CONSOLIDATE** — Run consolidation per agent, verify facts promoted.
```typescript
it("Phase C: consolidation yields promoted facts", async () => {
	// Run consolidateMemory for each agent
	// Verify eventsProcessed > 0
	// Verify factsPromoted > 0 (preferences/decisions extracted)
	// Verify idempotency: re-run produces 0 new facts
})
```

**Phase D: CHAIN TRACE** — Trace provenance of promoted facts.
```typescript
it("Phase D: chain trace completeness", async () => {
	// For each promoted structured_mem entry:
	// - traceReasoningChain(factId, "structured_mem")
	// - Verify nodes array is non-empty
	// - Verify chain has event nodes + fact node
	// - Verify chainComplete is true (no gaps)
	// - Verify events are timestamp-sorted
})
```

**Phase E: NOVELTY SCAN** — Verify anomalies rank highest.
```typescript
it("Phase E: novelty scan accuracy", async () => {
	// scanNovelty for each agent
	// For coding-agent: "switching to Rust" and "considering Supabase" should be in top-5
	// For support-agent: "threatening legal action" should be in top-5
	// For prod-agent: "career change" should be in top-5
	// NOTE: This may fail without mongot/embeddings — test graceful degradation path too
})
```

**Phase F: IMPORTANCE DECAY** — Verify decay curve matches formula.
```typescript
it("Phase F: importance decay within 5% of formula", async () => {
	// computeImportanceDecay(1.0, 0 days ago) -> ~1.0
	// computeImportanceDecay(1.0, 7 days ago) -> ~0.5
	// computeImportanceDecay(1.0, 14 days ago) -> ~0.25
	// computeImportanceDecay(1.0, 28 days ago) -> ~0.0625
	// Each within ±5% of expected value
})
```

**Phase G: ACCESS TRACKING** — Verify batched counts.
```typescript
it("Phase G: access tracking batches correctly", async () => {
	// Create AccessTracker with flushThreshold=5
	// recordAccess 50 times for various event IDs
	// flush()
	// Query events collection, verify accessCount >= expected
	// close() tracker to prevent timer leak
})
```

**Phase H: WIKI CATEGORIZATION** — Verify filtered KB search.
```typescript
it("Phase H: wiki source filtering", async () => {
	// Insert KB chunks with wikiSource="obsidian", vault="engineering", section="setup"
	// Insert KB chunks WITHOUT wikiSource
	// Query kb_chunks with wikiSource filter
	// Verify only wiki-tagged chunks returned
})
```

**Phase I: CROSS-AGENT ISOLATION** — Zero leakage between agents.
```typescript
it("Phase I: zero cross-agent leakage", async () => {
	// For each agent:
	// - traceReasoningChain -> verify all nodes belong to this agent
	// - scanNovelty -> verify all events belong to this agent
	// - consolidateMemory -> verify promoted facts belong to this agent
	// - Search -> verify no results from other agents
})
```

**Phase J: SCORE CARD** — Aggregate 10-dimension weighted score.
```typescript
it("Phase J: score card >= 90/100", async () => {
	const scores = {
		chainCompleteness: 0,     // 15%
		chainOrdering: 0,         // (part of chainCompleteness)
		noveltyAccuracy: 0,       // 15%
		noveltyDegradation: 0,    // (part of noveltyAccuracy)
		consolidationYield: 0,    // 20%
		consolidationIdempotency: 0, // (part of consolidationYield)
		importanceDecay: 0,       // 10%
		accessTracking: 0,        // 10%
		wikiCategorization: 0,    // 5%
		crossAgentIsolation: 0,   // 25%
	}

	// Score each dimension 0-100 based on previous phase results
	// Weight: chain=15%, novelty=15%, consolidation=20%, decay=10%, access=10%, wiki=5%, isolation=25%
	const weighted =
		scores.chainCompleteness * 0.15 +
		scores.noveltyAccuracy * 0.15 +
		scores.consolidationYield * 0.20 +
		scores.importanceDecay * 0.10 +
		scores.accessTracking * 0.10 +
		scores.wikiCategorization * 0.05 +
		scores.crossAgentIsolation * 0.25

	console.log("=== E2E EVALUATION SCORE CARD ===")
	console.log(JSON.stringify(scores, null, 2))
	console.log(`OVERALL: ${weighted.toFixed(1)}/100`)

	expect(weighted).toBeGreaterThanOrEqual(90)
	// No dimension below 70
	for (const [dim, score] of Object.entries(scores)) {
		expect(score, `${dim} score too low`).toBeGreaterThanOrEqual(70)
	}
})
```

### Scoring Rubric (10 dimensions)

| # | Dimension | Weight | 100 = | 70 = | 0 = |
|---|-----------|--------|-------|------|-----|
| 1 | Chain Completeness | 15% | 100% chains have zero gaps, all timestamp-sorted | 70% complete | No chains traced |
| 2 | Chain Ordering | (part of 1) | All chains timestamp-sorted | 70% sorted | Unsorted |
| 3 | Novelty Accuracy | 15% | All seeded anomalies in top-5 | 50% in top-10 | No anomalies ranked |
| 4 | Novelty Degradation | (part of 3) | Empty report on mongot-down, no crash | Partial report | Crash |
| 5 | Consolidation Yield | 20% | >=80% preference/decision promoted | >=50% promoted | <30% promoted |
| 6 | Consolidation Idempotency | (part of 5) | 0 new facts on re-run | <5 duplicates | Duplicates |
| 7 | Importance Decay | 10% | All values within 5% of formula | Within 10% | >15% deviation |
| 8 | Access Tracking | 10% | accessCount >= expected batch count | Count > 0 | Count = 0 |
| 9 | Wiki Categorization | 5% | Zero false positives in filtered search | <10% false positives | Wrong source |
| 10 | Cross-Agent Isolation | 25% | 0 cross-agent leakage events | 0 leakage | Any leakage = 0 |

### Task 12.4: Run evaluation

```bash
# Start Docker if not running
docker compose -f docker/mongodb/docker-compose.preview.yml up -d

# Wait for healthy
docker compose -f docker/mongodb/docker-compose.preview.yml ps

# Run evaluation
cd /Users/rom.iluz/Dev/Memongo && \
  MEMONGO_MONGODB_URI="mongodb://localhost:27017" \
  bun run --filter @memongo/memory-engine test:e2e -- --reporter=verbose
```

Expected: All phases pass, score card >= 90/100, no dimension below 70.

**HITL checkpoint:** Review score card output. If any dimension < 70, investigate and fix before proceeding. If novelty scan returns empty due to missing mongot/embeddings, score the degradation path (should return `{ error: "mongot_unavailable" }` cleanly, which counts as 100 for degradation).

**Commit:** `e2e: add 10-dimension evaluation harness with 3 scenarios`

---

## Phase 13: Final Validation + Commit + Push [HITL]

> **Exit Criteria:** `bun run build` passes. `bun run check-types` passes. All unit tests pass. E2E evaluation passes. Code committed and pushed.

**Objective:** Full validation gate and publish.

### Task 13.1: Build gate

```bash
bun run build
```
Expected: PASS (exit 0)

### Task 13.2: Type check gate

```bash
bun run check-types
```
Expected: PASS

### Task 13.3: Unit test gate

```bash
bun run test
```
Expected: All existing tests + ~40 new tests PASS

### Task 13.4: E2E gate (requires Docker)

```bash
cd /Users/rom.iluz/Dev/Memongo && \
  MEMONGO_MONGODB_URI="mongodb://localhost:27017" \
  bun run --filter @memongo/memory-engine test:e2e -- --reporter=verbose
```
Expected: Score card >= 90/100

### Task 13.5: Commit

```bash
git add packages/memory-engine/src/mongodb-reasoning-chain.ts \
       packages/memory-engine/src/mongodb-reasoning-chain.test.ts \
       packages/memory-engine/src/mongodb-novelty.ts \
       packages/memory-engine/src/mongodb-novelty.test.ts \
       packages/memory-engine/src/mongodb-access-tracker.ts \
       packages/memory-engine/src/mongodb-access-tracker.test.ts \
       packages/memory-engine/src/mongodb-consolidator.ts \
       packages/memory-engine/src/mongodb-consolidator.test.ts \
       packages/memory-engine/src/mongodb-trust.ts \
       packages/memory-engine/src/mongodb-trust.test.ts \
       packages/memory-engine/src/mongodb-schema.ts \
       packages/memory-engine/src/index.ts \
       packages/memory-engine/src/types.ts \
       packages/memory-engine/src/mongodb-manager.ts \
       packages/memory-engine/src/mongodb-e2e.e2e.test.ts \
       packages/memory-engine/src/e2e-evaluation.e2e.test.ts \
       packages/memory-bridge/src/memongo-bridge.ts \
       apps/api/src/routes/v1.ts \
       apps/mcp/src/server.ts \
       packages/client/src/client.ts \
       packages/client/src/types.ts \
       packages/client/src/index.ts \
       packages/tools/src/index.ts
git commit -m "feat: add 6 native memory intelligence features with E2E evaluation

- Reasoning chain traversal (\$lookup provenance)
- Novelty detection (centroid vector scoring, graceful degradation)
- Server-side batched access tracking (approximation pattern)
- Importance decay (exponential half-life)
- Wiki source categorization (KB schema extension)
- Consolidation agent (Dreamer pipeline)
- 5-layer integration: Engine -> Bridge -> API -> MCP -> Client SDK + AI SDK Tools
- E2E evaluation: 3 scenarios, 450+ events, 10-dimension score card"
```

### Task 13.6: Push

```bash
git push origin main
```

**HITL checkpoint:** Verify push succeeded. Review GitHub for any CI failures.

---

## Phase Dependency Map

```
Phase 0 (Schema) ─────────────────────────────────────────────────────┐
Phase 1 (Reasoning Chain) ─ depends on Phase 0 types ─────────────────┤
Phase 2 (Novelty Detection) ─ depends on Phase 0 types ───────────────┤
Phase 3 (Access Tracker) ─ depends on Phase 0 ─────────────────────────┤
Phase 4 (Importance Decay) ─ independent (pure function) ──────────────┤
Phase 5 (Wiki Categorization) ─ independent (schema only) ─────────────┤
Phase 6 (Consolidation) ─ depends on Phases 1, 2, 4 ──────────────────┤
Phase 7 (Bridge) ─ depends on Phases 1-6 ──────────────────────────────┤
Phase 8 (API) ─ depends on Phase 7 ────────────────────────────────────┤
Phase 9 (MCP) ─ depends on Phase 10 (client methods) ─────────────────┤
Phase 10 (Client SDK + AI SDK) ─ depends on Phase 8 (API routes) ─────┤
Phase 11 (Manager Wiring) ─ depends on Phases 1-6, 7 ─────────────────┤
Phase 12 (E2E Evaluation) ─ depends on ALL above ─────────────────────┤
Phase 13 (Final Validation) ─ depends on Phase 12 ────────────────────┘
```

## Phase Autonomy Classification

| Phase | Checkpoint Type | Classification | Reason |
|-------|----------------|----------------|--------|
| 0 | none | AFK | Schema-only, no ambiguity |
| 1 | none | AFK | Standalone function, clear spec |
| 2 | none | AFK | Standalone function, clear spec |
| 3 | none | AFK | Standalone class, clear spec |
| 4 | none | AFK | Pure function, formula given |
| 5 | none | AFK | Schema-only, trivial |
| 6 | none | AFK | Clear spec from ClawMongo source |
| 7 | none | AFK | Bridge pattern well-established |
| 8 | none | AFK | API pattern well-established |
| 9 | none | AFK | MCP pattern well-established |
| 10 | none | AFK | Client pattern well-established |
| 11 | none | AFK | Manager pattern well-established |
| 12 | human_verify | HITL | E2E results need human review of score card |
| 13 | human_action | HITL | Push requires human approval |

## Risks And Mitigations

| Risk | P | I | Score | Mitigation |
|------|---|---|-------|------------|
| mongot unavailable in Docker preview | 3 | 3 | 9 | Novelty scan degrades gracefully; E2E scores degradation path as valid |
| Vector index not created automatically | 3 | 3 | 9 | E2E setup calls ensureSearchIndexes; manual index creation as fallback |
| consolidateMemory pattern matching too conservative | 2 | 3 | 6 | Seed events use exact pattern phrasing ("I prefer", "I decided") |
| AccessTracker timer leak in tests | 3 | 2 | 6 | Always call close() in afterEach; use vi.useFakeTimers() |
| Bridge type casts break on manager API changes | 2 | 2 | 4 | Capability-cast pattern (same as ActiveSlateCapableManager) isolates risk |
| E2E Docker not available on CI | 2 | 2 | 4 | E2E tests behind MEMONGO_MONGODB_URI env var guard |

## Acceptance Checks

1. `bun run build` exits 0
2. `bun run check-types` exits 0
3. `bun run test` — all existing + ~40 new unit tests pass
4. E2E evaluation: score card >= 90/100, no dimension below 70
5. No references to "Honcho", "ClawMongo", or "ported from" in new code
6. EXPECTED_COLLECTION_SUFFIXES includes `consolidation_runs` (25 total)
7. EXPECTED_STANDARD_INDEX_COUNT = 66

## Baselines After Build

| Metric | Before | After |
|--------|--------|-------|
| Collections (EXPECTED_COLLECTION_SUFFIXES) | 24 | 25 |
| Standard indexes (EXPECTED_STANDARD_INDEX_COUNT) | 63 | 66 |
| New engine files | 0 | 4 (+4 test files) |
| New API routes | 0 | 3 |
| New MCP tools | 0 | 3 |
| New client methods | 0 | 3 |
| New AI SDK tools | 0 | 3 |
| New unit tests | 0 | ~40 |
