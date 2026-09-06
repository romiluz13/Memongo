# Wave 1b — W02/W03/W12: erasure retry, erasure race, quarantine crash window

Date: 2026-09-06
Scope: second wave of the independent-audit remediation (DDD v0.7.0).
Findings: W02 (P1 erasure retry false-complete), W03 (P1 erasure races
active work), W12 (P2 quarantine promotion crash window). Related ingress
hardening: relevance_artifacts gain their own agentId (W02 remedy's
"preferably").

## Findings (docs/audits/2026-09-05-independent/logic_write.md)

- **W02**: relevance_artifacts ownership is indirect through runId; parents
  and artifacts are deleted in the same parallel sweep, parents even when
  ownership discovery failed; no durable unresolved-runId list. Retry finds
  no parents, omits artifact deletion, reports complete with artifacts
  retained (audit reproduced: firstStatus partial, secondStatus complete,
  artifactExists true). Remedy: delete and verify dependent artifacts
  before deleting parent ownership records; retain failed ownership until
  retry succeeds; preferably give artifacts their own immutable agentId.
- **W03**: erasure delegates straight into parallel deletes with no
  admission fencing or drain; a running extraction worker retains the event
  in memory and continues projection writes after the deletes; receipt
  still says complete. Remedy: durable per-agent erasure/admission epoch
  checked by writers and workers, drain local work, then sweep and verify;
  define post-erasure write semantics.
- **W12**: promote flips pending-review -> promoted BEFORE the canonical
  write; catch-compensation only runs if the process survives; re-review
  rejects non-pending rows, so a crash between claim and write is
  unrecoverable (row says promoted, no memory exists, forever outside the
  pending TTL). A direct structured write routed to quarantine also loses
  its original type/key/value shape (promotion re-derives via
  matchPatterns and may fail or alter identity). Remedy: leased
  intermediate promoting status with durable candidate identity and
  recovery; persist the full candidate shape at quarantine ingress.

## Documentation basis

Technology: MongoDB Server 8.x (local stack 8.3.8 replica set), Node
driver v7 line, as in Wave 1a (EL-012..EL-015 already locked).

1. updateOne/upsert with uniquely-indexed filter —
   https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/
   (EL-013, cached): upsert on the epoch document filters on `_id` (unique
   by definition), so concurrent bumps cannot multi-insert.
2. deleteMany —
   https://www.mongodb.com/docs/manual/reference/method/db.collection.deleteMany/
   "Removes all documents that match the filter"; returns deletedCount.
   The sharded-collection warning recommends re-checking with a query
   until it returns no documents — the post-sweep verification pass
   implements that honesty pattern for this (non-sharded) deployment.
3. countDocuments —
   https://www.mongodb.com/docs/manual/reference/method/db.collection.countDocuments/
   "performs an aggregation ... returns an accurate count"; "returns 0 on
   an empty or non-existing collection" — the verify pass uses it per
   swept collection.
4. Partial indexes —
   https://www.mongodb.com/docs/manual/core/index-partial/
   partialFilterExpression accepts `$in` (and `$or`, `$and`, equality,
   `$exists`, ranges, `$type`) — the quarantine TTL partial filter widens
   from `{status: "pending-review"}` to
   `{status: {$in: ["pending-review", "promoting"]}}` so an abandoned
   promoting claim cannot outlive the TTL backstop. Same index name with
   different options is an IndexOptionsConflict, so the schema migration
   drops the old index first (the established dropIndex/createIndex
   pattern in the same file).
5. Time-series + unique-index contracts — EL-015/EL-012 (unchanged).

Snippets: all code below is proposed code (untested) until the Validation
section records run results.

Open questions: none. Post-erasure write semantics (W03 remedy's
"define"): NEW writes after an erasure legitimately recreate the tenant —
the epoch guard only abandons work claimed before the epoch bump; the
per-agent worker is stopped by the erasure drain and restarts on the next
legitimate write (the established memoryJobWorkerStopped restart pattern
in the write path).

## Fix design

### W02 — ordered artifact sweep + ownership retention (mongodb-erasure.ts)

1. Phase 1 (existing) collects the agent's relevance runIds. NEW: a run
   row without a usable string runId counts as unresolved ownership (the
   same retention rule as a phase-1 read failure).
2. Phase 1.5 (new, BEFORE the parallel sweep): delete relevance_artifacts
   matching `{$or: [{agentId}, {runId: {$in: runIds}}]}` — the agentId arm
   covers new artifacts (see ingress change), the runId arm covers legacy
   rows while their parents still exist.
3. Retention rule: if phase 1 failed, any run lacked a usable runId, or
   the phase-1.5 artifact delete failed, relevance_runs is EXCLUDED from
   this attempt's sweep and gets an error receipt ("retained for artifact
   retry"). The retry then re-resolves runIds from the retained parents,
   sweeps artifacts, and finally deletes the runs — the false-complete
   path is structurally gone.
4. relevance_artifacts docs gain `agentId` at write time
   (mongodb-relevance.ts persistRun) — the audit's "preferably": future
   artifacts are directly tenant-reachable even if their parent run row
   is already gone.

### W03 — epoch fence + local drain + verification

New module `mongodb-erasure-epoch.ts`:
- `getTenantErasureEpoch(db, prefix, agentId)`: reads the per-agent epoch
  document in the GLOBAL `meta` collection (survives erasure by design).
  Absent document = epoch 0.
- `bumpTenantErasureEpoch(db, prefix, agentId)`: findOneAndUpdate on
  `_id: tenant-erasure-epoch:<agentId>` with `{$inc: {epoch: 1}}`,
  upsert, returnDocument after — returns the new epoch.

`deleteAllForAgent` flow becomes: bump epoch (a failed bump yields a
partial receipt with `epochError` and NO deletes — an unfenced erasure
must not run) -> phase 1 -> phase 1.5 -> sweep (minus retained
relevance_runs) -> VERIFY (countDocuments per swept target; any residual
document becomes `verification.residual[]` and forces partial) -> audit
record (meta now carries epoch + residual summary) -> receipt (gains
`epoch`, `verification`, `epochError?`).

Manager-side drain (mongodb-manager-admin.ts deleteAllForAgent): stop the
per-agent memory-job worker (stopMemoryJobWorker awaits the in-flight
runner, so its writes land before the sweep and are erased), flush the
access tracker (buffered counts land pre-sweep), then run the erasure.
The worker restarts on the next legitimate post-erasure write.

Worker-side guard (mongodb-manager-jobs.ts): the extraction runner
captures the tenant epoch at claim and the existing per-stage leaseFence
additionally re-reads the epoch — an advanced epoch abandons the job
before the next side-effecting stage (covers cross-process workers whose
job row the sweep already deleted). The consolidation runner checks the
epoch once before starting (its writes are one consolidateMemory
sequence; the verification pass is the backstop for an in-flight
straddle). Residual, documented: a single stage already past its fence
can still straddle the sweep; the verify pass reports it as residual
(partial receipt) instead of a false complete.

### W12 — leased promoting status + candidate roundtrip

1. QuarantineStatus gains "promoting". promoteQuarantined claims
   pending-review -> promoting with `promoteClaimedAt` +
   `promoteLeaseExpiresAt` (2-minute constant), writes the memory, then
   finalizes promoting -> promoted (+memoryId). A write failure reverts
   promoting -> pending-review as today; a crash leaves promoting with an
   expired lease.
2. Recovery: promoteQuarantined accepts a promoting row whose lease has
   expired (re-claims with a fresh lease; writeStructuredMemory is an
   identity-keyed upsert, so re-promotion is idempotent); a promoting row
   with a live lease is refused ("promotion in progress"). A failed
   finalize leaves the row promoting (recoverable) and surfaces
   `finalizeError` on the receipt.
3. Ingress roundtrip (mongodb-structured-memory.ts): a structured write
   routed to quarantine persists the FULL StructuredMemoryEntry as
   `structuredCandidate` on the row; promotion rebuilds the exact
   original entry from it (type/key/value preserved verbatim) instead of
   re-deriving through matchPatterns. Consolidator-sourced rows (raw
   conversation text, no shape to preserve) keep the matchPatterns path.
4. TTL backstop (schema): the pending TTL partial filter widens to
   include "promoting" (officially supported `$in`), with drop-first
   migration of the existing index.

## Validation plan (native checks)

- mongodb-tenant-erasure.test.ts (stateful fake = the database, fault
  injection): happy path (unchanged semantics + epoch + verification
  fields); W02 audit reproduction — artifact delete failure -> partial
  with relevance_runs RETAINED -> retry (failure cleared) sweeps
  artifacts then runs -> complete, artifacts gone at every step; phase-1
  read failure -> retention (updated expectation vs the old test);
  failed-delete residual confirmed by the verification pass; epoch bump
  recorded in meta + receipt; epoch-bump failure -> no deletes, partial
  with epochError.
- mongodb-quarantine-review.test.ts: claim -> promoting -> finalize
  ordering; write-failure revert; crash window (promoting + expired lease
  -> re-promotable, idempotent upsert); live lease refusal; candidate
  roundtrip (original type/key/value promoted verbatim, no
  matchPatterns reinterpretation); legacy row (no candidate) still
  promotes via matchPatterns.
- Epoch module unit tests (get/bump semantics on the stateful fake).
- Worker guard: epoch-module tests + live probe.
- Live probe (memongo-preview, disposable database): W02 two-attempt
  scenario against the REAL server with a real delete failure injected
  via a wrapper collection handle (deleteMany throws once for
  relevance_artifacts); assert first receipt partial with runs retained,
  second receipt complete, artifacts gone; W03: epoch doc present and
  incremented, verification field empty on the happy path; W12: promote
  happy path + simulated crash (row manually left promoting with expired
  lease) recovered by re-promotion.
- `bun run check-types` repo-wide; full memory-engine suite; Biome on
  touched files.

## Status

- [x] Grounding complete (3 new official docs, EL-016..EL-018, plus
      EL-012..EL-015 from Wave 1a).
- [x] Implementation — files: mongodb-erasure-epoch.ts (new primitive),
      mongodb-erasure.ts (ordered artifact sweep + retention + epoch fence +
      verification + receipt fields), mongodb-manager-admin.ts (drain:
      stop worker, flush tracker, then sweep), mongodb-manager-jobs.ts
      (extraction per-stage epoch fence + consolidation claim-site fence,
      both best-effort with lease fence + verification as the owner guard /
      truth gate), mongodb-quarantine-review.ts (leased promoting claim +
      finalize + expired-lease recovery + verbatim candidate roundtrip +
      reject-recovery), mongodb-structured-memory.ts (structuredCandidate
      persisted at quarantine ingress, refreshed on dedup reuse),
      mongodb-relevance.ts (artifacts carry agentId),
      mongodb-schema-standard-indexes-operations.ts ($in partial TTL with
      drop-first migration), internal-barrel.ts (exports), tests (erasure,
      quarantine, schema, jobs epoch-abandon).
- [x] Unit + type checks — focused battery over every changed source
      file's suite: 102/102 (.ddd/reports/runs/wave1b-unit-suite.log).
      Full engine battery on the final source tree: 2591 passed / 1
      environment-caused failure (see below). Repo check-types 15/15.
      Biome error-free on all twelve touched files (one new-code style
      warning fixed; the rest verified pre-existing at HEAD).
- [x] ENVIRONMENT INCIDENT (recorded per the amended DDD protocol, v0.7.1):
      the shared local preview container's mongod wedged under repeated
      full-battery connection load — even in-container mongosh got
      ECONNRESET; server logs showed backpressure + 100ms handshake
      slow-queries; RAM 40% (not OOM). Diagnosed via the substrate's own
      documented observability (docker logs/stats/health,
      serverStatus().connections), remediated (container restart), re-ran:
      the one failing check ($vectorSearch autoEmbed warm-up) passed 96/96
      on re-run. Environment-caused failure kept separate from code
      results. Run discipline adopted: focused suites during iteration,
      one full battery per wave. Target stays local Docker; the switch
      criterion (wedge again under disciplined load) is agreed with the
      user; Atlas requires a provided URI (none is configured).
- [x] Live probe — .ddd/reports/runs/w1b-probe.log: 29/29 assertions on
      the real server (W02 two-attempt with real injected-once delete
      failure: partial-with-retention then complete-with-artifacts-gone;
      W03 epochs 1..5 + residual verification; W12 crash recovery + exact
      candidate roundtrip). The $in partial TTL filter live-verified by
      creating the index shape on a disposable database.
- [x] Compare phase — reopened the three new official pages (fetched this
      session, compared against the actual section text): deleteMany
      removes-all-matches + the manual's own re-check guidance == the
      verification pass; countDocuments accurate + 0-on-missing == the
      residual check semantics; partialFilterExpression $in == the widened
      TTL filter (server-accepted); updateOne/upsert on the uniquely-keyed
      epoch document == no multi-insert (empirically monotonic 1..5);
      time-series meta.agentId deletes unchanged from C-003 and
      live-exercised by the probe's full sweeps. Corrections during
      comparison: the consolidation guard's initial two-read design was
      replaced with a claim-site baseline (the design review found two
      same-instant reads prove nothing); the epoch reads were made
      best-effort fail-open after the native checks showed mock
      environments without a meta collection — the lease fence remains the
      owner guard and the verification pass the truth gate, so fail-open
      cannot produce a false-complete receipt.
      Residual limitations, documented: a single stage already past its
      fence can still straddle the sweep (reported as verification
      residual -> partial, never a false complete); legacy artifacts whose
      parents were deleted by a PRE-fix partial erasure remain
      unreachable (no agentId, no parents) — the retention rule prevents
      new occurrences; multi-instance full drain barriers are out of this
      wave's scope (the epoch + verification bound them honestly).

## Disposition

W02: FIXED (live two-attempt probe; the audit's reproduced
firstStatus-partial / secondStatus-complete / artifactExists-true shape is
structurally impossible — parents are retained until children are swept).
W03: FIXED to the remedy's scope (durable epoch checked by workers, local
drain, sweep, verify; post-erasure new writes intentionally recreate the
tenant). W12: FIXED (leased intermediate state, crash recovery, verbatim
candidate roundtrip, TTL backstop). Related hardening: relevance_artifacts
gain their own agentId (W02 remedy's "preferably").
