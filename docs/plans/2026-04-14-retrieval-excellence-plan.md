# Retrieval Excellence Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD where practical.
> **Design:** See `docs/plans/2026-04-14-retrieval-excellence-design.md` for the strategic source of truth.
> **ADR:** See `docs/plans/2026-04-14-session-evidence-architecture-adr.md` for the only intentionally unresolved architecture choice.

**Goal:** Improve LongMemEval-S retrieval through one coherent Memongo-native wave, not disconnected fixes.

**Architecture:** This plan uses a canary-first execution model. It fixes correctness and measurement first, then improves query-time quality, then resolves the session-evidence architecture by experiment, then productionizes the winning path and runs the full benchmark.

**Tech Stack:** Bun, Turborepo, TypeScript ESM, MongoDB Atlas Local Preview, auto-embed vector search, Atlas Search, `$rankFusion`, `$scoreFusion`, `exact: true` ENN, Voyage rerank-2.5.

**Prerequisites:**
- Atlas Local Preview running and healthy
- `VOYAGE_API_KEY` available in the shell environment
- official cleaned LongMemEval-S dataset at `~/.memongo/workspace/benchmarks/longmemeval_s_cleaned.json`
- baseline repository health: `bun run check-types`, `bun run test`, `bun run build`

**Durable Decisions:**
- MongoDB-native only
- one planner, one retrieval authority, one provenance story
- no second memory runtime
- `rankFusion` is the broad default unless evidence proves otherwise
- ENN is a real truth/evaluation lane, not an optional curiosity
- turn provenance is mandatory for any session or synthetic evidence
- full benchmark runs are acceptance gates, not every-task diagnostics
- the session-evidence storage shape is not pre-decided; the ADR experiment chooses it

**Differences from agreement that are still open:**
- only the physical expression of session evidence remains open
- everything else in this plan assumes convergence already exists on strategy

---

## Codebase Reality Check

- `packages/memory-engine/src/mongodb-manager.ts:1247-1368` and `:1437-1652` contain the current cache write paths and search entry points.
- `packages/memory-engine/src/mongodb-manager.ts:2445-2565` runs LongMemEval scenarios and resolves benchmark results.
- `packages/memory-engine/src/mongodb-search.ts:517-900` already implements `$scoreFusion`, `$rankFusion`, and JS merge fallback behavior.
- `packages/memory-engine/src/mongodb-search-executor.ts:68-150` already seeds recipe defaults with `rankFusion`.
- `packages/memory-engine/src/mongodb-hybrid.ts:140-348` already contains cross-result JS merge/RRF logic.
- `packages/memory-engine/src/backend-config.ts:221`, `:272-278`, and `:438-441` hold fusion, candidate-count, and reranker-threshold defaults.
- `packages/memory-engine/src/mongodb-sync.ts:474-503` and `:621-693` already create session-derived chunks in the canonical `chunks` path with `source: "sessions"`.
- `packages/memory-engine/src/mongodb-schema.ts:37-57` and `:2553-2956` show the canonical collection and search-index patterns, including separate `kb_chunks`.
- `packages/memory-engine/src/mongodb-kb.ts` and `packages/memory-engine/src/mongodb-kb-search.ts:138-227` show the existing separate KB chunk pattern and native hybrid search path.

## Relevant Codebase Files

### Patterns to Follow
- `packages/memory-engine/src/mongodb-search.ts` - native fusion and fallback patterns
- `packages/memory-engine/src/mongodb-hybrid.ts` - existing JS merge/RRF implementation
- `packages/memory-engine/src/mongodb-schema.ts` - canonical collection/index creation patterns
- `packages/memory-engine/src/mongodb-sync.ts` - existing session-derived chunk ingestion

### Benchmark Surfaces
- `packages/memory-engine/src/mongodb-manager.ts` - benchmark scenario loop, cleanup, result resolution
- `scripts/run-official-longmemeval-benchmark.ts` - full benchmark runner

### Validation Surfaces
- `packages/memory-engine/src/backend-config.test.ts`
- `packages/memory-engine/src/mongodb-manager.test.ts`
- `packages/memory-engine/src/mongodb-sync.test.ts`

## Benchmark Protocol

### Default loop

Every meaningful retrieval change uses:

1. narrow unit/integration tests
2. `bun run check-types`
3. stratified LongMemEval canary

### Full benchmark gates

Run the full official LongMemEval-S benchmark only:

- after Phase 2 winner lock
- after the final acceptance candidate in Phase 4

## Phase Dependency Map

- Phase 0 enables trustworthy measurement
- Phase 1 depends on Phase 0 traces and metadata
- Phase 2 depends on Phase 1 so both architecture candidates use the same scoring/tracing substrate
- Phase 3 depends on Phase 2 because only the winning architecture should be productionized
- Phase 4 depends on Phase 3 because fusion/default lock only matters after the retrieval shape is real

## Phase 0: Correctness And Measurement Substrate

> **Exit criteria:** scope-safe cache behavior proven, canary runner exists, trace artifacts explain lane behavior, ENN lane is available, no full benchmark required yet.

### Task 0.1: Fix scope-cache correctness first

**Files:**
- Modify: `packages/memory-engine/src/mongodb-manager.ts:1240-1250`, `:1362-1373`, `:1477-1485`, `:1647-1658`
- Test: `packages/memory-engine/src/mongodb-manager.test.ts`

**Steps:**
1. Write a failing focused test that seeds two sessions with conflicting evidence, runs a session-scoped query, and asserts cache writes do **not** land under `scope: "agent"`.
2. In `search()` fix the cache write at `packages/memory-engine/src/mongodb-manager.ts:1362-1373` by replacing the hard-coded `scope: "agent"` and `scopeRef: this.agentScopeRef` with the resolved search scope and scopeRef used by the query.
3. In `searchDetailed()` fix the cache write at `packages/memory-engine/src/mongodb-manager.ts:1647-1658` the same way.
4. Check the read/write symmetry against the existing cache-read calls at `packages/memory-engine/src/mongodb-manager.ts:1240-1250` and `:1477-1485`.
5. Run: `bun x vitest run packages/memory-engine/src/mongodb-manager.test.ts -t "scope"` and then `bun run check-types`.

**Commit:** `engine: fix scope-safe cache writes for benchmark search`

### Task 0.2: Align broad fusion default to `rankFusion`

**Files:**
- Modify: `packages/memory-engine/src/backend-config.ts:221`
- Test: `packages/memory-engine/src/backend-config.test.ts:50`, `:389-398`

**Steps:**
1. Change `fusionMethod: mongoCfg?.fusionMethod ?? "scoreFusion"` at `packages/memory-engine/src/backend-config.ts:221` to default to `"rankFusion"`.
2. Update the default-resolution tests in `packages/memory-engine/src/backend-config.test.ts` so the repo default expectation becomes `"rankFusion"`.
3. Keep explicit override tests intact so the plan still allows `scoreFusion` as an evidence-backed specialist mode.
4. Run: `bun x vitest run packages/memory-engine/src/backend-config.test.ts -t "fusionMethod"` and then `bun run check-types`.

**Commit:** `engine: align backend fusion default with planner default`

### Task 0.3: Add a stratified LongMemEval canary runner

**Files:**
- Create: `scripts/run-longmemeval-canary.ts`
- Modify: `packages/memory-engine/src/mongodb-manager.ts` only if a small runner-facing hook is required

**Steps:**
1. Create a canary runner that materializes a deterministic **48-evaluation** subset: `8` evaluation cases per question type when available, selected by stable sort on `scenarioId` + `caseId`.
2. The canary must preserve the official benchmark path by running through `runScenarioBenchmarkDataset()`, not through a custom scoring shortcut.
3. Persist artifacts under the same benchmark-artifact family with a distinct canary marker, including:
   - run metadata
   - dataset hash
   - selected case IDs
   - top-line session metrics
   - per-question-type breakdown
4. Target runtime should stay roughly within the “fast iteration” lane; if the canary grows materially beyond that, reduce evaluations evenly rather than biasing types.
5. Run the canary once with the current baseline path to prove it produces stable output before using it for architectural decisions.

**Commit:** `benchmark: add stratified longmemeval canary runner`

### Task 0.4: Enrich benchmark traces

**Files:**
- Modify: `packages/memory-engine/src/mongodb-manager.ts`
- Modify: `packages/memory-engine/src/mongodb-search.ts`
- Modify or create tests around trace output as needed

**Steps:**
1. Extend benchmark-facing trace artifacts so each top candidate row can answer:
   - query text
   - case ID / question type
   - lane/path
   - fusion method used
   - base score
   - post-retrieval score
   - final score/rank
   - reranked `true|false`
   - `canonicalId`
   - `sessionId`
   - `sourceEventIds`
   - timestamp
2. Reuse existing trace entry points in `packages/memory-engine/src/mongodb-manager.ts:1259-1278`, `:1335-1354`, and `:1608-1627` instead of inventing a second trace pipeline.
3. Extend the low-level search trace surface in `packages/memory-engine/src/mongodb-search.ts:19-48` only as needed so fusion-method and fallback decisions are preserved.
4. Persist a machine-readable trace artifact, preferably JSONL, for the top `50` candidates per evaluated case.
5. Ensure no trace enhancement bypasses `searchV2()` as the retrieval authority.

**Commit:** `benchmark: enrich retrieval traces for canary and full runs`

### Task 0.5: Add ENN as a truth/evaluation lane

**Files:**
- Modify: `packages/memory-engine/src/mongodb-search.ts`
- Modify: `packages/memory-engine/src/backend-config.ts` only if a safe internal flag/config is needed
- Test: relevant search tests

**Steps:**
1. Add an `exact: true` vector-search path using the existing `buildVectorSearchStage()` flow in `packages/memory-engine/src/mongodb-search.ts:322+`.
2. Follow MongoDB ENN rules precisely:
   - set `exact: true`
   - omit `numCandidates`
   - keep `limit`
   - preserve existing filter pushdown
3. Keep ENN behind an internal or expert-only path used for canary truth checks and highly selective evaluation, not as the broad default.
4. Validate ENN on a small scoped scenario and record the trace comparison against ANN.

**Commit:** `engine: add exact vector search lane for evaluation truth`

## Phase 1: Query-Time Quality Upgrades

> **Exit criteria:** question-date-aware scoring and benchmark-critical ranking signals exist, canary artifacts explain what moved, defaults remain evidence-gated.

### Task 1.1: Add post-retrieval scoring module

**Files:**
- Create: `packages/memory-engine/src/mongodb-post-retrieval-scoring.ts`
- Create: `packages/memory-engine/src/mongodb-post-retrieval-scoring.test.ts`

**Steps:**
1. Implement four scoring helpers with explicit function boundaries:
   - `keywordOverlapBoost(..., weight=0.30)`
   - `temporalProximityBoost(..., maxBoost=0.40)`
   - `entityNameBoost(..., weight=0.40)`
   - `quotedPhraseBoost(..., weight=0.60)`
2. Implement a composite `applyPostRetrievalScoring(...)` helper that re-sorts candidates after applying the boosts.
3. Treat these weights as initial benchmark-informed defaults, not eternal truth; keep them configurable enough to ablate later if needed.
4. Keep this layer ranking-only; it must never retrieve new documents.
5. Write unit tests for empty queries, no matches, malformed metadata, quoted phrases, temporal phrases, and proper-noun cases.

**Commit:** `engine: add benchmark-aware post-retrieval scoring`

### Task 1.2: Wire benchmark metadata, especially `questionDate`

**Files:**
- Modify: `packages/memory-engine/src/mongodb-manager.ts:1289-1310`, `:1700-1790`, `:2499-2518`, `:5287-5317`, `:5976-5989`
- Modify any benchmark dataset/type surface needed for typing only

**Steps:**
1. Add `questionDate?: Date` to the `searchV2()` search-options type near `packages/memory-engine/src/mongodb-manager.ts:5293-5317`.
2. Pass `questionDate` from the benchmark loop at `packages/memory-engine/src/mongodb-manager.ts:2499-2518` into both the normal `search()` path and any benchmark explain path that should share the same ranking semantics.
3. Wire the post-retrieval scorer into `searchV2()` at the exact insertion point between heuristic reranking and Voyage reranking:
   - current heuristic rerank at `packages/memory-engine/src/mongodb-manager.ts:5976`
   - current cross-encoder rerank starts at `:5978-5989`
4. Preserve non-benchmark callers by making `questionDate` optional and default-safe.
5. Add a narrow temporal ranking test that proves `questionDate` changes ordering in a relevant case.

**Commit:** `engine: wire benchmark questionDate into post-retrieval ranking`

### Task 1.3: Turn candidate-count and reranker thresholds into evidence-backed settings

**Files:**
- Modify: `packages/memory-engine/src/backend-config.ts:272-278`, `:438-442`
- Modify: `packages/memory-engine/src/backend-config.test.ts:374-398`, `:832-844`

**Steps:**
1. Compare the current defaults:
   - `numCandidates: 200` at `packages/memory-engine/src/backend-config.ts:272-278`
   - `reranking.minScore: 0.1` at `packages/memory-engine/src/backend-config.ts:438-442`
   against stronger recall-oriented settings:
   - `numCandidates: 500`
   - `reranking.minScore: 0.01`
2. Run the canary matrix with all other settings held constant.
3. Only promote those values to new defaults if they improve canary quality without obvious noise regressions, especially in the weak categories.
4. Update tests only after the evidence-backed decision is made.

**Commit:** `engine: lock retrieval thresholds from canary evidence`

## Phase 2: Session-Evidence ADR Experiment

> **Exit criteria:** the session-evidence architecture is chosen by canary evidence and documented in the ADR. Only one winner moves forward.

### Task 2.1: Implement minimal canary prototype for ADR Option A

**Files:**
- Modify: `packages/memory-engine/src/mongodb-sync.ts`
- Modify: `packages/memory-engine/src/mongodb-search.ts`
- Modify: `packages/memory-engine/src/mongodb-manager.ts`
- Modify: `packages/memory-engine/src/mongodb-schema.ts` only if index/filter support must change
- Test: whichever focused tests cover the touched path

**Steps:**
1. Implement the smallest end-to-end prototype of Option A that can participate in the canary.
2. Preserve source-event provenance.
3. Reuse the same trace/scoring/rerank substrate from Phases 0 and 1.

### Task 2.2: Implement minimal canary prototype for ADR Option B

**Files:**
- Create or modify a dedicated session-evidence module in `packages/memory-engine/src/`
- Modify: `packages/memory-engine/src/mongodb-schema.ts`
- Modify: `packages/memory-engine/src/mongodb-search.ts`
- Modify: `packages/memory-engine/src/mongodb-manager.ts`
- Reuse: `packages/memory-engine/src/mongodb-hybrid.ts` for merge logic where appropriate
- Test: whichever focused tests cover the touched path

**Steps:**
1. Implement the smallest end-to-end prototype of Option B that can participate in the same canary.
2. Preserve source-event provenance.
3. Do not add a second planner or a second retrieval authority.

### Task 2.3: Run the ADR canary comparison and lock the winner

**Files:**
- Update: `docs/plans/2026-04-14-session-evidence-architecture-adr.md`

**Steps:**
1. Run both options on the same stratified canary with the same scoring, rerank, and trace settings.
2. Compare:
   - R@5 / R@10
   - weakest-category lift
   - latency
   - provenance quality
   - planner/retrieval-authority simplicity
3. Record the winner in the ADR and explicitly close the losing path.

## Phase 3: Productionize The Winning Retrieval Shape

> **Exit criteria:** the winning session-evidence architecture is fully integrated, preference/userfact evidence exists, assistant-aware second pass exists, provenance-safe benchmark resolution is intact.

### Task 3.1: Build the winning session-evidence path fully

**Files:**
- Determined by ADR outcome

**Steps:**
1. Expand the winning prototype into the full implementation.
2. Ensure benchmark cleanup, indexing, and result resolution all understand the winning evidence shape.
3. Keep all retrieval traffic flowing through the same planner/authority path.

### Task 3.2: Add synthetic preference/userfact evidence

**Files:**
- Create or modify evidence-population modules in the winning path
- Add focused tests for extraction and provenance

**Steps:**
1. Add synthetic preference/userfact evidence tied to session identity and source events.
2. Keep this evidence auditable and traceable; do not create orphan synthetic facts.
3. Validate gains primarily against `single-session-preference` and related canary cases.

### Task 3.3: Add assistant-aware second pass

**Files:**
- Modify retrieval path in the winning architecture
- Add targeted tests for assistant-reference cases

**Steps:**
1. Add a second-pass retrieval policy for cases where assistant content likely carries the answer.
2. Keep this conditional and explicit in traces; it should be a specialized path, not the universal default.
3. Validate on assistant-reference canary cases and ensure no broad regression.

### Task 3.4: Preserve turn-level truth

**Files:**
- Modify benchmark result resolution code in `packages/memory-engine/src/mongodb-manager.ts`
- Add tests for provenance resolution

**Steps:**
1. Ensure session or synthetic hits can still resolve back to the right session and original turn evidence.
2. Make provenance visible in traces and benchmark debugging artifacts.
3. Verify session-level gains do not silently destroy turn-level interpretability.

## Phase 4: Fusion Lock And Acceptance

> **Exit criteria:** canonical fusion/default policy is evidence-backed, full benchmark completes, final artifacts are publishable and explainable.

### Task 4.1: Run fusion ablation on the mature candidate

**Files:**
- Create or modify: `scripts/run-fusion-ablation.ts`
- Update benchmark artifact docs if needed

**Steps:**
1. Compare the mature candidate across `rankFusion`, `scoreFusion`, vector-only, and any still-relevant fallback mode.
2. Use the canary first; only run full benchmark on the winner.
3. Lock the canonical broad default based on measured evidence, not preference.

### Task 4.2: Run final full LongMemEval-S benchmark

**Files:**
- Use existing benchmark runner and artifact paths

**Steps:**
1. Run the full benchmark on the winning mature candidate.
2. Record commit, dataset hash, full metrics, per-type breakdown, and trace artifacts.
3. Treat the benchmark as publishable only if correctness and artifact completeness hold.

### Task 4.3: Write the final acceptance memo

**Files:**
- Create a benchmark result memo under the existing artifact/checkpoint structure

**Steps:**
1. Summarize what changed, why it won, and which defaults were locked.
2. Include benchmark proof, not just design prose.
3. Call out honest residual risks or follow-on opportunities instead of hiding them.

## Phase Autonomy

- **AFK-safe:** Tasks 0.2, 0.3, 0.4, 0.5, 1.1, and 4.1 can be executed by a build agent without user checkpoint once started.
- **HITL before commit to winner:** Task 2.3 should produce the ADR decision output for review before the losing architecture path is discarded.
- **HITL before full benchmark run:** Task 4.2 should confirm the mature candidate commit and benchmark environment before the overnight acceptance run.

## SKILL_HINTS

Use these where relevant during implementation and verification:

- `mongodb-search-and-ai`
  - validate vector-search, Atlas Search, fusion, and ENN behavior against official MongoDB guidance
- `mongodb-schema-design`
  - validate any schema/index changes, especially if ADR Option B introduces a dedicated session-evidence collection
- `mongodb-query-optimizer`
  - validate index/filter tradeoffs and confirm selective pushdown assumptions
- `verification-before-completion`
  - run before claiming a phase is done

## Cross-Phase Contracts

- **Retrieval authority contract:** no phase introduces a second planner or alternate primary search path.
- **Provenance contract:** every new evidence document or retrieval hit must preserve a path back to source events.
- **Harmony contract:** no public knob ships unless it changes behavior and is benchmark- or product-justified.
- **Benchmark contract:** canary first, full benchmark only at explicit acceptance gates.
- **ADR contract:** the session-evidence storage shape is open until the ADR experiment closes it.

## Risks

| Risk | Probability | Impact | Score | Mitigation |
|------|-------------|--------|-------|------------|
| Fixing retrieval quality while silently fragmenting the architecture | 3 | 5 | 15 | Enforce one planner/one authority/ADR lock before productionization |
| Chasing full benchmarks too often and losing iteration speed | 4 | 4 | 16 | Canary-first protocol |
| Session-level gains harming turn-level truth | 3 | 5 | 15 | Provenance contract + explicit benchmark resolution tests |
| Hard-locking config defaults without evidence | 3 | 4 | 12 | Canary ablation before default changes |
| Architecture argument stalls the whole wave | 2 | 5 | 10 | Narrow ADR experiment with explicit winner rules |

## Acceptance Checks

- `bun run check-types`
- relevant focused Vitest suites for each modified area
- stratified canary after every meaningful retrieval change
- full LongMemEval-S only after Phase 2 winner lock and final Phase 4 candidate
- final artifact bundle must include:
  - commit hash
  - dataset hash
  - top-line metrics
  - per-question-type breakdown
  - trace artifacts sufficient to explain the result
