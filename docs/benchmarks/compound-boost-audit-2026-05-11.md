# Task 2.R3 — Compound Boost Audit (2026-05-11)

> Scope: **`scope-3-docs-benchmarks`**. Cites MongoDB MCP Finding #3
> (`mongodb.com/docs/atlas/atlas-search/customize-score`). Audits every
> `boost:` key in the retrieval stack to confirm no multiplicative stacking
> regressed from the 2026-04 preference-evidence fix.

## Method

Ripgrep command (normative):

```bash
rg -n 'boost\s*:\s*\{' packages/memory-engine/src/
rg -n 'boost\s*:\s*[0-9]' packages/memory-engine/src/
```

Run on `main` at commit `9b7a569604` (Phase 1 merge tip). Also confirmed
against `scope-2-retrieval-ranking` tip.

## Findings

### 1) `packages/memory-engine/src/mongodb-manager.ts`

- Preference-evidence provenance boost is applied **post-rerank, single-site**.
- Numeric boosts are explicit: `PROVENANCE_BOOST_USER = 1.25`,
  `PROVENANCE_BOOST_ASSISTANT = 1.00` (no stack, no compounding).
- No `$search.compound.should[].boost.value` paths observed in benchmark
  recall lane (file is otherwise dense with auxiliary code).

### 2) `packages/memory-engine/src/mongodb-reranker.ts`

- Voyage rerank output is re-scored with a single provenance adjustment —
  not multiplied with another boost.
- Zero instances of `boost: { value: X }` inside an Atlas `$search` compound
  spec.

### 3) `packages/memory-engine/src/mongodb-conversation-recall.ts`

- Uses `$rankFusion` with default 0.5/0.5 weights (MongoDB 8.1+ server-side).
- No manual `boost` overrides; per-pipeline weights are the knob.

## Conclusion

No multiplicative stacking observed on `main` or `scope-2`. **No code change
required** for R3. Future per-query weighting (Task 2.R6) changes the
`$rankFusion.input.pipelines[].weight` values; that is not a boost-stack.

## Follow-ups (non-blocking)

- Task 2.R6 per-query weighting is a proposal-only artifact; if/when it
  lands, re-run this audit and append a dated section.
- Gate 5 reranker bake-off (Task 2.R9) will compare Voyage vs Cohere vs
  ZeroEntropy; if any introduces its own boost API, re-audit.

Cite: `mongodb.com/docs/atlas/atlas-search/customize-score`,
`mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search`.

_Last updated: 2026-05-12._
