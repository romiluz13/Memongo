# Silent-Fallback Audit — 2026-05-11 (Phase 1 / Task 1.8)

**Workflow:** `wf-20260511T212602Z-9db2daeb` (BUILD).
**Scope:** `scope-1-harness-reliability` (Phase 1). Ownership transfers to
Scope #3 in Phase 2 via `git mv` on the same path; the file does not move.
**Grep seed:** `rg -n --multiline 'catch\s*\([^)]*\)\s*\{[^}]*(?:warn|log\.warn|continue|return)' packages/memory-engine/src/mongodb-{manager,retrieval-planner,search,search-executor,reranker,llm-enrichment,conversation-recall}.ts`

Honesty-over-vanity posture: in strict benchmark mode (`MEMONGO_BENCHMARK_STRICT=1`)
there must be zero silent fallback. Any fallback is either:
- **KEEP** — product resilience for real users outside benchmark runs.
- **CONVERT** — must re-throw (or add `if (isBenchmarkStrictMode()) throw err`) so the
  canary strict-mode path (`shouldCanaryAbort`, Task 1.6) can classify and abort.

## Legend

| Column | Meaning |
|---|---|
| Site | file path + line of the `catch` |
| Class | what the fallback protects against |
| Kind | KEEP / CONVERT |
| Strict-mode action | Required behavior when `MEMONGO_BENCHMARK_STRICT=1` |
| Follow-up | Task where a CONVERT lands |

## Findings

| Site | Class | Kind | Strict-mode action | Follow-up |
|---|---|---|---|---|
| `mongodb-manager.ts:785` (MongoDB connect) | connection | KEEP | Already re-throws via `throw new Error(...)` path; warn is diagnostic only | — |
| `mongodb-manager.ts:870` (per-memory enrich catch in batch) | enrichment | KEEP | Enrichment per-memory failure is classified into the returned record; not silent | — |
| `mongodb-manager.ts:921` (`relevance runtime initialization failed`) | init | KEEP | Init returns without relevance; product-path warning only; strict benchmark runs re-throw at the first relevance call | — |
| `mongodb-manager.ts:950` (`initial memory sync failed`) | startup | KEEP | Startup warning; retried on next change-stream tick; does not touch hot path | — |
| `mongodb-manager.ts:2529` (benchmark event search convergence probe) | probe | **CONVERT (done)** | Task 1.5 delegates to `readSearchIndexStatus`; strict mode aborts on STALE or `queryable=false`; aggregate fallback is bounded by `MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS` | Task 1.5 ✔ |
| `mongodb-manager.ts:3067` (benchmark evidence creation) | benchmark write | **CONVERT (deferred)** | In strict mode must throw `retrieval-miss` or `scope-leak`; today logs warn only. Land at Phase 2 Scope #2 — the relevant evidence-creation paths are part of retrieval-ranking scope and rewriting here would cross-scope leak. | Phase 2 Scope #2 |
| `mongodb-manager.ts:4264-4369` (sync / resume token / KB auto-refresh) | maintenance | KEEP | Background maintenance loops; retried on next tick | — |
| `mongodb-manager.ts:4936-5088` (derived-memory work, job-update retries) | async jobs | KEEP | Individual job failure is logged + counted; does not affect the current benchmark scenario's retrieval correctness | — |
| `mongodb-manager.ts:5143-5185` (duplicate-key handling) | write dedup | KEEP | Duplicate-key error is an expected idempotency signal | — |
| `mongodb-manager.ts:5251-5705` (writeEventAndProject: entity extract / episode trigger / lane coverage) | derivation | KEEP | Derivations must not block event writes; retried asynchronously | — |
| `mongodb-manager.ts:5487` (`error closing MongoDB connection`) | shutdown | KEEP | Close-path warning | — |
| `mongodb-manager.ts:6112` (lane coverage load for planner) | planner data | **CONVERT (deferred)** | In strict benchmark mode, an empty lane-coverage map silently degrades the planner — land in Phase 2 Scope #2 (retrieval-planner rewrite is on scope-2). | Phase 2 Scope #2 |
| `mongodb-reranker.ts:164` (rerank fallback to input order) | rerank | **CONVERT (deferred)** | Silent "fallback to input order" masks Voyage 429/500 during benchmarks. Add `if (isBenchmarkStrictMode()) throw err` and rely on taxonomy to classify as `model-failure`. Lands in Phase 2 Scope #2 (rerank pipeline is retrieval-ranking scope). | Phase 2 Scope #2 |
| `mongodb-conversation-recall.ts:547-568` (hybrid & semantic recall fallback) | recall | **CONVERT (deferred)** | In strict mode the canary must fail instead of silently degrading to lexical. Land in Phase 2 Scope #2. | Phase 2 Scope #2 |
| `mongodb-llm-enrichment.ts:478` (retry loop) | retry | KEEP | `lastError` is surfaced; not a fallback per se — the retry policy is explicit | — |

## Additional finding (Task 1.9 gate proof)

The Task 1.9 forced-failure run surfaced a new silent-fallback suspect:

- **Site:** API server's Voyage client wiring (precise site TBD under Scope #2).
- **Observation:** With `MEMONGO_VOYAGE_BASE_URL=http://127.0.0.1:65530`
  (unroutable) set on the API server process, a 1-case LongMemEval benchmark
  run still completed with `hitRate=1` and no logged error. That means one
  of the following is happening silently:
  1. The base-URL env var is not being read where the Voyage client is
     instantiated (configuration drift), OR
  2. The retrieval path bypasses Voyage entirely for this particular
     question-type shape (lexical-only / cached), OR
  3. The Voyage failure surfaces but is caught and swallowed as "degraded"
     without strict mode re-throwing.
- **Follow-up:** Investigate on scope-2-retrieval-ranking (this is retrieval
  scope; changing Voyage wiring or strict-mode enforcement there crosses
  scope-1's harness boundary). Add a correctness test that forces
  `MEMONGO_VOYAGE_BASE_URL` unroutable and asserts the API returns a 5xx in
  strict mode within 10s.

## Summary

- 14 hot-path catch sites audited across the 7 files named in Task 1.8.
- 1 CONVERT already landed on scope-1 at Phase 1 (Task 1.5 — readiness probe).
- 4 CONVERT deferred to Phase 2 on scope-2 (retrieval-ranking). Landing them on
  scope-1 now would pull retrieval-ranking code across scope boundaries and
  violate the 6-scope partition.
- 9 sites classified KEEP — product-resilience fallbacks that do not mask
  benchmark-strict signal because they sit outside the strict hot path (init,
  shutdown, async maintenance) or already re-throw after logging.

## Ownership Transfer (Phase 2 Scope #3)

This file was created on `scope-1-harness-reliability` in Phase 1. When Scope #3
lands in Phase 2, `git mv` the file as part of the Scope #3 PR — the path stays
identical. No redraft.

## References

- Plan: `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md` Task 1.8 (on
  scope-3-docs-benchmarks).
- Task 1.4 taxonomy: `packages/memory-engine/src/benchmark-failure-taxonomy.ts`.
- Task 1.5 probe upgrade: `packages/memory-engine/src/mongodb-benchmark-readiness.ts`.
- Task 1.6 strict-mode fatal class list:
  `scripts/run-longmemeval-canary.ts` `BENCHMARK_STRICT_FATAL_CLASSES`.
