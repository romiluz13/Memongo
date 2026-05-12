# Task 2.R2 — numCandidates Approved Table (2026-05-11)

> Scope: **`scope-3-docs-benchmarks`**. Task 2.R2 Sub-path A. The user
> approved the `numCandidates` table at Phase 0 Task 0.5 Recommended
> Default #1. This document is the durable record.

## Approved table

| `limit` | `numCandidates` |
| --- | --- |
| 5 | 200 |
| 10 | 200 |
| 20 | 400 |
| 30 | 600 |

- Intermediate limits scale by **20× limit** with a **200 floor** (MCP
  Finding #2 baseline: `numCandidates ≥ 20 × limit`).
- `override` parameter wins when provided (Gate 5 experimentation).

## Helper location

`packages/memory-engine/src/mongodb-retrieval-planner.ts` exports
`resolveNumCandidates(limit, override?)`. Both `semanticRecall` and
`hybridRecall` at `packages/memory-engine/src/mongodb-conversation-recall.ts`
call the helper for `$vectorSearch.numCandidates`.

Tests pin the contract:
`packages/memory-engine/src/mongodb-retrieval-planner.test.ts` (7 cases,
including discrete table + 20× interpolation + clamp + override).

## Citation

- `mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage`
- MongoDB MCP `search-knowledge`.

## Next steps

- Gate 5 recall-curve ablation will compare the approved table against
  higher `numCandidates` (e.g., 800, 1200) using the `override`
  parameter. No changes to the approved table without a new sign-off.

_Last updated: 2026-05-12._
