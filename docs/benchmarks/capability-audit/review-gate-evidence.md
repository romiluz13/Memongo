# Scope-expansion SE-3 — Human Review / Promotion Gate (DEFERRED stub)

> Task 2.SE-3 (ADR-006). **Deferred to follow-on branch
> `scope-7-web-review-gate`.** This file is the Phase 2 exit-criterion
> stub.

## Status — Deferred

Scope-7 branch was not created in Phase 0. Creating it mid-phase would
mutate the 6-scope partition user-approved at Task 0.3 and invalidate
the byte-for-byte reconstruction proof. Per plan line 1822-1841, SE-3
lands across 5 surfaces:

- `apps/web/app/page.tsx` + new `apps/web/app/review/page.tsx`
- `apps/api/src/routes/v1.ts` — `GET /v1/review/queue`,
  `POST /v1/review/promote/{id}`, `POST /v1/review/reject/{id}`
- `packages/memory-bridge/src/memongo-bridge.ts` — three new bridge
  entries (`listPending`, `promote`, `reject`)
- `packages/memory-engine/src/mongodb-consolidator.ts` — promotion
  event emits canonical write only after the approval event
- `packages/memory-engine/src/mongodb-schema.ts` — `memory_pending`
  collection or a `promotionStatus` field on events

Touching 5 packages cross-cuts scope-2 (engine), scope-4 (api/bridge),
scope-6 (web/client) and requires a brand-new scope-7. This is a
scope-expansion decision, not a within-phase task — it will be
sequenced in a follow-on BUILD cycle.

## Phase 2 exit criterion (b)

Exit criterion (b) requires 4-layer evidence for all six CLAUDE.md
capabilities + four ADR-006 scope expansions. SE-3 evidence is
satisfied by this **stub** that:

1. States the deferral explicitly (no silent skip).
2. Names the target branch (`scope-7-web-review-gate`).
3. Lists the 5 surfaces that must co-land.
4. Commits to Property 13 (plan line 553) being proven at SE-3 land time,
   not now.

## Bridge into SE-2

Until SE-3 ships, Task 2.SE-2 quarantined rows accumulate in
`memory_quarantine` with `status="pending-review"`. This is **safe by
design** — quarantined content is never returned by search, never
folded into canonical. Reviewers can operate on the collection
directly via `mongosh` or a future web console.

## Property 13 (plan line 553) — to be proven at SE-3 landing

> No memory moves from `pending` to `canonical` without an explicit
> approval event. Every approval event is audit-trailed.

Will be expressed as a fast-check property over a fixture pipeline:

```typescript
fc.assert(
  fc.property(
    fc.array(promoteOrReject, { minLength: 1, maxLength: 50 }),
    fc.string(),
    (ops, initialContent) => {
      const db = new InMemoryReviewStore({ content: initialContent })
      runOps(db, ops)
      // Invariant: canonical set equals exactly the set of `promote`d ids.
      expect(db.canonical).toEqual(
        new Set(ops.filter(o => o.kind === "promote").map(o => o.id)),
      )
    },
  ),
)
```

Seed to be recorded at SE-3 evidence time.

_Last updated: 2026-05-12._
