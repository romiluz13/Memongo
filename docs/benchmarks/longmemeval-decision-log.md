# LongMemEval Decision Log

This log records benchmark-gate decisions. Keep entries short, factual, and
linked to raw artifacts.

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
