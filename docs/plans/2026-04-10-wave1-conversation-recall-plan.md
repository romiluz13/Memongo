# Wave 1: Conversation Recall Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** See `docs/plans/2026-04-10-harmony-memory-roadmap.md` for the constitutional source of truth and `docs/plans/2026-04-10-benchmark-first-harmony-execution-plan.md` for wave-level sequencing.
> **Status:** historical child execution spec for completed Wave 1. This file does not replace the parent sequencing plan in `docs/plans/2026-04-10-benchmark-first-harmony-execution-plan.md`.

**Goal:** Ship a first-class conversation recall surface so Memongo can answer "what did we discuss last Tuesday about X?" through a provenance-rich, MongoDB-native public contract across the full stack.

**Architecture:** Conversation recall is a new read surface over the existing `events` collection. No new collections, no new write paths. The engine queries canonical events using MongoDB standard queries (date range + role + session filters) and vector/hybrid search (for semantic recall). Results cite canonical event IDs and include rendered text previews. The full stack follows existing Memongo conventions: engine function -> bridge facade -> Hono API route -> OpenAPI spec -> typed client method -> MCP tool -> AI SDK tool.

**Tech Stack:** Bun 1.2+, TypeScript ESM, MongoDB Atlas Local Preview 8.2.6, Hono API, stdio MCP server, Vitest, Biome (tabs, double quotes).

**Prerequisites:**
- Phases 0-3 complete
- Phase 4 Batch A, Batch B, Batch B2, and Batch C complete in the current branch
- Events collection with standard indexes: `idx_events_agent_scope_scoperef_ts`, `idx_events_session_ts`
- Events vector search index (`memongo_events_vector`) with filter fields: `agentId`, `scope`, `scopeRef`, `sessionId`, `role`, `channel`, `timestamp`
- Events text search index (`memongo_events_text`) with `body` as string, `role`/`sessionId`/`agentId`/`scope`/`scopeRef`/`channel` as token, `timestamp` as date

**Durable Decisions:**
- Conversation recall queries the canonical `events` collection; it NEVER creates a separate transcript store or materialized view.
- Date/time semantics are explicit: clients send ISO 8601 timestamps; the engine stores and queries UTC; timezone is a client-side presentation concern resolved before the API call (or passed as an optional hint for date-only strings).
- Tool messages default to excluded unless the caller explicitly opts in (`includeToolMessages: true`). This matches Letta's convention and prevents noisy tool call/response pairs from diluting recall results.
- Citations are canonical event references: `eventId`, `sessionId`, `role`, `timestamp`, `sourceRef?`, plus a rendered text preview.
- The `asOf` contract is introduced narrowly: only for the conversation recall path. In Wave 1 it acts only as an upper bound on event timestamps (`timestamp <= asOf`) and does NOT cross-reference derived-memory validity. Any broader temporal unification belongs to the later temporal-convergence wave.
- No new indexes are needed. The existing standard indexes on events (`idx_events_agent_scope_scoperef_ts`, `idx_events_session_ts`) and search indexes (`events_vector`, `events_text`) already cover all planned query patterns.

---

## Current State Analysis

### What exists today for conversation access

1. **Event storage and retrieval** (`packages/memory-engine/src/mongodb-events.ts`):
   - `writeEvent()` stores canonical events with `eventId`, `agentId`, `sessionId`, `channel`, `role`, `body`, `metadata`, `scope`, `scopeRef`, `timestamp`
   - `getEventsByTimeRange()` retrieves events by `agentId` + date range + optional scope/scopeRef (lines 89-118)
   - `getEventsBySession()` retrieves events by `agentId` + `sessionId` (lines 120-135)
   - `getSessionEventsWithBound()` retrieves most recent N events from a session (lines 246-275)
   - `renderEventChunkText()` produces `"Role: body"` text for recall quality (line 30-35)

2. **Context bundle conversation section** (`packages/memory-engine/src/mongodb-context-bundle.ts`):
   - `buildContextBundle()` includes a "Recent Events" section that loads last N events from the current session/scope (lines 645-663)
   - This is a fixed-window recent-events view, NOT a queryable recall surface

3. **Search executor** (`packages/memory-engine/src/mongodb-search-executor.ts`):
   - Events are already one of the search lanes (`"conversation"` source preference)
   - `conversationScope.sessionKey` narrows search to a specific session
   - Event chunks in the `chunks` collection get vector search via the `chunks_vector` index
   - But there is no dedicated conversation recall query shape with role filters, time range, or tool-message policy

4. **Vector/text search indexes on events** (`packages/memory-engine/src/mongodb-schema.ts`):
   - `{prefix}events_vector`: autoEmbed on `body` with filter fields for `agentId`, `scope`, `scopeRef`, `sessionId`, `role`, `channel`, `timestamp`
   - `{prefix}events_text`: Atlas Search with `body` as string field, token fields for `agentId`/`scope`/`scopeRef`/`sessionId`/`role`/`channel`, and `timestamp` as date

5. **Standard indexes on events** (`packages/memory-engine/src/mongodb-schema.ts`):
   - `idx_events_agent_scope_scoperef_ts`: `{ agentId: 1, scope: 1, scopeRef: 1, timestamp: -1 }` -- the primary access pattern
   - `idx_events_session_ts`: `{ sessionId: 1, timestamp: -1 }` (sparse)
   - `uq_events_eventid`: unique on `{ eventId: 1 }`
   - `uq_events_sourceref`: unique sparse on `{ agentId, sourceRef }`

### What is missing (gap analysis)

| Capability | Status | Gap |
|---|---|---|
| Queryable conversation recall with role filters | Missing | No public surface accepts `roles` filter |
| Exact date/time range filtering on recall | Partial | `getEventsByTimeRange()` exists in engine but is NOT exposed through bridge/API/client/MCP |
| Timezone-aware date resolution | Missing | No timezone hint parameter anywhere |
| Tool-message include/exclude policy | Missing | No filter to exclude `role: "tool"` events |
| Semantic (vector) conversation recall | Missing | Events have vector search index but no dedicated recall query uses it |
| Hybrid recall (keyword + semantic) | Missing | No hybrid search path exists for conversation-specific recall |
| Provenance-rich citations | Missing | Search results have `canonicalId` but no dedicated citation shape for conversation recall |
| Full-stack recall surface | Missing | No API route, bridge function, client method, MCP tool, or AI SDK tool for conversation recall |
| Conversation recall regression suite | Missing | No benchmark/regression tests for recall-specific behavior |
| `asOf` temporal predicate | Missing | Structured memory has `currentOnly` filter but no cross-cutting `asOf` contract |

---

## Design Decisions

### ADR-1: Where does conversation recall live in the engine?

**Context:** Conversation recall is a new read surface. It needs to query events with rich filtering. The existing `mongodb-events.ts` has basic read helpers. The `mongodb-search-executor.ts` has the full search orchestration but is designed for cross-collection search, not conversation-specific recall.

**Decision:** Create a new `packages/memory-engine/src/mongodb-conversation-recall.ts` file. This keeps the conversation recall contract clean, testable, and self-contained. It imports from `mongodb-events.ts` for rendering and from `mongodb-schema.ts` for collection access. It does NOT duplicate event storage or create a new collection.

**Consequences:**
- **Positive:** Clean separation of concerns; the recall contract is independently testable; easy to find and maintain
- **Negative:** One more file in the engine package (acceptable given the ~500 LOC guidance)
- **Alternatives Considered:** Extending `mongodb-events.ts` (rejected: would bloat a clean file); adding to `mongodb-search-executor.ts` (rejected: that file orchestrates multi-collection search, not single-collection recall)

### ADR-2: MongoDB query patterns for conversation recall

**Context:** Conversation recall needs three query modes: (a) standard query with filters (no semantic search needed), (b) semantic recall with vector search, (c) hybrid recall combining keyword + semantic.

**Decision:** Implement two query paths inside the recall engine:

1. **Standard recall** (when no `query` is provided or when only date/session/role filters are used): Use a simple `find()` on the events collection with the compound index `idx_events_agent_scope_scoperef_ts`. This is a direct MongoDB query, not an aggregation pipeline, for maximum performance.

2. **Semantic/hybrid recall** (when a `query` string is provided): Use `$vectorSearch` on the `events_vector` index with `filter` for `agentId`, `sessionId?`, `role?`, and `timestamp` range. The vector search index already includes `timestamp` as a filter field, enabling native date-range filtering inside the vector search stage. If Atlas Search text index is available, optionally combine with `$search` on `events_text` using `$rankFusion` for hybrid recall.

**MongoDB verification:** The events vector search index definition at `mongodb-schema.ts:2854-2862` includes `{ type: "filter", path: "timestamp" }`, which means `$vectorSearch.filter` can include `{ timestamp: { $gte: ..., $lte: ... } }` directly. This is supported by Atlas Vector Search on date fields per MongoDB documentation.

**Consequences:**
- **Positive:** Zero new indexes; leverages existing infrastructure; standard recall is O(1) with index
- **Negative:** Hybrid path depends on `$rankFusion` (MongoDB 8.0+) but Atlas Local Preview 8.2.6 supports it

### ADR-3: How do citations/provenance work?

**Context:** Letta returns messages with role + content + timestamp. Memongo should go further with proper provenance.

**Decision:** Define a `ConversationRecallCitation` type:
```typescript
type ConversationRecallCitation = {
    eventId: string
    sessionId?: string
    role: "user" | "assistant" | "system" | "tool"
    timestamp: Date
    sourceRef?: string
    preview: string  // first 500 chars of body, rendered via renderEventChunkText()
}
```

Each recall result includes its canonical citation. The citation is NOT a separate stored document; it is assembled at query time from the event fields.

### ADR-4: What is the `asOf` contract for this path?

**Context:** The harmony roadmap requires temporal truth unification. Conversation recall touches truth semantics because it might cross-reference derived memories.

**Decision:** Introduce `asOf` as an optional parameter on the conversation recall request. Default: `new Date()` (current time). In Wave 1, `asOf` only gates the events query upper bound (`timestamp <= asOf`). It is intentionally not used to cross-reference structured memory or graph validity windows yet. That broader temporal unification is deferred to the later temporal-convergence wave.

### ADR-5: How does tool-message policy work?

**Context:** Tool messages (role: "tool") are often noisy function call results. Letta includes a `roles` filter that can exclude them. Supermemory does not distinguish.

**Decision:** Default behavior is `includeToolMessages: false`. Callers opt in explicitly. Implementation: when `includeToolMessages` is false (or omitted), add `role: { $ne: "tool" }` to the query filter. When true, no role filter is applied (unless `roles` explicitly lists specific roles). The `roles` parameter takes precedence over `includeToolMessages` when both are provided.

### ADR-6: Timezone handling approach

**Context:** Letta requires "precise dates and times, not relative phrases." Users may say "last Tuesday" but the API should receive exact timestamps.

**Decision:** The API accepts ISO 8601 timestamps only. The optional `timezone` parameter (IANA string like `"America/New_York"`) is used ONLY when the client sends date-only strings (e.g., `"2026-04-08"`) to resolve them to exact UTC boundaries:
- `startTime: "2026-04-08"` + `timezone: "America/New_York"` -> `2026-04-08T04:00:00.000Z` (start of day in ET)
- `endTime: "2026-04-08"` + `timezone: "America/New_York"` -> `2026-04-09T03:59:59.999Z` (end of day in ET)

When full ISO timestamps with timezone offsets are provided (e.g., `"2026-04-08T14:30:00-04:00"`), the `timezone` parameter is ignored and the offset is used directly.

When no timezone is provided and a date-only string is given, assume UTC boundaries (conservative default).

---

## Batch Breakdown

### Batch A: Contract and Engine (1 BUILD cycle)

**Objective:** Define all types and implement the core engine conversation recall function.

**Files:**
- Create: `packages/memory-engine/src/mongodb-conversation-recall.ts` (~300 LOC)
- Create: `packages/memory-engine/src/mongodb-conversation-recall.test.ts` (~400 LOC)
- Modify: `packages/memory-engine/src/types.ts` (add recall types)
- Modify: `packages/memory-engine/src/index.ts` (add exports)

**Harmony invariants strengthened:** Recall Plane (invariant 4), Provenance Everywhere (invariant 7), One Temporal Truth Model (invariant 1 - narrow `asOf` introduction)

#### Step 1: Add types to `packages/memory-engine/src/types.ts`

Add after the `MemoryBenchmark*` types block (after line ~830):

```typescript
// ---------------------------------------------------------------------------
// Conversation Recall (Wave 1)
// ---------------------------------------------------------------------------

export type ConversationRecallToolPolicy = "exclude" | "include" | "summary"

export type ConversationRecallRequest = {
	agentId: string
	query?: string
	sessionId?: string
	roles?: Array<"user" | "assistant" | "system" | "tool">
	startTime?: string
	endTime?: string
	timezone?: string
	includeToolMessages?: boolean
	limit?: number
	asOf?: Date
}

export type ConversationRecallCitation = {
	eventId: string
	sessionId?: string
	role: "user" | "assistant" | "system" | "tool"
	timestamp: Date
	sourceRef?: string
	preview: string
}

export type ConversationRecallResult = {
	citation: ConversationRecallCitation
	score?: number
	matchType: "filter" | "semantic" | "hybrid"
}

export type ConversationRecallResponse = {
	results: ConversationRecallResult[]
	metadata: {
		totalMatched: number
		queryUsed?: string
		filtersApplied: string[]
		searchMethod: "standard" | "semantic" | "hybrid"
		durationMs: number
	}
}
```

**Run:** `bun run check-types`
**Expected:** PASS (types are additive, no breaking changes)

#### Step 2: Create `packages/memory-engine/src/mongodb-conversation-recall.ts`

The core engine function. Two query paths:

**Path 1: Standard recall (no query text)**
- Build a `find()` filter: `{ agentId }` + optional `sessionId`, `role` filter, `timestamp` range, tool-message exclusion
- Sort by `{ timestamp: -1 }` (most recent first)
- Limit to `request.limit` (default 50, max 200)
- Uses `idx_events_agent_scope_scoperef_ts` or `idx_events_session_ts`

**Path 2: Semantic/hybrid recall (query text provided)**
- Build a `$vectorSearch` stage on `events_vector` index:
  - `query: { text: request.query }` (autoEmbed syntax)
  - `filter`: `{ agentId }` + optional `sessionId`, `role`, `timestamp` range
  - `numCandidates: 100`, `limit: request.limit`
- If hybrid mode available, combine with Atlas Search `$search` stage via `$rankFusion`
- Falls back to vector-only if `$rankFusion` is unavailable

**Both paths:**
- Resolve timezone for date-only strings
- Apply `asOf` as an upper bound on `timestamp` (defaults to `new Date()`)
- Render each event into a `ConversationRecallCitation` using `renderEventChunkText()`
- Return `ConversationRecallResponse`

Implementation details:

```typescript
import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { renderEventChunkText, type CanonicalEvent } from "./mongodb-events.js"
import { eventsCollection } from "./mongodb-schema.js"
import type {
	ConversationRecallRequest,
	ConversationRecallResponse,
	ConversationRecallResult,
	ConversationRecallCitation,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:conversation-recall")

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_PREVIEW_LENGTH = 500

function clampLimit(limit?: number): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit!)))
}
```

**Timezone resolution function:**

```typescript
function resolveTimeBoundary(
	isoString: string,
	edge: "start" | "end",
	timezone?: string,
): Date {
	// Full ISO with time component -> parse directly
	if (isoString.includes("T")) {
		return new Date(isoString)
	}
	// Date-only: resolve to day boundary in timezone (or UTC)
	// "2026-04-08" + "start" -> start of day
	// "2026-04-08" + "end" -> end of day (23:59:59.999)
	if (edge === "start") {
		return timezone
			? startOfDayInTimezone(isoString, timezone)
			: new Date(`${isoString}T00:00:00.000Z`)
	}
	return timezone
		? endOfDayInTimezone(isoString, timezone)
		: new Date(`${isoString}T23:59:59.999Z`)
}
```

For timezone resolution, use `Intl.DateTimeFormat` with `timeZone` option to compute UTC offset for the given date in the given timezone. This avoids any dependency on external timezone libraries.

**Standard recall path:**

```typescript
async function standardRecall(params: {
	db: Db
	prefix: string
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
}): Promise<ConversationRecallResult[]> {
	const { db, prefix, request, effectiveLimit, startDate, endDate } = params
	const filter: Document = { agentId: request.agentId }

	if (request.sessionId) {
		filter.sessionId = request.sessionId
	}

	// Role filter
	if (request.roles && request.roles.length > 0) {
		filter.role = { $in: request.roles }
	} else if (!request.includeToolMessages) {
		filter.role = { $ne: "tool" }
	}

	// Time range
	const tsFilter: Document = {}
	if (startDate) tsFilter.$gte = startDate
	if (endDate) tsFilter.$lte = endDate
	if (Object.keys(tsFilter).length > 0) {
		filter.timestamp = tsFilter
	}

	const events = await eventsCollection(db, prefix)
		.find(filter)
		.sort({ timestamp: -1 })
		.limit(effectiveLimit)
		.toArray()

	return events.map((doc) => eventToRecallResult(doc, "filter"))
}
```

**Semantic recall path:**

```typescript
async function semanticRecall(params: {
	db: Db
	prefix: string
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
	vectorIndexName: string
}): Promise<ConversationRecallResult[]> {
	const { db, prefix, request, effectiveLimit, startDate, endDate, vectorIndexName } = params
	const filter: Document = { agentId: { $eq: request.agentId } }

	if (request.sessionId) {
		filter.sessionId = { $eq: request.sessionId }
	}

	if (request.roles && request.roles.length > 0) {
		filter.role = { $in: request.roles }
	} else if (!request.includeToolMessages) {
		filter.role = { $ne: "tool" }
	}

	if (startDate || endDate) {
		const tsFilter: Document = {}
		if (startDate) tsFilter.$gte = startDate
		if (endDate) tsFilter.$lte = endDate
		filter.timestamp = tsFilter
	}

	const pipeline: Document[] = [
		{
			$vectorSearch: {
				index: vectorIndexName,
				query: { text: request.query },
				path: "body",
				filter,
				numCandidates: Math.min(effectiveLimit * 4, 400),
				limit: effectiveLimit,
			},
		},
		{ $addFields: { _vsScore: { $meta: "vectorSearchScore" } } },
	]

	const events = await eventsCollection(db, prefix)
		.aggregate(pipeline)
		.toArray()

	return events.map((doc) => ({
		...eventToRecallResult(doc, "semantic"),
		score: typeof doc._vsScore === "number" ? doc._vsScore : undefined,
	}))
}
```

Note on `$vectorSearch` syntax: The events vector index uses autoEmbed. Per the codebase pattern at `mongodb-search.ts:317-319`, the correct syntax is `query: { text: "..." }` with `path: "body"`, NOT `queryString` or `queryVector`. The exact stage shape (verified from `buildVectorSearchStage`):

```typescript
{
	$vectorSearch: {
		index: vectorIndexName,
		query: { text: request.query },
		path: "body",
		filter,
		numCandidates: ...,
		limit: ...,
	}
}
```

Use `runSearchAggregateWithRetry` from `mongodb-search.ts` for warmup resilience. The `buildVectorSearchStage` helper at `mongodb-search.ts:298-325` can be reused directly if the recall engine wants to centralize the stage construction.

**Citation builder:**

```typescript
function eventToRecallResult(
	doc: Document,
	matchType: "filter" | "semantic" | "hybrid",
): ConversationRecallResult {
	const event = doc as unknown as CanonicalEvent
	return {
		citation: {
			eventId: event.eventId,
			sessionId: event.sessionId,
			role: event.role,
			timestamp: event.timestamp,
			sourceRef: (doc as any).sourceRef,
			preview: renderEventChunkText(event).slice(0, MAX_PREVIEW_LENGTH),
		},
		matchType,
	}
}
```

**Main entry point:**

```typescript
export async function recallConversation(params: {
	db: Db
	prefix: string
	request: ConversationRecallRequest
	vectorIndexName?: string
	capabilities?: { vectorSearch: boolean; rankFusion: boolean }
}): Promise<ConversationRecallResponse> {
	const startMs = Date.now()
	const { db, prefix, request } = params
	const effectiveLimit = clampLimit(request.limit)
	const asOf = request.asOf ?? new Date()

	// Resolve time boundaries
	let startDate = request.startTime
		? resolveTimeBoundary(request.startTime, "start", request.timezone)
		: undefined
	let endDate = request.endTime
		? resolveTimeBoundary(request.endTime, "end", request.timezone)
		: asOf

	// asOf always caps the upper bound
	if (endDate > asOf) {
		endDate = asOf
	}

	const filtersApplied: string[] = []
	if (request.sessionId) filtersApplied.push(`sessionId:${request.sessionId}`)
	if (request.roles?.length) filtersApplied.push(`roles:${request.roles.join(",")}`)
	if (startDate) filtersApplied.push(`startTime:${startDate.toISOString()}`)
	if (endDate) filtersApplied.push(`endTime:${endDate.toISOString()}`)
	if (!request.includeToolMessages && !request.roles) {
		filtersApplied.push("excludeToolMessages")
	}

	let results: ConversationRecallResult[]
	let searchMethod: "standard" | "semantic" | "hybrid"

	if (!request.query?.trim()) {
		// Standard recall: filter-only
		results = await standardRecall({
			db, prefix, request, effectiveLimit, startDate, endDate,
		})
		searchMethod = "standard"
	} else if (params.capabilities?.vectorSearch && params.vectorIndexName) {
		// Semantic recall via vector search
		results = await semanticRecall({
			db, prefix, request, effectiveLimit, startDate, endDate,
			vectorIndexName: params.vectorIndexName,
		})
		searchMethod = "semantic"
	} else {
		// Fallback: standard recall with regex on body
		results = await standardRecall({
			db, prefix, request, effectiveLimit, startDate, endDate,
		})
		searchMethod = "standard"
	}

	return {
		results,
		metadata: {
			totalMatched: results.length,
			queryUsed: request.query?.trim() || undefined,
			filtersApplied,
			searchMethod,
			durationMs: Date.now() - startMs,
		},
	}
}
```

**Run:** `bun run check-types`
**Expected:** PASS

#### Step 3: Add exports to `packages/memory-engine/src/index.ts`

Add after the `buildContextBundle` export:

```typescript
export {
	recallConversation,
} from "./mongodb-conversation-recall.js"
export type {
	ConversationRecallRequest,
	ConversationRecallResponse,
	ConversationRecallResult,
	ConversationRecallCitation,
	ConversationRecallToolPolicy,
} from "./types.js"
```

**Run:** `bun run check-types && bun run build`
**Expected:** PASS

#### Step 4: Write conversation recall tests

Create `packages/memory-engine/src/mongodb-conversation-recall.test.ts`:

Test cases:
1. **Standard recall without filters** - writes 5 events, recalls all non-tool events
2. **Session filter** - writes events across 2 sessions, recalls only from specified session
3. **Role filter** - writes user + assistant + tool events, recalls only specified roles
4. **Exact date range boundary inclusion** - writes events at exact boundary timestamps, verifies inclusive matching
5. **Timezone-resolved date-only range** - passes date-only string + timezone, verifies correct UTC resolution
6. **Tool message exclusion (default)** - writes mix of roles including tool, verifies tool excluded by default
7. **Tool message inclusion (explicit)** - sets `includeToolMessages: true`, verifies tool events included
8. **Citations include all provenance fields** - verifies eventId, sessionId, role, timestamp, preview in each citation
9. **asOf upper bound** - writes events at various timestamps, sets asOf to a past time, verifies only events before asOf returned
10. **Limit clamping** - verifies limit defaults to 50, clamps at MAX_LIMIT
11. **Empty result set** - queries with filters that match nothing, verifies clean empty response
12. **Semantic recall with query** (if vector search available) - writes events, recalls by semantic query

Each test uses a fresh agent/session to avoid cross-test contamination. Tests import `writeEvent` directly for setup.

**Run:** `bun run test packages/memory-engine/src/mongodb-conversation-recall.test.ts`
**Expected:** All tests PASS

#### Step 5: Wire into MongoDBMemoryManager

Add a `recallConversation()` method to `MongoDBMemoryManager` in `packages/memory-engine/src/mongodb-manager.ts`:

```typescript
async recallConversation(request: Omit<ConversationRecallRequest, "agentId">): Promise<ConversationRecallResponse> {
	return recallConversation({
		db: this.db,
		prefix: this.prefix,
		request: { ...request, agentId: this.agentId },
		vectorIndexName: `${this.prefix}events_vector`,
		capabilities: this.capabilities,
	})
}
```

Also add `recallConversation` to the `MemorySearchManager` interface in `types.ts`:

```typescript
recallConversation?(request: Omit<ConversationRecallRequest, "agentId">): Promise<ConversationRecallResponse>
```

**Run:** `bun run check-types && bun run test`
**Expected:** PASS (all existing + new tests)

**Batch A exit criteria:**
- `recallConversation()` function exists in engine with full typing
- Standard recall works with session, role, date range, tool-message filters
- Citations reference canonical event IDs with rendered previews
- `asOf` parameter gates temporal upper bound
- 12+ focused tests pass
- `bun run check-types` and `bun run build` pass

---

### Batch B: Full Stack Wiring (1 BUILD cycle)

**Objective:** Wire conversation recall through bridge -> API/OpenAPI -> client -> MCP -> AI SDK tools.

**Files:**
- Modify: `packages/memory-bridge/src/memongo-bridge.ts` (add `memongoBridgeRecallConversation`)
- Modify: `apps/api/src/routes/v1.ts` (add `POST /v1/recall-conversation`)
- Modify: `apps/api/src/openapi-spec.ts` (add endpoint spec)
- Modify: `packages/client/src/client.ts` (add `.recallConversation()`)
- Modify: `packages/client/src/types.ts` (add client types)
- Modify: `apps/mcp/src/server.ts` (add `memongo_recall_conversation` tool)
- Modify: `packages/tools/src/index.ts` (add `memongo_recall_conversation` AI SDK tool)
- Modify: `apps/api/src/app.test.ts` (add API-level recall tests)

**Harmony invariants strengthened:** Recall Plane (invariant 4), Wrappers are Wrappers (invariant 8)

#### Step 1: Bridge facade

Add to `packages/memory-bridge/src/memongo-bridge.ts`. Follow the existing bridge pattern where each function resolves the manager internally via `memongoBridgeGetManager(params.agentId)`:

```typescript
export async function memongoBridgeRecallConversation(params: {
	agentId?: string
	query?: string
	sessionId?: string
	roles?: Array<"user" | "assistant" | "system" | "tool">
	startTime?: string
	endTime?: string
	timezone?: string
	includeToolMessages?: boolean
	limit?: number
}): Promise<ConversationRecallResponse> {
	const m = await memongoBridgeGetManager(params.agentId)
	if (!m.recallConversation) {
		throw new Error("recallConversation not available on this backend")
	}
	return m.recallConversation({
		query: params.query,
		sessionId: params.sessionId,
		roles: params.roles,
		startTime: params.startTime,
		endTime: params.endTime,
		timezone: params.timezone,
		includeToolMessages: params.includeToolMessages,
		limit: params.limit,
	})
}
```

**Run:** `bun run check-types`
**Expected:** PASS

#### Step 2: API route

Add to `apps/api/src/routes/v1.ts` after the `/context-bundle` route. The existing route pattern resolves `agentId` from the request context (e.g., `c.get("agentId")` or from the request body/headers per the existing auth pattern in the file). Check the existing `/context-bundle` or `/search` route for the exact agentId extraction pattern:

```typescript
v1.post("/recall-conversation", async (c) => {
	const body = await c.req.json()
	const result = await memongoBridgeRecallConversation({
		agentId: body.agentId,
		query: body.query,
		sessionId: body.sessionId,
		roles: body.roles,
		startTime: body.startTime,
		endTime: body.endTime,
		timezone: body.timezone,
		includeToolMessages: body.includeToolMessages,
		limit: body.limit,
	})
	return c.json(result)
})
```

#### Step 3: OpenAPI spec

Add the request/response schemas to `apps/api/src/openapi-spec.ts`:

- Request: `ConversationRecallRequest` schema with all optional fields documented
- Response: `ConversationRecallResponse` schema with results array and metadata
- Endpoint: `POST /v1/recall-conversation` with description emphasizing exact timestamps, role filters, and citation provenance

#### Step 4: Client SDK method

Add to `packages/client/src/client.ts`:

```typescript
async recallConversation(input: {
	query?: string
	sessionId?: string
	roles?: Array<"user" | "assistant" | "system" | "tool">
	startTime?: string
	endTime?: string
	timezone?: string
	includeToolMessages?: boolean
	limit?: number
}): Promise<MemongoRecallConversationResponse> {
	const response = await this.fetch("/v1/recall-conversation", {
		method: "POST",
		body: JSON.stringify(input),
	})
	return response.json() as Promise<MemongoRecallConversationResponse>
}
```

Add matching types to `packages/client/src/types.ts`.

#### Step 5: MCP tool

Add to `apps/mcp/src/server.ts`:

```typescript
{
	name: "memongo_recall_conversation",
	description:
		"Search and retrieve past conversation messages with filters. " +
		"Use exact ISO 8601 timestamps (e.g., '2026-04-08T14:30:00Z'), not relative phrases like 'last week'. " +
		"For date-only input (e.g., '2026-04-08'), include the optional timezone parameter to resolve day boundaries correctly. " +
		"Tool messages (function calls/results) are excluded by default; set includeToolMessages to true to include them. " +
		"Returns cited messages with eventId, role, timestamp, and text preview.",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Semantic search query for conversation content. Omit for filter-only recall."
			},
			sessionId: {
				type: "string",
				description: "Filter to a specific conversation session."
			},
			roles: {
				type: "array",
				items: { type: "string", enum: ["user", "assistant", "system", "tool"] },
				description: "Filter to specific message roles."
			},
			startTime: {
				type: "string",
				description: "Inclusive start of time range. ISO 8601 format: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'."
			},
			endTime: {
				type: "string",
				description: "Inclusive end of time range. ISO 8601 format: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'."
			},
			timezone: {
				type: "string",
				description: "IANA timezone (e.g., 'America/New_York') for resolving date-only boundaries. Ignored when full timestamps are provided."
			},
			includeToolMessages: {
				type: "boolean",
				description: "Include tool messages in results. Default: false."
			},
			limit: {
				type: "number",
				description: "Maximum results to return. Default: 50, max: 200."
			},
		},
	},
}
```

Add the handler in the `CallToolRequestSchema` handler:

```typescript
if (name === "memongo_recall_conversation") {
	const result = await memongoBridgeRecallConversation({
		manager,
		query: args.query as string | undefined,
		sessionId: args.sessionId as string | undefined,
		roles: args.roles as Array<"user" | "assistant" | "system" | "tool"> | undefined,
		startTime: args.startTime as string | undefined,
		endTime: args.endTime as string | undefined,
		timezone: args.timezone as string | undefined,
		includeToolMessages: args.includeToolMessages as boolean | undefined,
		limit: args.limit as number | undefined,
	})
	return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
}
```

#### Step 6: AI SDK tool

Add to `packages/tools/src/index.ts`:

```typescript
memongo_recall_conversation: tool({
	description: "Search past conversation messages by content, session, role, and time range. Uses exact ISO 8601 timestamps.",
	parameters: z.object({
		query: z.string().optional(),
		sessionId: z.string().optional(),
		roles: z.array(z.enum(["user", "assistant", "system", "tool"])).optional(),
		startTime: z.string().optional(),
		endTime: z.string().optional(),
		timezone: z.string().optional(),
		includeToolMessages: z.boolean().optional(),
		limit: z.number().optional(),
	}),
	execute: async (params) => client.recallConversation(params),
}),
```

#### Step 7: API tests

Add to `apps/api/src/app.test.ts`:

1. `POST /v1/recall-conversation` with empty body returns results (default behavior)
2. `POST /v1/recall-conversation` with sessionId filter returns only that session's events
3. `POST /v1/recall-conversation` with roles filter returns only matching roles
4. `POST /v1/recall-conversation` with date range returns bounded results
5. `POST /v1/recall-conversation` response shape matches expected contract

**Run:** `bun run test && bun run check-types && bun run build`
**Expected:** All PASS

**Batch B exit criteria:**
- engine -> bridge -> API -> OpenAPI -> client -> MCP -> AI SDK tool parity
- MCP tool description teaches exact timestamp format and filter behavior
- API-level tests confirm the contract
- `bun run test`, `bun run check-types`, `bun run build` all pass

---

### Batch C: Conversation Recall Regression Suite (1 BUILD cycle)

**Objective:** Build a Memongo-native conversation recall regression suite that serves as a benchmark-adjacent release gate.

**Files:**
- Create: `packages/memory-engine/src/mongodb-conversation-recall-benchmark.test.ts` (~300 LOC)
- Modify: `packages/memory-engine/src/mongodb-conversation-recall.test.ts` (add edge cases)

**Harmony invariants strengthened:** Benchmark rule (execution plan), Provenance Everywhere (invariant 7)

#### Step 1: Design the regression corpus

Create a small, deterministic conversation corpus embedded in the test file (NOT loaded from external JSONL). The corpus should cover:

**Scenario 1: Multi-session recall**
- Agent "benchmark-recall-01" has 3 sessions, each with 10 turns
- Session A: work discussions (Mon-Tue)
- Session B: personal topics (Wed-Thu)
- Session C: technical debugging (Fri)
- Test: recall "debugging" should find Session C events; recall with `sessionId: "B"` should find only Session B

**Scenario 2: Role and tool-message filtering**
- Agent "benchmark-recall-02" has 1 session with: 4 user messages, 4 assistant messages, 3 tool messages
- Test: default recall returns 8 results (no tool); with `includeToolMessages: true` returns 11; with `roles: ["user"]` returns 4

**Scenario 3: Exact date boundary**
- Agent "benchmark-recall-03" has events at:
  - `2026-04-07T23:59:59.000Z`
  - `2026-04-08T00:00:00.000Z`
  - `2026-04-08T12:00:00.000Z`
  - `2026-04-08T23:59:59.999Z`
  - `2026-04-09T00:00:00.000Z`
- Test: recall with `startTime: "2026-04-08"`, `endTime: "2026-04-08"` returns exactly 3 events (boundary-inclusive for the full day in UTC)

**Scenario 4: Timezone-aware boundary**
- Same events as Scenario 3
- Test: recall with `startTime: "2026-04-08"`, `endTime: "2026-04-08"`, `timezone: "America/New_York"` returns events from `2026-04-08T04:00:00Z` to `2026-04-09T03:59:59.999Z` (EDT offset)

**Scenario 5: asOf temporal gate**
- Agent "benchmark-recall-05" has events at T1, T2, T3
- Test: recall with `asOf: T2` returns only events at or before T2

**Scenario 6: Citation completeness**
- Test: every result has non-empty `citation.eventId`, `citation.role`, `citation.timestamp`, and `citation.preview`

#### Step 2: Implement regression tests

Each test:
1. Ingests events using `writeEvent()` with explicit timestamps
2. Calls `recallConversation()` with specific filters
3. Asserts exact expected counts and citation fields
4. Documents the expected behavior as a regression contract

#### Step 3: Add edge case tests to the main test file

- Empty body search (no events exist) -> empty results, clean metadata
- Limit of 1 -> exactly 1 result
- overlapping role filter + includeToolMessages (roles takes precedence)
- Invalid timezone string -> falls back to UTC
- startTime after endTime -> empty results (no error)
- Very long body text -> preview truncated at 500 chars

**Run:** `bun run test packages/memory-engine/src/mongodb-conversation-recall-benchmark.test.ts`
**Expected:** All PASS

**Batch C exit criteria:**
- 6 regression scenarios pass deterministically
- Edge cases documented and tested
- Regression suite can be re-run as a release gate for any recall-affecting change
- `bun run test`, `bun run check-types`, `bun run build` all pass

---

## Type Definitions (Draft)

```typescript
// In packages/memory-engine/src/types.ts

export type ConversationRecallToolPolicy = "exclude" | "include" | "summary"

export type ConversationRecallRequest = {
	agentId: string
	/** Semantic search query. Omit for filter-only recall. */
	query?: string
	/** Narrow to a specific session. */
	sessionId?: string
	/** Filter to specific message roles. Overrides includeToolMessages when provided. */
	roles?: Array<"user" | "assistant" | "system" | "tool">
	/** Inclusive start of time range. ISO 8601: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SSZ". */
	startTime?: string
	/** Inclusive end of time range. ISO 8601: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SSZ". */
	endTime?: string
	/** IANA timezone for date-only boundary resolution. Ignored for full timestamps. */
	timezone?: string
	/** Include tool messages in results. Default: false. */
	includeToolMessages?: boolean
	/** Max results. Default: 50, max: 200. */
	limit?: number
	/** Temporal upper bound. Default: now. Events after asOf are excluded. */
	asOf?: Date
}

export type ConversationRecallCitation = {
	eventId: string
	sessionId?: string
	role: "user" | "assistant" | "system" | "tool"
	timestamp: Date
	sourceRef?: string
	/** Rendered text preview (max 500 chars). */
	preview: string
}

export type ConversationRecallResult = {
	citation: ConversationRecallCitation
	/** Relevance score (present for semantic/hybrid recall). */
	score?: number
	/** How this result was matched. */
	matchType: "filter" | "semantic" | "hybrid"
}

export type ConversationRecallResponse = {
	results: ConversationRecallResult[]
	metadata: {
		totalMatched: number
		queryUsed?: string
		filtersApplied: string[]
		searchMethod: "standard" | "semantic" | "hybrid"
		durationMs: number
	}
}
```

## API Contract (Draft)

### `POST /v1/recall-conversation`

**Request:**
```json
{
	"query": "what did we discuss about the deployment?",
	"sessionId": "session-abc-123",
	"roles": ["user", "assistant"],
	"startTime": "2026-04-08",
	"endTime": "2026-04-09",
	"timezone": "America/New_York",
	"includeToolMessages": false,
	"limit": 20
}
```

**Response:**
```json
{
	"results": [
		{
			"citation": {
				"eventId": "evt-uuid-001",
				"sessionId": "session-abc-123",
				"role": "user",
				"timestamp": "2026-04-08T14:30:00.000Z",
				"preview": "User: Can we discuss the deployment timeline for next week?"
			},
			"score": 0.87,
			"matchType": "semantic"
		},
		{
			"citation": {
				"eventId": "evt-uuid-002",
				"sessionId": "session-abc-123",
				"role": "assistant",
				"timestamp": "2026-04-08T14:30:15.000Z",
				"preview": "Assistant: The deployment is scheduled for Wednesday at 2 PM EST..."
			},
			"score": 0.82,
			"matchType": "semantic"
		}
	],
	"metadata": {
		"totalMatched": 2,
		"queryUsed": "what did we discuss about the deployment?",
		"filtersApplied": [
			"sessionId:session-abc-123",
			"roles:user,assistant",
			"startTime:2026-04-08T04:00:00.000Z",
			"endTime:2026-04-10T03:59:59.999Z"
		],
		"searchMethod": "semantic",
		"durationMs": 45
	}
}
```

## MCP Tool Design

**Tool name:** `memongo_recall_conversation`

**Description (for agent consumption):**
> Search and retrieve past conversation messages with precise filters. Returns cited messages with canonical event IDs, roles, timestamps, and text previews.
>
> **Time format:** Use exact ISO 8601 timestamps (e.g., "2026-04-08T14:30:00Z"), not relative phrases like "last week." For date-only input (e.g., "2026-04-08"), include the timezone parameter to correctly resolve day boundaries.
>
> **Tool messages:** Function call/result messages (role: "tool") are excluded by default. Set includeToolMessages to true to include them.
>
> **Query:** Provide a query string for semantic search across conversation content. Omit for filter-only recall (returns events matching session/role/time filters in reverse chronological order).

## Benchmark Integration

Conversation recall regression tests in Batch C serve as the Memongo-native regression suite described in the benchmark charter. These tests:

1. **Are deterministic** - fixed event corpus, fixed timestamps, exact expected counts
2. **Cover all recall dimensions** - session, role, time, tool-policy, citations, asOf
3. **Run with standard Vitest** - `bun run test` includes them in every CI/local run
4. **Act as a release gate** - any recall-affecting change must not regress these scenarios

For the official benchmark integration with LongMemEval/LoCoMo, conversation recall can be exercised by:
- Ingesting benchmark conversations through `writeConversationEvent()`
- Recalling specific sessions/time ranges through `recallConversation()`
- Comparing retrieved event IDs against expected session/turn evidence

This integration is deferred to Wave 3 (Benchmark Operations) to avoid coupling the recall implementation to benchmark harness changes.

## Harmony Invariant Checklist

| Invariant | How Wave 1 strengthens it |
|---|---|
| 1. One temporal truth model | Introduces `asOf` on the conversation recall path as a narrow, proven-by-code contract |
| 2. One lifecycle model | N/A (Wave 2 scope) |
| 3. One identity/namespace model | Uses existing `agentId` + `scope` + `scopeRef` + `sessionId` identity system |
| 4. One recall plane | Adds conversation recall as the fourth member: profile, memory_blocks, context-bundle, conversation recall |
| 5. One feedback/review plane | N/A (Wave 6 scope) |
| 6. One scheduler owner | N/A (conversation recall is read-only) |
| 7. Provenance everywhere | Every recall result cites canonical eventId with rendered preview |
| 8. Wrappers are wrappers | MCP tool, AI SDK tool, and client all delegate to the same engine function |

## Phase Dependency Map

- **Batch A** (Contract + Engine): standalone, no dependencies
- **Batch B** (Full Stack): depends on Batch A types and engine function
- **Batch C** (Regression Suite): depends on Batch A engine function; can overlap with Batch B

## Phase Autonomy Classification

| Phase | Checkpoint Type | Classification | Reason |
|-------|----------------|----------------|--------|
| Batch A | none | AFK | Types and engine function are well-specified; no design ambiguity |
| Batch B | none | AFK | Stack wiring follows established patterns from 29 existing MCP tools and full-stack surfaces |
| Batch C | none | AFK | Regression corpus is specified; test design follows existing benchmark test patterns |

## Acceptance Checks

1. `bun run test` - all tests pass including new recall tests
2. `bun run check-types` - no type errors
3. `bun run build` - clean build (Turbo)
4. Manual: `curl -X POST http://localhost:3000/v1/recall-conversation -d '{"query":"deployment","limit":5}'` returns cited results
5. Manual: MCP tool `memongo_recall_conversation` with `startTime`/`endTime` returns correctly bounded results
6. Regression: `bun run test packages/memory-engine/src/mongodb-conversation-recall-benchmark.test.ts` passes all 6 scenarios

## Risks And Mitigations

| Risk | P | I | Score | Dimension | Mitigation |
|------|---|---|-------|-----------|------------|
| autoEmbed `$vectorSearch` syntax may differ from documented pattern | 2 | 3 | 6 | Technical | Verify against existing `buildVectorSearchStage` in `mongodb-search-executor.ts`; use `runSearchAggregateWithRetry` for warmup resilience |
| `timestamp` filter in `$vectorSearch.filter` may not support range operators on dates | 2 | 4 | 8 | Technical | Already verified: events_vector index includes `{ type: "filter", path: "timestamp" }`; per MongoDB docs, date filter fields support range operators in vectorSearch |
| Timezone resolution via `Intl.DateTimeFormat` edge cases (DST transitions) | 3 | 2 | 6 | Quality | Test with known DST boundary dates; document that timezone resolution uses the JS engine's timezone database |
| MCP tool count increases to 30 (search index budget consideration) | 1 | 1 | 1 | Technical | MCP tools do not consume search index budget; only Atlas Search/Vector Search indexes count |
| Semantic recall quality depends on autoEmbed model quality | 2 | 2 | 4 | Quality | Standard (filter-only) recall is always available as fallback; benchmark regression suite validates recall quality |

## Relevant Codebase Files

### Patterns to Follow
- `packages/memory-engine/src/mongodb-events.ts` (lines 14-28) - CanonicalEvent type definition
- `packages/memory-engine/src/mongodb-events.ts` (lines 30-35) - renderEventChunkText pattern
- `packages/memory-engine/src/mongodb-events.ts` (lines 89-118) - getEventsByTimeRange query pattern
- `packages/memory-engine/src/mongodb-context-bundle.ts` (lines 447-480) - buildRecentEventsSection rendering pattern
- `packages/memory-engine/src/mongodb-schema.ts` (lines 2854-2862) - events vector search filter fields
- `packages/memory-engine/src/mongodb-schema.ts` (lines 2819-2833) - events text search definition
- `packages/memory-engine/src/mongodb-schema.ts` (lines 1569-1616) - events standard indexes
- `packages/memory-engine/src/mongodb-structured-memory.ts` (lines 806-812) - currentOnly temporal filter pattern (for asOf reference)
- `packages/memory-engine/src/mongodb-search.ts` (lines 93-120) - runSearchAggregateWithRetry pattern
- `apps/api/src/routes/v1.ts` (lines 406-470) - context-bundle route pattern (follow for recall route)
- `apps/mcp/src/server.ts` (lines 95-140) - memongo_build_context_bundle tool pattern (follow for recall tool)
- `packages/client/src/client.ts` (lines 650-674) - buildContextBundle client pattern (follow for recall client)

### Configuration Files
- `packages/memory-engine/tsconfig.json` - TypeScript settings
- `packages/memory-engine/vitest.config.ts` - Vitest configuration
- `biome.json` - Biome formatting (tabs, double quotes)

## Summary

- Plan saved: `docs/plans/2026-04-10-wave1-conversation-recall-plan.md`
- Phases: 3 (Batch A: Contract+Engine, Batch B: Full Stack, Batch C: Regression Suite)
- Risks: 5 identified, 1 at score 8 (mitigated by verified index definition)
- Key decisions: new file for recall engine, no new indexes, tool messages excluded by default, narrow asOf contract, timezone via Intl.DateTimeFormat
