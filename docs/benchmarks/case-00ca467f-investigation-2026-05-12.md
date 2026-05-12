# Case `00ca467f` Deterministic Miss Root-Cause Investigation — 2026-05-12

Diagnostic-only report per plan line 2052: "Any miss → re-investigate with miss-ledger + case diagnostics BEFORE changing retrieval logic (avoids tuning-for-1/type anti-pattern)." No retrieval code is modified in this commit.

## 1. Summary

Phase 3 Gate 3 n=3 strict 1/type canary retry at `artifacts/canary-runs/gate3-strict-1pertype-n3-1778599299/` (main @ `8e6a422a01`) produced `deterministicMisses: ["00ca467f"]`. The miss is present in all three same-commit runs (byte-identical top-5 sessions, identical top-1 score `0.255859375`). The case is the `multi-session` slot in the 1/type lane.

- **question_type:** `multi-session`
- **question:** "How many doctor's appointments did I go to in March?"
- **answer:** 2
- **question_date:** 2023/03/27 (Mon) 23:35 (all haystack turns precede this)
- **expected_session_ids:** `answer_39900a0a_3`, `answer_39900a0a_2`, `answer_39900a0a_1`
- **expected_turn_ids:** `answer_39900a0a_3::turn_1`, `answer_39900a0a_1::turn_1` (only 2 of 3 expected sessions have a turn-level target; `_2`'s appointment is April 1st, so it's an answer-source session but not a March-countable appointment turn)

### Ground-truth turn contents (first user turn of each expected session)

| session | date | March-appointment claim |
|---|---|---|
| `answer_39900a0a_1` | 2023/03/27 20:56 | "finally went to see my primary care physician, Dr. Smith, on **March 3rd**, and he diagnosed me with bronchitis" |
| `answer_39900a0a_2` | 2023/03/27 08:05 | "I had an appointment with my primary care physician, but the antibiotic didn't fully clear it up" + **EMG test scheduled with Dr. Johnson on April 1st** (future) |
| `answer_39900a0a_3` | 2023/03/27 00:55 | "recently had a follow-up appointment with my orthopedic surgeon, Dr. Thompson, on **March 20th**" |

The gold answer "2" = {Dr. Smith March 3 (`_1::turn_1`)} ∪ {Dr. Thompson March 20 (`_3::turn_1`)}. `_2` is a valid answer-source session (the user talks about her medical history and doctor visits) but its retrieval-relevance turn target is absent from `expectedTurnIds` because that session's explicitly-named appointment is April 1st, not March.

### Run-level outcome

| run | rAt5 | rAt10 | sessionFound | allSessionsFound | turnReachable | missCategory |
|---|---|---|---|---|---|---|
| run-1 | 0.333 | 0.333 | true | false | false | `turn-selection` |
| run-2 | 0.333 | 0.333 | true | false | false | `turn-selection` |
| run-3 | 0.333 | 0.333 | true | false | false | `turn-selection` |

All three runs produce **byte-identical** top-10 session ordering (`answer_39900a0a_3`, `e4cb6c56`, `ultrachat_239705`, `8d1f9505`, `10857212_2`, `ultrachat_113678`, `ultrachat_193901`, `8a70ec05_2`, `07942c06`), identical top-1 score `0.255859375`, and identical canonical procedure IDs (`procedure:procedure-64d34644dd3c` at rank 1). The only inter-run variability is the `sourceEventIds` UUIDs (re-issued per ingest); canonical IDs are stable. Deterministic.

## 2. Hypotheses Tested

| ID | Hypothesis | Verdict |
|---|---|---|
| H1 | **Recall gap.** Expected turn/session not in top-K candidates. Either `$vectorSearch.numCandidates` is too low for this query shape, or embedding semantic distance from query to evidence is too large, or the wrong lane dominates. | **Confirmed** (see §3) |
| H2 | Rerank inversion — correct item present in top-K candidates but rerank pushes it below. | Refuted (§4) |
| H3 | `$rankFusion` pipeline asymmetry — one branch scored the right item high, the other low, default 0.5/0.5 weights miss. | Refuted (§4) |
| H4 | Multi-session / temporal correlation gap — case requires cross-session reasoning and recall is session-scoped. | Refuted (§5) |
| H5 | Provenance / preference boost applicable but not firing. | Refuted (§6) |
| H6 | Bi-temporal `$match` (Phase 2 SE-1) filter leak — expected memory's `validAt`/`invalidAt` excludes it from `asOf` query. | Refuted (§7) |
| H7 | Injection classifier false-positive — expected memory routed to `memory_quarantine` at consolidation pre-write. | Refuted (§7) |

## 3. H1 — Recall gap (confirmed)

### 3.1 Top-10 composition

From `caseDiagnostics[00ca467f].topCandidates` (run-1; runs 2 and 3 identical):

| rank | score | source | canonicalId | resolved session |
|---|---|---|---|---|
| 1 | 0.25586 | structured | `procedure:procedure-64d34644dd3c` | `answer_39900a0a_3` |
| 2 | 0.22266 | structured | `procedure:procedure-c3499c272973` | `e4cb6c56` |
| 3 | 0.22168 | structured | `procedure:procedure-2ca8b7a62332` | `ultrachat_239705` |
| 4 | 0.22168 | structured | `procedure:procedure-2e0db0c0cdb0` | `8d1f9505` |
| 5 | 0.21582 | structured | `procedure:procedure-5446f84ee7fd` | `10857212_2` |

All 5 top candidates are `source: "structured"`, `canonicalId: procedure:*`. Top-10 `topCandidateSessionIds` contains 9 distinct sessions, none of which are `answer_39900a0a_1` or `answer_39900a0a_2`. Zero conversation-lane hits in top-10.

### 3.2 Deep-K recall from LongMemEval projection

From `caseDiagnostics[00ca467f].longMemEval` (same across all runs):

```
session.recallAnyAt1  = 1     session.recallAllAt1  = 0     session.ndcgAnyAt1  = 1
session.recallAnyAt5  = 1     session.recallAllAt5  = 0
session.recallAnyAt10 = 1     session.recallAllAt10 = 0
session.recallAnyAt30 = 1     session.recallAllAt30 = 0
session.recallAnyAt50 = 1     session.recallAllAt50 = 0

turn.recallAnyAt1  = 0   ... turn.recallAnyAt50 = 0
```

Two critical signals:
- `session.recallAllAt50 = 0`: **sessions `_1` and `_2` never appear in top-50**, not just top-10. This is not a ranking problem — it's pure recall failure for 2 of 3 expected sessions at the widest K the projection measures.
- `turn.recallAnyAt50 = 0`: **no expected turn ID ever appears in top-50**, even though the expected turns' session (`_3`) does rank first. The representative returned for `_3` is `turn_4` (a procedure-derived structured document), not the gold `turn_1`.

That `recallAnyAt50 = 0` for turns kills H2 and H3 outright: rerank or fusion re-ordering cannot explain an item that is absent from the candidate list at the top-50 ceiling.

### 3.3 Interpretation

The **procedural memory lane** is dominating the retrieval surface for this query. Every session that ranks has an LLM-enrichment-produced "procedure" document associated with it; those are the items that rank. Sessions `_1` and `_2` either:

- (a) never received a procedure document during the scenario-scoped enrichment pass, or
- (b) their procedure documents embed further from the query than 9 other sessions' procedures.

Either way the **conversation-event lane** (which would contain the gold `turn_1` user-authored statements "went to see my primary care physician, Dr. Smith, on March 3rd" for `_1` and "follow-up appointment with my orthopedic surgeon, Dr. Thompson, on March 20th" for `_3::turn_1`) is not contributing at all in the top-50.

**Why this query in particular:**
- The query "How many doctor's appointments did I go to in March?" is a **counting / aggregation** question. Voyage embeddings for counting questions put more semantic mass on the concept ("doctor's appointment", "March") than on any single event. Procedure-lane documents aggregate a session's content into a single vector, which tends to pull counting queries toward them; conversation turn chunks embed a specific utterance and are diluted by surrounding turn content.
- Query classification at `packages/memory-engine/src/mongodb-retrieval-planner.ts:775-812` returns `"direct"` for this query because the `TIME_KEYWORDS` list (`today, yesterday, last week, this week, last month, this month, recent, recently, earlier today, just now, latest` at `:128-144`) does NOT include bare month names (`march`, `april`, etc.). No temporal lane is selected; no time-range is resolved; `breadth`/`raw-window` biases do not apply.
- Active paths for `direct` classification follow `MemorySearchSourcePreference` default order `["conversation", "structured", "procedural", "reference", "episodic", "graph"]` (`mongodb-search-executor.ts:57-66`). Once the $rankFusion merge completes, the procedure lane's session-aggregate embeddings win 9 of the top-10 slots.

## 4. H2 / H3 refuted — rerank / fusion

H2 and H3 both require the correct item to be *present* in the candidate list pre-rerank or in at least one inner pipeline. Evidence from §3.2 shows `recallAnyAt50 = 0` for the expected turn across all runs. An item that is not in top-50 cannot have been outranked by rerank and cannot have been shadowed by a fusion weight; it was never retrieved. Refuted.

Note on observability: the Phase-2 R1 patch enabled `scoreDetails` on recall paths, but the benchmark-runner candidate projection (`caseDiagnostics.topCandidates`) does not thread `scoreDetails` through the benchmark envelope. Per-pipeline scores are not visible in the current artifact. This would become relevant if H2/H3 were the suspect — but because the item is absent from top-50 entirely, H3's "fusion asymmetry shadowed one pipeline's win" narrative cannot hold.

## 5. H4 refuted — multi-session / temporal correlation

The scenario ingests all 47 haystack sessions under a single scenario-scoped `agentId`. There is no per-session isolation of scopes; a cross-session query has access to every haystack event. The search fully spans the intended corpus — the planner just prefers procedure documents within it. No evidence of scope filtering excluding the answer sessions.

## 6. H5 refuted — preference-evidence boost not applicable here

`applyPreferenceEvidenceBoostAfterRerank` at `packages/memory-engine/src/mongodb-manager.ts` gates on `RECOMMENDATION_MEMORY_QUERY_RE` (recommendation-shaped queries: `suggest/recommend/accessor(y|ies)/complement/setup/prefer/preference`). The query "How many doctor's appointments did I go to in March?" does not match. Even if it did, the boost lifts user-provenance turns within the rerank window — it cannot resurrect items that were never in the top-K. Refuted.

## 7. H6, H7 refuted — bitemporal filter / injection quarantine

- **H6:** Benchmark ingestion (`packages/memory-engine/src/mongodb-benchmark-dataset.ts`, `mongodb-events.ts`) does NOT write `validAt`/`invalidAt` on conversation events. `buildBitemporalFilter(queryTime)` at `packages/memory-engine/src/mongodb-bitemporal.ts:34-57` explicitly allows `validAt: { $exists: false }` (legacy rows treated as valid) and `invalidAt` absent/null (not yet invalidated). No legacy event is excluded by the filter. The question_date 2023/03/27 23:35 post-dates every haystack turn anyway. Refuted.
- **H7:** `classifyInjection` runs only in the consolidator pre-write hook at `mongodb-consolidator.ts:552`. Primary conversation-event ingestion bypasses it entirely. Refuted.

## 8. Root cause (with confidence)

**Confidence: high** on the observed symptom (expected turns are absent from top-50); **confidence: medium** on the mechanism (procedural-lane dominance vs. conversation-lane underweighting) because the benchmark envelope does not emit per-lane scoreDetails in the candidate projection.

**Root cause:** For multi-session counting queries with bare month names (`"in March"`), the retrieval planner classifies the query as `direct` (no temporal lane preference), the `$rankFusion` output is dominated by LLM-enrichment-produced procedural memory documents (one per haystack session), and the gold user-authored conversation turns (`_1::turn_1`, `_3::turn_1`) that literally name the March doctor's appointments are filtered out of the top-50 candidate set. The procedure lane surfaces only the answer-session with the strongest semantic match to "doctor's appointment" (`_3`), represented by a non-gold turn (`turn_4`, derived from enrichment).

This is a **pattern-wide** failure mode, not case-specific:
- Any multi-session counting or aggregation question lacking a TIME_KEYWORD match will take the same planner path.
- The same procedural-lane dominance will apply whenever LLM enrichment has populated procedure documents for all session candidates.
- Turn-precision is impossible because procedure documents represent a session, not a turn.

## 9. Fix directions (for user decision — not landed)

Both are generalizable, not case-specific. Both are **plan-forbidden for Phase 3** per line 2052 and belong to Phase 5 retrieval-tuning:

### Fix direction A — Extend TIME_KEYWORDS to recognize bare month + date-of-month references

**Site:** `packages/memory-engine/src/mongodb-retrieval-planner.ts:128-144` (`TIME_KEYWORDS`) and related `classifyRetrievalQuery` / `resolveTimeRangePreset` logic.

**Change:** Add matchers for bare month names (`/\bin (?:january|february|march|april|...|december)\b/i`), `/\bon (?:january|...|december) \d{1,2}(?:st|nd|rd|th)?\b/i`, and "date X to Y" phrases. When matched, set a time-range anchored by the month/date and/or route the query through the temporal retrieval recipe (`sourcePreference` puts `conversation` ahead of `procedural`, and raw-window plus episodic lanes are added).

**Risk:** Low-to-medium. Adding time keywords only broadens classification; it does not remove any existing path. A failure mode would be over-triggering the temporal lane on non-temporal queries that mention months (e.g., "What is March Madness?"), but that is rare and the `temporal` recipe still executes hybrid search; it only changes preference order and adds raw-window.

**Generalizability:** Affects any query with explicit month/date text. Positive ROI across multi-session, temporal-reasoning, and knowledge-update types.

### Fix direction B — Weight conversation-lane higher in `$rankFusion` when query classification is `direct` and question_type metadata is `multi-session`

**Site:** `packages/memory-engine/src/mongodb-conversation-recall.ts` `$rankFusion` wiring + `packages/memory-engine/src/mongodb-search.ts` inner pipelines.

**Change:** Lower the procedural/structured lane `$rankFusion` weight (RRF constant 60 with default 0.5/0.5 inner pipeline weights; lower weight = higher influence) OR explicitly increase the conversation-lane weight when question_type signals a multi-session lookup, so that user-authored turn embeddings are not crowded out by session-aggregate procedure embeddings.

**Risk:** Medium. Any per-class weight tuning without a calibration sweep risks benchmark-specific tuning. Must land with Gate 5 bake-off evidence, not at Phase 3.

**Generalizability:** Affects every `multi-session` case. Prime-suspect for other `multi-session` deterministic/variance misses if they surface later in Phase 3 or Phase 4.

### Fix direction C (defensive, also deferred) — Emit scoreDetails into benchmark `caseDiagnostics.topCandidates`

**Site:** `packages/memory-engine/src/mongodb-benchmark-runner.ts` candidate-projection path.

**Change:** Thread the `scoreDetails` envelope from `ConversationRecallResult` into the candidate projection so the miss ledger exposes per-pipeline (vector, text), pre-rerank, post-rerank scores. Without this, future `00ca467f`-shaped misses cannot be classified H2 vs H3 vs H1 from the artifact alone.

**Risk:** Low (observability only; no retrieval-path change).

**Generalizability:** Diagnostic win for every future miss investigation.

## 10. Recommendation

**DEFER-PHASE-5.** Plan line 2052 explicitly prohibits retrieval tuning at Phase 3 for 1/type canary misses. Both fix directions A and B are generalizable pattern fixes (not hardcoding), but they require the kind of calibrated rollout that belongs to Phase 5 Option A (retrieval-SOTA) with:
- bake-off evidence on the held-out split (`longmemeval_s_heldout.json`),
- before/after retrieval trace diffs,
- Voyage rerank reproducibility check against n=3 canary,
- explicit MongoDB MCP citation for any $rankFusion weight or $vectorSearch.filter change (Gate-5 evidence requirement).

**For Gate 3 verdict (current):** The n=3 aggregate is `hitRate mean 0.667 min 0.333` with 1 deterministic + 5 variance misses. Even if `00ca467f` were tuned now, the variance-miss band (5 cases that appear only in some runs) points to broader retrieval-side instability that also needs Phase 5 treatment. Single-case tuning would not flip the gate to PASS.

**Phase 3 action:** Accept FAIL verdict on the n=3 retry, carry `00ca467f` into the Phase 5 Option A backlog with this report as the evidence anchor, and keep this report referenced from `docs/benchmarks/longmemeval-decision-log.md` when that entry is updated.

## 11. Artifact references

- Aggregate: `artifacts/canary-runs/gate3-strict-1pertype-n3-1778599299/aggregate-summary.json`
- Bootstrap: `artifacts/canary-runs/gate3-strict-1pertype-n3-1778599299/bootstrap.json`
- Per-run miss ledger (identical across 3 runs): `artifacts/canary-runs/gate3-strict-1pertype-n3-1778599299/run-{1,2,3}/benchmark-response.json` → `.missLedger[] | select(.caseId == "00ca467f")`
- Per-run case diagnostics (identical across 3 runs): same files → `.caseDiagnostics[] | select(.caseId == "00ca467f")`
- Dataset gold: `~/.memongo/workspace/benchmarks/longmemeval_s_cleaned.json` (277 MB; SHA `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` per bootstrap.json).
- Code anchors: `packages/memory-engine/src/mongodb-retrieval-planner.ts:128-144` (TIME_KEYWORDS), `:775-812` (classifyRetrievalQuery); `packages/memory-engine/src/mongodb-search-executor.ts:57-66` (sourcePreference default); `packages/memory-engine/src/mongodb-conversation-recall.ts` ($rankFusion wiring); `packages/memory-engine/src/mongodb-bitemporal.ts:34-57` (bitemporal legacy-row pass-through); `packages/memory-engine/src/mongodb-consolidator.ts:552` (injection classifier call site, consolidator-only).

## 12. Scope compliance

No retrieval code was modified. Only this report is added. Per plan line 2052, root-cause investigation precedes any retrieval tuning, and tuning is deferred to Phase 5.
