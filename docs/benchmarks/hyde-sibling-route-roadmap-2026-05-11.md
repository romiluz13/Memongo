# Task 2.R8 — HyDE as Sibling Retrieval Route (roadmap, 2026-05-11)

> Scope: **`scope-3-docs-benchmarks`**. Pass-3 C5. HyDE generates a
> hypothetical answer, embeds it, retrieves neighbors of the embedding.
> This is a **Gate-5 evaluation cell**, not required to land as code for
> Gate 3/4.

## Route contract

Three sibling retrieval routes share the same `$rankFusion` envelope at
`packages/memory-engine/src/mongodb-conversation-recall.ts`. The query
classifier selects one per query:

1. **decomposition** — existing sub-query expansion
   (`mongodb-query-decomposition.ts`).
2. **HyDE** — LLM generates a hypothetical answer; embed; feed into
   `$vectorSearch` as the vector-pipeline source.
3. **straight-hybrid** — baseline: user query → embed → `$rankFusion`.

```typescript
type RetrievalRoute = "decomposition" | "hyde" | "straight-hybrid"

function chooseRoute(queryClass: QueryClass): RetrievalRoute {
  if (queryClass === "multi-hop") return "decomposition"
  if (queryClass === "semantic-paraphrase") return "hyde"
  return "straight-hybrid"
}
```

## References

- r/LocalLLaMA 9-technique test: HyDE ranked #1 on factoid recall,
  RAG-Fusion #2.
- arXiv 2509.06544 (ReDI) — retrieval augmented with hypothetical
  expansions outperforms query rewriting on multi-hop.

## Gate 5 benchmark-matrix cell

Evaluate "HyDE vs decomposition vs straight-hybrid" on LongMemEval-S
retrieval lane.

- Same dataset SHA (pinned in
  `docs/benchmarks/heldout-split-protocol.md`).
- Same pre-rerank stack (Voyage embeddings + `$vectorSearch`).
- Same `MEMONGO_CANARY_*` env contract from Task 1.0.
- One canary run per route, artifact dirs:
  - `artifacts/canary-runs/gate5-route-decomposition-{ts}/`
  - `artifacts/canary-runs/gate5-route-hyde-{ts}/`
  - `artifacts/canary-runs/gate5-route-straight-hybrid-{ts}/`
- Metrics: R@5, R@10, NDCG@10, empty-rate, any@1
  session + turn, latency p50/p95, cost-per-1k-cases.

## Exit criterion

Roadmap artifact exists (this file). Gate-5 matrix cell reserved.
Implementation branches:

- Route selector lives in `mongodb-retrieval-planner.ts` next to the
  per-query weighting classifier (Task 2.R6).
- HyDE LLM call is gated behind `MEMONGO_LLM_HYDE_MODEL` env; off by
  default on atlas-local:preview runs.

## Open questions

- What LLM generates the hypothetical answer? Default to the same model as
  `MEMONGO_LLM_MODEL` (canary uses `claude-opus-4-7`). Budget: 150 tokens.
- Cache hypothetical embeddings in `query_cache` (TTL 60s) to avoid
  re-LLM-ing identical queries.

_Last updated: 2026-05-12._
