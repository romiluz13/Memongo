# Held-Out Private Split Protocol (Task 0.7)

**Purpose:** Maintain a private held-out split of LongMemEval-S that Memongo **never publishes scores on** unless the public split has already been reported. This is an overfitting-drift detector. It mirrors the MindStudio benchmark-hygiene recommendation (and directly answers MemPalace's self-documented test-set leakage — see `mempalace-forensic-audit.md` section 4).

## Invariant (Public, Load-Bearing)

1. Memongo **never publishes** metrics on the held-out split.
2. Gate 3, Gate 4, and every public canary report cite **only the public split (~450 cases)**.
3. Gate 5 runs the held-out split internally as a drift check.
4. **If `R@5` diverges by more than 5 points between public and held-out**, Gate 5 exit is **blocked** and a root-cause investigation opens (overfit / dataset skew / provenance leak).
5. This document does **not** list the held-out question IDs.

## Split Methodology (Public)

- **Source:** `longmemeval_s_cleaned.json` at `$MEMONGO_WORKSPACE_DIR/benchmarks/` (default `~/.memongo/workspace/benchmarks/`).
- **Total cases in source:** 500.
- **Selection method:** uniform random sample, fixed seed.
- **Held-out count:** ~50 cases.
- **Public split count:** ~450 cases.
- **Seed:** recorded **only** in the private seed-meta file at `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_heldout_seed.json` (NOT tracked by git).

## Storage (Public)

| File | Location | Tracked? | Contains |
|---|---|---|---|
| Source cleaned dataset | `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_cleaned.json` | No | Full 500 cases |
| Held-out private split | `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_heldout.json` | No | ~50 held-out cases |
| Private seed + IDs meta | `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_heldout_seed.json` | No | Seed, held-out question IDs, SHA-256 |
| Public protocol doc | `docs/benchmarks/heldout-split-protocol.md` | Yes (scope-3) | This document |

All three workspace files live **outside** the repository tree. A `.gitignore` entry is not required because `git` does not track paths outside the working tree; the original plan's proposed `.gitignore` entry was corrected during pass-3 advisory review.

## Drift-Detection Rule

At Gate 5, the same pinned config runs twice:

1. Public split → `R@5_public`, `NDCG@10_public`, `any@1_public`.
2. Held-out split → `R@5_heldout`, `NDCG@10_heldout`, `any@1_heldout`.

Drift condition:

```
|R@5_public - R@5_heldout| > 5 points  →  BLOCK Gate 5 exit.
```

If drift triggers, the canary envelope records:
- both sets of metrics
- the gap
- suspected cause (Voyage cache bleed, index sharing, scope leak, preference-boost overfit, etc.)

## Reviewer Verification Protocol

A skeptical external reviewer can verify the protocol **without access to the held-out IDs** by:

1. Confirming the public split sums to ~450 cases.
2. Confirming Gate 5 artifacts contain **both** metric sets with gap < 5 points.
3. Requesting the private seed from the repository owner out-of-band (email / signed note) to independently regenerate the held-out sample and verify the SHA-256 matches.

The reviewer never needs the IDs themselves; they need only the seed + the source SHA to regenerate the split.

## Traceability

- Parent plan: `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md` Task 0.7.
- Related artifact: `docs/benchmarks/mempalace-forensic-audit.md` section 4 (MemPalace self-documented asymmetries).
- Gate 5 usage: plan Phase 5 drift-check step.
- Created: 2026-05-11.
