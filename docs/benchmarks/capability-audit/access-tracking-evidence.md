# Capability 3 — Access Tracking (4-layer evidence) **[PRIME SUSPECT]**

> Task 2.C3. Capability file:
> `packages/memory-engine/src/mongodb-access-tracker.ts`.
> **fast-check seed (correctness invariant): 20260512.**

## Design justification (pass-1 A1 response)

AccessTracker is **engine-internal**. No HTTP route and no MCP tool call
it directly — it is invoked **transitively** by search / recall / KB read
paths. Layer 3 is therefore reshaped to **"Engine boundary integration"**
rather than "E2E" with an explicit rationale: any future HTTP / MCP
surface would be a new consumer, not a fix for a missing one.

The three bridge-level entry points that transit the tracker are
enumerated in Layer 3 below; they fully exercise the read path.

## Silent-bug risks

- Batched writes losing recency on crash (SIGTERM between flush windows).
- Race between batch flush and a concurrent read.
- Monotonicity violation if the batch coalesces increments incorrectly.

## Layer 1 — Unit

- Batch flush logic + dedup
  (`mongodb-access-tracker.test.ts`).
- Assertions:
  - Flush count matches reads within one flush window.
  - Dedup: two reads in the same flush window are counted twice (not
    collapsed to one).

## Layer 2 — Integration

- 100 reads through `memongoBridgeRecallConversation` (NOT directly
  against the tracker).
- Verify: batched write count matches read count.
- SIGTERM mid-batch → assert count never goes backwards on restart.

## Layer 3 — Engine boundary integration (renamed from "E2E")

Three external entry points transit the tracker:

1. `memongoBridgeSearch` (full semantic + hybrid search).
2. `memongoBridgeRecallConversation` (per-conversation recall).
3. `memongoBridgeSearchKB` (knowledge base read).

Assertion: every read via these entries increments the tracker exactly
once. Also assert: the SIGTERM handler drains the batch within
`FLUSH_TIMEOUT_MS` (configurable; default 5000ms).

## Layer 4 — Correctness invariant (fast-check)

- **Property 5 (plan line 546):** access count is monotonic under
  sequential reads.
- Property: batch drain completes on shutdown signal within
  `FLUSH_TIMEOUT_MS`.
- Generator: sequences of `{ eventId, timestamp }` pairs sorted by
  timestamp; simulated shutdown at a random index.
- Seed: **20260512**, 200 runs.

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-access-tracker.test.ts
# Shutdown property runs under fast-check with simulated SIGTERM.
```

## Open items

- Layer-3 coverage is exercised transitively; no dedicated
  bridge-exposed tracker endpoint is added (by design).
- AccessTracker fsync-on-shutdown hook needs explicit test at Gate 3
  bootstrap sub-sequence.

_Last updated: 2026-05-12._
