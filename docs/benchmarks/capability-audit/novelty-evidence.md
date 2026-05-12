# Capability 2 — Surprisal Novelty (4-layer evidence)

> Task 2.C2. Capability file:
> `packages/memory-engine/src/mongodb-novelty.ts`.
> **fast-check seed (correctness invariant): 20260512.**

## Silent-bug risks

- Stale baselines (not updated on new events).
- Scope leak across `(agentId, scope, scopeRef)`.
- Divide-by-zero on cold start (empty baseline).

## Layer 1 — Unit

- Score bounds: `novelty ∈ [0, 1]` for every path.
- Math correctness: identical event → 0 novelty (trusted baseline).
- Cold-start: first event returns a defined score (never NaN / Infinity).

Tests at `packages/memory-engine/src/mongodb-novelty.test.ts`.

## Layer 2 — Integration

- Persisted baselines read/write against atlas-local:preview.
- Cold-start: fresh agent, first scan_novelty returns `[0..1]`.
- Scope isolation: two agents with identical content bodies do not share
  baselines.

## Layer 3 — E2E

- `POST /v1/novelty-scan`. Request `{ agentId, scope, scopeRef, events: [...] }`.
- Response includes `novelty` field per event; aggregate on the envelope.

## Layer 4 — Correctness invariant (fast-check)

- **Property 9 (plan line 548):** score in `[0, 1]`.
- Property: monotonic under identical context (repeated same event has
  non-increasing novelty).
- Generator: random event bodies (strings), repeated injection schedules.
- Seed: **20260512**, 300 runs.

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-novelty.test.ts
# E2E via canary at Gate 3; artifact in artifacts/canary-runs/gate3-*/
```

## Open items

- Property test for "score stable under seed" currently asserted in
  deterministic-mode. Non-deterministic baseline updates are a Gate-5
  ablation candidate.

_Last updated: 2026-05-12._
