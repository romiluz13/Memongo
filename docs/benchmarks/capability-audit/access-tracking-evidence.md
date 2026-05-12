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

- **Property 5** (plan line 546) — implemented at
  `packages/memory-engine/src/mongodb-access-tracker.test.ts:326–` under
  "fast-check Property (CRIT-4): total flushed $inc count === total
  recordAccess calls" (commit `76dcddd2ce`).
  - Generator: sequences of `recordAccess(eventKey)` calls over up to 50
    random keys; fresh `AccessTracker` + fake collection per run (so state
    leakage across runs is impossible).
  - Assertion: sum of `$inc.accessCount` across all `bulkWrite` operations
    equals `calls.length` — no count loss, no count duplication.
  - Seed: **20260512**, 200 runs.

Supporting HIGH-4 regression test at `mongodb-access-tracker.test.ts:259–324`:

- First flush fails (`insertMany` rejects); second flush succeeds with
  the re-buffered snapshot — total `$inc` count across both attempts still
  equals the number of `recordAccess` calls, proving the deadletter path
  never loses counts.

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-access-tracker.test.ts
# 2026-05-12: exit 0, 11/11 passed (HIGH-4 re-buffer + CRIT-4 property added).
```

## Open items

- Layer-3 coverage is exercised transitively; no dedicated
  bridge-exposed tracker endpoint is added (by design).
- AccessTracker fsync-on-shutdown hook needs explicit test at Gate 3
  bootstrap sub-sequence.

_Last updated: 2026-05-12._
