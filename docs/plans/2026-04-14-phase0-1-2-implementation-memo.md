# Retrieval Excellence: Phase 0-2 Implementation Memo

**Date:** 2026-04-14
**Author:** Claude Code (CC10X BUILD workflow)
**Reviewer:** Other AI (requested)
**Baseline:** 73.4% R@5, 77.0% R@10 on LongMemEval-S (500/500 cases, commit `cd32e0f169`)
**Current HEAD:** `5cfbf7a716`

## Summary

14 commits implementing Phases 0, 1, and 2 of the retrieval excellence plan. 2,857 lines added across 20 files. 74 new tests. All verified through the full CC10X chain (builder -> reviewer -> hunter -> verifier -> memory).

No full benchmark has been run yet. The canary comparison for the ADR experiment is the next step (HITL).

## What Changed

### Phase 0: Correctness and Measurement Substrate (6 commits)

| Commit | What | Why |
|--------|------|-----|
| `ece644ee2b` | Fix scope-cache leak in `search()` and `searchDetailed()` | Session-scoped queries were writing cache under `scope: "agent"`, causing cross-session pollution. Both read and write paths now use resolved `searchScope`/`searchScopeRef`. |
| `ec2040d3c7` | Align fusion default to `rankFusion` | `backend-config.ts:221` defaulted to `scoreFusion` while all search recipes defaulted to `rankFusion`. Aligned to `rankFusion`. |
| `1d5e7e493c` | Add stratified canary runner | 48-evaluation subset (8 per question type) with deterministic stable sort. Calls the same benchmark API — no scoring shortcuts. |
| `f18aab0bc6` | Enrich benchmark traces | `BenchmarkCandidateTrace` captures top-50 candidates per case with rank, score, source, canonicalId, sessionId, sourceEventIds. |
| `29c2ae046a` | Add ENN exact:true truth lane | `buildVectorSearchStage` accepts `exact?: boolean`. When true: sets `exact: true`, omits `numCandidates`, preserves filter. Building block for evaluation. |
| `78ee5aea47` | Align searchV2 fusion fallback | Hunter finding: `searchV2()` internal fallback at line 5356 still defaulted to `scoreFusion`. Aligned to `rankFusion`. |

**Key files:** `mongodb-manager.ts`, `backend-config.ts`, `mongodb-search.ts`, `mongodb-benchmark-runner.ts`, `run-longmemeval-canary.ts`

### Phase 1: Query-Time Quality Upgrades (4 commits)

| Commit | What | Why |
|--------|------|-----|
| `7851d29fae` | Add post-retrieval scoring module | 4 boost functions (keyword overlap 0.30, temporal proximity 0.40, entity name 0.40, quoted phrase 0.60) + composite `applyPostRetrievalScoring`. Ranking-only — never retrieves new documents. |
| `03de8a6183` | Wire questionDate into searchV2 | `questionDate?: Date` added to `search()`, `searchV2()`, and `relevanceExplain()`. Benchmark loop extracts from `evaluation.metadata.questionDate`. |
| `0dbb17b94c` | Lock recall-oriented thresholds | `numCandidates`: 200 → 500, `reranking.minScore`: 0.1 → 0.01. Env-var overridable via `MEMONGO_NUM_CANDIDATES` and `MEMONGO_RERANK_MIN_SCORE`. |
| `8a91e8e474` | Fix cross-encoder rerank bypass + keyword punctuation | **Critical reviewer/hunter finding:** `crossEncoderRerank` received `heuristicReranked` instead of `postScored`, silently discarding all Phase 1 scoring when Voyage was active. Also fixed `extractKeywords` to strip punctuation. |

**Key files:** `mongodb-post-retrieval-scoring.ts` (NEW, 420 LOC), `mongodb-manager.ts`, `backend-config.ts`

**Post-retrieval scoring insertion point:** Between `rerankResults()` (heuristic rerank) and `crossEncoderRerank()` (Voyage) inside `searchV2()`. Pipeline is: heuristic rerank → post-retrieval scoring → cross-encoder rerank → final slice.

### Phase 2: Session-Evidence ADR Experiment (4 commits)

| Commit | What | Why |
|--------|------|-----|
| `59092e6efa` | Add session evidence module | `mongodb-session-evidence.ts` (196 LOC) with `buildSessionEvidenceDocuments`, `writeSessionEvidenceOptionA`, `writeSessionEvidenceOptionB`, `resolveSessionEvidenceMode`, `truncateAtSentenceBoundary`, `extractSessionIdFromCanonicalId`. |
| `95189b9fff` | Wire into schema, manager, searchV2 | `session_chunks` collection with 3 standard + 2 search indexes. Benchmark ingestion creates session evidence. searchV2 adds parallel lane for Option B. Benchmark scoring recognizes `session-chunk/` canonical IDs. |
| `d1dc17af5e` | Add canary comparison script | Reads canary artifacts, produces side-by-side R@5/R@10/per-type metrics for baseline/A/B. |
| `5cfbf7a716` | Fix Option A source filter + provenance | **Critical hunter finding:** Option A docs used `source: "session-evidence"` but searchV2 filtered `{ $in: ["conversation", "sessions"] }` — session docs were written but never searchable. Also fixed vectorSearch projection to include `canonicalId` and `metadata.sourceEventIds`. |

**Key files:** `mongodb-session-evidence.ts` (NEW), `mongodb-schema.ts`, `mongodb-manager.ts`, `mongodb-search.ts`, `compare-session-evidence-canary.ts` (NEW)

**ADR architecture:**
- **Option A:** Session docs in canonical `chunks` collection with `source: "session-evidence"`. Reuses existing auto-embed + text indexes. Native `$rankFusion` across turn + session results.
- **Option B:** Session docs in dedicated `session_chunks` collection with own auto-embed vector + Atlas Search text indexes. Parallel `$vectorSearch` merged via JS RRF.
- **Control:** `MEMONGO_SESSION_EVIDENCE_MODE` env var (`A`, `B`, or `none`). Default `none`.

## Critical Bugs Caught By Review Chain

| Bug | Found By | Impact | Fix |
|-----|----------|--------|-----|
| Scope-cache writes `scope: "agent"` for session queries | Plan analysis | Benchmark cross-session cache pollution | `ece644ee2b` |
| searchV2 internal fusion fallback misaligned | Hunter (Phase 0) | Drift trap for unconfigured callers | `78ee5aea47` |
| Cross-encoder rerank bypasses post-scoring | Reviewer + Hunter (Phase 1) | **All Phase 1 scoring silently discarded when Voyage active** | `8a91e8e474` |
| Option A session docs excluded from search | Hunter (Phase 2) | **ADR comparison would be invalid — Option A = baseline** | `5cfbf7a716` |
| vectorSearch drops canonicalId/metadata | Hunter (Phase 2) | Session results lose provenance for benchmark scoring | `5cfbf7a716` |

The cross-encoder bypass and Option A exclusion are the two most important catches — without them, Phase 1 and Phase 2 would appear to do nothing.

## Test Evidence

| Suite | Count | Status |
|-------|-------|--------|
| Engine (total) | 1191 | Pass |
| API | 53 | Pass |
| Bridge | 41 | Pass |
| MCP | 8 | Pass |
| Tools | 10 | Pass |
| **Total** | **1303** | **Pass** |
| Type check | 13/13 | Pass |
| Build | 10/10 | Pass |

**New test files:**
- `mongodb-post-retrieval-scoring.test.ts` — 32 tests (all 4 boost functions, composite, edge cases)
- `mongodb-session-evidence.test.ts` — 25 tests (doc building, truncation, provenance, mode resolution)
- `run-longmemeval-canary.test.ts` — 5 tests (stratified selection, determinism, capping)
- `mongodb-benchmark-runner.test.ts` — 1 new test (topCandidates trace)
- `mongodb-manager.test.ts` — 3 new tests (scope-cache, questionDate, session evidence)
- `backend-config.test.ts` — 6 new tests (fusion default, threshold overrides)
- `mongodb-search.test.ts` — 3 new tests (ENN exact:true)
- `mongodb-schema.test.ts` — updated assertions (29 collections, 84 indexes, 14 search indexes)

## Known Deferred Items

These were identified by reviewers/hunters and explicitly deferred as non-blocking for the current phase:

| Item | Source | Severity | Why Deferred |
|------|--------|----------|--------------|
| `shouldUseDetailedSearchCache` is dead code | Hunter P0 | Medium | hybridMode always set by applySearchConfig |
| Trace missing fusionMethod/rerankFlag per candidate | Reviewer P0 | Medium | Phase 0 substrate is sufficient; extend in Phase 3+ |
| `create()` return type tightened (breaking) | Reviewer P0 | Medium | Correct contract; note in changelog |
| `temporalProximityBoost` uses Math.abs (bidirectional) | Reviewer P1 | Medium | Low practical impact on historical data |
| `searchDetailed` minScore hardcoded 0.1 vs searchV2 0.01 | Hunter P1 | High | Non-benchmark path; align in future phase |
| Unicode quotes not matched by `extractQuotedPhrases` | Hunter P1 | Medium | ASCII quotes cover LongMemEval corpus |
| `MemorySearchManager` interface missing `questionDate` | Hunter P1 | Medium | Implementation widens interface; fix in Phase 3+ |
| Option A `insertMany` no duplicate protection | Reviewer P2 | Medium | Prototype scope; add upsert in Phase 3 |
| `recordSearchAccess` ignores session-chunk canonical IDs | Hunter P2 | Medium | Benchmark-only; address in productionization |
| Auto-embed timing gap on immediate search | Hunter P2 | Medium | Benchmark settling step exists; verify in canary |

## Current Codebase State

| Metric | Value |
|--------|-------|
| Collections | 29 |
| Standard indexes | 84 |
| Search indexes | 14 |
| Engine tests | 1191 |
| Total tests | 1303 |
| MCP tools | 48 |

## Reference Documents

| Document | Purpose |
|----------|---------|
| `docs/plans/2026-04-14-retrieval-excellence-design.md` | Strategy source of truth |
| `docs/plans/2026-04-14-retrieval-excellence-plan.md` | Execution source of truth |
| `docs/plans/2026-04-14-session-evidence-architecture-adr.md` | Open ADR for session evidence |
| `.claude/cc10x/v10/activeContext.md` | CC10X memory — recent changes + next steps |
| `.claude/cc10x/v10/progress.md` | CC10X progress — task checklist |
| `.claude/cc10x/v10/patterns.md` | CC10X patterns — gotchas and conventions |
| `.claude/cc10x/v10/competitive-intel/01-05` | Competitive intel from 14 reference repos |

## What's Next

**Immediate (HITL):** Run the ADR canary comparison:

```bash
# 1. Baseline (~25 min)
MEMONGO_SESSION_EVIDENCE_MODE=none bun run benchmark:canary

# 2. Option A (~25 min)
MEMONGO_SESSION_EVIDENCE_MODE=A bun run benchmark:canary

# 3. Option B (~25 min)
MEMONGO_SESSION_EVIDENCE_MODE=B bun run benchmark:canary

# 4. Compare
bun scripts/compare-session-evidence-canary.ts
```

**After ADR lock:** Phase 3 (productionize winner + preference extraction + assistant second-pass) then Phase 4 (fusion ablation + final full benchmark).
