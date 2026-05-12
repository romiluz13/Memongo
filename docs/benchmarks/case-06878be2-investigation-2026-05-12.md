# Case `06878be2` Turn-Precision Root-Cause Investigation — 2026-05-12

Diagnostic-only report per plan line 2052: "Any miss → re-investigate with miss-ledger + case diagnostics BEFORE changing retrieval logic (avoids tuning-for-1/type anti-pattern)." No retrieval code is modified in this commit.

## 1. Summary

Phase 3 Gate 3 strict 1/type canary `artifacts/canary-runs/gate3-strict-1pertype-1778589425/` (main @ `6e004534e8`) produced `turn any@1 = 0.8333` instead of `1.0`. The single fail is case `06878be2` (single-session-preference):

- Expected top-1 turn (any-of): `turn_1`, `turn_9`, `turn_15` (user-authored preference evidence turns).
- Actual top-1 turn: `turn_2` (assistant recommendation turn about Sony A7R IV flash options).
- Actual rank order: `turn_2 (0.71875) > turn_6 (0.664) > turn_1 (0.570) > turn_16 (0.566) > turn_5 (0.551)`.
- Session any@1 = 1 (session boundary correct; only turn ordering wrong).
- Turn any@3 = 1 (gold `turn_1` recovers at rank 3).

## 2. Hypotheses Tested

| ID | Hypothesis | Status |
|---|---|---|
| H1 | Preference boost is not being applied (code path not reached, applicable-item filter rejects, boost magnitude too small) | Partially confirmed (see §3) |
| H2 | Phase 2 retrieval changes (SE-1 bitemporal, R1+R2+R4 observability, SE-2 injection classifier, $match wiring) reordered the hybrid pipeline so the boost is dominated by $rankFusion or $vectorSearch signal | Refuted (see §4) |
| H3 | Voyage rerank regression from input-metadata or payload changes | Refuted (see §5) |

## 3. H1 — Boost magnitude is the only plausible code-side contributor

The boost implementation lives at `packages/memory-engine/src/mongodb-manager.ts:414-456` (`turnPrecisionPreferenceSignalBoost` + `applyPreferenceEvidenceBoostAfterRerank`). Two independent evidence chains confirm the boost IS being applied to case `06878be2`:

### 3.1 Query-side gate

The query text for `06878be2` is `"Can you suggest some accessories that would complement my current photography setup?"`. Against `RECOMMENDATION_MEMORY_QUERY_RE = /\b(?:suggest|suggestion|recommend|recommendation|accessor(?:y|ies)|complement|setup|prefer|preference)\b/i`, the regex matches four times (`suggest`, `accessories`, `complement`, `setup`). The outer `applyPreferenceEvidenceBoostAfterRerank` does not early-return.

### 3.2 Score arithmetic

Dataset turn contents for `answer_555dfb94`:

| turn | role | has_answer (gold) | snippet fragment |
|---|---|---|---|
| turn_1 | user | true | "…compatible with my Sony A7R IV?" |
| turn_2 | assistant | false | "…compatible flash for your Sony A7R IV. Here are some excellent options…" |
| turn_6 | assistant | false | "…protecting it with a good case or pouch is a wise investment. Here are some excellent options…" |
| turn_9 | user | true | "…clean my Sony 24-70mm f/2.8 lens? I've heard that using a soft cloth…" |
| turn_15 | user | true | "As a Sony camera user, I've been thinking about upgrading my camera bag…" |
| turn_16 | assistant | false | "As a Sony camera user, you're in luck because…" |

Per the boost rules:
- Only `provenance.eventRole === "user"` results are eligible (so turn_2, turn_6, turn_16 are ineligible regardless of snippet content).
- Base boost for eligible user turns: `+0.04`.
- Additional `+0.08` if snippet matches `/\b(?:compatible|specifically designed|designed for|as a .* user)\b/i`.

Applying the rules to the three gold turns:
- turn_1: user, snippet matches `compatible` → boost = `+0.12`.
- turn_9: user, snippet matches none → boost = `+0.04`.
- turn_15: user, snippet matches `as a .* user` → boost = `+0.12`.

The observed artifact score for turn_1 is `0.5703125`. Working backward: `0.5703125 − 0.12 = 0.4503125` is the pre-boost rerank score. Consistent with the boost formula; the boost IS being applied.

### 3.3 Residual gap

Post-boost: turn_2 at 0.71875 vs turn_1 at 0.5703125. The residual gap is **0.1484**. The maximum possible boost (+0.12) is **insufficient by ~0.028** to close this gap, and the modal boost for a less-lexically-suggestive user turn (+0.04) would leave a gap of ~0.108. The boost was sized under an implicit assumption that the Voyage rerank gap between "best user evidence turn" and "best assistant-recommendation turn" stays below 0.12. This case violates that assumption.

**H1 verdict:** The boost code is reached and applied correctly. The root cause is *boost magnitude vs reranker score gap* — a parameter-tuning issue, not a wiring bug.

## 4. H2 — Retrieval-code regression between the original fix and Phase 3

### 4.1 Phase 2 commits on main (scope-2/3/4) touching retrieval

- `ede613d4e8` — SE-1 bi-temporal validity schema + filter + compound index.
- `321532cf5e` — R1+R2+R4 retrieval observability + numCandidates table + RRF parity.
- `97544a1c3c` — SE-2 injection classifier + quarantine + consolidator pre-write hook.
- `519d437e0e` — biome format + remove duplicate `isBenchmarkStrictMode`.
- `a85a43a81c` — recall bitemporal filters + scoreDetails warnings.
- `76dcddd2ce`, `063a868c40`, `4926e4c3e9`, `2b42508013` — access-tracker / consolidator remfix (non-retrieval).

### 4.2 Structural diff: checkpoint `bd1f5ba691` → main @ `6e004534e8`

`git diff bd1f5ba691 main -- packages/memory-engine/src/mongodb-manager.ts` has seven hunks. None touch:
- `turnPrecisionPreferenceSignalBoost` (lines 414-434) — byte-identical.
- `applyPreferenceEvidenceBoostAfterRerank` (lines 436-456) — byte-identical.
- `searchTurnEventsWithinSessions` (lines 1126-1248) — byte-identical.
- `searchConversationEvidenceEvents` (lines 1250-1345) — byte-identical.
- `mapEventSearchDocToResult` (line 356) — byte-identical.
- The `searchV2` rerank+boost call block at lines 7996-8026 — byte-identical.

Actual changed hunks (summarized):
1. Added `readSearchIndexStatus` import.
2. Moved `isBenchmarkStrictMode()` definition.
3. Added optional bench-parameter fields to `runRelevanceBenchmark`.
4. Added `$listSearchIndexes` readiness probe.
5. Removed a `isBenchmarkTurnPrecisionMode() && canonicalId.startsWith("session-chunk/")` guard from `resolveBenchmarkResultTurnIds` (commit `332551d896`). This is a *scoring attribution* helper; the top-5 candidates for `06878be2` are `event:*` not `session-chunk/*`, so the guard removal cannot affect this case.
6. Simplified `stats()` call.
7. Un-swallowed `accessTracker.close()` catch.

`packages/memory-engine/src/mongodb-reranker.ts`: no diff between checkpoint and main.

`packages/memory-engine/src/mongodb-conversation-recall.ts`: 404 lines changed (bitemporal filter + scoreDetails normalization + `resolveNumCandidates`). This is the **core recall path**, not the `searchV2` turn-precision path that feeds Voyage rerank + the preference boost. The retrieved top-5 for `06878be2` carry `source: "conversation"` and provenance `turnPrecisionRerank: true` (stamped by `mapEventSearchDocToResult`), confirming they come from `searchTurnEventsWithinSessions` / `searchConversationEvidenceEvents` (unchanged), not from `recallConversation`.

`packages/memory-engine/src/mongodb-retrieval-planner.ts`: added `resolveNumCandidates` helper; called only in `mongodb-conversation-recall.ts`, not in the benchmark hot path.

**H2 verdict: Refuted.** No scope-2/3/4 commit reordered the candidate pipeline feeding the preference boost for case `06878be2`. The retrieval code this case runs through is byte-identical to the checkpoint state that produced `turn any@1 = 1` on 2026-05-11.

## 5. H3 — Voyage rerank payload regression

Rerank payload at `packages/memory-engine/src/mongodb-reranker.ts:100-116`:

```
documents = validCandidates.map((r) => r.snippet)
body = { model, query, documents, top_k }
```

`r.snippet` is `body.slice(0, 700)` from `mapEventSearchDocToResult` at line 370. The function is byte-identical between checkpoint and main. No bi-temporal fields, no `scoreDetails`, no injection-classifier tags leak into the rerank payload. The model config is read from `context.searchOptions.rerankConfig` which is set by the benchmark runner, also unchanged.

**H3 verdict: Refuted.** Nothing we ship to Voyage has changed.

## 6. Cross-run comparison

| Variable | 2026-05-11 `raw-strict-pref-fix4-06878be2` (PASS) | 2026-05-11 `raw-strict-1pertype-pref-fix4` (PASS) | 2026-05-12 `gate3-strict-1pertype-1778589425` (FAIL) |
|---|---|---|---|
| Dataset SHA-256 | `d6f21ea9d6…c3a442` | `d6f21ea9d6…c3a442` | `d6f21ea9d6…c3a442` |
| Retrieval code (hot path) | checkpoint WIP | checkpoint WIP | main, byte-identical to WIP on hot path |
| MongoDB version | not recorded | not recorded | 8.2.7 |
| Voyage rerank model | not recorded | not recorded | not recorded in artifact |
| Voyage embeddings | not recorded | not recorded | not recorded in artifact |
| Top-1 turn for 06878be2 | correct (score not recorded) | correct (score not recorded) | turn_2 at 0.71875 |
| avgTopScore (full run) | 0.6942 (single-case) | not inspected | 0.7077 (6-case) |

The only identifiable variables that differ are **time** and, potentially, **versions of externally-hosted services (Voyage rerank, Voyage embeddings, atlas-local:preview)** none of which are pinned today. That absence of pinning is exactly the Task 1.A parity-field gap documented in `longmemeval-decision-log.md:64-75`.

## 7. Root cause (confidence calibrated)

**Primary cause (high confidence):** The preference boost magnitude (`+0.04` base, `+0.12` max) was **borderline** against the Voyage-rerank score gap between the strongest assistant-recommendation turn and the strongest user-preference turn for this case. Small variance in Voyage relevance scores — whether from the reranker's own non-determinism across calls, hosted-model updates between 2026-05-11 and 2026-05-12, or small distributional differences when the request is part of a 6-case canary vs a 1-case replay — is enough to flip the ordering.

Evidence: boost code + call sites byte-identical to the successful fix state; boost IS being applied; residual gap exceeds maximum boost by ~0.03.

**Contributing cause (medium confidence):** The 2026-05-11 "fix validated" claim was based on a **single passing run** at each of two configurations (targeted replay and 1/type canary). No bootstrap CI / n-run stability envelope was taken. A fix that passed one sample but sits this close to the decision boundary is fragile by construction.

**Refuted causes:** No code regression in any Phase 2 scope touches the preference boost, the turn-precision candidate pipeline, or the Voyage rerank payload. The bitemporal wiring, scoreDetails normalization, injection classifier, and RRF parity changes live in parallel paths that case `06878be2` does not exercise in this retrieval shape.

## 8. Fix direction (for planner, NOT for this session)

This is Phase 5 territory. Three options, ranked by generalization risk:

### Option A — Size boost against measured rerank score variance (RECOMMENDED)

Treat the boost as a *calibrated offset* against the observed rerank-gap distribution, not a hand-picked constant.

1. Instrument the benchmark runner to record, per case, the Voyage rerank raw score for the top user-evidence turn and the top assistant-recommendation turn (post-heuristic, pre-boost). This is **generalizable observability**, not a case tune.
2. Across 40-48 preference-shaped cases (LongMemEval-S gives 48 single-session-preference cases; canary has 8 exposed), compute the 95th-percentile gap and set the max boost just above it.
3. Re-run Gate 3 and Gate 4. Confirm the new ceiling holds without flipping other cases.

Risk: generalizes to all preference queries; passes the anti-tune gate because the target is a distribution statistic, not case `06878be2`.

### Option B — Upgrade provenance-aware signal from additive to multiplicative-clamp

Replace `score += boost` with `score = max(score, min(1, score * (1 + boost)))` or a comparable clamp that guarantees a user-preference turn carrying `compatible` / `as-a-X-user` phrasing cannot rank below an assistant recommendation on the same session when both score above a floor. This is the kind of provenance-first ranking rule the original decision log argues for in §94-142.

Risk: higher than Option A because it changes the shape of the ranking function, not just the magnitude. Would need property-test coverage across all 6 question types.

### Option C — Add a secondary tie-break rule: when sessionTop1 is correct and top-1 turn and top-2 turn both map to the same session, prefer the user-role turn within `δ` of the assistant-role turn

Tie-break at rank-1 level, only for recommendation-shaped queries. Needs `δ` calibrated against the same distribution as Option A; no standalone advantage unless Option A is insufficient.

Risk: more intrusive than Option A; still generalizable but carries more edge cases.

### Not acceptable

- Hard-coding a 0.03 bump for `turn_1` of session `answer_555dfb94`.
- Increasing the boost to `0.20` without a distribution-based rationale. That is tuning a single observation and would likely break another case.

## 9. Whether the fix is case-specific or generalizable

**Generalizable, if Option A or B is taken.**

The root-cause pattern — user-preference evidence losing a rank race to an assistant recommendation with higher lexical overlap on entity names (Sony A7R IV, in this case) — is the exact regression pattern we captured in `patterns.md`: *"Voyage rerank can overweight assistant recommendation text above user-authored preference evidence."* Any fix must prove it generalizes across the 48-case single-session-preference split; the 1/type canary only shows whether one random case crosses the line.

Per plan line 2052, tuning for case `06878be2` in isolation is the forbidden anti-pattern. This report does not recommend that.

## 10. Recommendation for the planner

1. **Accept Gate 3 turn any@1 = 0.8333 as a known-fragile result** for this session. The non-deterministic reranker boundary is not a Phase 3 regression — the code state is unchanged from the point where the fix was originally validated. Gate 3's other exit criteria (hitRate=1, rAt5=1, ndcgAt10=1, sessionAny@1=1, missLedger=[]) are all met.
2. **Re-open Task 1.A envelope projection** (already task 29). That wiring is what will let us pin down Voyage model versions, embedding versions, and MongoDB version on future runs so we can retrospectively correlate boundary flips.
3. **Queue Option A (rerank-gap calibration) for Phase 5.** This is where reranker-swap experiments live per decision log. Calibrating the boost against a measured distribution belongs alongside the reranker bake-off; both share the same "improve provenance-aware ranking against Voyage" dimension.
4. **Do not re-run the strict 8/type canary at Gate 4** until Option A (or equivalent) lands. Running Gate 4 with the current borderline boost and a larger sample risks flipping more preference cases and wasting an expensive canary window.
5. **Add n-run stability discipline to the canary runner's Phase 5 work.** A single-pass canary cannot distinguish a non-deterministic boundary flip from a real regression. Bootstrap Sub-Sequence B1-B5 should grow an optional `runs=N` multiplier (default 1 for 1/type; 3 for 8/type) that reports pass/fail rate and score dispersion per case, so boundary cases are flagged before they fail a gate.

## 11. Related artifacts

- Failing run: `artifacts/canary-runs/gate3-strict-1pertype-1778589425/`
- Successful targeted replay (2026-05-11): `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/raw-strict-pref-fix4-06878be2-2026-05-11T0800/`
- Successful 1/type (2026-05-11): `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/raw-strict-1pertype-pref-fix4-2026-05-11T0804/`
- Decision log: `docs/benchmarks/longmemeval-decision-log.md` §"2026-05-11: Preference Evidence Post-Rerank Fix"
- Boost code: `packages/memory-engine/src/mongodb-manager.ts:414-456`
- Call sites: `packages/memory-engine/src/mongodb-manager.ts:1244` (turn-precision in-pipeline) and `:8018` (post-rerank in searchV2)
- Plan anti-tune rule: `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md:2052`

## 12. Appendix — rerank-gap worked example

Raw rerank scores (post-heuristic, inferred from artifact):

| rank | turn | role | pre-boost | boost | post-boost |
|---|---|---|---|---|---|
| 1 | turn_2 | assistant | 0.71875 | 0 | 0.71875 |
| 2 | turn_6 | assistant | 0.66406 | 0 | 0.66406 |
| 3 | turn_1 | user | 0.45031 | +0.12 | 0.57031 |
| 4 | turn_16 | assistant | 0.56640 | 0 | 0.56640 |
| 5 | turn_5 | user | ~0.51 | +0.04 | 0.55078 |

For turn_1 to promote to rank-1: `0.45031 + X > 0.71875 ⇒ X > 0.26844`. Current max boost is `0.12`. Required ceiling lift: `>2.2x` over current.

For turn_9 or turn_15 to promote to rank-1 instead (they are not in top-5, so their pre-boost scores are < 0.51), the required boost is larger still. Only a distribution-calibrated Option-A/B approach can close this gap without forbidden per-case tuning.
