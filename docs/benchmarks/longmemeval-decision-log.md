# LongMemEval Decision Log

This log records benchmark-gate decisions. Keep entries short, factual, and
linked to raw artifacts.

## 2026-05-12: Phase 3 Gate 3 Re-Open A — Task 1.A envelope projection (BUILD wf-20260511T212602Z-9db2daeb)

Status: **PASS (Task 1.A projection)** — every parity field is populated at runtime on the live `benchmarkReport` envelope. Retrieval-quality regression (hitRate, turn any@1, caseDiagnostics) remains scoped to task #30 and is NOT covered by this re-open. Gate 3 exit itself still blocked until task #30 resolves retrieval quality.

Run:

- Run id: `gate3-strict-1pertype-reopen-a-1778593839`
- Timestamp: 2026-05-12T13:54:59Z
- Commit SHA: `abe55b6a3d2ebd9364d672c6cf5e85b22a065d27` on `main` (stack: two commits on main from this re-open: `bd08f79ea0` projection module + tests, `abe55b6a3d` manager wiring)
- Artifact dir: `artifacts/canary-runs/gate3-strict-1pertype-reopen-a-1778593839/`
- Dataset: `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` (same as prior Gate 3 run)
- MongoDB: atlas-local:preview 8.2.7 on port 27018 (bench stack already healthy from prior Gate 3 run)
- Scope: 6 evaluations, 1 per LongMemEval question type
- Strict flags: `MEMONGO_BENCHMARK_STRICT=1`, `MEMONGO_LLM_ENRICHMENT_STRICT=1`
- Wall-clock: canary ~90s (well under 30 min budget)

Parity field inventory (synthesized from the real `benchmarkReport`, NOT hand-filled):

- `runIdentity.datasetSha256` = `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` — PASS
- `runIdentity.retrievalUnit` = `"turn"` — PASS
- `embedding.model` = `"voyage-3.5"`, `dimensions` = `1024`, `quantization` = `"float32"` — PASS
- `reranker.model` = `"rerank-2.5"`, `version` = `null` (Voyage SDK does not pin the rerank version; null is the honest sentinel), `stage` = `"post-fusion"` — PASS
- `storage.collectionBytes` = `0` (fresh benchmark collection — no events were persisted after benchmark run completed / settle), `storage.indexBytes` = `1306624` — PASS (collStats worked on atlas-local:preview; no null-with-reason fallback needed)
- `latency.p50Ms` = `1552`, `latency.p95Ms` = `2459` — PASS
- `cost.embeddingCalls` = `0` (honest: MongoDB automated-mongot-embedding mode handles embedding server-side), `cost.rerankCalls` = `6` (one per case), `cost.llmEnrichmentCalls` = `0` (honest: `MEMONGO_LLM_ENRICHMENT_MODE` unset defaults to `none`) — PASS

Wiring commits:

- `bd08f79ea0` — `packages/memory-engine/src/benchmark-parity-envelope.{ts,test.ts}` (new module, 24 unit tests) + projection helper `projectBenchmarkParityFields` in runner (+2 tests)
- `abe55b6a3d` — `mongodb-manager.ts` assembles parity bundle via `buildBenchmarkParityBundle`; run-scoped `BenchmarkRunCounters` instantiated in `relevanceBenchmark`, propagated to scenario managers, incremented at rerank + LLM enrichment call sites; canary script passes `datasetSha256` in benchmark body so the envelope traces to the full upstream dataset (not the subset file)

Test evidence:

- `CI=true bunx vitest run packages/memory-engine/src/benchmark-parity-envelope.test.ts` → exit 0, 24/24 pass
- `CI=true bunx vitest run packages/memory-engine/src/mongodb-benchmark-runner.test.ts` → exit 0, 28/28 pass
- `CI=true bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts` → exit 0, 76/76 pass
- `CI=true bunx vitest run scripts/run-longmemeval-canary.test.ts` → exit 0, 46/46 pass
- `bun run check-types` → exit 0, 14/14 workspace tasks green
- `bun run lint` → exit 0, 300 files clean
- `git diff --check` → exit 0

MongoDB MCP `search-knowledge` consulted via WebFetch substitution (MCP plugin not available in this session; disclosed substitution per `.cc10x/v10/patterns.md` gotcha):

- `https://www.mongodb.com/docs/manual/reference/command/collStats/` — confirms `collStats` returns `size` + `totalIndexSize` + `storageSize` on MongoDB 8.x Community + Atlas; still supported though deprecated 6.2 in favor of `$collStats` aggregation stage. On atlas-local:preview the command succeeded and populated `storage.*` without triggering the null-with-reason fallback.

Non-blocking advisories carried forward:

- `cost.embeddingCalls=0` is structurally correct in automated mongot mode but future Gate 4 / Gate 5 may want to surface mongot-side embedding telemetry; tracked as a follow-on.
- Retrieval-quality regression (hitRate=0.666, caseDiagnostics=5) — DEFERRED to task #30 (case 06878be2 root-cause).

---

## 2026-05-12: Phase 3 Gate 3 Strict 1/Type Canary (BUILD wf-20260511T212602Z-9db2daeb)

Status: **FAIL** — Task 1.A envelope parity fields missing from `benchmarkReport`; one turn-precision miss on single-session-preference. Gate 3 blocked; Task 1.A re-opened per plan `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md:2037`.

Run:

- Run id: `gate3-strict-1pertype-1778589425`
- Timestamp: 2026-05-12T13:02:18Z (canary completed 12:55:57Z)
- Commit SHA: `6e004534e8be5b761dcfd193af7c2cc19813d1ea` on `main`
- Artifact dir: `artifacts/canary-runs/gate3-strict-1pertype-1778589425/`
- Dataset: `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
- MongoDB: atlas-local:preview 8.2.7 on port 27018 (fresh volumes; benchmark stack)
- Scope: 6 evaluations, 1 per LongMemEval question type
- Strict flags: `MEMONGO_BENCHMARK_STRICT=1`, `MEMONGO_LLM_ENRICHMENT_STRICT=1`
- Wall-clock: canary ~171s (end-to-end 5.5 min including bootstrap) — well under 30 min budget

Bootstrap B1-B5a results:

- B1 (tool + dataset): PASS (`mongosh`, `docker`, `bun`, `curl` present; 277 MB dataset sha verified)
- B2 (atlas-local:preview up): PASS after fresh volume wipe (prior stale volumes caused replica-set init panic; clean run healthy in ~36s)
- B3 (`@memongo/api` start): initially failed with `SyntaxError: memongoBridgeShutdown not exported` — stale bridge dist; fixed by rebuilding `packages/memory-bridge` and `packages/memory-engine`; API then healthy on port 3847 connected to port 27018
- B4 (`/health` probe): `{"ok":true,"service":"memongo-api"}`
- B5 (bootstrap.json): emitted at `bootstrap.json`
- B5a (mongot lag): PASS (status=READY, queryable=true, mongotLagEstimateSec=null, no STALE drift; post-canary re-snapshot `mongot-lag-post.json` also READY)
- B5a knowledge URL: `https://www.mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes/` (disclosed WebFetch substitution for MCP `search-knowledge`)

Gate 3 exit-criteria checkboard (plan line 2035-2037):

| Criterion | Result |
|-----------|--------|
| `hitRate=1` | PASS |
| `emptyRate=0` | PASS |
| `rAt5=1` | PASS |
| `rAt10=1` | PASS |
| `ndcgAt10=1` | PASS |
| session `any@1=1` | PASS |
| turn `any@1=1` | **FAIL** (0.8333) |
| `missLedger=[]` | PASS (empty) |
| `caseDiagnostics=[]` | **FAIL** (1 entry: `06878be2`) |
| Task-1.A parity fields populated | **FAIL** (see parity inventory) |

Internal metrics (all 1):

- `hitRate=1`, `emptyRate=0`, `rAt5=1`, `rAt10=1`, `ndcgAt10=1`, `avgTopScore=0.7077`, `p95LatencyMs=8420`

Official LongMemEval metrics:

- Session: `any@1=1`, `all@1=0.5`, `ndcg@1=1`, `any@3=1`, `all@3=1`, `ndcg@3=1`, `any@10=1`, `ndcg@10=1` (perfect across K)
- Turn: `any@1=0.8333`, `all@1=0.3333`, `ndcg@1=0.8333`, `any@3=1`, `all@3=0.8333`, `ndcg@3=0.8425`, `any@5=1`, `any@10=1`, `ndcg@10=0.8671`, `any@30=1`, `all@30=1`
- Release gates: `official-retrieval=passed`, `internal-retrieval=passed`, `conversation-recall-regression=not-run`, `query-governance=advisory-only`; warnings=0, degradations=0

Miss (case `06878be2`, single-session-preference):

- Session top1 found (`sessionTop1Found=true`); turn top1 NOT found (`turnTop1Found=false`)
- Expected turns: `turn_1`, `turn_9`, `turn_15`
- Top-5 rank: `turn_2` (0.719), `turn_6` (0.664), `turn_1` (0.570), `turn_16` (0.566), `turn_5` (0.551)
- Classification: preference evidence turn outranked by earlier assistant-response turn. Recovers at rank 3 → `any@3=1`.

Task-1.A parity field inventory (Gate 3 blockers — all MISSING from `benchmarkReport`):

- `datasetSha256` — MISSING; canary-artifact + bootstrap carry dataset SHA, but benchmarkReport envelope does not surface it
- `retrievalUnit` — MISSING
- `embedding.*` (model, dimensions, quantization, provider) — MISSING
- `reranker.*` (enabled, model, topN) — MISSING
- `storage.*` (BenchmarkStorageFootprint) — MISSING (not even null-with-reason)
- `latency.p50` — MISSING (only `p95LatencyMs=8420` emitted)
- `latency.p95` — PRESENT (8420 ms at `benchmarkReport.metrics.internal.p95LatencyMs`)
- `cost.*` (BenchmarkCostCounters) — MISSING

Note: Phase 1 Gate 1 wired the parity envelope types (`BenchmarkRunIdentity`, `BenchmarkEmbeddingConfig`, `BenchmarkRerankerConfig`, `BenchmarkStorageFootprint`, `BenchmarkLatencyDistribution`, `BenchmarkCostCounters`) with unit tests, but the `benchmarkReport` assembly path in `packages/memory-engine/src/mongodb-benchmark-runner.ts` does not currently project those values into the live benchmark response envelope. Task 1.A is re-opened.

Decision:

- **Gate 3 FAIL.** Do not proceed to Phase 4 (Gate 4 Strict 8/Type).
- Re-open Task 1.A: wire envelope parity assembly into `benchmarkReport` (populate `datasetSha256`, `retrievalUnit`, `embedding.*`, `reranker.*`, `storage.*`, `latency.p50`, `cost.*`; null-with-reason is acceptable only for `storage.*` when `collStats` is unsupported on atlas-local:preview).
- Re-investigate case `06878be2` turn-precision miss with miss-ledger + case diagnostics BEFORE changing retrieval logic (plan line 2052). Do NOT tune for 1/type — that's the anti-pattern. The 2026-05-11 preference-evidence post-rerank entry above claims this case was fixed; this regression at top1 turn level requires root-cause analysis.
- Mongot lag + bootstrap infrastructure are GREEN. Phase 1 harness reliability is proven stable across this run.

Next gate:

- Re-run Gate 3 after Task 1.A parity-field wiring lands AND case `06878be2` turn-precision root-cause analysis completes (and, if needed, a targeted fix — not a dataset-specific tune).
- Do NOT publish any retrieval comparison numbers until Gate 3 passes.

Rejected alternatives:

- Proceeding to Phase 4 despite caseDiagnostics≠[] and missing parity: rejected — plan explicitly requires both conditions cleared.
- Tuning retrieval on case `06878be2` in isolation: rejected per plan anti-pattern line 2052.

## 2026-05-11: Preference Evidence Post-Rerank Fix

Status: promote to strict 8/type canary.

Runs:

- Targeted replay:
  `raw-strict-pref-fix4-06878be2-2026-05-11T0800`
- 1/type canary:
  `raw-strict-1pertype-pref-fix4-2026-05-11T0804`
- Artifacts:
  `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/raw-strict-pref-fix4-06878be2-2026-05-11T0800/`
  and
  `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/raw-strict-1pertype-pref-fix4-2026-05-11T0804/`
- Strict flags: `MEMONGO_BENCHMARK_STRICT=1`,
  `MEMONGO_LLM_ENRICHMENT_STRICT=1`
- Retrieval flags: temporal coverage enabled, turn precision enabled, Voyage
  rerank enabled, Sonnet enrichment enabled

Gate result:

- Targeted `06878be2`: `missLedger=[]`, `caseDiagnostics=[]`, session
  `any@1=1`, turn `any@1=1`
- 1/type: 6/6 cases scored, warnings 0, degradations 0,
  `missLedger=[]`, `caseDiagnostics=[]`
- 1/type internal: `hitRate=1`, `emptyRate=0`, `r@5=1`, `r@10=1`,
  `ndcg@10=1`, `p95LatencyMs=3215`
- 1/type official session: `any@1=1`, `all@3=1`, `all@10=1`
- 1/type official turn: `any@1=1`, `all@3=0.8333`, `all@10=0.8333`,
  `all@30=1`

Decision:

- Keep the post-rerank preference evidence boost.
- Promote to strict 8/type canary before any full benchmark run.
- Track turn completeness separately from top-answer correctness.

Why:

- The failing `single-session-preference` case was not an isolation or MongoDB
  filter issue. MongoDB retrieved the right scoped evidence, but the external
  reranker placed assistant advice above user-authored setup constraints.
- For agent memory, user-authored preferences, owned gear, compatibility needs,
  and setup constraints should be primary evidence. Assistant recommendations
  are supporting context.
- The fix is provenance-aware and applies after rerank, where the ranking was
  actually being overwritten.
- The 1/type canary stayed clean across all six LongMemEval question types.

Known gap:

- The preference case still needs a larger result window for complete coverage
  of every annotated expected turn. That is not a top-answer miss, but it is a
  real recall-completeness signal to monitor in the 8/type canary.

## 2026-05-07: Turn Precision Rerank, Strict 3/Type Canary

Status: keep as experimental candidate. Do not make default yet.

Run:

- `strict-sonnet46-three-per-type-turn-precision-2026-05-07T0650`
- Artifact: `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/strict-sonnet46-three-per-type-turn-precision-2026-05-07T0650/canary-artifact.json`
- Dataset: `longmemeval_s_cleaned.json`
- Scope: 18 evaluations, 3 per LongMemEval question type
- Strict flags: `MEMONGO_BENCHMARK_STRICT=1`, `MEMONGO_LLM_ENRICHMENT_STRICT=1`
- Retrieval flags: session evidence A, userfact evidence enabled, LLM enrichment enabled, query decomposition enabled, turn precision mode enabled
- Models: `claude-sonnet-4-6` for enrichment, Voyage auto embeddings

Gate result:

- Warnings: 0
- Degradations: 0
- Miss ledger: 1
- Session: `any@1=0.9375`, `all@3=0.9375`, `all@10=0.9375`, `ndcg@10=0.9616`
- Turn: `any@1=0.5`, `all@1=0.1875`, `any@10=0.8125`, `all@10=0.6875`, `any@50=0.9375`, `all@50=0.8125`, `ndcg@10=0.5780`

Decision:

- Keep the session-first turn precision rerank behind
  `MEMONGO_BENCHMARK_TURN_PRECISION_MODE=enabled`.
- Do not enable it as a default product behavior yet.
- Do not claim the turn-level issue is fully fixed.

Why:

- The original strict 1/type provenance baseline exposed a real turn-selection
  miss: session-level evidence found the right session, but MongoDB ranked the
  session document rather than the individual turns inside
  `metadata.sourceEventIds`.
- The turn precision rerank improves turn completeness versus that baseline:
  turn `all@10` rose from `0.3333` in the 1/type provenance smoke to `0.5` in
  the 1/type precision smoke and `0.6875` in this 3/type canary.
- The larger 3/type canary still has one temporal miss:
  `0bc8ad92`, category `temporal`, `r@5=0.6667`, `r@10=0.6667`,
  `sessionFound=true`, `turnReachable=true`, `allSessionsFound=false`.
- Larger-sample turn `any@10=0.8125` is below the 1/type precision smoke
  (`1.0`), so the approach needs more miss analysis before becoming default.

Rejected alternatives from prior canaries:

- Broad turn-evidence docs improved some `all` metrics but hurt turn
  `any@10` and added storage/index complexity. Reject for now.
- Session-coverage round-robin made session metrics look perfect on a tiny
  1/type canary but hurt turn `any@1`, `any@10`, and `ndcg@10`. Removed.

Next gate:

- Analyze the `0bc8ad92` temporal miss before changing retrieval again.
- Run strict 8/type only after one targeted temporal fix or a decision that the
  miss is dataset/noise rather than algorithmic.
