# Task 2.R7 — ENN Fallback for Small Per-user Corpora (2026-05-11)

> Scope: **`scope-3-docs-benchmarks`**. Pass-3 C4. For users with fewer
> than ~10k vectors, `$vectorSearch` with `exact: true` (ENN) outperforms
> ANN. Proposal artifact first; code landing gated by new Task 0.5-style
> sign-off.

## Motivation

ANN search (default) amortizes well across millions of vectors but loses
recall on small corpora. ENN (`exact: true` on `$vectorSearch`) computes
exact nearest neighbors — cost scales with corpus size, so sub-10k is the
natural break-even zone.

Cite: MongoDB MCP `search-knowledge` query
`"$vectorSearch exact ENN small corpus"`,
`mongodb.com/docs/atlas/atlas-search/vector-search/`.

## Corpus-size estimator

```typescript
async function estimateScopedCount(
  db: Db,
  collectionName: string,
  filter: { agentId: string; scope?: string; scopeRef?: string },
): Promise<number> {
  // Bounded: we don't need exact — sub-10k vs over-10k is the decision.
  // `countDocuments` with a scoped filter is fine at this corpus size.
  return db.collection(collectionName).countDocuments(filter, { limit: 10_000 })
}
```

## Branching pseudo-code

```typescript
const approxCount = await estimateScopedCount(db, `${prefix}events`, {
  agentId,
  scope,
  scopeRef,
})
const useExact = approxCount < 10_000
const vectorSearchStage = {
  $vectorSearch: {
    ...base,
    exact: useExact,
    numCandidates: useExact ? undefined : resolveNumCandidates(limit),
  },
}
```

## Exit criterion

Proposal artifact exists (this file). Sub-10k-corpus recall delta is
measured at Gate 5 using LongMemEval-S held-out split (50 cases, 8 types);
code landing follows a Task 0.5 sign-off.

## Risk

- A freshly bootstrapped agent starts empty; ENN on empty is fine but the
  estimator overhead adds latency. Mitigation: short-circuit on
  `approxCount === 0` — return no results without even issuing the search.
- Agents spanning 9k-11k sit on the boundary. Mitigation: add hysteresis
  so flapping between ANN and ENN does not cause recall swings. Use
  `< 9_500` for ENN and `> 10_500` for ANN, reuse the last mode in the
  boundary band.

## Open questions

- Does ENN on a sparse-but-growing corpus stress the Atlas node?
  _Gate 5 benchmarks will measure p50/p95 latency at 9k; escalate to
  dedicated node sizing if p95 > 300ms._
- Is `countDocuments({ scope, scopeRef })` cheap enough to run on every
  recall? _With a compound index on (agentId, scope, scopeRef) it is O(log
  n); cache TTL 30s in `query_cache` as a belt on top of the index._

_Last updated: 2026-05-12._
