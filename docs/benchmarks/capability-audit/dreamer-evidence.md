# Capability 6 — Dreamer Consolidator (4-layer evidence) **[PRIME SUSPECT]**

> Task 2.C6. Capability file:
> `packages/memory-engine/src/mongodb-consolidator.ts`.
> **fast-check seed (correctness invariant): 20260512.**

## Silent-bug risks

- Cross-scope merge (catastrophic — user A's fact shows up under user B).
- Provenance loss (`sourceEventIds` missing the contributing events).
- Consolidation swallowing an injection-shaped candidate (now defended
  at Task 2.SE-2 pre-write hook).

## Layer 1 — Unit

- Dedup math + merge-decision logic
  (`mongodb-consolidator.test.ts`).
- Assertions:
  - Similar candidates above `SIMILARITY_THRESHOLD_NOOP` (0.85) skip
    promotion; below the threshold ADD.
  - Conflict detection short-circuits promotion.

## Layer 2 — Integration

- 10 events → consolidated memory against atlas-local:preview.
- Assert every consolidated memory's `sourceEventIds` preserves
  provenance (superset of source event ids, no silent omission).

## Layer 3 — E2E

- `POST /v1/consolidate` followed by read-back through `/v1/search`.
- Assert consolidated facts appear under the owning `(agentId, scope,
  scopeRef)` and not under any sibling scope.

## Layer 4 — Correctness invariant (fast-check)

- **Property 4 (plan line 545):** no consolidated memory's
  `sourceEventIds` spans more than one `scopeRef`; cross-`scopeRef`
  merge NEVER occurs.
- Generator: random event sets with intentionally overlapping bodies
  across scopes; assert the consolidator never merges rows across
  scopeRefs.
- Seed: **20260512**, 300 runs.

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-consolidator.test.ts
# E2E via Gate 3 canary — artifacts/canary-runs/gate3-*/consolidate.json
```

## Open items

- The Dreamer pre-write hook from Task 2.SE-2 now routes
  injection-likely candidates to `memory_quarantine` with
  `status="pending-review"`. SE-3 (human review gate) is deferred to
  `scope-7-web-review-gate`; until SE-3 ships, quarantined rows remain
  pending indefinitely — by design, never silent.

_Last updated: 2026-05-12._
