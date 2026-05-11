# Recommended Defaults — Sign-Off Record (Task 0.5)

**Date:** 2026-05-11
**Builder workflow:** CC10X BUILD (Phase 0)
**Checkpoint type:** `human_verify`
**Outcome:** **ALL 3 DEFAULTS APPROVED** by user.

The 3 recommended defaults below are locked for Phase 1 and Phase 2 implementation. Any subsequent change requires a fresh `[CHECKPOINT — human_verify]` gate.

---

## 1. `numCandidates` table by top-k — APPROVED

**Value:**

| `limit` (top-k) | `numCandidates` |
|---:|---:|
| 5 | 200 |
| 10 | 200 |
| 20 | 400 |
| 30 | 600 |

**Rationale (from the plan's `Recommended Defaults` section):**
- `$vectorSearch` requires `numCandidates ≥ 20 × limit` for stable recall.
- Values above bake in ≥40× multiplier at small top-k (5, 10) for safety margin under binary quantization.
- 20× ratio retained at larger top-k (20 → 400, 30 → 600) to balance latency.
- Source: MongoDB MCP knowledge-base guidance on `$vectorSearch.numCandidates` (already cited in the plan design).

**Effect on downstream tasks:**
- **Task 2.R2 Sub-path A proceeds as code change** — the `numCandidates` lookup table lands in `packages/memory-engine/src/mongodb-manager.ts` (or the retrieval planner as decided during Phase 2 TDD).
- No proposal-only downgrade.

## 2. Failure-classification taxonomy — APPROVED (9-class)

**Enum:**
```
harness-timeout | model-failure | json-parse | index-not-ready | scope-leak | retrieval-miss | queue-settle-timeout | probe-timeout | unknown
```

**Rationale:**
- Refines the design's 7-class list by splitting timeouts into root causes: `queue-settle-timeout` (background derivation stuck) vs `probe-timeout` (search convergence never stabilized) vs `harness-timeout` (outer wall-clock).
- Each class maps to a distinct operator remediation (wait longer, rebuild index, rotate API key, open investigation).
- `unknown` is a required fallback; a strict run that emits `unknown` still aborts, but the artifact preserves the unclassified context.

**Effect on downstream tasks:**
- **Task 1.4 ships the 9-class taxonomy** (not the design's 7-class baseline).
- Canary envelope adds `failureClass` field with the 9-class enum.

## 3. Readiness-probe upgrade timing — APPROVED at Gate 1

**Decision:**
- Replace the current aggregate `$search` probe with `$listSearchIndexes → status==READY + queryable==true` based probe **at Gate 1**, NOT at Gate 2.
- Ship a small helper `readSearchIndexStatus` extracted from `packages/memory-engine/src/mongodb-schema.ts` (or adjacent) so the probe is unit-testable independently of the full benchmark harness.

**Rationale:**
- `Stale` status (queryable but replication stopped) is silently indistinguishable from `Ready` under the aggregate `$search` probe.
- Upgrading at Gate 1 means every forced-failure canary in Phase 1 and every live canary in Phase 3+ uses the better probe, so a 500-case run never hangs behind a stale index.
- Source: MongoDB MCP knowledge-base finding #4 (`$listSearchIndexes` API + `Ready` vs `Stale` semantics).

**Effect on downstream tasks:**
- **Task 1.5 ships the `$listSearchIndexes` probe** (not the Gate-2-deferred variant).
- Aggregate `$search` probe remains as a fallback behind `MEMONGO_BENCHMARK_PROBE_LEGACY=1`.

---

## Sign-Off Record

- **Presented by:** component-builder agent (CC10X BUILD Phase 0 Task 0.5)
- **Decided by:** User
- **Timestamp:** 2026-05-11
- **Outcome:** All 3 approved, no conditions.

## Traceability

- Plan reference: `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md` (Task 0.5 section, "Recommended Defaults sign-off checkpoint").
- Decision log mirror: will be appended to `docs/benchmarks/longmemeval-decision-log.md` during Phase 2 (keeps the log chronologically accurate).
- Memory: `.cc10x/v10/activeContext.md ## Decisions` — 2026-05-11 Task 0.5 entry.
