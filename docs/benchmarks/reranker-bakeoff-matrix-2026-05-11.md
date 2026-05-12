# Task 2.R9 — Reranker Bake-off Matrix Spec (2026-05-11)

> Scope: **`scope-3-docs-benchmarks`**. Pass-3 C6. Gate 5 publishes R@5,
> R@10, NDCG@10, latency p50/p95, and cost-per-1k-cases for Voyage
> rerank-2.5 vs Cohere Rerank 4 vs ZeroEntropy zerank-2 on the **same**
> 500-case LongMemEval-S cut.

## Contract

- **Same dataset SHA** (pinned in
  `docs/benchmarks/heldout-split-protocol.md`).
- **Same retrieval stack** (pre-rerank): Voyage embeddings +
  `$vectorSearch` + `$rankFusion`, top-50 candidates per case.
- **Swap only the reranker call.** All else (filters, scopes, numCandidates,
  LLM enrichment, concurrency, timeout budget) is byte-identical.
- Rerank result fused back through the existing provenance-aware boost
  applier at `packages/memory-engine/src/mongodb-manager.ts` (no boost
  stack; see R3 audit).

Cite: Mem0 zeroentropy case study at `zeroentropy.dev`, HackerNoon "cross
encoder 63% NDCG lift", MongoDB MCP `search-knowledge` query
`"Atlas Search reranker cross-encoder cohere zeroentropy voyage"`.

## Canary invocation

```bash
GATE_LABEL=gate5-reranker-voyage-2.5
export MEMONGO_CANARY_ARTIFACT_DIR="artifacts/canary-runs/${GATE_LABEL}-$(date +%s)"
export MEMONGO_RERANKER_PROVIDER=voyage
export MEMONGO_RERANKER_MODEL=rerank-2.5
bun run scripts/run-longmemeval-canary.ts 2>&1 | tee "$MEMONGO_CANARY_ARTIFACT_DIR/run.log"
```

Repeat with `MEMONGO_RERANKER_PROVIDER=cohere`
(`MEMONGO_RERANKER_MODEL=rerank-4`) and
`MEMONGO_RERANKER_PROVIDER=zeroentropy`
(`MEMONGO_RERANKER_MODEL=zerank-2`). Each run emits a `benchmarkReport`
with Task-1.A envelope populated, `reranker.{model,version,stage}`
filled per call.

## Metrics matrix (to be filled at Gate 5)

| Reranker | R@5 | R@10 | NDCG@10 | p50 (ms) | p95 (ms) | cost/1k |
| --- | --- | --- | --- | --- | --- | --- |
| Voyage rerank-2.5 | TBD | TBD | TBD | TBD | TBD | TBD |
| Cohere Rerank 4 | TBD | TBD | TBD | TBD | TBD | TBD |
| ZeroEntropy zerank-2 | TBD | TBD | TBD | TBD | TBD | TBD |

## Decision rubric

- **Keep Voyage** if all-three-metric aggregate ranking is within 1pp.
  Voyage is already wired; switching has migration cost.
- **Switch to best** if any metric lifts by ≥3pp at comparable latency
  (≤1.2× Voyage p95) and within 1.5× cost envelope.
- **Report, do not ship** if best-in-class varies by metric (e.g., one
  wins R@5 but loses NDCG@10). Document which profile picks which.

## Exit criterion

Gate 5 matrix artifact has all 3 rows filled with raw canary-run artifact
dirs referenced. Decision commit lands at Phase 5 (retrieval lane freeze).

_Last updated: 2026-05-12._
