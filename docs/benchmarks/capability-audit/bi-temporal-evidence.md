# Scope-expansion SE-1 — Bi-temporal Memories (4-layer evidence)

> Task 2.SE-1 (ADR-006). Capability files:
> - `packages/memory-engine/src/mongodb-bitemporal.ts` (new, scope-2)
> - `packages/memory-engine/src/mongodb-schema.ts` (validAt/invalidAt fields
>   + compound index on events)
>
> **fast-check seed (correctness invariant): 20260512.**

## Motivation

Zep's public methodology leads Memongo by ~15 points on temporal queries
because of bi-temporal modeling. ADR-006 adopts `validAt` (when an
assertion became true) + `invalidAt` (when it stopped being true; null =
still valid). Retrieval at `queryTime = T` MUST satisfy:

```
validAt <= T AND (invalidAt IS NULL OR invalidAt > T)
```

## Silent-bug risks

- Retrieval returning memories whose `invalidAt < queryTime`.
- Legacy pre-migration rows (no `validAt`) being excluded.
- Compound index missing causing full-scan regressions.

## Layer 1 — Unit

Tests at `packages/memory-engine/src/mongodb-bitemporal.test.ts`:

- `buildBitemporalFilter(queryTime)` returns the correct `$and` shape.
- `isMemoryValidAt` predicate accepts legacy rows (no `validAt`) and
  rejects rows whose `invalidAt <= queryTime`.
- Exit-code evidence: `CI=true bunx vitest run
  packages/memory-engine/src/mongodb-bitemporal.test.ts` → exit 0, 8/8
  passed (recorded at commit `ede613d4e8`).

## Layer 2 — Integration

- Schema validation at `mongodb-schema.test.ts` asserts events schema
  includes `validAt` (date) + `invalidAt` (date | null).
- Standard-indexes test asserts the compound index
  `{ agentId: 1, scope: 1, scopeRef: 1, validAt: 1, invalidAt: 1 }` with
  name `idx_events_agent_scope_scoperef_validAt_invalidAt` is created.
- Index count bumped 84 → 85 (recorded in test).

## Layer 3 — E2E

- Bridge-level `recallConversation` test confirms bi-temporal filter is
  applied under atlas-local:preview. (Wired during scope-2 integration
  pass; runs at Gate 3.)

## Layer 4 — Correctness invariant (fast-check)

- **Property 11 (plan line 551):** no retrieval returns a memory where
  `invalidAt <= queryTime`.
- Property duality (partition): filtered ∪ rejected = input, and the two
  sets are disjoint.
- Generator: arrays of up to 100 memories, each with independent random
  `{ validAtMs, invalidAtMs }`; random queryMs.
- Seed: **20260512**, 500 runs (Property 11) + 200 runs (duality).

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-bitemporal.test.ts
# exit 0, 8/8 passed (2026-05-12)

CI=true bunx vitest run packages/memory-engine/src/mongodb-schema.test.ts
# exit 0, 111/111 passed (2026-05-12)
```

## Citations

- `mongodb.com/docs/manual/core/indexes/index-types/index-compound/`
- MongoDB MCP `search-knowledge` query:
  `"MongoDB bi-temporal index compound index validAt invalidAt"`.

_Last updated: 2026-05-12._
