# WS-13 ground decisions (implementation session, pre-verification)

Date: 2026-09-05
Session context: implementation of WS-13 (memory lifecycle: C-020, C-021,
C-022, C-023) resumed after a context compaction. The book already holds
plan-stage traces for WS-13 (TR-093..TR-099, validation_id: null). This
record captures the design decisions made during implementation so the
book stays the source of record between plan stage and landing. Run logs
and validation entries are recorded at land time per the standard loop.

## C-020 — consolidation scheduling for API-only deployments

- Drain loop (`mongodb-manager-jobs.ts`) now claims consolidation jobs in
  addition to extraction jobs, and stages an auto-consolidation job after
  the prune step each drain tick.
- `stageAutoConsolidationJob()`: window-keyed deterministic jobId
  (`consolidation-auto:<agentId>:<windowStart-ISO>`), insert with E11000
  tolerance so concurrent drains dedupe to one job per window.
- `resolveAutoConsolidationMs()`: env `MEMONGO_AUTO_CONSOLIDATION_MS`,
  default 21600000 (6h), 0 disables staging. Default chosen so decay,
  dedupe, and contradiction resolution run at least 4x/day without
  doubling job volume for the common single-agent deployment.
- Extraction loop changed `return` → `break` so the drain continues to the
  consolidation claim block after extraction capacity is exhausted.
- `runClaimedConsolidationJob()`: reuse of the existing lease/heartbeat
  fencing (same claim path as extraction; no second fencing mechanism),
  calls `consolidateMemory()` then `invalidateQueryCache()` so stale
  consolidated state is not served from cache; completes with metadata
  (factsPruned, conflictsResolved) for auditability.

## C-021 — loud and durable dead letters

- `MEMORY_JOB_MAX_ATTEMPTS = 3` unchanged; the terminal branch in
  `finishClaimedMemoryJob` now marks dead letters with `deadLetterAt`
  (date) and `$unset`s `completedAt` — TTL indexes key on `completedAt`,
  so a dead letter (which never carries it) is structurally outside the
  terminal-job TTL. No TTL-index change needed; the exemption is implicit
  and documented in `mongodb-schema-standard-indexes-operations.ts`.
- Telemetry operation `memory-job-dead-letter` added; fired at the
  dead-letter transition.
- `retryFailedMemoryJob` `$unset`s `deadLetterAt` so a retry re-arms the
  TTL interaction correctly.
- V2 status (`mongodb-manager-admin.ts`) now reports memoryJobs counts:
  pending, running, failed, deadLettered — all via allSettled so status
  stays available when the jobs collection is missing.

## C-022 / C-023 — episodes lifecycle

- EPISODES_SCHEMA validator fixed: the schema previously validated a
  phantom `eventIds` field that the writer never writes; replaced with
  the actual fields (`sourceEventIds`, `sourceEventsHash`,
  short/medium/longTermSummary, `topics`, `createdAt`). A validator that
  requires a phantom field fails every insert once validators are
  enforced; this was a latent production-breaker.
- Episodes TTL: `episodesRetentionDays` option (config key
  `episodesRetentionDays`, env `MEMONGO_EPISODES_RETENTION_DAYS`), TTL on
  `updatedAt`, default 0 = disabled with ghost-index drop, mirroring the
  files-retention pattern. Default off because episodes are the
  provenance substrate for consolidation; retention is a deployment
  decision, not an engine default.
- Per-scope cap: `MEMONGO_EPISODES_MAX_PER_SCOPE` (default 200);
  `enforceEpisodesScopeCap()` prunes oldest episodes beyond the cap after
  an upsert (only on upsertedCount === 1, so replays are idempotent).

## Disposition — legacy write path (`writeEventAndProject`)

- Production-dead (no production callers), but used as the e2e harness
  primitive (18 call sites in `real-e2e-v2.e2e.test.ts`). Plan: move to
  test helpers as part of the WS-13 legacy-write-path removal change so
  the e2e suite keeps its primitive while the production surface drops
  the dead code.

## Tooling status (honest note)

- The `ddd` CLI writers referenced by prior landing notes (validation
  writer pinning --construct verbatim) are NOT on PATH in this session
  (`which ddd` empty). Per the skill router rule, this is reported rather
  than simulated: validation entries at land time will be hand-recorded
  in the established V-xxx schema (reports/validations.yaml) with
  evidence hashes over captured run logs, mirroring the existing format.

## State at time of writing

- Changes 1-3 (above) applied to the working tree; not yet type-checked
  or tested at the moment of this record. Change 4 (batch backstop
  test), change 5 (legacy write path removal), change 6 (receipts parity
  test) pending.
- Verification loop at land time: memory-engine + lib unit suites,
  check-types both packages, refutation report for C-020..C-023, sweep
  ws13, validation entries, landing-progress update.
