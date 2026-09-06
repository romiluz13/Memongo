# Wave 1c — W05/W18/W19: ownership and lease-fencing residuals

Date: 2026-09-06
Scope: third wave of the independent-audit remediation (DDD v0.7.1). Findings:
W05 (P1 worker reclaims live explicit-consolidation tracking rows and loses
their options; S13's residual is the same construct), W18 (P2 prefetch can
exhaust leases before heartbeats begin; expired-running reclaim is
unbounded), W19 (P2 the lease fence is a periodic observation, not a fresh
ownership check).

## Findings (docs/audits/2026-09-05-independent/logic_write.md)

- **W05**: explicit consolidate inserts a `status:"running"` row with no
  lease; the claim filter treats running+missing leaseExpiresAt as
  abandoned, so the standing worker steals the LIVE tracking row and
  re-runs consolidation with default options (workspace/session scope
  replayed as agent scope); the original runner's unfenced updateMemoryJob
  can then overwrite the stolen row. Remedy: separate nonclaimable tracking
  rows from queued jobs, or route explicit work through the leased payload
  protocol preserving all options.
- **W18**: jobs are leased before prefetchExtractionSessionFacts; the
  heartbeat starts only inside the runner, so a prefetch >= leaseMs burns
  the lease, the post-prefetch renewal fails, and the job repeats the
  pay-prefetch/lose-ownership loop forever — the claim filter's running
  arms have no attempts bound. Remedy: heartbeat from claim until
  completion, and explicitly bound crash/lease-expiry retry loops.
- **W19**: leaseFence awaits the last in-flight heartbeat and reads a
  boolean; it performs no fresh ownership check, so a worker whose lease
  was stolen between heartbeats can still pass the fence and mutate
  projections. Remedy: write-side epoch fencing or transactional guards at
  mutation stages, and cancellation checks inside long stages.

## Documentation basis

Technology: unchanged from Waves 1a/1b (MongoDB 8.x local stack, Node
driver v7 line; EL-012..EL-018 already locked). One new official page:

1. updateMany —
   https://www.mongodb.com/docs/manual/reference/method/db.collection.updateMany/
   "Updates all documents that match the specified filter";
   "updateMany() modifies each document individually. Each document write
   is an atomic operation, but updateMany() as a whole is not atomic";
   "updateMany() should only be used for idempotent operations." The
   dead-letter sweep is idempotent by construction (matched rows leave the
   `running` state, so a re-run matches nothing) and per-document
   deterministic, which is exactly the operation shape the page prescribes.
2. Conditional updateOne renewals (the fence's fresh ownership proof) and
   findOneAndUpdate CAS claims — EL-013/EL-014 semantics, unchanged.
3. The repo's own lease architecture (server-time $$NOW stamps, lease
   tokens) is pre-existing grounded surface; this wave changes filters and
   call timing, not the lease primitives.

Snippets: all code below is proposed code (untested) until the Validation
section records run results.

Open questions: none.

## Fix design

### W05 — nonclaimable tracking rows + options-preserving retries

1. The explicit-consolidate tracking row (mongodb-manager-lifecycle.ts)
   gains `tracking: true` — it records a synchronous run; it is not queued
   work.
2. The claim filter's two RUNNING arms (lease-expired and lease-missing)
   gain `tracking: { $ne: true }` — a live explicit run can no longer be
   stolen. Legacy pre-lease rows (no tracking field) stay reclaimable.
3. runClaimedConsolidationJob reconstructs the caller's options from
   `job.metadata` (validated field-by-field: maxEvents, minCombinedScore,
   resolveContradictions, llmDedup, scope, scopeRef) and passes them to
   consolidateMemory, and invalidates the query cache for the STORED
   scope/scopeRef instead of hardcoded agent scope. A FAILED explicit run
   (already worker-retryable via the failed arm) is therefore retried with
   its original options — the audit's "loses their options" defect closes
   for both the steal and the retry path.

### W18 — heartbeat from claim + bounded expiry loops

4. The drain loop starts a prefetch heartbeat (an interval renewing every
   claimed job's lease at MEMORY_JOB_HEARTBEAT_MS) immediately after the
   claim batch, cleared after the post-prefetch stillOwned revalidation —
   ownership now spans claim -> prefetch -> runner heartbeat without a
   gap.
5. Both RUNNING claim arms gain `attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS }`
   — the pay-prefetch/lose-lease loop is bounded by the same attempt
   budget that bounds failed retries.
6. A dead-letter sweep (`deadLetterExpiredMemoryJobs`, updateMany) runs
   once per drain round: running rows whose lease expired (or is missing)
   with attempts >= MAX transition to failed + deadLetterAt (no
   completedAt, lease fields unset) — mirroring finishClaimedMemoryJob's
   dead-letter shape — so a bounded-out job is VISIBLE as a dead letter in
   the status counts instead of zombie-looping or silently stalling.

### W19 — fresh ownership proof at every fence

7. leaseFence forces an immediate server-side renewal (`await heartbeat()`
   — the conditional updateOne matching jobId+agentId+leaseOwner+
   leaseToken+unexpired lease) before reading leaseLost, alongside the
   W03 epoch check: each side-effecting stage is now preceded by a
   FRESH ownership proof, not a possibly-stale boolean from the last
   periodic beat. Residual, documented: the proof is still check-then-
   write within a stage; per-write lease-token predicates inside the
   graph/structured helpers remain out of this wave's scope (the audit's
   "transactional guard" alternative) — stage-boundary proofs plus the
   Wave 1b erasure-epoch fence and event-receipt idempotency bound the
   residual, and the comparison section must state that separation
   explicitly (the audit asks that idempotency and lease exclusivity be
   described separately).

## Validation plan (native checks)

- mongodb-memory-jobs tests: claim filter — tracking row NOT claimable
  while live; legacy running row still reclaimable; running reclaim
  attempts-bounded; dead-letter sweep transitions expired-at-max rows
  (and only those); failed-explicit retry carries options.
- mongodb-manager-jobs tests: prefetch heartbeat keeps leases alive across
  a prefetch longer than the lease (fake timers); consolidation runner
  passes metadata options + invalidates the stored scope; leaseFence
  performs a fresh renewal per stage (renew call count at fences).
- mongodb-manager-lifecycle test: explicit consolidate writes tracking:
  true.
- Full battery once, repo check-types, Biome on touched files; live probe
  (drain with a real tracking row + a real expired-at-max row + prefetch
  exceeding the lease).

## Status

- [x] Grounding complete (updateMany page fetched this session and locked
      as EL-019, plus EL-012..EL-018 from Waves 1a/1b).
- [x] Implementation — files: mongodb-manager-lifecycle.ts (tracking:
      true on the explicit consolidate row), mongodb-memory-jobs.ts (both
      RUNNING claim arms gain tracking: { $ne: true } and attempts: { $lt
      MEMORY_JOB_MAX_ATTEMPTS }; new deadLetterExpiredMemoryJobs
      updateMany sweep), mongodb-manager-jobs.ts (prefetch heartbeat
      started at the claim batch and cleared after the post-prefetch
      stillOwned revalidation; runner replays the caller's stored options
      field-by-field and invalidates the STORED scope's query cache;
      leaseFence forces an immediate conditional renewal before reading
      leaseLost, alongside the epoch check), types.ts (tracking +
      deadLetterAt fields), test-helpers/manager-test-kit.ts (job
      fixtures), tests (memory-jobs claim/dead-letter, manager-jobs
      heartbeat/replay/fence/tracking, part2/part3 expectation updates).
      One formatting-only rewrap in mongodb-conversation-recall.ts
      (semantics unchanged).
- [x] Unit + type checks — focused battery over every changed suite:
      55/55 (.ddd/reports/runs/wave1c-unit-suite.log). Full engine
      battery on the final tree: 2597 passed / 1 environment-caused
      failure (see below) / 10 skipped of 2608 across 148 files
      (.ddd/reports/runs/wave1c-engine-suite.log). Repo check-types
      15/15 with --force, 0 cached
      (.ddd/reports/runs/wave1c-check-types.log). Biome error-free on
      all ten touched files; the 9 remaining warnings (3 unused imports
      in mongodb-manager-jobs.ts, 6 noNonNullAssertion in
      mongodb-manager-lifecycle.ts) verified pre-existing at HEAD by
      symbol-usage comparison — the flagged lines are untouched by this
      wave.
- [x] ENVIRONMENT INCIDENTS (recorded per the amended DDD protocol,
      v0.7.1). (a) Docker daemon down at wave start, then a host
      OOM-kill of the preview container mid-wave; the recreate exposed a
      volume-lineage defect: the atlas-local image derives the
      replica-set name and member host from the container hostname, and
      Docker assigns a random ID when it is not pinned, so the persisted
      volume's stored replica-set config no longer matched the recreated
      member and mongod never elected a primary (surfaced as the stack
      answering on the wrong port: the engine's probe found 27018 where
      the pinned stack expects 27019). Root cause fixed, not worked
      around: docker/docker-compose.yml pins hostname: memongo-preview
      so container name, hostname, volume lineage, and port expectations
      always agree across recreations. (b) Full-battery Voyage transient:
      the live rerank call for real-e2e-v2 Phase 15 threw mid-battery
      under 148-file parallel load (catch-path warn "rerank failed,
      falling back to input order" at 11:39:19 local; the reranker
      degraded to input order exactly per its WS-12/C-019 design,
      returning reranked: false). That phase is untouched by this wave
      (empty diff on mongodb-reranker.ts and the test file) and an
      isolated re-run of the same phase against the same live provider
      passed 2/2 including the previously-failing assertion
      (.ddd/reports/runs/w1c-rerank-rerun.log) — a provider-load
      transient, not code. Environment-caused failures kept separate
      from code results. Run discipline held: focused suites during
      iteration, one full battery per wave.
- [x] Live probe — .ddd/reports/runs/w1c-probe.log: 25/25 assertions on
      the real server (memongo-preview, port 27019, disposable scratch
      database dropped in finally): a live tracking row is NOT claimable
      while a legacy pre-lease running row IS reclaimed and a
      dead-lettered tracking row stays unclaimable (W05); a
      spent-budget running row is NOT claimable and the sweep
      transitions it to failed + deadLetterAt with lease fields unset,
      an idempotent re-run modifies 0, and live tracking rows are
      excluded from the sweep (W18); renewal is refused on a wrong lease
      token and on an expired lease, accepted only for the valid token
      (W19 fresh-ownership proof).
- [x] Compare phase — reopened the updateMany page (fetched this
      session) against the shipped sweep: "modifies each document
      individually ... updateMany() as a whole is not atomic" == the
      sweep's per-row transition (each matched running row becomes
      failed independently; no cross-row atomicity is assumed or needed);
      "should only be used for idempotent operations" and the manual's
      own "rerun until no additional documents match" == the sweep's
      re-runnable filter — matched rows leave running, so a re-run
      matches 0 (live-verified in the probe); matchedCount/modifiedCount
      returns == the sweep's returned count feeding the drain round.
      Conditional updateOne renewals (the fence's fresh ownership proof)
      and the findOneAndUpdate CAS claim re-compared against EL-013 /
      EL-014 semantics, unchanged from prior waves. The audit's
      requirement that idempotency and lease exclusivity be described
      separately: the dead-letter sweep is the IDEMPOTENT primitive
      (re-runnable, converging, count-reported), the conditional lease
      renewal is the EXCLUSIVITY primitive (matches job + agent + owner
      + token + unexpired lease) — deliberately different constructs in
      the code. Corrections during comparison: none — the shipped
      filter/sweep matched the page text on first comparison.
      Residual, documented (carried from the design): the fresh-ownership
      proof is still check-then-write within a stage; per-write
      lease-token predicates inside the graph/structured mutation
      helpers remain out of this wave's scope — stage-boundary proofs
      plus the Wave 1b erasure-epoch fence and event-receipt idempotency
      bound the residual.

## Disposition

W05: FIXED (tracking discriminator keeps live explicit runs unclaimable —
live-verified on the real server; worker-side retries replay the
caller's stored options field-by-field with stored-scope cache
invalidation — unit-verified; S13's residual is the same construct and
closes with it).
W18: FIXED (heartbeat spans claim -> prefetch -> runner without a gap —
fake-timer unit over a prefetch longer than the lease; RUNNING reclaims
attempts-bounded; expired-at-ceiling rows dead-letter visibly via the
idempotent updateMany sweep — live-verified including the 0-modified
re-run).
W19: FIXED to the remedy's stage-boundary scope (leaseFence performs a
fresh conditional renewal at every side-effecting stage, abandoned on a
refused renewal even when the periodic boolean is stale-true — unit
reproduces the stolen-lease/no-beat case; per-write lease-token
predicates inside mutation helpers documented as out of scope, bounded
by stage proofs + the Wave 1b epoch fence + event-receipt idempotency).
