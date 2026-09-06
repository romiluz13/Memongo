# Wave 2 — write durability (W06–W11, W13–W17)

Date: 2026-09-06
Scope: fourth wave of the independent-audit remediation (DDD v0.7.1). The
audit's write-durability area: 11 findings. Per the master wave mapping this
area is one wave, but following the Wave-1 precedent it is landed in coherent
sub-waves, each grounded, validated, and committed on its own:

- **Wave 2a (this landing): W08, W09, W10** — the event-write durability
  core. W08 residual (P1): thrown post-commit errors still reject an
  already-durable write. W09 (P1): insertMany/batch retries and
  writeConcernErrors are not reconciled against what the server actually
  applied. W10 (P2): the idempotency-key retention sweep ages by event
  `timestamp` instead of acceptance time `recordedAt`.
- **Wave 2b (next): W07, W14, W15** — ingest/sync durability. Long-line
  chunk identities, source-read failure treated as deletion, and the
  "atomic" file replacement that commits deletion before replacement.
- **Wave 2c (remainder): W06, W11, W13, W16, W17** — workspace identity
  round-trip, access-tracker exactly-once, stats tenancy, projection-lag
  semantics, startup resource unwinding.

## Findings (docs/audits/2026-09-05-independent/logic_write.md)

- **W08 residual**: `released === false` was converted to an acknowledged
  write with an outbox marker (P0.1), but every *thrown* post-commit error
  still propagates to the caller: `projectEventChunk`, `releaseStagedMemoryJob`,
  batch `markEventsProjected` after retries, and non-bulk
  `createMemoryJobsBatch` insert errors. The event is durable on the server,
  the caller is told it failed, and a keyless retry duplicates it.
- **W09**: `insertMany` (unordered) is wrapped in a generic transient retry;
  a retry that hits E11000 from the first attempt's success is read as item
  failure. `asBulkWriteFailure` requires only a `writeErrors` array;
  `markInserted` treats every document absent from `writeErrors` as durable,
  and `writeConcernErrors` is never inspected — a majority-ack failure can
  clear recovery markers while a lost acknowledgment (data written, error
  returned) can evict durable events from projection. Same pattern in
  `createMemoryJobsBatch`.
- **W10**: the idempotency retention sweep prunes on event `timestamp`, so a
  fresh import of historical events loses its replay protection immediately
  and future-dated events extend retention unboundedly. `recordedAt` (the
  insertion instant) exists on the document but is unused by the sweep.

## Documentation basis

Grounded for Wave 2a (all captured 2026-09-06, digests in
`.ddd/evidence.lock` EL-020..EL-023):

- insertMany (EL-020,
  https://www.mongodb.com/docs/manual/reference/method/db.collection.insertMany/):
  unordered inserts continue past per-item errors; writeErrors and
  writeConcernErrors are separate report fields; the thrown
  MongoBulkWriteError carries the partial result (insertedIds keyed by
  original array index) plus per-error index/code.
- Retryable Writes (EL-021,
  https://www.mongodb.com/docs/manual/core/retryable-writes/): insertMany
  is driver-retried once; an error without the NoWritesPerformed label
  means partial-or-full work persisted; with the label (6.1+) zero writes
  were performed by the attempts.
- Write Concern (EL-022,
  https://www.mongodb.com/docs/manual/reference/write-concern/): a
  writeConcernError (e.g. wtimeout) is an uncertain outcome — MongoDB does
  NOT undo successful modifications; data may replicate or roll back.
- Driver 7.5.0 shipped types (EL-023, node_modules/mongodb/mongodb.d.ts):
  MongoBulkWriteError.result carries the partial BulkWriteResult even on
  throw; writeErrors are per-item with .index/.code;
  hasErrorLabel("NoWritesPerformed") is the zero-writes guarantee;
  .err/getWriteConcernError() expose the write-concern signal.

Previously locked: EL-013 (unique compound indexes), EL-019 (updateMany
idempotency), EL-017 (deleteMany re-check).

## Fix design

### W08 — post-commit failures become diagnostics, never rejections

The durable acknowledgment boundary is the canonical-event commit itself
(single: event + staged job transaction / direct writes; batch: the events
insertMany). Everything after it degrades:

1. `projectEventChunk` / `projectEventChunksBatch` (mongodb-events.ts):
   the chunk upsert already degrades in the batch variant; both variants'
   `markEventsProjected` retry-exhausted throw is now caught — chunks that
   exist stay, projectedAt stays unset, the projection repair pass
   re-projects (chunk upserts are idempotent by `path`). Neither function
   throws after this change; both record a `failed` projection run when
   degraded so health telemetry stays honest.
2. Single write path (mongodb-manager-write.ts): `releaseStagedMemoryJob`
   throws now take the P0.1 route already used for `released === false` —
   extractionJobPendingAt stays set for `repairExtractionOutbox`, the write
   is acknowledged, a warning is logged.
3. `createMemoryJobsBatch` (mongodb-memory-jobs.ts): non-per-item errors
   no longer throw into a persisted batch; every item gets a receipt
   (see W09), and the caller's existing per-item warn + marker-retention
   path handles not-ok items.

### W09 — outcomes reconciled against what the server actually applied

A shared classifier (`classifyBulkInsertError`, structural per EL-023)
replaces the writeErrors-array-only `asBulkWriteFailure` in both
`writeEventsBatch` and `createMemoryJobsBatch`:

- **writeErrors present** → per-item receipts: E11000 = duplicateKey (the
  item is durable — a prior copy holds the unique slot), other codes =
  failed. Items not listed are confirmed inserts UNLESS a writeConcernError
  rides along, in which case unlisted items are uncertain and go to
  read-reconciliation.
- **NoWritesPerformed label** (the server guarantees zero writes) → every
  item {ok:false, duplicateKey:false, "no writes performed"} — the caller
  can re-run the batch with no duplicate risk.
- **writeConcernError without writeErrors / network error exhausted** →
  uncertain outcome: reconcile by READ — `find({eventId: {$in: ...}})` (or
  jobId for jobs). Present = durable (receipt ok, duplicateKey flagged for
  the replay mapping); absent = not durable (ok:false, retry-safe). If the
  reconciliation read itself fails, receipts say "durability unconfirmed"
  instead of throwing — a throw after a durable commit is the W08
  anti-pattern, and receipts preserve the batch's siblings.
- Caller side (mongodb-manager-write.ts): a keyless duplicateKey receipt is
  now a durable-exists outcome — receipt {ok:true, replayed:true,
  chunkCreated:false}; the event's own outbox marker from the prior attempt
  drives projection. Keyed items keep the Stripe-style winner replay.

### W10 — retention ages by acceptance time

`pruneIdempotencyFingerprints` prunes on the immutable acceptance instant
`recordedAt` (always written by `buildCanonicalEventDocument`), with an
explicit legacy fallback for pre-recordedAt rows: `$or: [{recordedAt:
{$lt: cutoff}}, {recordedAt: {$exists: false}, timestamp: {$lt: cutoff}}]`.
A fresh import of historical events keeps its replay protection for the
full window; future-dated events can no longer extend retention.

## Validation plan (native checks)

1. Focused unit battery over every Wave 2a-changed suite (events,
   memory-jobs, manager-write, manager-write-state) — the three-way
   classifier branches, read-reconciliation shapes, W08 degradation
   paths, and the W10 prune filter, plus the rewritten P0.1 regression.
2. Live probe on memongo-preview (27019) with production functions and
   the production unique indexes on a disposable scratch database:
   keyed/keyless E11000 receipts, unordered sibling survival, a REAL
   server write-concern error (unsatisfiable w + wtimeout) → uncertain
   classification with the doc present on read-back, duplicate jobId
   receipts, and the W10 retention matrix.
3. Full memory-engine battery on the final tree (environment incidents
   classified separately per the amended v0.7.1 protocol).
4. Repo check-types with `--force` (no turbo cache) + Biome on every
   touched file with pre-existing warnings verified against HEAD.

## Status

- [x] Grounding: W09 official pages captured + driver error shapes extracted
- [x] Fix design written
- [x] Implementation complete (W08 / W09 / W10)
- [x] Focused unit suites green (116/116, V-150)
- [x] Live probe on memongo-preview (27019) (26/26, V-153)
- [x] Full engine battery + repo check-types (V-151 / V-152)
- [x] Claim + validations filed (C-044, V-150..V-153)
- [x] Disposition + landing

## Disposition

**W08, W09, W10: resolved.** The durable acknowledgment boundary is the
canonical-event commit; every post-commit failure degrades to a
diagnostic with its repair marker retained (projection/extraction
repair passes re-derive from the events collection). Insert outcomes
are classified structurally per the driver's own report fields and
reconciled by read when uncertain; retention ages by acceptance time.

Verification: focused battery 116/116 (wave2a-unit-suite.log), live
probe 26/26 (w2a-probe.log), engine battery 144/148 files and
2615/2625 tests with 0 code failures (wave2a-engine-suite.log;
the earlier rerank latency flake classified environment per protocol —
solo re-run green — and did not recur), check-types 15/15 with --force
(wave2a-check-types.log). Claim C-044, validations V-150..V-153.

Residual documented (carried forward):

- Read-reconciliation confirms presence at read time. If an
  uncertain-outcome write later disappears in a replica-set rollback,
  receipts are not retracted; this is bounded by the durable-path write
  concern and the repair passes, and is inherent to EL-022's
  uncertain semantics rather than a classification defect.
- A `writeConcernError` riding `writeErrors` marks unlisted items
  read-reconciled rather than confirmed; a reconciliation-read failure
  yields "durability unconfirmed" receipts — deliberately weaker than
  a throw (the W08 anti-pattern) and surfaced to the caller's existing
  per-item warn path.
- The keyed E11000 winner-replay keeps Stripe-style semantics (caller
  replays the winner's receipt); only the keyless eventId collision is
  the read-confirmed durable-exists path.
- Biome: 2 warnings on touched files (unused `Db` import,
  useOptionalChain in mongodb-manager-write.ts) verified pre-existing
  at HEAD and left in place (V-152).

Next: Wave 2b (W07, W14, W15 ingest/sync durability), then Wave 2c
(W06, W11, W13, W16, W17).
