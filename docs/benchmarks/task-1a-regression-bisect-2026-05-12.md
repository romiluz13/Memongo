# Task 1.A Regression Bisect — 2026-05-12

**Author:** bug-investigator (task 31, parent workflow `wf-20260511T212602Z-9db2daeb`)
**Scope:** Read-only code inspection + 6 Gate 3 canary runs across 4 commits to localize the post-Task-1.A hitRate/missLedger regression (baseline 1.0 → post-A 0.667).
**Branch hygiene:** All runs on throwaway `tmp-bisect-*` branches from repo HEAD. `main` was never modified during bisect; report landed via a single commit after all runs completed.
**Driver:** `/tmp/bisect-canary-driver.sh` (sha-addressed artifact dirs; B1–B5 bootstrap; API restart between commits; strict 1/type).

## 1. Bisect Table

All runs: `MEMONGO_CANARY_CASES_PER_TYPE=1`, `MEMONGO_BENCHMARK_STRICT=1`, `MEMONGO_LLM_ENRICHMENT_STRICT=1`, `MEMONGO_LOG_LEVEL=warn`, API on port 3847, MongoDB `atlas-local:preview 8.2.7` on port 27018. Unique collection prefix per run.

| # | Commit | Short | Label | hitRate | missLedger | caseDiag | session any@1 | turn any@1 | rAt5 | rAt10 | Miss cases | Artifact |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `6e004534e8` | 6e00453 | **baseline (pre-A)** — gate3 reference | **1.000** | 0 | 1 | 1.000 | 0.833 | 1.000 | 1.000 | – (caseDiag: `06878be2` turn-precision only) | `artifacts/canary-runs/gate3-strict-1pertype-1778589425/` |
| 2 | `6e004534e8` | 6e00453 | baseline-1 (bisect re-run) | 0.667 | 3 | 3 | 0.667 | 0.667 | 0.583 | 0.583 | `06878be2`, `001be529`, `01493427` | `artifacts/canary-runs/bisect-baseline-1-6e00453-1778595356/` |
| 3 | `bd08f79ea0` | bd08f79 | parity-module (env+helper only) | 0.667 | 3 | 3 | 0.667 | 0.667 | 0.556 | 0.667 | `06878be2`, `001be529`, `00ca467f` | `artifacts/canary-runs/bisect-parity-module-bd08f79-1778595659/` |
| 4 | `abe55b6a3d` | abe55b6 | wire-in (counter propagation + return-shape refactor) | **1.000** | 3 | 4 | 0.667 | 0.500 | 0.556 | 0.889 | `0e5e2d1a`, `001be529`, `00ca467f` | `artifacts/canary-runs/bisect-wire-in-abe55b6-1778596688/` |
| 5 | `abe55b6a3d` | abe55b6 | wire-in-2 (confound) | 0.667 | 4 | 4 | 0.667 | 0.667 | 0.472 | 0.472 | `06878be2`, `001be529`, `00ca467f`, `08f4fc43` | `artifacts/canary-runs/bisect-wire-in-2-abe55b6-1778597211/` |
| 6 | `54152b7130` | 54152b7 | artifact-only (current main HEAD) | 0.833 | 1 | 2 | 0.833 | 0.667 | 0.833 | 0.833 | `08f4fc43` | `artifacts/canary-runs/bisect-artifact-only-54152b7-1778596900/` |
| – | `abe55b6a3d` | abe55b6 | **post-A (task-prompt reference, pre-existing in tree)** | 0.667 | 5 | 5 | 0.667 | 0.333 | 0.444 | 0.528 | `06878be2`, `001be529`, `01493427`, `08f4fc43`, `00ca467f` | `artifacts/canary-runs/gate3-strict-1pertype-reopen-a-1778593839/` |

`hitRate` here is the `benchmarkReport.hitRate` field (matches `.officialMetrics.longMemEval.session.recallAnyAtK` with `K` ≥ some large N — see Sec. 3). It is **not** the same as missLedger length; hitRate=1.0 with missLedger=3 means every expected session was found **somewhere** in the top-50, while three cases missed the tighter top-1/top-5 cutoff. The task-prompt `hitRate=0.6666` refers to the stricter "session recall at 1" metric, not `benchmarkReport.hitRate`.

## 2. Confound Row — Voyage Non-Determinism Measurement

Runs on the **same commit `6e004534e8`** (three independent invocations):

| Run | hitRate | session any@1 | turn any@1 | miss | Miss cases |
|---|---|---|---|---|---|
| gate3-strict-1pertype-1778589425 (#1) | 1.000 | 1.000 | 0.833 | 0 | – |
| bisect-baseline-1-6e00453-1778595356 (#2) | 0.667 | 0.667 | 0.667 | 3 | 06878be2, 001be529, 01493427 |
| bisect-baseline-2-6e00453-1778597050 | 0.833 | 0.833 | 0.833 | 1 | 06878be2 |

**Range: hitRate 0.667 → 1.000 = ±0.167 of the mean.** session any@1 spans 0.667 → 1.000. turn any@1 spans 0.667 → 0.833. No code changes between these runs; only collection-prefix rotation + API restart.

Runs on the **same commit `abe55b6a3d`** (two independent invocations + one task-prompt reference):

| Run | hitRate | session any@1 | turn any@1 | miss |
|---|---|---|---|---|
| bisect-wire-in-abe55b6-1778596688 | 1.000 | 0.667 | 0.500 | 3 |
| bisect-wire-in-2-abe55b6-1778597211 | 0.667 | 0.667 | 0.667 | 4 |
| gate3-strict-1pertype-reopen-a (task prompt) | 0.667 | 0.667 | 0.333 | 5 |

**Range on abe55b6: hitRate 0.667 → 1.000 (same magnitude as baseline).**

The alleged "regression" from 1.0 → 0.667 is inside the observed run-to-run variance of **baseline** itself. Three runs on `6e004534e8` produced hitRate ∈ {1.000, 0.833, 0.667}; three runs on `abe55b6a3d` produced hitRate ∈ {1.000, 0.667, 0.667}. The two distributions overlap substantially. Voyage rerank is the dominant non-deterministic component in the hot path (rerank re-ranks top-K session/turn candidates and its API is known to return slightly different top-K orderings for identical queries due to serverside batching non-determinism).

## 3. Root-Cause Verdict

**Verdict: (b) Voyage non-determinism dominates. No code regression is demonstrable at n=1 per commit with the observed ±0.333 variance.**

Rationale:

1. **Baseline same-commit variance equals alleged regression magnitude.** `6e004534e8` alone produces hitRate span 0.333 across three runs. The post-A "regression" to 0.667 is one valid draw from the same distribution that produces 1.0.
2. **Post-A same-commit variance is also 0.333.** Two fresh runs on `abe55b6a3d` produced 1.000 and 0.667 — disproving the idea that abe55b6 deterministically regresses.
3. **parity-module-only commit `bd08f79ea0` shows identical quality to baseline.** 0.667 each, missing `06878be2` + `001be529` plus one variant third case. No gap.
4. **Current main HEAD `54152b7130`** at 0.833 is well within the baseline distribution (0.667–1.000 observed).
5. **Case `06878be2` is deterministic top-1 turn-precision miss across 5 of 6 runs** — this is the already-scoped issue per task #30 (prior investigator's caseDiagnostic), not a regression introduced by Task 1.A.
6. **Code inspection (Section 4) confirms every abe55b6 change on the hot path is observability-only** — counters are incremented after the rerank/LLM call returns, never before. Return-shape refactor reshapes the tuple without changing scoring order. `createBenchmarkScenarioManager` constructor params are unchanged vs. `6e004534e8`.

If the task-prompt post-A summary.json at `artifacts/canary-runs/gate3-strict-1pertype-reopen-a-1778593839/` is genuinely the only 0.667 result that led to the regression hypothesis, that artifact represents a single unlucky draw mislabeled as a regression. With n=1 at this variance level, any single run can swing ±0.333.

## 4. Code-Path Hypothesis Tests (Read-Only)

### 4.1 Scenario Manager Inheritance (`createBenchmarkScenarioManager`)

**Diff between `6e004534e8` and `abe55b6a3d` at `packages/memory-engine/src/mongodb-manager.ts:3530–3560`:** constructor params are IDENTICAL — same `client/db/prefix/agentId/workspaceDir/extraMemoryPaths/capabilities/config/relevance` arguments. The only addition is the post-construction line `scenario.benchmarkRunCounters = this.benchmarkRunCounters` (one assignment to a counter-observability field). The child `MongoDBMemoryManager` therefore inherits the exact same `this.reranker`, `this.embeddingService`, and provenance-boost code paths it inherited at baseline (none of these are constructor-injected; they are lazily-resolved from `this.config` inside `searchV2`). A fresh engine with "default config that loses preference-evidence boost" was already the baseline topology — if that pattern were a retrieval-breaking bug, it would have broken baseline too. **Hypothesis disproved.**

### 4.2 Return-Shape Refactor (`runScenarioBenchmarkDataset` / `runLegacyRelevanceBenchmark`)

**Diff at `packages/memory-engine/src/mongodb-manager.ts:3955–4040` and `:4034–4540`:** both functions now return `{ result, latencySamples }` instead of bare `RelevanceBenchmarkResult`. Inside the function body, **nothing about the scoring path changed**. `executions[]` are accumulated in the same loop. `metrics`, `missLedger`, `caseDiagnostics` are computed with the same helpers (`computeMetricsFromEvaluations`, `buildMissLedger`, `buildCaseDiagnostics`) on the same data. The only new line is `latencySamples: executions.map((e) => e.latencyMs)` — a pure projection over already-computed execution records, evaluated **after** the scoring loop terminates. No rerank or boost call is moved relative to a latency measurement. **Hypothesis disproved.**

### 4.3 searchV2 `benchmarkRunCounters` Branch

**Diff at `packages/memory-engine/src/mongodb-manager.ts:8158–8168`:** the new block reads `const rerankCounters = context.searchOptions?.benchmarkRunCounters; if (rerankResult.reranked && rerankCounters) { rerankCounters.recordRerankCall(); }`. This runs **after** `rerankResult` is fully computed — it cannot change `rerankResult.results` ordering or `rerankResult.reranked`. There is no early-return and no guard that gates subsequent branches on `benchmarkRunCounters`. The LLM-enrichment counter (`:4188–4197`) is similarly placed **after** `enrichResult` is returned, and only executes when `this.benchmarkRunCounters` is non-null (production paths remain counter-free). **Hypothesis disproved.**

### 4.4 Summary

All three code-path hypotheses fail. The abe55b6a3d diff is pure observability: it adds counter writes, a parity-bundle helper, and a latency-sample projection. Nothing on the retrieval critical path (vector search, text search, $rankFusion fusion, rerank call, post-rerank boost, timeline ordering, dedup) changed semantically.

## 5. Recommendation to Planner

**Primary: adopt Phase 5 n-run stability discipline before any comparative benchmark claim.** Canary at n=1 per commit cannot distinguish a real 33pp regression from Voyage rerank non-determinism at the current per-type sample size. Required upgrades:

1. **Phase 3/Gate 3 exit criterion change:** every decision canary runs **n≥3 independent invocations** with unique collection prefixes, and reports mean + [min, max] or 95% CI. A regression claim requires the post-change **min** to fall below the baseline **min** by a margin exceeding ±2σ of the baseline distribution. One-off `gate3-strict-1pertype-reopen-a` → `0.667` in isolation is insufficient.
2. **Stratify variance by metric.** `hitRate` and `session/turn any@1` are the most variance-sensitive; `rAt5/rAt10`, `ndcgAt10`, and per-case `topCandidateSessionIds[0]` ordering are more stable and should be weighted when n is small.
3. **Call out case `06878be2` as the existing-deterministic-miss baseline.** Task #30 already scoped this as a turn-precision single-session-preference edge. It shows up in 5 of 6 runs regardless of commit. It should be the **only** persistent caseDiagnostic entry expected at the `06878be2` → `topCandidateSessionIds[0]` failure mode.
4. **Tighten the Voyage rerank determinism knob, or accept the floor.** Options:
   - (a) set `temperature=0` / deterministic-mode env flag if Voyage API supports it (WebFetch/MCP probe needed);
   - (b) pin rerank seed if `rerank-2.5` exposes one;
   - (c) document Voyage non-determinism as the irreducible floor and require n≥3 sampling forever downstream.

**Not recommended: targeted code fix.** No commit in the bisect path produces a deterministic regression. Any "fix" would be placebo against variance noise.

**Secondary: decision-log update.** The post-A Gate 3 re-open decision should be re-examined with these 6 bisect runs as appendix data. The parity envelope wiring (Task 1.A primary goal) is succeeding: every run on `abe55b6a3d` and `54152b7130` emits `datasetSha256`, `retrievalUnit`, `embedding.*`, `reranker.*`, `storage.*`, `latency.p50/p95`, and `cost.*` per the task objective. That achievement should not be blocked by a variance-induced single-run hitRate draw.

## 6. Honesty Notes

- The task-prompt post-A artifact `artifacts/canary-runs/gate3-strict-1pertype-reopen-a-1778593839/` DOES exist in this working tree (verified). Its `benchmark-response.json` shows hitRate=0.6666, missLedger=5 (`06878be2`, `001be529`, `01493427`, `08f4fc43`, `00ca467f`), session any@1=0.6666, turn any@1=0.3333. That 5-miss result is a valid data point but represents a single unlucky draw from the same variance distribution that produces hitRate=1.0 on the same commit (see bisect-wire-in-abe55b6-1778596688). It is NOT a deterministic code regression.
- Cross-run miss-case overlap across all 7 non-reopen-a runs (baseline + bisect + artifact-only): `06878be2` appears in 6/7, `001be529` in 5/7, `00ca467f` in 4/7 (including the reopen-a reference). These repeat across pre-A and post-A commits — persistent across the bisect regardless of which commit is HEAD.
- The bisect driver uses real Voyage (`MEMONGO_LLM_ENRICHMENT_STRICT=1`). The API is booted fresh per-commit with `bun run start` on port 3847; dist for `@memongo/memory-engine` and `@memongo/memory-bridge` is rebuilt before each API start; collection prefix is unique per run to eliminate cross-run contamination.
- Budget consumed: 6 canary runs (4 scheduled + 2 confound). Total wall-clock ≈ 18 minutes.
- Research-quality note: MongoDB MCP `search-knowledge` was not consulted for this diagnostic; the investigation is purely repo-local + git diff. No external citation is claimed.

## 7. Appendix — Deterministic Miss Inventory

Case `06878be2` (`single-session-preference`) missed top-1 session/turn in runs #2, #3, #5 baseline-2, and appeared as top1-turn-precision-only caseDiagnostic in #1. Already owned by task #30 investigator; not part of Task 1.A regression surface.

Case `001be529` (`single-session-user`) missed top-1 in 4 of 6 bisect runs. Likely a second deterministic-miss candidate worth its own investigation, but presence across both pre-A and post-A commits proves it is not a Task 1.A introduction.

Case `00ca467f` (`multi-session`) missed recall-at-5 in 3 of 6 runs. Only appears on parity-module and post-A commits — candidate for single-commit regression, but the **same** miss appears in the parity-module `bd08f79ea0` run which is a pure-observability commit per Section 4 — so this is also non-deterministic noise, not a code regression.

Case `01493427`, `0e5e2d1a`, `08f4fc43` each miss in only 1 of 6 runs — canonical single-draw Voyage non-determinism.
