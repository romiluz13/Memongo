# Capability 4 — Importance Decay (4-layer evidence) **[PRIME SUSPECT]**

> Task 2.C4. Capability file:
> `packages/memory-engine/src/mongodb-trust.ts`.
> **fast-check seed (correctness invariants): 20260512.**

## Silent-bug risks

- `temporalScope=permanent|ongoing` guard failing → important memories
  rot silently.
- Decay formula produces values outside `[0, 1]` under unusual inputs.
- Non-monotonic under no-access (impossible but has shipped before).

## Layer 1 — Unit

- `computeImportanceDecay()` property test on small fixed inputs.
- Assertions:
  - `{ temporalScope: "permanent", ageMs: 365 * 24 * 3600 * 1000 }` →
    no decay (output === input importance).
  - `{ temporalScope: "ongoing" }` → no decay.
  - `{ temporalScope: "temporary", ageMs: 30 * 24 * 3600 * 1000 }` → strictly
    less than input importance.

## Layer 2 — Integration

- Decay over 30-day time window with mixed `temporalScope` values.
- Fixture: 100 events with 25% permanent / 25% ongoing / 50% temporary.
- Assert: permanent/ongoing rows preserve importance exactly; temporary
  rows decay per the curve.

## Layer 3 — E2E

- Full scan + re-rank after simulated 30-day `asOf` advance.
- Assert: top-K ordering respects non-decayed permanent rows (they
  surface above decayed-temporary rows of equal-initial importance).

## Layer 4 — Correctness invariants (fast-check)

Three linked invariants (plan lines 544-545):

- **Property 1:** `temporalScope ∈ { "permanent", "ongoing" }` → NEVER
  decays.
- **Property 2:** output always in `[0, 1]`.
- **Property 3:** monotonic decreasing under no-access (temporary
  memories).

Generator: random `{ importance ∈ [0,1], temporalScope, ageMs, lastAccessMs }`.
Seed: **20260512**, 500 runs.

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-trust.test.ts
# Importance property test seed confirmed in test output header.
```

## Open items

- Add explicit "age=0" boundary test (ensures the decay curve's initial
  value equals input importance exactly).
- Gate 5 ablation: compare `halfLifeDays=30` vs `halfLifeDays=60` on
  held-out LongMemEval-S split.

_Last updated: 2026-05-12._
