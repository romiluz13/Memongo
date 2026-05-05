# LongMemEval 96+ Master Plan

## Purpose

This is the fresh, zero-history master plan for pushing Memongo toward `96%+`
session-level `RecallAny@5` on LongMemEval-S.

This document is grounded only in:

- Memongo code
- benchmark artifacts in this repository
- reference-repo code in the external `memory-referance` workspace
- official MongoDB docs and MongoDB MCP knowledge

This document explicitly does **not** use old comparison memos, checkpoint
opinions, README marketing claims, or historical roadmap claims as evidence.

## Evidence Policy

Allowed evidence:

- `packages/memory-engine/src/mongodb-userfact-evidence.ts`
- `packages/memory-engine/src/mongodb-retrieval-planner.ts`
- `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/benchmark-runs/2026-04-13T23-11-02-973Z-b3bca21a/benchmark-response.json`
- `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/comparison/session-evidence-comparison.json`
- `memory-referance/mempalace/benchmarks/longmemeval_bench.py`
- `memory-referance/LongMemEval/src/retrieval/index_expansion_utils.py`
- `memory-referance/LongMemEval/src/index_expansion/temp_query_search_pruning.py`
- official MongoDB docs:
  - [Vector Search stage](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/)
  - [Accuracy / ENN guidance](https://www.mongodb.com/docs/atlas/atlas-vector-search/improve-accuracy/)
  - [Hybrid search](https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/)
  - [Search `vectorSearch` operator](https://www.mongodb.com/docs/atlas/atlas-search/operators-collectors/vectorSearch/)
  - [View support for Search / Vector Search](https://www.mongodb.com/docs/atlas/atlas-vector-search/view-support/)
  - [Score details](https://www.mongodb.com/docs/atlas/atlas-search/score/get-details/)
  - [Hybrid search product announcement](https://www.mongodb.com/blog/post/product-release-announcements/boost-search-relevance-mongodb-atlas-native-hybrid-search)
  - [Flat indexes announcement](https://www.mongodb.com/company/blog/product-release-announcements/improved-multitenancy-support-in-vector-search-introducing-flat-indexes)

Rejected as evidence:

- old design docs unless revalidated in code
- README score claims without backing artifacts or code
- prior AI conclusions
- harmony arguments that are not tied back to code structure

## Baseline Reality

Source:
`.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/benchmark-runs/2026-04-13T23-11-02-973Z-b3bca21a/benchmark-response.json:1`

What the first completed full run actually says:

- `500/500` cases scored
- internal `rAt5 = 0.5905`
- internal `rAt10 = 0.6577`
- internal `ndcgAt10 = 0.5537`
- official session-level:
  - `RecallAny@5 = 0.7340`
  - `RecallAny@10 = 0.7702`
  - `RecallAll@5 = 0.4660`
  - `NDCGAny@10 = 0.5612`

Weakest question types in the full run:

- `single-session-preference`: `rAt5 = 0.4000`
- `single-session-user`: `rAt5 = 0.4714`
- `multi-session`: `rAt5 = 0.5744`
- `temporal-reasoning`: `rAt5 = 0.6080`

What the canary already proved:

Source:
`.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/comparison/session-evidence-comparison.json:1`

- Baseline canary: `R@5 = 87.8%`
- Option A (`extend chunks`): `R@5 = 92.0%`
- Option B (`session_chunks`): `R@5 = 87.8%`

Interpretation:

- Extending the existing chunk lane with session-linked evidence is already
  empirically better than the separate `session_chunks` path on the current
  canary.
- The benchmark is not blocked by a need for a second retrieval runtime.
- The remaining gap is not "invent more memory systems." It is better
  candidate generation and better benchmark-shaped evidence.

## Zero-History Evidence Ledger

| Idea | Direct evidence | Status | Why it matters | Harmony risk |
| --- | --- | --- | --- | --- |
| Assistant-only second pass | `mempalace/benchmarks/longmemeval_bench.py:1219-1256`, `:1677-1723` | Proven reference pattern, Memongo gap | Assistant-reference questions are handled by a targeted re-query branch, not by globally mixing assistant text into every retrieval path | Low |
| Synthetic session-linked preference docs | `mempalace/benchmarks/longmemeval_bench.py:1259-1265`, `:1668-1735` | Proven reference pattern, partially stolen in Memongo | Same-session synthetic evidence bridges generic user queries to discriminative facts | Low |
| Richer userfact extraction than current regex set | `LongMemEval/src/index_expansion/batch_expansion_session_userfact.py`, `packages/memory-engine/src/mongodb-userfact-evidence.ts:40-105` | Proven gap | Memongo already does userfact extraction, but the reference benchmark extracts broader user facts, dates, life events, and preferences | Low / medium |
| Expansion join mode (`separate`, `merge`, `replace`) | `LongMemEval/src/retrieval/index_expansion_utils.py:17-80` | Proven reference retrieval variable, not fully explored in Memongo | The benchmark code treats join mode as a first-class retrieval dimension | Medium |
| Temporal rebucketing instead of only scalar boosting | `LongMemEval/src/index_expansion/temp_query_search_pruning.py:148-173` | Proven reference pattern, Memongo gap | In-range sessions are moved earlier without hard-filtering the rest away | Medium |
| Query-aware hybrid weighting | Official MongoDB hybrid docs and hybrid blog | Proven MongoDB capability, Memongo plan candidate | Different query types should not share one fixed vector/text mix | Low |
| ENN (`exact: true`) truth lane | Official MongoDB vector search docs | Proven MongoDB capability, likely Memongo gap | Native way to measure ANN miss quality and benchmark truth slices | Low |
| View-backed transformed retrieval surfaces | Official MongoDB view support docs | Proven MongoDB capability, untested for Memongo | Native way to build cleaner retrieval surfaces without collection sprawl | Medium |
| Advanced lexical prefilters before semantic ranking | Official MongoDB Search `vectorSearch` operator docs | Proven MongoDB capability | Better handling of proper nouns, quoted phrases, and anchored lexical cues | Medium |
| Reranking after recall is fixed | `mempalace/benchmarks/longmemeval_bench.py:2765-3103` | Proven reference tactic, not yet proven in Memongo | If the right session enters the candidate pool consistently, reranking can convert candidate recall into top-5 wins | Medium |
| Flat indexes as main benchmark lever | Official flat index docs | Proven capability, low benchmark priority | Useful for multitenancy and small filtered partitions, not obviously the current LongMemEval unlock | Low |

## Current Memongo Reality

Memongo already has the right architectural primitives:

- synthetic userfact evidence exists:
  `packages/memory-engine/src/mongodb-userfact-evidence.ts:8-217`
- retrieval planner scaffolding exists:
  `packages/memory-engine/src/mongodb-retrieval-planner.ts:14-220`

What is missing is not a new brain. What is missing is benchmark-grade use of
those primitives.

The code-backed gaps are:

1. `mongodb-userfact-evidence.ts` is narrower than the reference benchmark
   expansions.
2. Strong `structured` and `procedure` hits can dominate benchmark candidates
   while still being under-credited if search result shaping or benchmark
   diagnostics fail to preserve session-creditable provenance.
3. The planner exists, but there is no proven benchmark-specific assistant
   second pass.
4. Temporal handling is present in spirit, but LongMemEval’s own rebucketing
   pattern is not yet the center of the plan.
5. Join-mode experimentation is not yet a first-class evaluation dimension.

## What We Should Not Do

These ideas are not supported strongly enough to anchor the plan:

- build a second full memory runtime
- add many always-on evidence families at once
- globally mix assistant text into every retrieval path
- rely on blind fusion tuning as the main lever
- treat flat indexes as the immediate LongMemEval unlock
- run full 4.5-hour benchmarks after every small change

## Master Strategy

The path to `96%+` should be executed in coherent waves, not isolated micro-fixes.

### Wave 0: Truth, Tracing, and Benchmark Discipline

Goal: stop guessing.

Wave 0 is intentionally small. The canary runner, miss-ledger path, and ENN
building block already exist in the codebase. The remaining Wave 0 work is to
make the measurement lane trustworthy enough that Wave 1 changes are worth
believing.

Remaining must-have outputs before more architecture work:

- a stable canary protocol on a fixed ingest or fixed benchmark surface
- diagnostic artifacts that preserve benchmark-creditable provenance for strong
  non-conversation hits
- ENN truth checks used as a validation tool, not a broad production default

Why first:

- without this, every retrieval change risks being interpreted through canary
  noise or misleading diagnostics
- MongoDB officially supports both score introspection and ENN truth comparison
- this wave should be short; if it turns into a tooling project, it has failed

### Wave 1: Candidate Generation, Not Ranking Cosmetics

Goal: increase the chance that the correct session is already in the candidate
set.

Priority order:

1. Keep Option A as the backbone.
   The canary already proved `extend chunks` beats `session_chunks`.
2. Expand synthetic userfact / preference evidence.
   Use reference-code-backed patterns, not folklore.
3. Evaluate join mode as a real lever:
   - `separate`
   - `merge`
   - optional `replace` only as a controlled benchmark experiment
4. Preserve same-session identity and provenance for all synthetic evidence.

Expected primary movement:

- `single-session-preference`
- `single-session-user`
- `knowledge-update`
- benchmark cases currently blocked by under-credited structured provenance

### Wave 2: Query-Shaped Branches

Goal: fix specific benchmark failure modes with narrow, native branches.

Priority order:

1. Assistant-only second pass for assistant-reference questions.
2. Temporal rebucketing for temporal queries.
3. Planner-level routing that remains one authority, not multiple runtimes.

Expected primary movement:

- `single-session-assistant`
- `temporal-reasoning`
- some `knowledge-update`

### Wave 2.5: Structured Provenance and Benchmark Credit

Goal: ensure strong structured or procedural hits can receive fair benchmark
credit when their provenance genuinely traces back to the right session.

Priority order:

1. Preserve `sessionId` in structured/procedural search result shaping whenever
   it exists on the stored record.
2. Preserve `sourceEventIds` through structured/procedural result shaping
   whenever they exist on the stored record.
3. Keep benchmark diagnostics aligned with the same session-resolution logic
   used by official scoring.
4. Do not fake session IDs onto records that do not have real session
   provenance.

Expected primary movement:

- `single-session-preference`
- `knowledge-update`
- `temporal-reasoning`

This wave comes before chunking because the current evidence shows a real
provenance-credit seam in existing results, while chunking remains a plausible
later lever rather than the first proven blocker.

### Wave 3: MongoDB-Native Leverage

Goal: use MongoDB capabilities where they genuinely improve retrieval quality
or evaluation quality.

Priority order:

1. Query-aware hybrid policy.
   Different mixes for lexical-heavy vs semantic-heavy vs temporal-heavy
   questions.
2. Advanced lexical-prefilter path where anchored lexical cues matter.
3. View-backed transformed retrieval surfaces if they simplify the benchmark
   surface without splitting the architecture.
4. ENN truth-lane checks for candidate quality and selective benchmark slices.

What this wave is **not**:

- random database feature tourism
- a reason to add five new indexes with no benchmark theory

### Wave 4: Reranking

Goal: convert high candidate recall into high top-5 success.

Only start this wave after:

- the miss ledger shows the correct session is frequently inside the top
  candidate pool
- candidate-generation changes have stabilized

If the right session is still absent, reranking is too early.

## Benchmark-Minimizing Execution Protocol

The main goal is to avoid running a million disappointing full benchmarks.

Rules:

1. No full benchmark for single-line tweaks.
2. Every wave must have a theory, not just a patch.
3. Full benchmark only after a wave passes canary and miss-ledger gates.
4. Do not compare noisy canaries across fresh uncontrolled ingests if a fixed
   ingest protocol is available.
5. Do not combine multiple unrelated experiments in one wave.

Recommended protocol:

1. Build a wave.
2. Run the stratified canary.
3. Inspect the miss ledger.
4. Run ENN truth checks on representative misses.
5. If the wave clearly improves the intended miss family without hurting the
   rest, then and only then run the full benchmark.

Fail-closed gates before a full run:

- no correctness regressions
- intended category lift is visible in the canary
- trace data explains why the lift happened
- no new major collapse in adjacent categories

## Concrete Priorities Toward 96+

If we optimize for highest evidence-to-effort ratio, the next sequence should be:

1. Stabilize the canary protocol and benchmark-creditable provenance path.
2. Improve synthetic userfact / preference evidence using only code-backed
   patterns.
3. Evaluate join mode for that evidence, especially `separate` vs `merge`.
4. Add assistant-only second pass.
5. Add temporal rebucketing.
6. Add query-aware hybrid policy and lexical-prefilter paths where justified.
7. Add reranking only after candidate recall is demonstrably high.
8. Revisit chunking only after the higher-confidence benchmark seams above are
   either exhausted or proven insufficient.

## Success Conditions

This plan should be considered successful only if it achieves all of these:

- Memongo remains one retrieval authority
- new evidence is provenance-preserving and session-native
- MongoDB features are used because they fit the retrieval problem, not because
  they are new
- the benchmark process is disciplined enough that each full run teaches us
  something decisive
- official LongMemEval session-level `RecallAny@5` moves from `73.4%` toward
  `96%+`

## Brutal Honesty

The code and docs justify this as the smartest current path.

They do **not** yet prove that `96%+` is guaranteed.

What they do prove is:

- the current gap is still mostly a retrieval-design problem, not a MongoDB
  capability ceiling
- Memongo already has the right native seams
- the strongest remaining steals are narrow, benchmark-shaped, and compatible
  with one harmonious architecture
