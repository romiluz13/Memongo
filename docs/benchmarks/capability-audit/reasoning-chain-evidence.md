# Capability 1 — Reasoning Chain (4-layer evidence)

> Task 2.C1. Capability file:
> `packages/memory-engine/src/mongodb-reasoning-chain.ts`.
> **fast-check seed (correctness invariant): 20260512.**

## Silent-bug risks

- Cycle detection failure (infinite traversal).
- Depth-guard off-by-one (`maxDepth` exceeded).
- Cross-scope chain leak (traversal crossing `agentId` or `scopeRef`).

## Layer 1 — Unit

- Tests at `packages/memory-engine/src/mongodb-reasoning-chain.test.ts`.
- Assertions:
  - Depth guard: `traceReasoningChain({ maxDepth: 3 })` returns at most 3
    hops even when underlying data has 10.
  - Cycle safety: self-referential `sourceEventIds` loop terminates.
- Command: `CI=true bunx vitest run packages/memory-engine/src/mongodb-reasoning-chain.test.ts`.

## Layer 2 — Integration

- Drive traversal through real `events` + `episodes` docs, scoped by
  `(agentId, scopeRef)`. Assert every traversed doc shares the same
  scope.
- Fixture: 4 events with a linear provenance chain, 2 events on a sibling
  scope (should never appear in traversal output).

## Layer 3 — E2E

- `POST /v1/chain-trace` round-trip against atlas-local:preview.
- Request: `{ agentId, factId, maxDepth: 4 }`.
- Response: chain with `hops.length <= 4`, every hop's `scope` +
  `scopeRef` matches input.

## Layer 4 — Correctness invariant (fast-check)

- **Property 8 (plan line 547):** depth ≤ `maxDepth`; no cycle re-entry.
- Random graph generator:
  - N nodes (N up to 20), random edges.
  - Inject intentional cycles with probability 0.3.
- Assert traversal terminates in bounded time, visits each node at most
  once.
- Seed: **20260512**, 200 runs.

## Commands (recorded at verification time)

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-reasoning-chain.test.ts
# Layer-3 e2e run lands at Gate 3 canary dir artifacts/canary-runs/gate3-*/
```

## Open items

- Layer-4 property test is currently engine-side (`maxDepth` + cycle)
  and will be explicitly anchored when the invariant test file lands on
  `scope-2-retrieval-ranking`.
- Layer-3 E2E is collected at Gate 3 (strict 1/type canary).

_Last updated: 2026-05-12._
