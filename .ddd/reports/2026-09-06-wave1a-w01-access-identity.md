# Wave 1a — W01 access reinforcement outside the owning tenant/scope

Date: 2026-09-06
Scope: full remediation of the independent audit (2026-09-05) under DDD
v0.7.0. This note is the plan + Documentation basis for Wave 1a (W01 and
the identity-transport gaps the finding rests on). RET-20's "relation id
mapping still wrong" and the structured canonicalId gap recorded in the
disposition fragments are the same construct and are fixed here.

## Finding (docs/audits/2026-09-05-independent/logic_write.md, W01, P1)

`AccessTracker` maps every collection's identity to a single id field
(`COLLECTION_ID_FIELDS`, structured_mem -> `key`), buffers by
`collection::id` only, and flushes canonical counters with the filter
`{[idField]: memoryId}`. The unique identity of a structured_mem row is
`{agentId, scope, scopeRef, type, key}`; procedures/entities/relations
carry scope-bearing unique identities too. Consequence: `updateOne` may
increment another tenant's row (audit reproduced: recording B's
`timezone` incremented A to 1, left B at 0). Remedy per audit: carry the
complete stable handle in access records and include full identity in
every canonical update; "do not repair by adding agentId alone".

Additional transport gaps confirmed at HEAD (d9784266d2) while grounding:

- `toStructuredResult` (mongodb-structured-memory.ts:1828) sets no
  `canonicalId`, so `recordSearchAccess` (mongodb-manager-search.ts:272)
  silently skips ALL structured search results — reinforcement is a
  structural no-op for the largest memory lane, not just mis-scoped.
- `recordSearchAccess` derives the id by slicing the canonicalId at the
  first colon. For `structured:${type}:${key}` it yields
  `${type}:${key}` (filter `{key: "preference:timezone"}` — matches
  nothing); for `relation:${from}:${type}:${to}` it yields the colon
  form while documents store `relationId` as the dash form
  `${from}-${to}-${type}` (mongodb-graph.ts) — also matches nothing.

## Documentation basis

Technology: MongoDB Server 8.x (local stack 8.3.8 replica set) with the
Node.js driver (v7 line) as resolved in the repo lockfile. Access method:
driver `bulkWrite` with `updateOne` ops (unordered).

Official links and the contract each decision rests on:

1. Unique compound index identity —
   https://www.mongodb.com/docs/manual/core/index-unique/
   "A unique compound index ensures that any given combination of the
   index key values appears at most once." The identity of a row in
   structured_mem/procedures/entities/relations IS the full compound
   key, not any single member. Repo indexes (mongodb-schema-standard-
   indexes-core/graph/operations.ts): `uq_structured_agent_scope_
   scoperef_type_key` = {agentId, scope, scopeRef, type, key};
   `uq_procedures_identity` = {procedureId, agentId, scope, scopeRef};
   `uq_entities_entityid_agent_scope_scoperef`; `uq_relations_identity`
   = {agentId, scope, scopeRef, fromEntityId, toEntityId, type};
   `uq_events_eventid` = {eventId} (global per collection);
   `uq_episodes_episodeid` = {episodeId}.

2. updateOne filter semantics —
   https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/
   "updateOne() finds the first document that matches the filter" — with
   a non-unique filter, which document is first is unspecified, so a
   `{key}`-only filter in a shared collection can update any tenant's
   row. An update that matches nothing changes nothing (silently).

3. Node driver update behavior —
   https://www.mongodb.com/docs/drivers/node/current/fundamentals/crud/write-operations/modify/
   `updateOne()` "Update the first document that matches the filter";
   "If an update operation fails to match any documents in a collection,
   it does not make any changes." Confirms both the wrong-owner hazard
   and the silent no-op hazard for driver-level bulkWrite updateOne ops.

Snippets: no official example is copied; all code below is proposed code
(untested) until the Validation section records run results.

Open questions: none. (Whether trend aggregation should group by full
handle rather than short memoryId is a pre-existing within-agent
ambiguity — NOT tenant corruption — and stays out of this wave.)

## Fix design

1. `AccessRecordTarget` (new type, types.ts) — per-access full identity:
   `{collection, id, scope?, scopeRef?, type?, fromEntityId?,
   toEntityId?}`. `id` semantics per collection: eventId / key /
   procedureId / episodeId / entityId / relation locator
   (`from:type:to`). agentId is NOT per-target: the tracker is
   constructed per agent and stamps its own agentId into every filter
   (audit: "include agent identity in every update").
2. `AccessTracker.recordAccess(target)` replaces `(id, collection)`.
   Buffer key becomes the full identity tuple (JSON-encoded, collision
   proof); buffer entries carry the target so two same-key rows in
   different scopes/types never merge counts.
3. `doFlush` builds the canonical update filter as the collection's
   EXACT unique-index compound (plus tracker agentId; events/episodes
   keep `{eventId|episodeId, agentId}` — single-field unique, agentId as
   defense in depth). Required-identity fields per collection:
   structured_mem {scope, scopeRef, type}; procedures/entities
   {scope, scopeRef}; relations {scope, scopeRef, fromEntityId,
   toEntityId, type}. If any required field is missing the canonical
   update is SKIPPED with one warn per flush (fail-safe: never write an
   under-specified filter), while the raw access event is still
   recorded.
4. `AccessEventDocument` gains optional top-level `scope`, `scopeRef`,
   `type` (same top-level treatment as `memoryId` per the L6 time-series
   note: high-cardinality fields stay out of `meta`). `memoryId` keeps
   the short id so the public accessSummaries/accessTrends memoryIds
   contract (MCP/client/bridge) is unchanged; the complete handle is the
   tuple {meta.agentId, meta.collection, memoryId, scope, scopeRef,
   type}.
5. `accessTargetFromSearchResult(result)` (new export,
   mongodb-access-tracker.ts) — parses `canonicalId` per collection
   (structured: first segment type, rest joined = key, mirroring
   readFile's parse; relation: exactly three segments from/type/to;
   `?scope=&scopeRef=` query suffix accepted as fallback), prefers
   result-level scope/scopeRef fields. `recordSearchAccess` uses it.
6. `toStructuredResult` sets
   `canonicalId: structured:${type}:${key}` (discovery-projections
   format; scope/scopeRef already ride as result fields), closing the
   structured-lane skip. `toProcedureResult` already sets
   `procedure:${procedureId}` + scope/scopeRef — no change needed.
7. Relations: filter uses the exact unique compound
   {agentId, scope, scopeRef, fromEntityId, toEntityId, type} from the
   parsed locator; the dash-form relationId field is NOT used (it is a
   locator convenience, not the unique identity).

## Validation plan (native checks)

- Unit: mongodb-access-tracker.test.ts — cross-tenant/cross-scope/
  cross-type same-key filters, per-collection compound filters, skip on
  under-specified identity, buffer dedupe by full identity, raw-event
  identity fields, fast-check count-safety property on the new API;
  accessTargetFromSearchResult parse matrix (colon keys, query-suffix
  fallback, relation 3-segment rule, unparseable -> null).
- Live probe (audit methodology, scratch database, disposable): RED at
  HEAD reproduces W01 (B's access increments A; relation/procedure
  filters match nothing); GREEN after fix (narrow target fails safe,
  full-identity target increments exactly the owning row, all other
  same-key rows untouched).
- `bun run check-types` (memory-engine + lib), engine unit suite,
  Biome format/lint on touched files.

## Status

- [x] Grounding complete (4 official docs; time-series page added during the
      compare phase for the measurement-fields claim).
- [x] RED probe run — `.ddd/reports/runs/w01-red-probe.log`: against the live
      memongo-preview server, B's narrow structured access incremented A's
      row (wrong owner, exactly the audit's reproduction), procedures and
      entities also incremented A's row, the relation filter matched nothing,
      and the raw history was ambiguous. Exit evidence: scratch DB dropped.
- [x] Implementation — files: packages/memory-engine/src/types.ts
      (AccessRecordTarget + AccessEventDocument identity fields),
      mongodb-access-tracker.ts (compound filters, fail-safe skip, buffer
      identity, accessTargetFromSearchResult), mongodb-manager-search.ts
      (recordSearchAccess rewrite), mongodb-structured-memory.ts
      (toStructuredResult canonicalId), internal-barrel.ts (exports),
      e2e-evaluation.e2e.test.ts + mongodb-access-tracker.test.ts (tests).
- [x] Unit + type checks — access-tracker suite 24/24; repo-wide
      `bun run check-types` 15/15 tasks; FULL memory-engine unit suite
      2585 passed / 0 failed / 10 skipped (the audit's 18 drift failures no
      longer reproduce at HEAD — they were fixed by WS-11..19 remediations
      after the audit's verification run; no regressions from this change).
      Biome: 3 formatting errors auto-fixed on touched files; the 15
      remaining warnings are pre-existing at HEAD (verified against the HEAD
      blob: unused `path`/`MemoryScope` imports, noNonNullAssertion x10,
      noUnusedFunctionParameters — all in untouched regions).
- [x] GREEN probe run — `.ddd/reports/runs/w01-green-probe.log`: all 13
      assertions pass on the live server. Narrow target (audit repro shape)
      fails safe with zero canonical increments and one bounded warn; full
      identity increments exactly the owning row (x2) across all six
      collections; other tenant / other scope / other type same-key rows all
      untouched; search-result identity parse feeds the tracker correctly
      (user-scope +1, relation +2); scope-less results skip; raw access
      events carry scope/scopeRef/type (complete handle).
- [x] Compare phase — reopened all four official pages and compared every
      documented API use in the diff:
      - bulkWrite updateOne filters now contain every member of each
        collection's unique compound index (unique-index doc: a compound
        combination appears at most once -> exactly one row can match);
        events/episodes add agentId on top of their single-field unique
        index (defense in depth; "include agent identity in every update").
      - updateOne "first document that matches the filter" can no longer
        select a foreign row because the filter is now exact; "fails to
        match any documents -> no changes" is the explicit fail-safe path
        for under-specified identities (skipped, warned, raw event kept).
      - Time-series inserts: measurements are "time, metadata, and all
        metrics recorded at that moment" — the new optional top-level
        scope/scopeRef/type fields are metrics; the metaField structure
        ({agentId, collection}) is unchanged ("You cannot add a metaField
        field ... after you create it" — not attempted). Confirmed by the
        live round-trip assertion in the GREEN probe.
      - No new dependencies, options, or version-gated APIs.
      Corrections made during comparison: none required.
      Unresolved limitations: none for W01. getAccessSummaries/
      getAccessTrends still group by short memoryId (within-agent,
      same-key-cross-scope trend merging) — pre-existing, out of W01's
      tenant-corruption scope, noted for the retrieval wave.

## Disposition

W01: FIXED by this wave (live RED -> live GREEN). The structured-canonicalId
skip and the relation locator mismatch (RET-20's "relation id mapping"
aspect) are fixed by the same identity pipeline. W11's raw re-insert + $inc
retry overlap is NOT addressed here (separate finding, erasure/wave-1b
adjacent).
