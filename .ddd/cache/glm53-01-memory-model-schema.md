# 01 — Core Memory Model & Schema

Repo: memongo (MongoDB-native long-term AI memory). All file references repo-root relative.

## 1. Executive summary (top 5 findings, one line each)

1. **Chunk-projection bitemporal gap**: Conversation chunks — the primary retrieval surface — carry no `validAt`/`invalidAt`, so invalidated memories surface silently in the semantic/lucene search lanes; bitemporality is enforced on events but not on the chunks they project to.
2. **Quarantined memories are silently lost forever**: Injection-classified candidates land in `memory_quarantine` with `status: "pending-review"` (`packages/memory-engine/src/mongodb-consolidator.ts:786-799`), but there is zero code anywhere to review/promote/reject them and no TTL — a legitimate user memory that trips a regex pattern is silently never stored.
3. **TTL asymmetry orphans chunks**: Events get `expiresAt` via `resolveWriteExpiresAt` (`packages/memory-engine/src/mongodb-manager-write.ts:538`) and are TTL-deleted, but projected chunks never receive `expiresAt` and the chunks collection has no TTL and no sweep — the conversation text a retention policy was supposed to forget keeps surfacing in search forever.
4. **Relation locator is type-ambiguous**: `relationId = ${fromEntityId}-${toEntityId}` omits the relation type (`packages/memory-engine/src/mongodb-graph.ts:496`), so `findRelationByLocatorId` (`mongodb-graph.ts:2080-2114`) returns an arbitrary relation when two types (e.g. `works_on` and `knows`) exist between the same entity pair.
5. **Exclusive-relation invalidation writes the wrong valid-time end**: The `owns`-invalidation path sets `validTo: now` — the transaction clock — instead of the superseding fact's `validFrom` (`packages/memory-engine/src/mongodb-graph.ts:520-536`), so as-of-T queries between the real transition date and the write date return stale ownership.

## 2. Checklist verification

| # | Item | Verdict | Evidence (file:line) |
|---|------|---------|----------------------|
| 1 | Enumerate every collection | **PASS** | 28 collections in `packages/memory-engine/src/mongodb-schema-collections.ts:11-243`; 22 validated via `$jsonSchema` (`mongodb-schema-validators.ts:58-126`); 6 without validators (session_chunks, lane_coverage, consolidation_runs, meta, files partial, memory_telemetry/access_events as timeseries) |
| 2 | Bitemporal model — event vs ingest time | **PARTIAL** | Events: `validAt`+`invalidAt` (valid time) + `recordedAt` (transaction time) — `mongodb-schema-validator-memory.ts:71-84`. Structured mem/relations/procedures: `validFrom`/`validTo`. Missing: a transaction-time invalidation marker (Graphiti's `expired_at` equivalent). Relations' `invalidatedBy.at` is a write-clock ISO **string**, while `validTo` is a Date — type inconsistency in the same update |
| 3 | Referential integrity / orphan prevention | **FAIL** | Only KB orphans are checked (`checkKBOrphans`, `mongodb-schema-integrity.ts:19-60`). No orphan checks for relations→entities, entity_links→entities, episodes→events, chunks→events, structured_mem.sourceEventIds→events. `deleteEntity` cascades to relations (`mongodb-graph.ts:1247-1248`) but not entity_links |
| 4 | Episode boundary detection | **PASS** | Triggers: session_gap (>30min default), event_count (>50), explicit. `resolveTriggeredEpisodeWindow` (`mongodb-episodes.ts:128`). Content-address dedup via `sourceEventsHash` (`mongodb-episodes.ts:166`); duplicate-key retry on concurrent materialization (`mongodb-episodes.ts:308`) |
| 5 | Unbounded growth — arrays approaching 16MB | **FAIL** | `entities.sourceEventIds`: `$addToSet`, no cap. `relations.sourceEventIds`: `mergeSourceEventIds` Set union, no cap (`mongodb-graph.ts:514-517`). `structured_mem.sourceEventIds`: direct set, no cap (`mongodb-structured-memory.ts:934-936`). `episodes.eventIds`: window-capped (~500) — OK. `procedures.evolutionHistory`: capped at 20 via `$push`+`$slice:-20` — OK. A hot entity ("user") accumulates one ~36-byte UUID per mention, indefinitely |
| 6 | Missing constraints — fields code assumes present | **FAIL** | `validationLevel: "moderate"` (`mongodb-schema-validators.ts:109`) means update-path `$set` of malformed values is never validated (insert-only guard). `EVENTS_SCHEMA` does not declare `idempotencyKey`/`idempotencyFingerprint`/`accessCount`/`dreamerProcessedAt` though code reads/writes them (extra properties pass silently). `EPISODES_SCHEMA` declares `eventIds` while the write path writes `sourceEventIds` (`mongodb-episodes.ts:269`) — the declared field is never populated |
| 7 | Type drift — documents matching TS types | **PARTIAL** | `Episode` TS type omits `sourceEventsHash`/`createdAt`/`status` that are written. `relationId` is a denormalized locator string on the doc but absent from TS relation types. Session-evidence docs carry `provenance`/`metadata`/`canonicalId` that appear in no TS chunk type. No runtime type enforcement — loose coupling everywhere |
| 8 | ID generation | **PARTIAL** | Events/episodes/KB: `randomUUID()`. Entities: sha256 content-hash slice(0,16) → 64 bits (`makeEntityId`, `mongodb-graph.ts:1397-1403`). Entity links: slice(0,24) → 96 bits. Relations: `from-to` pair **without type** (`mongodb-graph.ts:496`) — ambiguous locator (see finding 4). Revisions: deterministic `_id` with E11000 tolerated as no-op (`mongodb-structured-memory.ts:612-627`) — good idempotency |
| 9 | Time handling | **PASS** | UTC everywhere (`new Date()` for `recordedAt`/`updatedAt`). Future-dated `validAt` is accepted (only `invalidAt > validAt` is validated). Legacy fallback: missing `validAt` treated as valid (monotonic across migration, `mongodb-bitemporal.ts:36-47`) |
| 10 | Soft delete vs hard delete | **PASS** | Soft: episodes/chunks `status: active/archived/deleted`; structured_mem/relations/procedures `state: active/invalidated/conflicted`; entity_links `status: active/rejected`. Search filters `status: {$ne: "deleted"}` and `buildLiveStateClause` on all read paths. Hard delete only via `deleteEntity` cascade (relations but not entity_links). Note: `invalidated` relations are retained (history preserved), never purged |

## 3. Correctness bugs (reasoned reproductions, not speculation)

### B1. Chunk-level bitemporal blindness (P1)
- **Reproduction**: Write event A ("Alice is CEO", validAt 2024-01-01). Write event B ("Bob is now CEO", validAt 2025-06-01) which sets A's `invalidAt` to 2025-06-01. Both project to chunks at `events/<uuid>`. Semantic/hybrid search for "CEO" returns BOTH chunks, including the invalidated Alice fact, indefinitely.
- **Evidence**: `projectEventChunk` (`packages/memory-engine/src/mongodb-events.ts:841-891`) writes `path, text, hash, source, agentId, scope, scopeRef, sessionId?, timestamp, updatedAt` — no `validAt`/`invalidAt`. `buildBitemporalFilter` (`mongodb-bitemporal.ts:36-47`) is applied only on events-lane reads (`mongodb-search-lanes.ts` conversation evidence) and graph traversal, never on the chunks lane (`mongodb-manager-search.ts` filters only `status: {$ne: "deleted"}`).
- **Impact**: Invalidated facts surface alongside their successors in the primary retrieval surface. Compounds with U2 (TTL-deleted events leave live chunks).

### B2. Exclusive-relation invalidation uses transaction time as valid-time end (P1)
- **Reproduction**: On Jan 1 Bob acme.example becomes owner (validFrom 2025-01-01), but the write reaches memongo on Jun 1. The invalidation update sets Alice's `owns` relation `validTo: now` = 2025-06-01 (`mongodb-graph.ts:520-536`). An as-of-March query (`validFrom <= T < validTo`) still returns Alice as owner even though the system knows the transition happened Jan 1.
- **Evidence**: `const now = new Date()` then `$set: { state: "invalidated", validTo: now, ... }`. Graphiti by contrast sets `invalid_at` ← the new fact's `valid_at` (mintlify.wiki/getzep/graphiti temporal-model doc, "Temporal Edge Invalidation": `invalid_at ← new fact's valid_at; expired_at ← current timestamp`).
- **Impact**: As-of-T historical queries return stale state for the window between the real-world transition and the write. Also: memongo has no `expired_at` transaction-time marker at all, so "what did the system believe on date X?" is unanswerable.

### B3. Relation locator type ambiguity (P1)
- **Reproduction**: `(Alice) --[works_on]--> (Acme)` and `(Alice) --[knows]--> (Acme)` both get `relationId: "<AliceId>-<AcmeId>"` (`mongodb-graph.ts:496`). `findRelationByLocatorId` does `findOne({relationId})` sorted by `updatedAt desc` (`mongodb-graph.ts:2088-2092`) — returns whichever relation was touched most recently, not the type the caller meant. The fallback scan (lines 2100-2112) JS-matches the same pair, equally type-blind.
- **Impact**: Any readFile path resolving a `relation:<from>-<to>` locator can silently retrieve the wrong relation. The unique identity index (`uq_relations_identity`) includes `type`, so the data model supports multiple types per pair — the locator does not.

### Retracted candidates (verified false positives — documented to prevent re-litigation)
- **Session-evidence schema validation trap**: RETRACTED. Option A evidence docs (`mongodb-session-evidence.ts:31-56`) carry `path` + `source: "session-evidence"` but no `hash`; they fail CHUNKS_SCHEMA branch 1 (requires `hash`) and pass branch 2 (`required: [source, text, updatedAt]`, source enum includes the evidence literals — `mongodb-schema-validator-knowledge.ts:92-131`). `oneOf` is satisfied by exactly one branch; extra fields pass because `additionalProperties` is not `false`. Userfact-evidence docs (no `path`) likewise match only branch 2. No validation failure.
- **Bitemporal filter drift in search lanes**: RETRACTED as a correctness bug. `mongodb-search-lanes.ts:482` uses `$or: [{invalidAt: null}, {invalidAt: {$gt: queryTime}}]` without the `{$exists: false}` branch that `buildBitemporalFilter` has — but in MongoDB query semantics `{field: null}` matches both explicit null AND absent fields, so the two implementations are functionally equivalent. Remains a P2 consistency note (one predicate, two hand-rolled shapes; the vector variant `buildVectorBitemporalFilter` legitimately differs because Vector Search prefilters don't support BSON null).

## 4. Unknown unknowns (things no checklist covers — HIGHEST VALUE)

### U1. Quarantined-memory orphan sink (P0)
- The injection classifier routes flagged candidates to `memory_quarantine` with `status: "pending-review"` BEFORE any canonical write (`mongodb-consolidator.ts:781-799`). The schema models a full review lifecycle — `reviewedAt`, `reviewerId`, `reviewNotes`, `status: pending-review/rejected/promoted` (`mongodb-schema-validator-operations.ts:294-311`) — but **zero TypeScript code** ever reads these documents, changes their status, or lists them for review. Verified by grep across all non-test sources: the only non-schema hits are the consolidator insert and the collection accessor. There is no API endpoint, MCP tool, CLI command, or scheduled job that surfaces quarantined memories. Tier-1 is regex-based and always on, so false positives (legitimate memories containing e.g. instruction-shaped text) are silently dropped forever, with only a `log.warn` as trace. The collection also has no TTL — it grows unbounded while its contents are dead data.
- This converts the OWASP LLM08 (memory-poisoning) defense into silent data loss with no operator visibility.

### U2. TTL-deleted events leave orphan chunks — retention does not propagate (P0 for compliance-sensitive deployments)
- Enabling session TTL (`memory.mongodb.ttl.sessionDays`) gives events `expiresAt` (`mongodb-manager-write.ts:538`) which `idx_events_ttl_expires_at` enforces. But `resolveWriteExpiresAt` is called in exactly three places (grep-verified): manager-write events (x2) and structured memory. `projectEventChunk` never sets `expiresAt`, and the chunks collection has no TTL index. The only chunk-deletion code (`mongodb-sync.ts:267-290`) is namespace-filtered for kb/files sync — nothing deletes event-projected chunks when their source event expires.
- Result: a "forget after N days" policy deletes the event but leaves its full conversation text live in the primary search surface indefinitely. Structured memory is handled correctly (expiresAt + TTL index); the events→chunks projection is not.

### U3. Non-atomic event→chunk projection window (P2)
- The manager write path commits event+extraction-job in a transaction, then projects the chunk outside it (`mongodb-manager-write.ts:555-663` — `projectEventChunk` runs after commit). A crash in the gap leaves the event invisible to chunk-based search until the unprojected-events repair pass runs. The repair pass exists (`getUnprojectedEvents` → `projectEventChunksBatch`), so this is a bounded-visibility window, not data loss.

### U4. No archival tier or growth budget on core collections (P1)
- No sharding keys, no TTLs on chunks/entities/relations/episodes/procedures (structured_mem_revisions' indefinite default is documented as intentional audit substrate, with optional `revisionRetentionDays` TTL on `supersededAt` — `mongodb-schema-standard-indexes-operations.ts:88-99` — coherent since revisions are only created on updates). Every memory a multi-year deployment ingests is retained forever in the hot collections, plus the unbounded `sourceEventIds` arrays (checklist #5) push individual hot-entity documents toward the 16MB BSON cap.

### U5. Quarantine scope-mismatch retry loop (P2)
- On scope mismatch the consolidator adds the event to `failedEventIds` and `continue`s (`mongodb-consolidator.ts:755-772`). Failed events are not marked consolidated, so every subsequent run re-attempts them and re-fails — a permanently hot retry loop for any event whose candidate scope disagrees with run options (only surfaced in `MEMONGO_BENCHMARK_STRICT` mode).

## 5. Competitor comparison

| Pattern/feature | memongo (evidence) | Competitor (source) | Gap? |
|---|---|---|---|
| Four-timestamp bi-temporal edges | Events: `validAt`+`invalidAt`+`recordedAt`. Relations: `validFrom`+`validTo`+`createdAt`+`invalidatedBy.at`(string). No transaction-time invalidation marker | **Graphiti** `EntityEdge`: `valid_at`+`invalid_at`+`created_at`+`expired_at` (graphiti docs, temporal-model; `graphiti_core/edges.py:271-279`) | **Gap**: memongo cannot answer "what did the system believe on date X?"; `invalidatedBy.at` is a string, not a Date |
| Contradiction handling | Only exclusive `owns` relations auto-invalidate, and with `validTo: now` (write clock — B2). Structured memory conflicts set `state: "conflicted"`; caller must resolve | **Graphiti**: LLM-driven contradiction resolution during edge ops; old edge gets `invalid_at` ← new fact's `valid_at` (edge_operations.py:484 per docs) | **Gap**: memongo requires the caller to detect most contradictions; and even its automated path writes the wrong valid-time end |
| Point-in-time retrieval | Events lane supports as-of-T via bitemporal filter; chunks lane does not (B1) | **Graphiti**: `SearchFilters(valid_time=...)` across search | **Gap** on the chunks lane |
| Fact history | `structured_mem_revisions` (per-fact snapshots, deterministic `_id`, optional retention TTL) + `memory_mutations` audit (90-day TTL) | **mem0**: per-memory history API (docs.mem0.ai/api-reference/memory/history-memory), ADD/UPDATE/DELETE with old/new values | **Parity** on storage; memongo's mutations audit expires in 90d, revisions indefinite — coherent but two mechanisms to reason about |
| Working-memory blocks | No block model; episodes are aggregated summaries, mutable via `$set` on re-materialization (no episode revision trail) | **LettA/MemGPT**: agent-editable blocks (label/value/limit) with history | **Gap**: no agent-mutable working-block abstraction; episode re-materialization overwrites history without revisions |
| Immutable episodic provenance | Episodes upsert on identity; `sourceEventsHash` dedups; content mutable | **Graphiti**: episodes are immutable nodes | **Partial**: memongo episodes are upserted, not append-only |

## 6. External docs alignment

- **MongoDB `$jsonSchema`**: validators rely on `oneOf` + open `properties` (no `additionalProperties: false`) — correct for polymorphic chunks, but means the schema never rejects stray fields; combined with `validationLevel: "moderate"`, update-path writes are entirely unvalidated.
- **MongoDB TTL indexes**: applied to telemetry (7d), access_events (30d), mutations (90d), query_cache (per-doc), events/structured_mem (per-doc `expiresAt`), optional revisions TTL. Not applied to chunks (U2), entities, relations, episodes, procedures, memory_quarantine (U1).
- **MongoDB Vector Search prefilter constraints**: `buildVectorBitemporalFilter` (`mongodb-bitemporal.ts:56-77`) correctly avoids BSON null in prefilters (docs: null not a supported filter value); readiness check verifies no legacy `invalidAt: null` via `{invalidAt: {$type: 10}}` (`mongodb-schema-search-readiness.ts:187`). Aligned.
- **OWASP LLM Top 10**: LLM08 (excessive agency / memory poisoning) is addressed by tier-1/tier-2 classification but the quarantine sink (U1) makes it a black hole; LLM06 (sensitive disclosure) — no redaction layer; search returns full document text; retention policy (U2) does not propagate to derived copies.

## 7. Recommendations (P0 = data loss/security, P1 = correctness/cost, P2 = quality)

**P0**
- **R1**: Build the quarantine review workflow — `listQuarantined`/`promote`/`reject` API (surface via MCP tool and web console), set `reviewedAt`/`reviewerId`/`reviewNotes` on decision, and add a TTL or retention cap on unreviewed entries. Without it, tier-1 regex false positives are silent permanent data loss.
- **R2**: Propagate retention from events to chunks — either copy `expiresAt` into projected chunk docs + TTL index on chunks, or add a sweeper that deletes chunks whose source event no longer exists. Also gate `memory.mongodb.ttl` docs with a warning until this lands.

**P1**
- **R3**: Include `type` in `relationId` (e.g. `${from}-${to}-${type}`) with a migration for existing docs; until then `findRelationByLocatorId` should accept an optional type and filter on it.
- **R4**: Add `validAt`/`invalidAt` to chunk projection and apply `buildBitemporalFilter` on the chunks search lane (B1).
- **R5**: Set `validTo` on exclusive-relation invalidation from the superseding relation's `validFrom` (fallback `now`), and store `invalidatedBy.at` as a Date (B2).
- **R6**: Cap `sourceEventIds` arrays (entities, relations, structured_mem) — `$push`+`$slice` with recency eviction, or a bounded append in `mergeSourceEventIds`.
- **R7**: Extend orphan detection beyond KB: relations→entities, entity_links→entities, chunks→events, episodes→events; make `deleteEntity` cascade to entity_links.

**P2**
- **R8**: Fix `EPISODES_SCHEMA` to declare `sourceEventIds` (not `eventIds`) and declare the event fields code actually reads (`idempotencyKey`, `accessCount`, `dreamerProcessedAt`).
- **R9**: Deduplicate the bitemporal predicate — search lanes should call `buildBitemporalFilter` instead of hand-rolling an equivalent (null-matches-missing today; a future edit could break that equivalence silently).
- **R10**: Add validators (or documented rationale) for the unvalidated collections: session_chunks, lane_coverage, consolidation_runs, meta.
- **R11**: Bound the quarantine/mismatch retry loop (U5): cap attempts or mark permanently-failed events with a terminal state.
