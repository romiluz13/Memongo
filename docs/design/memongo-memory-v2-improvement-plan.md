# Memongo Memory V2 Improvement Plan

## Purpose

This document is the single implementation plan for the next Memongo memory hardening and improvement wave.

Target outcome:

- keep Memongo fully MongoDB-first
- preserve the current event-first architecture
- improve retrieval correctness, freshness, observability, and runtime behavior
- avoid architectural regressions while moving the richer v2 design into the default production path

This is not a brainstorming note. It is the phase-by-phase execution plan.

## Execution Discipline

This file is the one authoritative planning artifact for the V2 memory improvement wave.

Rules for execution:

1. Do not run multiple implementation phases in one coding pass.
2. Before each phase, capture the current behavior with targeted tests and one live MongoDB baseline run.
3. Only promote a phase after its local tests and live MongoDB gate are green.
4. If a phase improves one scenario but regresses another, stop and fix the regression before moving on.
5. If a MongoDB-specific design choice is unclear, check the official MongoDB docs before coding.
6. If an idea cannot be expressed cleanly in event-first, MongoDB-native seams, reject it.

## Definition Of Success

We will call this wave successful only if all of the following become true together:

- `memory_search` behaves like the V2 architecture, not the legacy merged path
- hard constraints reduce wrong-memory retrieval materially
- durable facts and decisions can change over time without silent truth loss
- fresh recall works directly from canonical events when it must
- summaries compress context without becoming truth
- operators can tell the difference between missing memory, degraded retrieval, projection lag, and ingest failure
- the real Docker-backed MongoDB gate stays green

## Phase Order And Dependency Rules

Execution order is strict:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8

Dependency rules:

- Phase 1 must land before planner-quality work matters.
- Phase 2 must land before retrieval-quality claims are trusted.
- Phase 3 must land before long-lived “best memory” claims are credible.
- Phase 4 must land before projection-derived features are treated as production behavior.
- Phase 5 protects freshness while the other phases evolve.
- Phase 6 depends on canonical summaries staying derived.
- Phase 7 must not outrun Phase 3 provenance work.
- Phase 8 closes the loop for operator trust and release confidence.

## Product Goal

Build the strongest MongoDB-native memory layer for OpenClaw-style agents:

- canonical runtime truth in MongoDB
- clear separation between memory and knowledge base
- safe retrieval routing across memory shapes
- auditable change over time
- derived projections that behave like infrastructure, not demos

## Source of Truth

For MongoDB-specific behavior, trust only official MongoDB web documentation.

Primary MongoDB references for this plan:

- MongoDB Search overview: [https://www.mongodb.com/docs/atlas/atlas-search/](https://www.mongodb.com/docs/atlas/atlas-search/)
- MongoDB Search query composition: [https://www.mongodb.com/docs/atlas/atlas-search/searching/](https://www.mongodb.com/docs/atlas/atlas-search/searching/)
- MongoDB Search `compound` operator: [https://www.mongodb.com/docs/atlas/atlas-search/compound/](https://www.mongodb.com/docs/atlas/atlas-search/compound/)
- MongoDB hybrid search: [https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/](https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/)
- MongoDB Vector Search with full-text search: [https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/vector-search-with-full-text-search](https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/vector-search-with-full-text-search)
- MongoDB change streams: [https://www.mongodb.com/docs/manual/changeStreams/index.html](https://www.mongodb.com/docs/manual/changeStreams/index.html)
- MongoDB TTL indexes: [https://www.mongodb.com/docs/manual/core/index-ttl/](https://www.mongodb.com/docs/manual/core/index-ttl/)
- MongoDB `$graphLookup`: [https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphlookup/](https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphlookup/)
- MongoDB `$rankFusion`: [https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankfusion/](https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankfusion/)
- MongoDB `$scoreFusion`: [https://www.mongodb.com/docs/manual/reference/operator/aggregation/scorefusion/](https://www.mongodb.com/docs/manual/reference/operator/aggregation/scorefusion/)
- MongoDB `moreLikeThis`: [https://www.mongodb.com/docs/atlas/atlas-search/operators-collectors/morelikethis/](https://www.mongodb.com/docs/atlas/atlas-search/operators-collectors/morelikethis/)

For Memongo behavior, the source of truth is the current codebase.

## Non-Negotiable Invariants

These rules must survive every phase:

1. MongoDB is the only canonical runtime memory backend.
2. Canonical runtime truth is event-first.
3. Chunks, entities, relations, episodes, summaries, caches, and embeddings are derived products.
4. `MEMORY.md` and `memory/*.md` stay bridge notes only, never runtime truth.
5. Knowledge base and memory remain separate:
   - KB = externally authored reference material
   - memory = interaction-derived facts, preferences, decisions, relationships, and experience
6. Runtime improvements must favor correctness over novelty.
7. Any improvement that weakens scope safety, provenance, or freshness is rejected.

## Current Strengths We Must Preserve

Memongo already has strong foundations:

- canonical event writes
- scope-aware memory via `scope` and `scopeRef`
- graph entities and relations
- episodic materialization
- structured memory
- KB separation
- MongoDB-native lexical/vector/hybrid retrieval
- relevance tracing and status machinery

The plan improves the runtime path without discarding these advantages.

## Confirmed Gaps

These are the gaps this plan addresses:

1. The default `memory_search` path is still not truly v2-first.
2. Retrieval planning is still too heuristic and not constraint-aware enough.
3. Structured durable memory still behaves too much like overwrite-by-key.
4. Projection capabilities exist, but projection operations are not yet treated like fully observable infrastructure.
5. Recent conversational recall still depends too much on chunk retrieval instead of event-native recall.
6. Entity resolution is useful but still too primitive for long-lived memory correctness.
7. Health semantics are not yet explicit enough for operators or agent reasoning.
8. Summary materialization exists, but summary references and JIT expansion are not first-class runtime behavior.

## Explicit Rejections

The following ideas are rejected for Memongo:

- vectorless-first memory as the default
- tree-navigation as the default runtime memory engine
- replacing hybrid retrieval with document-style top-down traversal
- using TTL on canonical events as a retention strategy
- importing AWM's memory taxonomy as the architectural center
- introducing any second source of truth
- making Markdown memory files durable runtime memory again

## Design Principles For All Changes

1. Improve the default runtime path before adding new optional features.
2. Prefer planner and projection improvements over schema sprawl.
3. Keep agent-facing tool contracts stable where possible.
4. Make every derived product auditable back to canonical events.
5. Add observability whenever a new derived behavior is introduced.
6. Keep KB-oriented ideas inside KB unless they clearly generalize.

## Implementation Phases

## Phase 0: Freeze The Contract

### Goal

Create a stable implementation boundary so later phases do not reintroduce drift.

### Primary Code Surfaces

- `src/agents/tools/memory-tool.ts`
- `src/agents/memory-search.ts`
- `src/memory/backend-config.ts`
- `src/memory/types.ts`
- `docs/concepts/memory.md`
- `docs/design/memongo-memory-v2-improvement-plan.md`

### Tasks

1. Restate the invariant boundaries in code-adjacent docs and comments where needed.
2. Lock the internal meaning of:
   - canonical event
   - derived chunk
   - structured memory
   - episode
   - KB document
   - bridge note
3. Confirm that runtime prompts, memory tools, and docs consistently describe:
   - `memory_search` as runtime memory recall
   - `kb_search` as reference retrieval
   - `memory_get` as exact read
   - `memory_write` as durable structured write
4. Record a baseline of current behavior before Phase 1:
   - legacy `manager.search(...)` path behavior
   - current `searchV2(...)` behavior
   - live MongoDB gate results
5. Write down a rollback rule for each later phase: revert to the last green phase, not to ad-hoc partial behavior.

### What Not To Do

- no schema redesign
- no new retrieval algorithm
- no new memory type

### Validation

- `pnpm build`
- `pnpm tsgo`
- targeted prompt/tool/docs tests
- grep audit for stale Markdown-as-memory instructions
- one baseline live MongoDB run recorded in the implementation notes for this wave

## Phase 1: Make The Default Retrieval Path Truly V2-First

### Goal

Make the public `memory_search` experience planner-driven by default.

### Why

The richer architecture exists, but the production path still mainly uses the flatter merged search path.

### Primary Code Surfaces

- `src/agents/tools/memory-tool.ts`
- `src/memory/mongodb-manager.ts`
- `src/memory/mongodb-retrieval-planner.ts`
- `src/memory/types.ts`
- tests covering `memory_search` and manager behavior

### Tasks

1. Route `memory_search` through a planner-driven execution path.
2. Keep the public tool contract unchanged.
3. Keep the old search path only as controlled fallback.
4. Preserve source coverage across:
   - conversation memory
   - bridge notes
   - structured memory
   - KB
5. Ensure planner output and fallback path are traceable.
6. Keep source budgets intentional so bridge notes remain searchable but auxiliary.
7. Preserve the current manager cache and scope identity guarantees while changing the internal path.

### What Not To Do

- do not remove the legacy path until the new path is validated live
- do not ship an LLM-planner loop as the default
- do not make KB-style document navigation part of general memory recall

### Validation

- targeted tests around `memory_search`
- search trace coverage
- live MongoDB search correctness on runtime memory
- regression tests for conversation, structured, and KB queries
- before/after comparison showing the public tool now flows through the V2 path
- rollback proof: legacy search can still be re-enabled if a live regression appears

## Phase 2: Add Hard-Filtered Retrieval Planning

### Goal

Reduce wrong-memory retrieval by extracting and enforcing real constraints.

### Why

The biggest failure mode in production is not “no memory”; it is “retrieved the wrong memory from the wrong time, scope, or source.”

### Primary Code Surfaces

- `src/memory/mongodb-retrieval-planner.ts`
- `src/memory/mongodb-manager.ts`
- `src/memory/mongodb-search.ts`
- `src/memory/mongodb-kb-search.ts`
- `src/memory/mongodb-structured-memory.ts`
- `src/memory/mongodb-scope.ts`
- planner and retrieval integration tests

### Tasks

1. Extend planning to extract:
   - temporal constraints
   - scope constraints
   - actor/entity constraints
   - source/type constraints
2. Treat high-confidence temporal and scope constraints as hard filters.
3. Split retrieval intent more explicitly across:
   - raw-window
   - episodic
   - graph
   - structured
   - lexical
   - vector
   - hybrid
   - KB
4. Push more lexical filtering into MongoDB Search `compound.filter`.
5. Keep vector prefiltering aligned with official MongoDB guidance.
6. Make planner output explain which constraints were treated as hard filters versus ranking hints.
7. Add negative tests proving that clearly out-of-scope memories stay excluded even when semantically similar.

### What Not To Do

- do not rely on soft ranking when the query contains clear hard boundaries
- do not make graph expansion the first step for all queries
- do not allow bridge-note retrieval to dominate runtime conversation recall

### Validation

- targeted planner tests by query class
- exact-time and exact-scope retrieval scenarios
- tests for source isolation
- live MongoDB explain traces confirming filter placement
- cross-check lexical filter behavior against official MongoDB Search docs when `compound.filter` changes

## Phase 3: Add Correctness Under Change

### Goal

Prevent stale durable memory from silently overwriting history.

### Why

Stale memory is worse than missing memory. Durable memory must represent change explicitly.

### Primary Code Surfaces

- `src/memory/mongodb-structured-memory.ts`
- `src/memory/mongodb-graph.ts`
- `src/memory/mongodb-schema.ts`
- `src/memory/types.ts`
- retrieval and read-path tests for durable memory

### Tasks

1. Redesign structured memory semantics around append-first or supersede-first behavior.
2. Introduce explicit concepts for durable facts and decisions:
   - provenance
   - superseded
   - invalidated
   - valid-from
   - valid-to
   - confidence
3. Keep “current truth” as a filtered or derived view.
4. Apply the same design discipline to graph relations where identity or truth can change.
5. Preserve exact provenance for writes that originate from user turns, agent writes, imports, or future projectors.
6. Define how contradictions surface in retrieval instead of silently disappearing.

### What Not To Do

- do not destroy historical truth
- do not silently merge contradictory facts
- do not conflate “same entity” with “possible same entity”

### Validation

- stale preference update scenarios
- superseded decision scenarios
- provenance visibility in retrieval
- tests ensuring older truth remains auditable
- live MongoDB scenarios proving “latest view” and “historical truth” can both be read correctly

## Phase 4: Make Projection A First-Class Runtime Subsystem

### Goal

Treat chunks, graph, episodes, and future summaries as observable derived infrastructure.

### Why

Projection features are only production features if lag, failure, and retry are visible and attached to the real runtime write path.

### Primary Code Surfaces

- `src/memory/runtime-write.ts`
- `src/memory/mongodb-manager.ts`
- `src/memory/mongodb-events.ts`
- `src/memory/mongodb-ops.ts`
- `src/memory/mongodb-change-stream.ts`
- `src/memory/mongodb-graph.ts`
- `src/memory/mongodb-episodes.ts`
- projection telemetry tests

### Tasks

1. Identify the single canonical runtime write path.
2. Attach projectors explicitly to that path.
3. Ensure projection telemetry exists for:
   - chunks
   - entities
   - relations
   - episodes
   - summary references if introduced
4. Record:
   - projection start
   - projection success/failure
   - lag
   - item counts
   - retry state
5. Make change-stream health and resume-token behavior explicit where change streams participate in projection flow.
6. Ensure projection lag is queryable without scraping logs.

### What Not To Do

- do not leave projection success implicit
- do not let tests be the only place where projection runs are visible
- do not treat graph or episode extraction as “best effort magic”

### Validation

- projection run telemetry tests
- lag reporting tests
- live write -> projection -> retrieval timing checks
- degraded projection status surfaced in manager status
- change-stream interruption and resume scenarios validated against MongoDB change stream behavior

## Phase 5: Finish Event-Native Recent Recall And Protect It From Regression

### Goal

Ensure fresh memory does not depend on chunk projection for recent conversation recall.

### Why

Recent recall should come directly from canonical events; chunks are a derived retrieval product.

### Primary Code Surfaces

- `src/memory/mongodb-manager.ts`
- `src/memory/mongodb-events.ts`
- `src/agents/tools/memory-tool.ts`
- runtime-write and recent-recall E2E tests

### Tasks

1. Make raw-window and recent recall event-native.
2. Use chunks primarily for broader retrieval and ranking, not for all freshness-sensitive recall.
3. Keep events and chunks aligned, but do not require chunk availability for immediate conversational memory.
4. Remove any remaining ambiguity about transcript-sync dependence.
5. Add regression protection so future ranking work cannot accidentally restore chunk-only freshness assumptions.

### What Not To Do

- do not regress to transcript-sync freshness
- do not make bridge sync part of live runtime correctness
- do not let legacy `sessions` chunks silently dominate recent recall

### Validation

- immediate post-write recall tests
- write-event without projection delay tests
- live Docker-backed runtime write E2E
- explicit failure-mode test where chunk projection lags but recent recall still succeeds

## Phase 6: Add Summary References And JIT Expansion

### Goal

Use summaries and episodes to compress context without replacing raw truth.

### Why

This is the strongest usable idea from AWM: compact references are useful, but only when they remain derived and expandable back to canonical events.

### Primary Code Surfaces

- `src/memory/mongodb-episodes.ts`
- `src/memory/mongodb-manager.ts`
- `src/agents/tools/memory-tool.ts`
- any new summary-reference helper module
- summary-resolution tests

### Tasks

1. Define a summary-reference format for derived episodic or thread summaries.
2. Keep summary references compact and stable.
3. Allow exact reopening of the underlying event window when needed.
4. Ensure summaries guide retrieval and context pressure management, not canonical truth.
5. Preserve mark-not-delete semantics for consolidated event histories.
6. Define when the runtime should stay on the summary and when it must reopen the source.

### What Not To Do

- do not store duplicated “full_content” as new truth
- do not let summaries compete with canonical raw events
- do not hide the path back to the underlying source

### Validation

- summary reference resolution tests
- exact expansion tests
- recap-query tests
- high-stakes answer path reopening the source events
- live MongoDB recap flow that proves summaries and raw events stay aligned

## Phase 7: Strengthen Entity Resolution Safely

### Goal

Improve graph usefulness without poisoning long-term memory through unsafe merges.

### Why

Entity resolution is high leverage and high risk.

### Primary Code Surfaces

- `src/memory/mongodb-graph.ts`
- `src/memory/mongodb-schema.ts`
- `src/memory/types.ts`
- `src/memory/mongodb-manager.ts`
- graph and identity-resolution tests

### Tasks

1. Add explicit distinction between:
   - confirmed same entity
   - candidate same entity
   - related mention
2. Keep merges reversible and provenance-backed.
3. Prefer graph expansion as a retrieval enhancer, not a hidden truth mutation.
4. Use confidence-aware relation handling.
5. Define the operator-visible path for correcting a bad merge or bad candidate link.

### What Not To Do

- do not silently canonicalize identity from weak mention overlap
- do not let co-occurrence become hidden identity truth
- do not blur cross-scope entities

### Validation

- alias collision scenarios
- same-name different-scope scenarios
- graph-assisted retrieval precision tests
- live MongoDB scenarios proving cross-scope identity does not bleed

## Phase 8: Strengthen Health Semantics

### Goal

Give operators and the agent a meaningful operational vocabulary for memory health.

### Why

A retrieval miss, stale projection, failed ingest, and weak query should not all collapse into one vague “memory failed” state.

### Primary Code Surfaces

- `src/memory/mongodb-manager.ts`
- `src/memory/mongodb-relevance.ts`
- `src/memory/mongodb-ops.ts`
- status/reporting surfaces
- operator-facing tests and diagnostics checks

### Tasks

1. Distinguish and surface at least:
   - no relevant results
   - retrieval degraded
   - projection behind
   - canonical ingest failed
   - derived product unavailable
   - health uncertain
2. Improve status output for operators.
3. Improve trace/explain visibility for debugging.
4. Consider safe agent-facing health hints where helpful.
5. Ensure degraded states are machine-actionable, not just human-readable strings.

### What Not To Do

- do not leak overly internal infrastructure details into normal agent behavior
- do not let degraded infrastructure masquerade as “nothing remembered”

### Validation

- forced degraded-mode tests
- status output assertions
- explain/trace artifact tests
- live failure injection where feasible so operator states are proven, not inferred

## Experimental Track

These are allowed only as bounded experiments after the main phases are stable:

1. Query-adaptive lexical/vector weights
2. Entity-aware reranking
3. Graph-assisted second-pass retrieval
4. Dynamic `numCandidates` tuning
5. Scoped semantic/query cache with strict invalidation
6. KB-only structure-aware retrieval for imported docs
7. `moreLikeThis` only if a concrete memory use case justifies it and official MongoDB behavior fits the design

Each experiment must:

- stay behind a clear seam
- have a rollback path
- prove better quality in live tests before promotion

Experiments must not start until Phases 1 through 5 are green.

## MongoDB-Specific Rules

These rules come directly from the official MongoDB docs and must guide implementation:

1. Use `compound.filter` for lexical hard filters because filter clauses do not contribute to score.
2. Treat lexical/vector fusion and weighting as capability-gated and query-dependent tuning work, not a hard-coded dogma.
3. Treat `$rankFusion` and `$scoreFusion` as version/capability-gated.
4. Treat change streams as infrastructure that requires explicit resume-token, retry, and health behavior.
5. Use TTL only for caches or clearly disposable derived data, not canonical event truth.
6. Use `$graphLookup` as a controlled graph-enrichment tool, not a substitute for provenance-safe identity logic.

## Phase Completion Template

Every phase closeout should capture the same evidence:

1. What changed
2. Which files changed
3. What invariants were protected
4. Which tests were added or updated
5. Exact live MongoDB command run
6. Pass/fail/skip counts
7. Before/after scenarios improved
8. Rollback plan if a later phase regresses this one

## Validation Strategy

Every phase must pass all applicable layers:

### 1. Build and Targeted Tests

- `pnpm build`
- `pnpm tsgo`
- `pnpm check`
- touched unit and integration suites

### 2. Live MongoDB Docker Gate

Required at the end of any phase that changes runtime memory behavior:

```bash
pnpm test -- src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose
```

Before trusting the result:

- verify the run is using the real Docker-backed MongoDB stack
- confirm whether automated embedding coverage is available in the environment
- if vector behavior is degraded, separate environment readiness from product regressions

### 3. Scenario Validation

Run scenario-based checks for:

- recent recall
- wrong-time / wrong-scope exclusion
- stale fact supersession
- recap queries
- graph/entity queries
- KB vs memory routing
- bridge-note non-interference
- degraded projection visibility
- structured-memory history reads
- event-native recall during projection lag

### 4. Acceptance Criteria

A phase is complete only when:

1. The new behavior is active in the intended runtime path.
2. There is a clear fallback or rollback path if needed.
3. Live MongoDB tests pass.
4. No invariant is weakened.
5. Retrieval quality improves without new correctness regressions.
6. The phase produced evidence that quality improved, not just that tests still pass.

## Use Of Sub-Agents During Implementation

Sub-agents are allowed and encouraged for:

- codebase investigation
- independent design review
- official-doc verification
- test triage
- post-change validation review

Sub-agents must not be treated as final coding authority.

Implementation rule:

- sub-agents may investigate, summarize, compare, and challenge assumptions
- final code changes and design decisions remain with the main implementation agent

## Final Release Gate

Do not call the work complete until all approved phases are done and the final live gate passes on the real Docker-backed MongoDB stack.

Final gate:

1. `pnpm build`
2. `pnpm tsgo`
3. `pnpm check`
4. all touched tests green
5. live MongoDB gate green
6. no unresolved health/lag ambiguity
7. memory and KB boundaries still explicit
8. before/after validation notes show that the new behavior improved at least the target scenarios for each shipped phase
9. event-first truth still intact

## Success Definition

The plan succeeds when Memongo can credibly claim:

- MongoDB is the single runtime brain
- memory correctness is stronger than before
- retrieval is more deliberate and less wrong
- change over time is represented safely
- summaries compress without replacing truth
- graph and episodes behave like real infrastructure
- operators can tell what is healthy, stale, degraded, or failed

That is the standard required before calling this the strongest OpenClaw-style memory implementation built on MongoDB.
