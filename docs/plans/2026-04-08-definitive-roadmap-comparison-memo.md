# Memongo Roadmap vs Corrected Research

Date: 2026-04-08

This memo compares `docs/plans/2026-04-08-definitive-roadmap-plan.md` against:

- `docs/research/2026-04-08-supermemory-architecture-memo.md`
- `docs/research/2026-04-08-honcho-mempalace-reference-corpus-memo.md`
- `docs/research/2026-04-08-memory-surface-landscape.md`
- `docs/experiments/research/2026-04-08-mongodb-native-agent-memory-thesis.md`
- the current Memongo baseline already present in `README.md`, `apps/api/src/routes/v1.ts`, `packages/memory-engine/src/mongodb-context-bundle.ts`, `packages/memory-engine/src/mongodb-profile.ts`, `packages/memory-engine/src/mongodb-active-slate.ts`, `packages/memory-engine/src/mongodb-retrieval-planner.ts`, `apps/mcp/src/server.ts`, and `packages/tools/src/index.ts`

## Executive handoff

If another AI reads only one document, it should read this one.

The most compact version of the corrected research is:

- **70% aligned** — the roadmap is strong on foundation fixes, MongoDB-native primitives, and several important adoption/distribution ideas.
- **20% too narrow** — many roadmap items are directionally right but framed as isolated features instead of parts of one memory-runtime thesis.
- **10% risky** — some items risk bolting smarter behavior onto the wrong core model before the runtime is unified.

The strongest synthesis across the corrected research corpus is:

> **Memongo should become Honcho semantics + Mempalace workflow + Supermemory product shape + Mem0 operational completeness + claude-mem/mengram distribution discipline + MongoDB-native execution.**

In practical terms, that means:

- Memongo should not evolve into "the current architecture plus more clever retrieval lanes and more tools."
- Memongo should evolve into **one coherent memory runtime** with:
  - **one recall plane**
  - **one hot-context plane**
  - **one feedback/review plane**
- The main product surface should center on:
  - `context-bundle`
  - `profile`
  - first-class `memory_blocks`
- The internal runtime should center on:
  - canonical events
  - temporal invalidation
  - provenance
  - unified retrieval projections
  - change-stream-driven materialization

This memo therefore serves two jobs at once:

1. compare the existing roadmap against the corrected research
2. preserve the final strategic opinion in a single handoff artifact

## Evidence status and framing

This document should be read as a **guardrail and convergence memo**, not as a claim that the current Memongo architecture is incoherent or non-functional.

After additional code-grounded challenge review, the strongest evidence-backed framing is:

- the current architecture is **more coherent than the first comparison draft implied**
- the roadmap is **valid as the shipping document**
- the corrected research is still useful, but mostly as:
  - direction-setting pressure
  - product-shape clarification
  - warnings against future drift

The most important corrections are:

- `structured_mem` is **not** an undisciplined catch-all in the code today; it already has category/state/provenance/temporal semantics
- `context-bundle` already acts as a substantial unified recall surface
- `active-slate` already functionally behaves like an early `memory_blocks` surface
- the MCP surface is already reasonably semantic and not just route mirroring

So the correct use of this memo is:

- **do not** read it as "rewrite Memongo first"
- **do** read it as "ship the roadmap, but make key additions in ways that converge toward a cleaner runtime"

The five highest-confidence incremental additions remain:

1. `sourceRef` for caller-owned idempotency
2. formalizing `memory_blocks` as the contract name for the existing hot-context family
3. naming/facade cleanup that unifies `profile + active-slate + context-bundle` as one state/recall family
4. operator trace/trust surfaces
5. optional semantic aliases over the existing MCP/API contract

Headline judgment:

The roadmap is strongest where it fixes real breakage and doubles down on MongoDB-native execution. It is weakest where it reads like a long list of stolen features instead of a tighter memory-runtime thesis. The corrected research is clearer than the roadmap on one central point: Memongo should not become "current architecture plus more intelligence." It should become one coherent memory runtime with one recall plane, one hot-context plane, and one feedback plane.

## Core thesis

The corrected research points to three master architectural moves that matter more than most individual roadmap items:

### 1. Make MongoDB the memory runtime, not only the storage backend

The winning design is not "MongoDB also does vectors." The winning design is:

- the same runtime holds the raw event
- the current belief
- the invalidated prior belief
- the retrieval projection
- the always-loaded hot context block
- the feedback signal that changes future ranking

That is the category-defining MongoDB-native advantage.

### 2. Make `context-bundle + profile + memory_blocks` the product shape

The corrected research is unusually consistent here:

- `Supermemory` contributes the best public product shape: profile + recall + context injection
- `Mempalace` contributes wake-up layering and protocol-teaching
- `Letta` contributes explicit always-loaded blocks
- current Memongo already hints at this through `profile`, `active-slate`, and `context-bundle`

The next move is not more fragmented endpoints. It is a unified state/recall family.

### 3. Replace collection/lane sprawl with one unified recall plane

The roadmap still assumes Memongo can mostly keep its current internal layout and add more intelligence around it.

The corrected research says the cleaner move is:

- split current-state memory from collection-style memory
- materialize a unified `retrieval_docs` plane or equivalent
- move from lane routing toward evidence planning

That is the architectural difference between "smarter pile of features" and "real memory runtime."

## What is already true in the current code

Another AI should assume these are already materially present, not hypothetical:

- canonical event-first ingestion and derived products
- revision-aware structured memory and procedures
- active-slate hydration
- profile synthesis
- prompt-ready context bundles
- retrieval planning with distinct lanes
- reasoning chain, novelty scan, and consolidation surfaces
- semantic MCP/tool surfaces for the main memory actions

That means the comparison with the roadmap is mainly about:

- what still needs fixing
- what should be formalized and renamed
- what should be added next
- what should remain future convergence work rather than immediate migration work

## 1. Where the roadmap strongly aligns with the corrected research

- Phase 0 is correct and urgent. The corrected research does not support building anything ambitious on top of silent failures, dead code, stale naming, or degraded Atlas Local paths. Fixing the missing event vector index, unwired access tracking, legacy references, dead files, API drift, and Docker traps is exactly the right first move.
- The roadmap's durable principles mostly align with the strongest synthesis:
  - MongoDB-native as the non-negotiable substrate
  - events as the canonical entry point
  - compression for presentation, not storage
  - conservative extraction over noisy write amplification
- Phase 1's MongoDB feature choices are directionally strong:
  - `$rankFusion` for hybrid retrieval
  - `$graphLookup` for reasoning chains
  - Change Streams for idle-debounced consolidation
  - temporal invalidation instead of silent overwrite
  These all match the MongoDB-native thesis and the Honcho/Graphiti-derived research.
- The roadmap correctly sees that memory is not just retrieval. The Dreamer direction, contradiction handling, novelty, access signals, and profile/context work all point toward memory as a living system rather than a search endpoint.
- The roadmap correctly values:
  - wake-up context and progressive loading
  - agent adapters and middleware
  - import pipelines
  - protocol guidance in status
  - benchmarks as a credibility gate
  Those all align with the corrected research on distribution, operability, and trust.
- The roadmap is also right to keep raw evidence recoverable and inspectable. That matches the strongest common conclusion across Honcho, Mempalace, Supermemory, LangMem, and the MongoDB-native thesis.

### Best keep-as-is ideas

If another AI is looking for the roadmap's strongest surviving bets, the clean shortlist is:

- all of Phase 0
- temporal fact invalidation
- progressive context loading
- benchmark suite
- import pipeline
- MCP/API/client cleanup
- coding-agent middleware and adapter work
- operator guidance in status
- procedure feedback loops

### Shipping interpretation

This section matters: the roadmap should still be treated as the active execution plan.

The comparison memo is not overruling it. It is adding these constraints:

- avoid hardening accidental seams while shipping
- prefer facade/alias/formalization before storage rewrites
- treat larger architectural moves as convergence paths unless the code is truly blocked

## 2. Where the roadmap is directionally right but under-scoped or framed too narrowly

- The roadmap treats `profile`, `active-slate`, and progressive context loading as separate features. The corrected research says these should be one product surface: state plus context blocks. Memongo already has `/v1/profile`, `/v1/context-bundle`, and active-slate hydration in the codebase. The next move is not "add profile." It is "unify state surfaces under one contract."
- The adapter plan is too framework-shaped and too JavaScript-shaped. `withMemongo()` for Vercel AI SDK, OpenAI middleware, and a Pi extension are useful, but the research is asking for a universal memory surface across API, SDK, MCP, hooks/plugins, CLI, local self-host, and hosted-compatible deployment. The roadmap is still thinking in wrapper packages more than surface parity.
- The feedback story is too narrow. Access tracking, procedure outcomes, and confidence scoring are good starts, but the corrected thesis wants a general `memory_signals` plane for reinforcement, corrections, review scheduling, freshness decay, contradiction rate, and planner quality over time.
- The import story is half-finished. The roadmap includes conversation import, which is good, but the research is explicit that import without export, portable bundles, and checkpointed save surfaces is not enough to win adoption.
- The roadmap correctly notices that coding agents matter, but it still frames them mostly as adapter targets. The research says coding agents need a first-class operating model: wake-up, save checkpoints, pre-compaction capture, recommended recall policy, and operator-visible status.
- The roadmap's entity registry, confidence, knowledge artifacts, and procedure loops are all reasonable, but they are framed as feature additions to the current model. The corrected research says these upgrades only get fully coherent after the data model is split by role instead of piling more semantics into `structured_mem`.

### What the roadmap is seeing correctly, but naming poorly

- `profile` is really part of a broader `state` surface
- `active-slate` is really an early `memory_blocks` surface
- `search recipes` are really a step toward evidence planning
- `AccessTracker` is really one part of a broader feedback plane
- `self-edit memory` only makes sense after hot context blocks are formalized
- `100% MCP coverage` is less important than a small, semantic public contract

### Practical reinterpretation

These are best implemented as incremental changes:

- `memory_blocks` should likely begin as a contract/type/name over current active-slate-style behavior
- unified state surfaces should begin as alias/facade work over current `profile`, `active-slate`, and `context-bundle`
- `sourceRef` should be introduced as a small optional field, not as a broad model rewrite

## 3. Where the roadmap conflicts with the strongest synthesis or risks bolted-on architecture

- The biggest conflict is structural: the roadmap never fully commits to the corrected architecture. The research wants:
  - split current-state memory from collection-style memory
  - a unified `retrieval_docs` recall plane
  - first-class `memory_blocks` for always-loaded context
  - evidence-class planning instead of collection/lane-centric planning
  The roadmap mostly keeps the current collection layout and adds more intelligence, more lanes, and more tools on top. That is how you get a smarter pile, not a cleaner runtime.
- The roadmap treats cross-collection recall as late polish. The corrected research says unified recall is a P0/P1 architectural move, not a Phase 5 enhancement. If Memongo keeps search split across collection-specific flows and only unifies late, every intermediate feature will harden the wrong seams.
- The roadmap's "100 percent MCP coverage" goal is too API-mirroring and route-count-driven. The corrected research is clear that the public agent surface should stay small and semantic. Intent surfaces like `recall`, `state`, `trace`, `review`, and `feedback` matter more than exposing every route as a tool.
- Phase 1.2 and Phase 3.8 risk over-investing in agentic background intelligence before the core memory model is clean. A five-phase Dreamer, a per-turn extractor, deduction and induction specialists, and quality filters can absolutely matter, but not if they are all operating on a mixed collection model with no unified recall plane.
- Phase 3.1 risks creating a second truth system. Letta-style block editing only makes sense after Memongo has first-class derived `memory_blocks`. If block editing lands before that, Memongo will blur prompt blocks and durable truth, which the corrected thesis explicitly warns against.
- The roadmap keeps reaching for more retrieval lanes and more special cases. The corrected MongoDB-native thesis argues for moving from lane routing to evidence planning. Memongo already has an 8-lane planner. The right next move is to collapse around evidence classes, not celebrate that the lane count can grow further.
- The roadmap is partially stale against the current repo baseline:
  - `/v1/profile` already exists
  - `context-bundle` already exists
  - active-slate already exists
  - MCP and AI tools already expose `profile`, `status`, `context-bundle`, `chain-trace`, `novelty-scan`, and `consolidate`
  This matters because the plan sometimes treats consolidation work as net-new feature work. That encourages duplicate surfaces instead of contract cleanup.

### Highest-risk roadmap traps

These are the places another AI should challenge hardest instead of accepting at face value:

- treating `$rankFusion` as a centerpiece instead of a tactical improvement
- overbuilding the five-phase Dreamer before the runtime is unified
- adding block-editing before `memory_blocks` are clearly derived and bounded
- celebrating more retrieval lanes instead of collapsing to a unified recall plane
- equating more MCP tools with better product strategy
- delaying unified recall until Phase 5

These are risks of emphasis, not reasons to discard the roadmap.

## 4. What genuinely important ideas from the corrected research are missing from the roadmap

- A first-class split between `semantic_profiles` and `semantic_memories`. The roadmap keeps `structured_mem` as the center of gravity for too many jobs.
- A unified `retrieval_docs` projection as the one hybrid recall plane for facts, procedures, episodes, entities, relations, and other retrievable evidence.
- First-class `memory_blocks` as always-loaded, labeled, token-budgeted context derived from the same durable state.
- A semantic public contract built around `observe`, `recall`, `state`, `trace`, `review`, and `feedback`, with `profile`, `active-slate`, and `context-bundle` as specialized views over that contract.
- Stable caller-owned source identity such as `sourceRef` for idempotent sync, update, dedupe, and import replay.
- A real feedback and review plane, not just isolated access counters. The research wants reinforcement, downgrade, correction, contradiction counts, freshness, and review scheduling to be native signals.
- Operator trust infrastructure:
  - write/read logs
  - recall traces
  - why-this-was-recalled inspection
  - edit/delete flows
  - job and queue state
  - token and latency visibility
- Export and portability:
  - portable bundle export
  - generic JSON export/import
  - checkpointed session-end and pre-compaction save surfaces
- Optional directional memory. Honcho's observer/subject model is one of the strongest architectural ideas in the corpus, and the roadmap does not meaningfully address it.
- Durable ingest-job visibility and streaming subscriptions for invalidations, block changes, review-required events, and background materialization outputs.

These are not garnish. These are the ideas that turn Memongo from "feature-rich MongoDB memory" into "the memory runtime."

### Most important missing ideas, ranked

1. `memory_blocks` as first-class, always-loaded hot context
2. unified `retrieval_docs` recall plane
3. split between current-state profile memory and long-tail collection memory
4. semantic public contract: `observe / recall / state / trace / review / feedback`
5. full feedback/review plane instead of isolated counters
6. operator trust surfaces: traceability, logs, replay, explainability
7. stable `sourceRef` for idempotent sync/import/update
8. optional directional/perspectival memory

### Which of these are immediate vs. convergence

Immediate:

- `sourceRef`
- `memory_blocks` formalization
- operator trust/trace surfaces
- state-surface naming cleanup

Convergence:

- unified `retrieval_docs`
- deeper profile-vs-collection separation
- semantic contract consolidation
- optional directional memory

## 5. A proposed rewrite of the roadmap into a smaller set of master bets

### Master Bet 1: Fix the foundation and lock the memory contract

Do Phase 0 first. Then immediately stop treating `structured_mem` as the catch-all durable layer.

Fold into this bet:

- all Phase 0 fixes
- split `structured_mem` into profile-state and collection-memory models
- add a shared memory envelope with scope, provenance, validity, trust, and review fields
- add stable `sourceRef`
- make temporal validity universal across facts, relations, and procedures

Why this is the right rewrite:

- it prevents every later feature from hardening the wrong schema
- it aligns with the corrected research more than any single Dreamer improvement does

### Master Bet 2: Collapse recall and state into one product surface

Build one recall runtime instead of more endpoint-specific behavior.

Fold into this bet:

- `retrieval_docs`
- `memory_blocks`
- evidence-class planning
- `state`, `recall`, and `trace` as the semantic public surface
- treat `profile`, `active-slate`, and `context-bundle` as views over the same system

Why this is the right rewrite:

- it matches what the current repo already hints at
- it fixes the biggest architectural gap in the roadmap
- it gives Memongo a tighter story than "8 lanes plus more smart routing"

### Master Bet 3: Make background memory formation native, inspectable, and feedback-driven

Use Change Streams as the runtime and keep hot-path vs background memory formation explicit.

Fold into this bet:

- Dreamer/consolidation upgrades
- per-turn extraction
- contradiction handling
- access tracking
- reinforcement and review scheduling
- `memory_signals`
- ingest/materialization job visibility

Why this is the right rewrite:

- it keeps the main path fast
- it makes memory improve through use and correction
- it turns background work from hidden magic into an operator-visible system

### Master Bet 4: Win distribution through parity and operator trust, not route count

Treat adapters and trust tooling as part of the core product, but keep them on one bridge contract.

Fold into this bet:

- MCP, API, SDK, hooks, middleware, CLI, and coding-agent installs
- `status` as an operating protocol
- import/export/checkpoints
- operator console and traceability
- benchmark suite

Why this is the right rewrite:

- the corrected research is unequivocal that distribution and operability decide who wins
- Memongo should ship fewer surface semantics, not more disconnected wrappers

### Master Bet 5: Add advanced semantics only after the runtime is coherent

This is where the more ambitious intelligence belongs.

Fold into this bet:

- directional memory
- entity onboarding/disambiguation
- procedure feedback loops
- knowledge artifacts
- search recipes
- framework-specific wrappers
- team memory and higher-order sharing

Why this is the right rewrite:

- these ideas are real differentiators
- they become architecture debt if shipped before Bets 1 through 4

## 5.5 Condensed rewrite

If this roadmap were rewritten into the smallest possible high-signal version, it should become:

### Bet A — Fix Reality

- remove silent failures
- clean up stale seams
- close API/docs/runtime drift
- make Atlas Local the truthful default

### Bet B — Define One Memory Runtime

- events canonical
- temporal validity everywhere
- provenance everywhere
- split current-state from collection memory
- unified retrieval projection

### Bet C — Define One Product Surface

- `state`
- `recall`
- `trace`
- `review`
- `feedback`

with `profile`, `active-slate`, and `context-bundle` as views, not disconnected products

### Bet D — Make Background Intelligence Native

- change-stream materializers
- extraction
- consolidation
- invalidation
- review and reinforcement

### Bet E — Win Adoption

- middleware
- hooks
- MCP
- import/export
- operator trust surfaces
- benchmarks

This condensed rewrite is a **north-star decomposition**, not a replacement instruction for the existing phased execution plan.

## 6. Priority ordering: must-do, should-do, later, avoid

### Must-do

- Ship Phase 0.
- Split current-state memory from collection memory.
- Build `retrieval_docs` and move from lane routing toward evidence planning.
- Introduce `memory_blocks` and treat `profile`, `active-slate`, and `context-bundle` as one state/recall family.
- Make temporal invalidation, provenance, and `sourceRef` first-class.
- Make Change Streams plus hot-path/background separation the default runtime.
- Add operator-visible trace, status, and job visibility.
- Ship import, export, and checkpoint surfaces together.

### Should-do

- Benchmarks.
- Coding-agent adapters and middleware built on the same bridge contract.
- Entity onboarding and disambiguation.
- Procedure feedback loops and memory feedback/review signals.
- Optional directional memory.
- Operator console improvements that expose logs, traces, and edit/delete flows.

### Later

- Search recipes.
- Pi-specific extension work.
- Human-readable age and minor polish surfaces.
- Team memory and secret scanning.
- Cross-collection search only if `retrieval_docs` is still not in place. If `retrieval_docs` exists, this ceases to be a separate roadmap item.

### Avoid

- Treating route parity as product strategy.
- Adding more behavior to `structured_mem` instead of splitting the model.
- Building prompt-editable memory blocks before derived `memory_blocks` exist.
- Shipping a five-phase Dreamer as the main story before the recall/state contract is unified.
- Porting Honcho or Mempalace storage shapes literally.
- Cargo-culting competitor features into a checklist roadmap.

Bottom line:

The roadmap is not wrong. It is just too additive. The corrected research points to a sharper strategy: stop bolting better ideas onto the current layout, and reorganize Memongo around one memory runtime. If Memongo does that, most of the roadmap's best feature ideas still survive, but they land on a substrate that can actually carry them.

## Final recommendation

If another AI is asked what to do next, the right answer is:

- keep the roadmap's foundation fixes
- demote feature-porting as the main story
- elevate unified runtime architecture as the main story
- make `context-bundle/profile/memory_blocks` the product shape
- make unified recall and temporal truth the core engineering bet

The corrected research does **not** say "throw away the roadmap."

It says:

> **Rewrite the roadmap so that the best ideas land on the right substrate.**

## Single-doc handoff rule

If another AI only gets one file, this should be the file.

It contains:

- the roadmap comparison
- the strategic synthesis
- the corrections from later code-grounded review
- the distinction between:
  - what is already implemented
  - what should be added incrementally
  - what should remain convergence work

The supporting research docs remain useful as appendices, but they are no longer required for a competent handoff if this document is read carefully.
