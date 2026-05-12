# Task 2.R6 — Per-query Hybrid Weighting Proposal (2026-05-11)

> Scope: **`scope-3-docs-benchmarks`**. Pass-3 C3. MongoDB docs explicitly
> advise per-query weighting over static 0.5/0.5. Proposal artifact first;
> code landing requires a new Task 0.5-style Recommended Default sign-off.

## Background

`$rankFusion` (MongoDB 8.1+) supports per-pipeline weights in the
`input.pipelines[].weight` position. Memongo currently uses default
0.5/0.5 for vector+text. LongMemEval-S factual-lookup queries favor BM25
over semantic similarity; semantic-paraphrase queries favor vector; multi-hop
benefits from a balanced weighting.

Cite: `mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search`,
MongoDB MCP `search-knowledge` query
`"MongoDB hybrid search per-query weighting"`.

## Classifier contract

```typescript
export type QueryClass =
  | "factual-lookup"
  | "semantic-paraphrase"
  | "multi-hop"
  | "mixed"

export function classifyQueryForWeighting(query: string): QueryClass

export function weightsForClass(c: QueryClass): {
  vector: number
  text: number
}
// factual-lookup      -> { vector: 0.4, text: 0.6 }
// semantic-paraphrase -> { vector: 0.6, text: 0.4 }
// multi-hop           -> { vector: 0.5, text: 0.5 }
// mixed               -> { vector: 0.5, text: 0.5 }
```

## Query class examples (from LongMemEval-S session inspection)

- **factual-lookup.** "What was my flight number?" "When is my dentist?"
  "What is my github username?" — keyword-heavy, entity-anchored.
- **semantic-paraphrase.** "Something I mentioned about my side project."
  "That thing I said about Python." — weak entities, high paraphrase.
- **multi-hop.** "Why did I switch from Django to FastAPI?" "What did we
  decide after the migration?" — chained causal/temporal reasoning.

## Recall-delta protocol (to be run at Gate 5)

Using `scoreDetails` observability from Task 2.R1 + held-out 50-case split
at `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_heldout.json`:

1. Run baseline (static 0.5/0.5) → record R@5, R@10, NDCG@10.
2. Run per-query-classified weights → record same metrics.
3. Delta per class + aggregate. Proposal accepted if ≥2pp aggregate lift
   without regressing any class below baseline −1pp.

## Risk

Misclassification drops a factual-lookup query into the
semantic-paraphrase bucket (0.6 vector). Fallback: `mixed` → 0.5/0.5 never
hurts more than the static baseline. Classifier confidence threshold
(>0.7) required to leave the `mixed` bucket.

## Exit criterion

Proposal artifact exists (this file). Code landing requires:

1. User sign-off as a new Recommended Default (numCandidates-style).
2. Classifier + weight helper in
   `packages/memory-engine/src/mongodb-retrieval-planner.ts`.
3. Wire into `$rankFusion.input.pipelines[].weight` at
   `packages/memory-engine/src/mongodb-conversation-recall.ts`.

## Open questions

- Classifier model: pattern-regex vs small LLM head?
  _Pattern-regex first; LLM head as Gate-5 ablation if needed._
- Failure-open: does `classifyQueryForWeighting` throw or fall back to
  `mixed`? _Fall back to `mixed`; log as `query-classifier-fallback`._

_Last updated: 2026-05-12._
