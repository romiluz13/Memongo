# Session Evidence Architecture ADR

**Date:** 2026-04-14
**Status:** Open until canary evidence closes it
**Related design:** `docs/plans/2026-04-14-retrieval-excellence-design.md`
**Related plan:** `docs/plans/2026-04-14-retrieval-excellence-plan.md`

## Decision Question

How should Memongo represent session-aware evidence for the LongMemEval retrieval wave?

This ADR exists because the strategy converged everywhere except here.
We should not hard-code this answer from taste.

## Invariants

Any winning option must preserve all of the following:

- one planner
- one retrieval authority
- one provenance story
- no second memory runtime
- canary-first evaluation
- turn-level provenance (`sourceEventIds` or equivalent)
- compatibility with the benchmark trace model

If an option violates these invariants, it is disqualified even if it appears locally convenient.

## Proven Facts

### From Memongo code

- `packages/memory-engine/src/mongodb-sync.ts:474-503` already writes session-derived chunks into the canonical `chunks` flow with `source: "sessions"`.
- `packages/memory-engine/src/mongodb-hybrid.ts:140-348` already provides app-level cross-result JS merge/RRF.
- `packages/memory-engine/src/mongodb-kb.ts` plus `packages/memory-engine/src/mongodb-schema.ts:37-57` already show a separate `kb_chunks` collection pattern for a different source family.

### From reference-repo code

- `LongMemEval` runs flat-corpus experiments with session vs turn granularity and multiple expansion strategies, but those are experiment modes, not proof of the final Memongo architecture.
- `mempalace` mixes session-level docs and synthetic preference docs in one collection for its main benchmark path, but uses a second collection for the assistant-aware pass. It does **not** mix short turn-level chunks with long session docs in the same main benchmark collection.

### From MongoDB capability validation

- native `$rankFusion` / `$scoreFusion` are same-collection fusion stages
- cross-collection search is still possible through supported MongoDB patterns or through Memongo’s existing JS merge logic
- ENN is real and available regardless of which session-evidence option wins

## Option A: Extend The Canonical Evidence Path More Directly

This option keeps session-aware evidence closer to the existing canonical chunk/evidence path.

Possible forms:
- enrich or formalize the existing `source: "sessions"` path in `chunks`
- or build a same-brain evidence shape that still participates naturally in canonical retrieval/indexing

Likely file surfaces:
- `packages/memory-engine/src/mongodb-sync.ts`
- `packages/memory-engine/src/mongodb-search.ts`
- `packages/memory-engine/src/mongodb-manager.ts`
- `packages/memory-engine/src/mongodb-schema.ts` if index/filter support must change

### Benefits

- strongest fit with same-collection native fusion
- simpler mental model for one brain
- fewer parallel collection semantics to keep in sync
- aligns most directly with the checkpoint doctrine favoring canonical-path extension

### Risks

- turn-level and session-level evidence may interfere if the representation is too mixed
- may require persistent filter discipline to avoid unintended query pollution
- may increase index and search-path complexity inside the existing collection

## Option B: Dedicated Session-Evidence Collection/Lane

This option creates a dedicated session-evidence collection or equivalent physical lane, while keeping the same planner and retrieval authority.

Likely file surfaces:
- a new session-evidence module under `packages/memory-engine/src/`
- `packages/memory-engine/src/mongodb-schema.ts`
- `packages/memory-engine/src/mongodb-search.ts`
- `packages/memory-engine/src/mongodb-manager.ts`
- `packages/memory-engine/src/mongodb-hybrid.ts` if JS merge remains the comparison path

### Benefits

- avoids mixing very different evidence granularities in one collection
- closer to the existing `kb_chunks` precedent for a distinct source family
- minimizes impact on unaffected turn-level query paths
- makes the session-evidence experiment more isolated

### Risks

- easier to drift into “parallel retrieval brain” behavior if lifecycle/provenance/traces diverge
- loses same-collection native fusion for session + turn unless representation changes
- can look architecturally clean while quietly creating long-term coordination burden

## Explicitly Rejected

The following are not valid outcomes of this ADR:

- second planner
- second memory runtime
- benchmark-only hidden store with no provenance discipline
- public feature sprawl that exposes the storage choice as user complexity

## Canary Experiment

The ADR winner is chosen on a stable stratified canary, not on a full benchmark first.

### Controlled conditions

Both candidates must use the same:

- benchmark subset
- query-time scoring layer
- reranker settings
- benchmark metadata wiring
- trace output schema
- provenance requirements

### Metrics

Compare both options on:

- session-level `R@5`
- session-level `R@10`
- weakest-type lift, especially:
  - `single-session-user`
  - `single-session-preference`
- latency
- trace clarity
- provenance quality

### Tie-break rules

If the retrieval metrics are meaningfully different, the higher-quality option wins.

If the metrics are effectively tied, choose the option that best preserves:

1. one retrieval authority
2. provenance simplicity
3. lower long-term harmony risk
4. lower permanent query/index tax on unrelated paths

## Decision Record Template

When the canary is run, append:

- winning option
- commit hash
- canary artifact path
- top-line metrics
- weakest-category comparison
- latency comparison
- rationale for closing the losing path

## Current Recommendation

Do **not** pre-bake the answer now.

The correct next move is:

1. build the shared scoring/tracing substrate
2. run the ADR canary experiment
3. lock the winner
4. close the losing path explicitly before the final retrieval wave continues
