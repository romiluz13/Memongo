# Structured Provenance Build Memo

Date: 2026-04-15
Audience: Builder/reviewer agents working on the LongMemEval 96%+ track
Scope: Completed build slice only. This memo is based on repo code, benchmark artifacts, and fresh verification evidence.

## Decision

We prioritized benchmark-creditable provenance before any further retrieval experimentation.

That decision was intentional:

1. The official scorer already knew how to credit results through `sourceEventIds`.
2. Some structured/procedure search paths were still dropping `sessionId` and/or `sourceEventIds` before results reached the benchmark trace.
3. The miss ledger was less capable than the scorer and could under-report creditable hits because it only trusted raw `sessionId`.

In short: candidate generation experiments were being interpreted through diagnostics that were not fully aligned with scoring truth. That had to be fixed first.

## What Changed

### 1. Structured search now preserves session provenance

File:
- `packages/memory-engine/src/mongodb-structured-memory.ts`

Changes:
- Added `sessionId` to the vector-search projection.
- Added `sessionId` to the `$text` fallback projection.
- Added `sessionId` to `toStructuredResult()`.

Impact:
- Structured hits can now carry direct session identity all the way into benchmark evaluation and diagnostic traces.

### 2. Procedure search now preserves session and event provenance

File:
- `packages/memory-engine/src/mongodb-procedures.ts`

Changes:
- Added `sessionId` and `sourceEventIds` to exact-match projection.
- Added `sessionId` and `sourceEventIds` to vector-search projection.
- Added `sessionId` and `sourceEventIds` to `$text` fallback projection.
- Added both fields to `toProcedureResult()`, including provenance fallback for `sourceEventIds`.

Impact:
- Procedure hits can now be benchmark-creditable through either direct `sessionId` or event provenance.

### 3. Benchmark trace now records resolved session/turn identity

File:
- `packages/memory-engine/src/mongodb-benchmark-runner.ts`

Changes:
- Extended `BenchmarkCandidateTrace` with:
  - `resolvedSessionIds?: string[]`
  - `resolvedTurnIds?: string[]`
- Populated those fields inside `evaluateRankingCase()` using the same resolver functions the official scorer already trusts.

Impact:
- Benchmark traces now expose the scorer’s actual resolved identity, not just raw result fields.

### 4. Miss ledger now follows scorer truth instead of raw-field truth

File:
- `packages/memory-engine/src/mongodb-benchmark-runner.ts`

Changes:
- `buildMissLedger()` now derives `topCandidateSessionIds` from `resolvedSessionIds` first, then falls back to raw `sessionId`.
- `buildMissLedger()` now derives reachable turn IDs from `resolvedTurnIds` first, then falls back to raw `sourceEventIds`.
- Miss-ledger top candidates now retain:
  - `resolvedSessionIds`
  - `sourceEventIds`

Impact:
- The miss ledger is no longer systematically weaker than official scoring.
- Reviewers can now distinguish:
  - "not retrieved"
  - "retrieved but not creditable"
  - "creditable through provenance but previously hidden by diagnostics"

### 5. Master plan was tightened to reflect this reality

File:
- `docs/plans/2026-04-15-longmemeval-96-master-plan.md`

Plan adjustments:
- Trimmed Wave 0 so it stays focused and does not become infrastructure procrastination.
- Added the structured/procedural provenance blocker explicitly.
- Moved chunking later in the priority order.

## Verification Evidence

### Focused test coverage that passed

Command:

```bash
bun test packages/memory-engine/src/mongodb-benchmark-runner.test.ts
```

Result:
- 20 passed
- 0 failed

What it proves:
- Benchmark trace changes compile and behave correctly.
- Miss-ledger resolution now works for provenance-only cases.

Command:

```bash
bun test packages/memory-engine/src/mongodb-structured-memory.test.ts -t "preserves session and provenance fields on search hits"
```

Result:
- 1 passed
- 0 failed

What it proves:
- Structured-memory search now returns `sessionId` and `sourceEventIds` in the result path we changed.

Command:

```bash
bun test packages/memory-engine/src/mongodb-procedures.test.ts -t "searches procedures and returns procedure locators|finds exact procedure aliases before broad search"
```

Result:
- 2 passed
- 0 failed

What it proves:
- Procedure exact/text result shaping now preserves provenance fields.

Command:

```bash
bunx tsc --noEmit -p packages/memory-engine/tsconfig.json
```

Result:
- Exit code `0`

What it proves:
- The added trace/result fields are type-safe in the package build graph.

### Important verification note

The full `mongodb-structured-memory.test.ts` and `mongodb-procedures.test.ts` suites still contain pre-existing `vi.mocked(...)` incompatibilities when run under the current `bun test` lane. Those failures predated this patch and were not introduced by the provenance work.

This slice was verified with targeted tests plus package type-checking, which is the truthful evidence for the code we changed.

## Lessons

### 1. Scoring truth and diagnostic truth must match

The scorer was already smarter than the ledger. That meant our debugging narrative could drift from benchmark reality. If diagnostics under-credit creditable hits, we risk optimizing the wrong subsystem.

### 2. Provenance is a first-class retrieval surface

For benchmark work, `sourceEventIds` are not incidental metadata. They are part of the identity bridge from non-conversation evidence back to the judged session/turn.

### 3. Search shapers are easy places to accidentally lose benchmark value

The retrieval engine may surface strong evidence, but if a result adapter drops the provenance fields, the benchmark path becomes partially blind. This is especially dangerous for structured and procedural memory because they look semantically strong in traces even when they are not creditable.

### 4. We should fix credibility blockers before widening the search space

Before asking whether userfact evidence, join mode, temporal rebucketing, or assistant second-pass help, we need confidence that the benchmark traces are describing reality faithfully.

## Reflection

This was the right first implementation slice.

It does not claim recall improvement by itself. That would be overstating the effect.

What it does claim, with evidence:

1. Structured and procedural hits now preserve more benchmark-creditable provenance.
2. The miss ledger is now materially closer to the official scorer’s truth model.
3. Future retrieval experiments should be easier to evaluate honestly.

## Recommended Next Step

Return to the master-plan sequence with this blocker removed:

1. Keep the canary protocol fixed-ingest and stable.
2. Re-run diagnostics with the repaired ledger.
3. Then continue the candidate-generation experiments:
   - stronger userfact/preference evidence
   - join-mode experiments
   - query-shaped branches
   - later, MongoDB capability leverage and reranking

## Files Changed In This Slice

- `docs/plans/2026-04-15-longmemeval-96-master-plan.md`
- `packages/memory-engine/src/mongodb-benchmark-runner.ts`
- `packages/memory-engine/src/mongodb-benchmark-runner.test.ts`
- `packages/memory-engine/src/mongodb-procedures.ts`
- `packages/memory-engine/src/mongodb-procedures.test.ts`
- `packages/memory-engine/src/mongodb-structured-memory.ts`
- `packages/memory-engine/src/mongodb-structured-memory.test.ts`
