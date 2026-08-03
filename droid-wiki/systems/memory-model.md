# Memory model

Memongo stores six memory types in MongoDB collections, all sharing the same tenant identity (`agentId` + scope/scopeRef), bitemporal validity fields, trust metadata, and provenance. Collection names are prefixed per agent (`memongo_{agentId}_`) in single-tenant mode or shared with an `agentId` discriminator in multi-tenant mode.

## The six memory types

| Type | Collection | Shape | Source module |
|------|-----------|-------|---------------|
| Events | `events` | Immutable conversation messages (role, body, timestamp, sessionId) | `packages/memory-engine/src/mongodb-events.ts` |
| Structured memories | `structured_mem` (+ `structured_mem_revisions`) | Typed facts with lifecycle state, salience, temporal scope | `packages/memory-engine/src/mongodb-structured-memory.ts` |
| Episodes | `episodes` | Summarized conversation windows with 3-tier summaries | `packages/memory-engine/src/mongodb-episodes.ts` |
| Graph entities | `entities` | Typed nodes (person, project, concept, ...) | `packages/memory-engine/src/mongodb-graph.ts` |
| Graph relations | `relations` | Typed directed edges between entities | `packages/memory-engine/src/mongodb-graph.ts` |
| Knowledge base | `kb_documents` + `kb_chunks` | Ingested documents, chunked and embedded | `packages/memory-engine/src/mongodb-kb.ts` |

Procedures (`procedures` + `procedure_revisions`, `packages/memory-engine/src/mongodb-procedures.ts`) are a structured sibling: named workflows with steps, trigger queries, and success signals, sharing the same lifecycle machinery as structured memories.

## Events

Events are the append-only source of truth. Every conversation turn becomes an event with `eventId`, `agentId`, `role` (user/assistant/system/tool), `body`, `timestamp`, optional `sessionId`, scope identity, and validity fields. Writes use a durable majority write concern (`w: "majority"`, 5s timeout) with retry on transient errors (`isTransientMongoWriteError`). Events are projected into searchable chunks and carry an `extractionJobPendingAt` outbox marker that the [job queue](job-queue.md) uses to schedule background extraction. The [consolidation pipeline](consolidation.md) marks processed events with `dreamerProcessedAt`/`dreamerRunId`; episode consolidation uses a separate `markEventsConsolidated` path.

## Structured memories

Structured memories are durable, addressable facts. The type system (`packages/memory-engine/src/mongodb-structured-memory.ts`):

**14 types** — `decision`, `preference`, `person`, `todo`, `fact`, `project`, `architecture`, `contact`, `milestone`, `problem`, `emotional`, `identity`, `instruction`, `custom`.

**4 salience levels** — `critical`, `high`, `normal`, `low`. Salience drives the active-critical retrieval lane and the active slate (critical first).

**4 temporal scopes** — `ongoing`, `bounded`, `permanent`, `transient`. These describe how long the fact is expected to hold, distinct from bitemporal validity timestamps.

**3 lifecycle states** — `active`, `invalidated`, `conflicted`. Invalidation is soft: the document stays for history and audit.

Other key fields: `confidence`, `reinforcementCount` (corroboration counter), `sourceReliability`, `reviewAt`/`lastConfirmedAt`, `sourceEventIds` provenance, and an optional `artifact` for code/config stored as first-class memory.

**Revisions and handles.** Every mutation bumps a `revision` counter and appends a snapshot to `structured_mem_revisions` with a deterministic `_id` (`identity:rN`) so duplicate supersede writes dedup on E11000 instead of doubling history. Callers hold **stable handles** that pin the observed revision; applying a stale handle throws `MemoryLifecycleConflictError` (permanent), while a compare-and-swap race throws `StructuredMemoryRevisionConflictError` carrying the driver's `TransientTransactionError` label so transactional callers retry against a fresh snapshot (up to 3 internal CAS retries for sessionless calls).

## Episodes

Episodes (`packages/memory-engine/src/mongodb-episodes.ts`) summarize windows of events into five types — `daily`, `weekly`, `thread`, `topic`, `decision` — with a pluggable `EpisodeSummarizer` (LLM in production, mock in tests). The summarizer receives the episode type so the same window produces genuinely different lenses rather than byte-identical clones. Tiered summaries (`packages/memory-engine/src/mongodb-tiered-summary.ts`) produce three independently useful levels — short-term ("what just happened"), medium-term ("what this session accomplished"), long-term ("what should be remembered forever") — plus 3-8 topic tags. Episodes link back to their `sourceEventIds` and carry a status of `active`, `archived`, or `deleted`.

## Graph entities and relations

The knowledge graph (`packages/memory-engine/src/mongodb-graph.ts`) has **11 entity types** (`person`, `org`, `project`, `topic`, `feature`, `issue`, `document`, `custom`, `location`, `system`, `concept`) and **8 relation types** (`works_on`, `owns`, `depends_on`, `blocked_by`, `decided`, `mentioned_with`, `reported_by`, `related_to`).

- **Extraction** — `packages/memory-engine/src/mongodb-entity-extractor.ts` pulls entities with regex heuristics or an LLM (`extractionMethod: "regex" | "llm"`), with a canonical stop-word list. The rule-based path auto-creates `mentioned_with` co-occurrence edges (confidence 0.2).
- **Typed relations** — `packages/memory-engine/src/mongodb-relation-extraction.ts` asks the LLM for typed edges between already-extracted entities (max 25 entities per prompt, confidence floor 0.5). `mentioned_with` and `owns` are deliberately excluded: the former is the co-occurrence default, the latter has destructive write-side exclusivity (a new `owns` edge invalidates other live `owns` edges to the same target) and stays manual/API-only so a probabilistic LLM edge cannot silently invalidate curated ownership.
- Relations carry their own lifecycle state (`active`, `invalidated`, `conflicted`) and bitemporal validity, and retrieval traverses the graph with `$graphLookup` in the graph lane of the [retrieval pipeline](retrieval-pipeline.md).

## Derived memories

`packages/memory-engine/src/mongodb-derived-memory.ts` promotes structured memories and procedures from individual events in the background (the extraction [job](job-queue.md)). It combines regex candidate extraction with LLM enrichment, refines valid-time with LLM-extracted dates (`refineCandidatesValidTime`), and runs `invalidateContradictedFacts` so a new fact expires the existing facts it directly contradicts. Event-receipt idempotency (`hasProcessedSourceEvents`) makes re-execution after a lease loss side-effect-free.

## Knowledge base

The KB (`packages/memory-engine/src/mongodb-kb.ts`) ingests documents from files, URLs, manual entry, or the API, chunks them with `chunkMarkdown`, hashes content for change detection, and embeds chunks for vector search. Every document and chunk is tagged with the caller's resolved `{agentId, scope, scopeRef}`; `scopeRef` is the concrete isolation namespace every read/write/delete filters on, so tenants sharing one physical collection cannot observe each other's KB. Shared corpora use scope `global` or `tenant`. See [Knowledge base](../features/knowledge-base.md).

## Bitemporal validity

Every memory type carries valid-time fields so retrieval can answer both "what is true now" and "what was true at time T" (`packages/memory-engine/src/mongodb-bitemporal.ts`):

- `validAt` / `validFrom` — when the assertion became true (distinct from the ingestion clock; derived from the source event timestamp or an LLM-extracted date)
- `invalidAt` / `validTo` — when it stopped being true (absent = still valid)

Retrieval at time T must only return memories where `validAt <= T AND (invalidAt IS NULL OR invalidAt > T)`. `buildBitemporalFilter` produces the `$and`-composable MongoDB clause; a vector-search variant omits the explicit-null branch because `$vectorSearch` prefilters do not document BSON null as a supported filter value, so canonical writes represent open windows by omitting `invalidAt`. Legacy rows written before the migration lack `validAt` and are treated as valid, keeping retrieval monotonic across the migration. `isMemoryValidAt` is the pure predicate mirror kept in the same file so tests cannot drift from the filter shape. See [Bitemporal memory](../features/bitemporal-memory.md).

## Common fields

All memory types share:

- `agentId` — tenant discriminator in every index and query filter
- `scope` / `scopeRef` — resolved isolation namespace (`session`, `user`, `agent`, `workspace`, `tenant`, `global`)
- Bitemporal fields (`validFrom`/`validTo`, `validAt`/`invalidAt`)
- Trust metadata feeding the 7-dimension scoring (see [Trust scoring](../features/trust-scoring.md))
- Provenance: `sourceEventIds`, `sourceAgent`, `provenance` records

## Key files

| File | Role |
|------|------|
| `packages/memory-engine/src/types.ts` | Shared memory types, job types, search request/response shapes |
| `packages/memory-engine/src/mongodb-structured-memory.ts` | Structured memory types, salience, lifecycle, revisions, stable handles |
| `packages/memory-engine/src/mongodb-events.ts` | Durable event writes, retry classification, chunk projection |
| `packages/memory-engine/src/mongodb-episodes.ts` | Episode types, summarizer injection, consolidation triggers |
| `packages/memory-engine/src/mongodb-graph.ts` | Entity/relation types, upserts, `$graphLookup` traversal |
| `packages/memory-engine/src/mongodb-entity-extractor.ts` | Regex/LLM entity extraction |
| `packages/memory-engine/src/mongodb-relation-extraction.ts` | LLM typed relation extraction |
| `packages/memory-engine/src/mongodb-derived-memory.ts` | Event-to-structured/procedure promotion with contradiction handling |
| `packages/memory-engine/src/mongodb-bitemporal.ts` | Validity filter shapes and predicate |
| `packages/memory-engine/src/mongodb-kb.ts` | KB ingestion, chunking, tenant scoping |

## Related pages

- [Systems overview](index.md)
- [Retrieval pipeline](retrieval-pipeline.md) — how each type is searched
- [Consolidation](consolidation.md) — how events become structured memories
- [Bitemporal memory](../features/bitemporal-memory.md)
- [Core engine package](../packages/memory-engine/index.md)
