# Wave 2c — workspace identity, tracker exactly-once, tenant stats, projection health, startup unwind (W06, W11, W13, W16, W17)

Date: 2026-09-06
Scope: third landing of the write-path wave (DDD v0.7.1). Five findings:
workspace-partition mismatch between write and search identity (W06, P1),
access-tracker retry duplication (W11, P2), shared stats tenancy leak (W13,
P2), projection-lag measuring inactivity (W16, P2), and startup leak after
connect (W17, P2). W06 lands first — it changes the identity objects that
the tracker and status surfaces consume; W11's guard and W13/W16's reads are
defined against the post-W06 identity shapes.

## Findings (docs/audits/2026-09-05-independent/logic_write.md)

- **W06 (P1)**: write-path scope resolution omits `workspaceDir`
  (`mongodb-manager-write.ts:322` single, batch path identical;
  `mongodb-idempotency-fingerprint.ts:97`; low-level `writeEvent` /
  `buildCanonicalEventDocument` `mongodb-events.ts:289`), so an explicit
  workspace scope without scopeRef (or `MEMONGO_DEFAULT_SCOPE=workspace`)
  resolves via the `mongodb-scope.ts:42` fallback to `workspace:<agentId>`.
  The manager already computes the true hashed workspace reference
  (`mongodb-manager.ts:560`, `workspace:<hash16(realpath)>`) and search
  reads use the actual workspace directory — writes and reads therefore land
  in different partitions and an unscoped add followed by workspace-default
  search does not round-trip. The idempotency fingerprint is computed over
  the same wrong scope, so replays and conflicts are also keyed to the
  wrong partition. Remedy per audit: "Resolve one complete identity at
  manager boundary and pass it, including fingerprint, to both paths."
- **W11 (P2)**: `doFlush` (`mongodb-access-tracker.ts:220`) inserts raw
  events first, then runs per-collection canonical `$inc` bulkWrites. On
  canonical failure it re-buffers only the failed collection's keys — but
  the raw events for ALL snapshot keys are already inserted, and unordered
  canonical ops for other collections may have partially applied. The next
  flush re-inserts every raw event (duplicate raw evidence) and re-runs
  every `$inc` (double increments). Audit evidence: two recorded accesses
  plus one summary-only failure produced three raw events in an executed
  production-code probe. The partial re-buffer is worse than a whole-buffer
  re-buffer: it desynchronizes raw/canonical alignment across collections.
  close() resolves after a re-buffered flush and does not guarantee drained
  data. Remedy per audit: "Separate raw-persistence and summary-projection
  retry state; use durable unique logical batch IDs and idempotent summary
  projection, accounting for time-series uniqueness constraints."
- **W13 (P2)**: `stats()` (`mongodb-manager-admin.ts:870`) calls
  `getMemoryStats` with no agent parameter and the function has no tenant
  filter at all (`mongodb-analytics.ts:55` — files/chunks aggregation over
  the whole shared collections); the sync count refresh likewise calls
  `countDocuments()` unfiltered (`mongodb-manager-sync.ts:251`). The
  per-agent surface returns deployment-wide volume and index activity, and
  the parent agent confirmed the aggregate is externally reachable through
  an agentId-only key on the HTTP stats route. Files/chunks rows carry
  `agentId` in the namespace, so the filter is available. Remedy per audit:
  "Pass full identity for tenant stats and keep physical index diagnostics
  on a distinct operator surface."
- **W16 (P2)**: `getProjectionLag` (`mongodb-ops.ts:199`) returns
  now − last-successful-projection-run time; `classifyProjectionHealth`
  (`mongodb-manager-admin.ts:216`) degrades any value above five minutes.
  A healthy idle agent therefore degrades, while a recent success conceals
  older stranded events — no pending-event watermark is compared anywhere.
  Additionally the production event-write path no longer records ingest
  runs while the removed legacy helper still does, so the canonicalIngest
  lane can remain uncertain despite successful public writes. Remedy per
  audit: "Report last activity separately; derive lag from oldest unmet
  source/projection obligation and track public write outcomes at actual
  boundary."
- **W17 (P2)**: in `create()` (`mongodb-manager.ts`) only the connect/ping
  phase has a catch that closes the client (`:620`). Everything after —
  ensureCollections, capability detection, dimension validation, strand
  refusal, search indexes + readiness waits, standard indexes, strict-mode
  checks, relevance runtime, manager construction, AccessTracker (which
  creates an interval timer), sync, repair, memory job worker, watcher,
  change streams — runs unprotected through `:934`. Any throw leaks the
  dedicated pool, the tracker timer, the worker, and watchers. Remedy per
  audit: "Explicit resource ownership cleanup around whole factory,
  releasing shared references through caller contract."

## Documentation basis

Grounded for Wave 2c (captured 2026-09-06, digests in `.ddd/evidence.lock`
EL-027..EL-031, full reliance analysis in `.ddd/cache/`):

- Time Series Indexes (EL-027,
  https://www.mongodb.com/docs/manual/core/timeseries/timeseries-index/):
  "Starting in version 6.0, you can add a secondary index to any field in a
  time series collection" — the `batchId` index on access_events is legal;
  unique indexes are on the prohibited list, so raw-event dedupe cannot be
  constraint-enforced.
- Time Series Limitations (EL-028,
  https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/):
  "You cannot write to time series collections in transactions"; no default
  `_id` index; no unique indexes. A flush spanning access_events plus the
  canonical collections therefore cannot be jointly atomic — each phase
  must be independently idempotent (the exact constraint the audit's
  "accounting for time-series uniqueness constraints" remedy points at).
  The update restrictions are out of scope: the tracker's access_events
  path is insert-only.
- `$ne` (EL-029, https://www.mongodb.com/docs/manual/reference/operator/query/ne/):
  "$ne selects documents where the value of the field is not equal to the
  specified value. This includes documents that do not contain the field";
  scalar `$ne` against an array matches where the scalar "is not present as
  an element in the array, including documents that don't have the field".
  This is the filter-side canonical guard: legacy documents and other-batch
  documents match, already-applied documents do not, and a no-match
  updateOne changes nothing.
- `$push` (EL-030, https://www.mongodb.com/docs/manual/reference/operator/update/push/):
  appends to an array, creating the field if absent; `$each`/`$slice`
  modifiers bound growth. The batchId append rides the SAME per-document
  atomic updateOne as the guarded `$inc`/`$set`.
- `$slice` (EL-031, https://www.mongodb.com/docs/manual/reference/operator/update/slice/):
  a negative value keeps "only the last `<num>` elements" — the
  appliedBatches window always retains the newest batch ids, so a
  re-buffered retry (same batchId) stays guarded for 32 further applied
  batches while the array stays permanently bounded.

Open questions: none. W06/W13/W16/W17 are code-threading fixes on contracts
already grounded in earlier waves (EL-012..EL-015 for canonical identity and
time-series measurement shape; EL-025 for bulkWrite first-match semantics).

## Fix design

### W06 — one complete identity at the manager boundary

1. `resolveScopeIdentity` already accepts `workspaceDir`; the manager host
   already exposes `this.host.workspaceDir`. Every write-path resolution
   site passes it: `writeConversationEvent`, `writeConversationEventsBatch`,
   and `computeIdempotencyFingerprint` (single + batch).
2. The resolved identity `{scope, scopeRef}` is computed ONCE per write at
   the manager boundary and the resolved `scopeRef` is passed down into
   `writeEvent`/`writeEventsBatch` so `buildCanonicalEventDocument` consumes
   the manager-resolved value instead of re-resolving without workspaceDir.
3. The fingerprint path passes `workspaceDir` so replay/conflict identity
   matches the write identity exactly (same partition for both).
4. Search/read paths already resolve with the workspace directory (root
   search auditor verified) — no read-side change; the round-trip test
   proves write/read agreement.

### W11 — batchId-guarded exactly-once flush

1. Each flush snapshot carries a `batchId` (randomUUID). Re-buffered
   entries preserve their original batchId; fresh entries get the flush's
   new one.
2. Raw layer (access_events, insert-only time series): every eventDoc
   carries `batchId` as a top-level measurement field (EL-015 measurement
   shape; metaField unchanged). Before inserting, the flush read-reconciles:
   if any access_events document already exists with this batchId, the raw
   insert is skipped entirely (unique indexes are prohibited on time-series
   collections, EL-027/EL-028 — read-reconcile is the only available
   exactly-once shape for the raw layer).
3. Canonical layer (six regular collections): each bulkWrite updateOne op
   carries `filter = { <compound canonical identity>, appliedBatches:
   { $ne: batchId } }` and `update = { $inc: {accessCount}, $set:
   {lastAccessedAt}, $push: { appliedBatches: { $each: [batchId],
   $slice: -32 } } }`. Per EL-029 the filter matches legacy docs (missing
   field) and excludes exactly the docs that already applied this batch;
   per EL-030/EL-031 the append is atomic with the increments and bounded.
   Ops are aggregated per canonical document identity within a flush so a
   batch never addresses one document twice.
4. Failure handling: on raw or canonical failure the WHOLE snapshot is
   re-buffered with batchIds preserved (replacing the partial
   failed-collection-only re-buffer). The retry then skips the raw insert
   (read-reconcile hit) and re-runs canonical ops, of which the
   already-applied ones no-match (EL-029) — exactly once at both layers for
   every in-process retry. Crash-mid-flush loses the in-memory buffer (no
   retry happens); a crash between raw insert and canonical apply leaves
   raw evidence without increments, which is reconcilable from the raw
   layer and strictly better than today's double increment.
5. New secondary index `{batchId: 1}` on access_events (EL-027: any field,
   ≥6.0) serves the read-reconcile; created with the same
   best-effort-logging pattern as the existing access_events indexes.
6. `AccessEventDocument` gains `batchId`; no canonical validator change —
   tracker-owned denormalized fields (accessCount, lastAccessedAt) are
   undeclared by house precedent, and time-series collections do not
   support schema validation at all (EL-028).
7. close() semantics: close flushes once and resolves; a failed flush
   during close is logged with the buffer dropped (unreachable data loss
   already logged today) — no change in contract, but the retry-during-
   close duplication is gone because retries are guarded.

### W13 — tenant-filtered stats and counts

1. `getMemoryStats` gains a required `agentId`; every files/chunks
   aggregation stage is prefixed with `$match: { agentId }`.
2. `stats()` passes `this.host.agentId`.
3. The sync count refresh counts `{ agentId }` on files and chunks, so
   `host.fileCount`/`host.chunkCount` describe the tenant, not the
   deployment.
4. Physical index diagnostics (server-wide by nature) stay unfiltered and
   are reported as-is — they are operational metadata, not tenant volume.

### W16 — backlog-derived lag, activity reported separately

1. `getProjectionLag` is redefined: the age of the OLDEST unmet projection
   obligation (per projection type), not now − last run. For the event
   lanes this is the oldest canonical event with `projectedAt` unset;
   per-type obligations follow each lane's own pending marker.
2. `classifyProjectionHealth` degrades on actual backlog, not inactivity;
   last successful run time remains in the status payload as a separate
   activity field.
3. The production event-write boundary records ingest runs (the same
   recordIngestRun helper the legacy path used), so the canonicalIngest
   lane reflects real write outcomes.

### W17 — full-factory unwind

1. Everything in `create()` after the connect/ping catch runs inside one
   try/catch that unwinds in reverse construction order: change-stream
   watcher, memory job worker, AccessTracker (timer), file watcher,
   relevance runtime, and the client — closing the client only when this
   factory owns it, releasing shared references through the existing
   caller contract otherwise.
2. The unwind itself is failure-tolerant (each cleanup guarded; first
   error wins for the rethrow, cleanup errors logged).
3. Unit tests inject a throw at each factory phase and assert every owned
   resource is closed exactly once.

## Validation plan

1. Unit (fake MongoDB): W06 write/read round-trip under workspace default +
   explicit workspace scope without scopeRef (write lands in
   `workspace:<hash>`, search finds it, fingerprint replays); W11
   raw/canonical equality invariants across partial-failure retries (fail
   one collection's bulk; assert raw count unchanged, each canonical count
   incremented exactly once, appliedBatches recorded, window bounded);
   W13 agent A stats with populated A+B collections (A-only numbers);
   W16 idle caught-up system stays healthy, old-backlog case degrades;
   W17 phase-injection tests close owned resources exactly once.
2. Live probe (memongo-preview): W06 round-trip on a real workspace hash;
   W11 flush with an injected canonical failure — raw events exactly once,
   canonical counts exactly once, batchId index present and used; W13
   two-agent stats separation; W16 status payload shows lag 0 when caught
   up and grows with a stranded event.
3. Full engine battery + `check-types` + Biome, all green, no skips.

## Status

- [x] Grounding complete (findings re-traced on the post-Wave-2b tree;
      EL-027..EL-031 captured and locked)
- [x] Fix design recorded
- [x] Implementation (23 files, engine commit df6cdb3151; includes the new
      mongodb-manager-factory-unwind.test.ts)
- [x] Verification battery (unit 2356/2356 pre- and post-format; e2e battery
      297 passed / 0 failed / 10 skipped of 307 against memongo-preview;
      check-types 15/15 with --force; Biome 0 errors on the touched files,
      HEAD-baseline-equal; live probe 32/32)
- [x] Final code-to-docs comparison (design sections above match the landed
      code; deviations noted in Disposition)
- [x] Ledger (claim C-046, validations V-158..V-161)

## Disposition

**W06, W11, W13, W16, W17: resolved.** Workspace identity is computed once
at the manager boundary: `resolveScopeIdentity` threads the host
`workspaceDir` through `writeConversationEvent`, the batch path, and
`computeIdempotencyFingerprint`, and the resolved `scopeRef` rides the
event object into `writeEvent` — explicit and workspace-default writes land
in `workspace:<hash16(realpath)>`, the fingerprint keys to the same
partition, and workspace-default search round-trips (W06). Tracker flushes
carry a per-snapshot `batchId` preserved across re-buffering: the raw
time-series layer read-reconciles by batchId before inserting (unique
indexes are prohibited there), the canonical layer guards every increment
with `appliedBatches {$ne: batchId}` and records the batchId via
`$push {$each, $slice: -32}` in the same atomic updateOne, and a failed
flush re-buffers the whole snapshot — exactly once at both layers across
retries, raw evidence never duplicated, window permanently bounded (W11).
Stats are tenant-scoped end to end: `getMemoryStats` takes a required
`agentId`, every files/chunks volume measurement filters by it, the sync
count refresh counts the tenant's rows, and physical index diagnostics
remain server-wide operator metadata (W13). Projection health derives lag
from the oldest unmet obligation per lane (`projectedAt` unset and
per-type pending markers), `projectionLastRun` reports last activity
separately, and the production write boundary records ingest runs (W16).
`create()` encloses every post-connect phase in one try/catch that unwinds
owned resources in reverse construction order — watcher, worker, tracker
timer, file watcher, relevance runtime, owned client — each cleanup
guarded, first error rethrown, shared references released through the
caller contract (W17).

Verification: full unit battery 2356/2356 twice — pre-format
(wave2c-unit-suite.log) and post-Biome-format on the final tree
(wave2c-unit-suite-postformat.log); e2e battery 297 passed / 0 failed /
10 skipped of 307 on memongo-preview (wave2c-engine-e2e-battery.log;
real-e2e-v2 81/81, tier-a 40/40; the standalone first mongodb-e2e run at
43/44 records the EXPECTED_STANDARD_INDEX_COUNT 102→103 fix iteration —
constant updated, suite green inside the battery); check-types 15/15 with
--force (wave2c-check-types.log); Biome 0 errors / 144 warnings / 3 infos
on the 23 touched files, equal to the HEAD baseline verified via a git
worktree (wave2c-biome-touched.log); live probe 32/32 (w2c-probe.log) —
W06 hashed-partition round-trip, fingerprint/replay/conflict identity, and
agent-scope isolation; W11 injected canonical failure with exactly-once at
both layers, the 32-id bounded window over 35 batches, and the batchId
index proven present and used (hinted explain); W13 two-tenant stats
separation on a shared deployment including a never-synced agent seeing
zero rows. W16's live evidence is the e2e battery (mongodb-e2e
stranded-obligation health semantics, real-e2e-v2 projectionLastRun
payload) rather than the probe — the health surface is async-driven and
the e2e suites already exercise it against the real server. Two probe
iterations are recorded honestly in V-161: the first replayed a different
payload (production correctly raised IdempotencyConflictError), the
second used a miswritten stats-lane expectation (a zero-data third-agent
diagnostic ruled out any real leak); no production change resulted from
either.

Residual documented (carried forward): tracker exactly-once is an
in-process retry contract — a crash mid-flush loses the in-memory buffer
(no retry happens), and a crash between raw insert and canonical apply
leaves raw evidence without increments, reconcilable from the raw layer
(analysis in the W11 design section); the raw read-reconcile is a
pre-check, not a constraint (time-series collections prohibit unique
indexes, EL-027/EL-028), so two concurrent flushes with the same batchId
cannot occur by construction (batchIds are per-snapshot UUIDs held only
in memory) but cross-process replay of a persisted batchId would rely on
the read-reconcile window. Stats tenancy filters by agentId on rows that
carry it; lanes that never carried agentId (server-wide index metadata)
are intentionally unfiltered operator diagnostics.

Next: Waves 3–7, the test-honesty pass, ledger closure, and re-audit.
