# Retrieval Excellence Design: Memongo #1 on LongMemEval

**Date:** 2026-04-14
**Status:** Converged design baseline
**Baseline:** 73.4% R@5, 77.0% R@10, NDCG@10 56.1% on the first completed LongMemEval-S run
**North Star:** state-of-the-art LongMemEval-S retrieval with one MongoDB-native brain
**Stretch Goal:** push toward benchmark leadership and the practical ceiling of the corpus, with honest proof at every step

## Purpose

Memongo has reached the point where benchmark quality, product identity, and MongoDB showcase value are the same problem.

This design exists to answer one question:

How do we steal the best retrieval ideas from the strongest reference systems, express them through MongoDB-native capabilities, and improve LongMemEval-S dramatically without turning Memongo into a split-brain feature museum?

This is not a generic roadmap. It is the strategic source of truth for the focused retrieval-excellence wave that comes after the first completed benchmark run.

## Evidence Inputs

This design is based on four evidence classes:

1. **Benchmark reality**
   - first completed LongMemEval-S result
   - weakest categories: `single-session-user`, `single-session-preference`
   - recall plateau at higher `k`, which indicates representation/policy problems rather than pure candidate-count starvation

2. **Reference-repo code**
   - `LongMemEval`: session vs turn granularity, expansion strategies, temporal-aware evaluation
   - `mempalace`: session-aware retrieval, synthetic preference evidence, assistant-aware second pass, wake-up/checkpoint mindset
   - `hindsight`: multi-lane retrieval, traces, rerank discipline, temporal reasoning
   - `graphiti`: temporal truth/invalidation rigor
   - `langmem`, `mem0`, `letta`, `supermemory`, `cognee`: orchestration, scoped surfaces, DX, document-first ingest, operator visibility

3. **MongoDB-native capability validation**
   - `$rankFusion` broad default for heterogeneous lanes
   - `$scoreFusion` as a specialist tool when score-aware weighting is actually proven useful
   - `exact: true` ENN as a real truth/evaluation lane
   - selective filter pushdown as a real performance and quality lever
   - strict index readiness as a correctness requirement
   - cross-collection search is possible, but same-collection native fusion remains a meaningful architectural advantage when it fits the data shape

4. **Stored Memongo validation checkpoints**
   - `.claude/checkpoints/2026-04-12-first-checkpoint-final-validation.md`
   - `.claude/checkpoints/2026-04-12-clean-room-subagent-synthesis.md`
   - `.claude/checkpoints/2026-04-12-mongodb-reference-harmony-matrix.md`
   - `.claude/checkpoints/2026-04-12-mongodb-competitor-harmony-convergence.md`
   - `.claude/checkpoints/2026-04-12-state-of-the-art-adoption-gate.md`

These checkpoint artifacts are not treated as code truth or MongoDB truth. They are treated as the stored conclusions of the clean-room research mission and therefore as strategic guardrails.

## Users

- **Benchmark evaluators** who compare Memongo against purpose-built memory frameworks
- **Developers** deciding whether Memongo is the long-term memory layer they should trust
- **Operators** who need benchmark artifacts, traces, and explanations instead of marketing claims

## Success Criteria

- LongMemEval-S improves materially and honestly from the first completed run
- The worst categories, especially `single-session-user` and `single-session-preference`, move substantially upward
- The retrieval architecture remains one coherent Memongo brain:
  - one planner
  - one retrieval authority
  - one provenance story
  - no second runtime
- Benchmark debugging becomes explainable through canaries and deep traces, not overnight guesswork
- MongoDB is used as a differentiator, not as branding pasted over a generic retrieval stack

## Non-Negotiable Constraints

- **MongoDB-native only**
  - no external vector stores
  - no second graph DB
  - no second memory engine

- **Harmony first**
  - no redundant public knobs
  - no competing truth systems
  - no “session cache architecture” that drifts from the canonical brain

- **Canary before full benchmark**
  - full 4.5h benchmark runs are acceptance gates, not every-task diagnostics

- **Evidence before defaults**
  - fusion policy, candidate counts, thresholds, and architecture choices must be benchmark-backed where they are disputed

- **Turn provenance preserved**
  - any session-level or synthetic evidence must retain a path back to original events/turns

## Out Of Scope

- LoCoMo, BEAM, and WMB-100K benchmark expansion before LongMemEval-S retrieval is stabilized
- Generative retrieval policies that hide evidence provenance
- Product-surface expansion unrelated to benchmark truth, MongoDB-native elegance, or operator clarity

## Converged Strategic Thesis

The best path is one integrated retrieval wave, not a chain of isolated tweaks.

That wave should improve five things together:

1. **Correctness**
   - fix known scope-cache leakage
   - align retrieval defaults with the intended model

2. **Measurement**
   - add a stratified canary
   - add lane-level traces, score details, provenance visibility, and rerank visibility
   - add ENN as a truth/evaluation lane for selective scopes and accuracy checks

3. **Evidence representation**
   - session-aware evidence
   - synthetic preference/userfact evidence
   - temporal-aware signals
   - assistant-aware second pass when needed

4. **Query-time quality policy**
   - `rankFusion` as the broad default
   - `scoreFusion` only where a query family proves it deserves it
   - vector-only and ENN remain first-class lanes
   - post-retrieval scoring remains a ranking aid, not a second retrieval engine

5. **Acceptance discipline**
   - canary after every meaningful retrieval change
   - full benchmark only after a coherent candidate exists

## Competitor Ideas To Steal, And Their Native Memongo Form

### Hindsight

Steal:
- multi-lane recall
- temporal-aware retrieval
- traceability and rerank discipline

Native Memongo form:
- planner-driven parallel lanes
- benchmark trace enrichment
- post-retrieval and rerank visibility
- no external retrieval orchestrator

### MemPalace

Steal:
- session-aware evidence
- synthetic preference evidence
- assistant-aware second pass
- checkpoint/wake-up mentality

Native Memongo form:
- canonical evidence docs with provenance
- explicit wake-up/checkpoint semantics over existing lifecycle
- no shell-hook or filesystem-centered truth store

### Graphiti

Steal:
- temporal truth maintenance
- contradiction/invalidation rigor

Native Memongo form:
- stronger temporal semantics on existing structured memory and graph collections
- no separate temporal graph engine

### LangMem

Steal:
- search existing memory, update/delete precisely, then consolidate

Native Memongo form:
- orchestration policy over existing structured memory, procedures, and consolidation
- no second prompt-optimization subsystem as the product core

### Supermemory

Steal:
- document-first ingest
- source-aware operator outputs

Native Memongo form:
- canonical docs/chunks/ingest jobs
- no separate connector memory store

### Mem0 / Letta / Cognee

Steal:
- scoped surfaces
- editable core/wake-up clarity
- explicit retrieval/query modes where they reduce confusion

Native Memongo form:
- thinner facades over canonical collections and planner behavior
- no simplified parallel truth store

## MongoDB-Native Leverage

### Keep as core identity

- `$rankFusion` for heterogeneous recall lanes
- `exact: true` ENN as truth/evaluation lane
- Voyage reranking as the high-precision second stage
- selective filter pushdown in search/vector search
- traceable explainability and query governance surfaces

### Use selectively

- `$scoreFusion` only when a query family proves score-aware combination is better
- vector-only when lexical signal is not helping
- flat indexes, view-routed strategies, and quantization only when the retrieval architecture is already correct

### Treat as later optimization, not first unlock

- flat-index routing
- quantization
- read-model/materialized-view refinement
- broader change-stream expansion

These may matter for the final product story, but the first benchmark unlock is retrieval evidence shape plus policy, not infrastructure ornamentation.

## Harmony Rules

These rules came through consistently across the clean-room comparison and the benchmark analysis:

- one planner
- one retrieval authority
- one provenance story
- one runtime brain
- no benchmark-only hacks that become permanent product identity
- no dead knobs
- no hidden sidecars

If a candidate feature cannot explain itself as a native extension of Memongo’s existing nervous system, it does not ship.

## Unresolved Decision

One question is still intentionally open:

How should session-aware evidence be physically expressed?

- extend the canonical evidence path more directly
- or use a dedicated session-evidence collection/lane

This is now an Architecture Decision Record, not a pre-baked conclusion.

See:

- `docs/plans/2026-04-14-session-evidence-architecture-adr.md`

The winner must be chosen by evidence on the canary, not by taste.

## Workstreams

### Workstream A: Truth And Diagnostics

- scope-cache correctness
- canary runner
- trace enrichment
- ENN truth lane
- strict readiness discipline

### Workstream B: Query-Time Quality

- question-date wiring
- post-retrieval scoring signals
- threshold/candidate ablations
- rerank visibility

### Workstream C: Session Evidence And Benchmark-Critical Evidence

- session-aware evidence
- synthetic preference/userfact evidence
- assistant-aware second pass
- provenance-safe result resolution

### Workstream D: Final Fusion And Acceptance

- fusion ablation
- canonical default lock
- full benchmark acceptance run

## Differences From The Previous Draft

The previous draft had three major problems:

1. It pre-baked `session_chunks` as a durable decision.
2. It assumed a full benchmark should happen after every phase.
3. It mixed strategic doctrine, implementation queue, and unresolved architecture choice into one artifact.

This revised design corrects all three:

- the session-evidence question is now an ADR
- canaries are the default verification loop
- the execution details belong in the implementation plan, not in the strategy document

## Decision

This design is the strategy source of truth for the next build wave.

It does **not** settle every implementation detail.
It does settle the contract:

- steal the best benchmark-critical ideas
- express them through MongoDB-native Memongo architecture
- preserve harmony
- measure everything
- lock disputed defaults only after evidence
