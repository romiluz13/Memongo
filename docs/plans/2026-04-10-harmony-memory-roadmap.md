# Memongo Harmony Memory Roadmap

> **Date:** 2026-04-10
> **Status:** companion north-star roadmap for `docs/plans/2026-04-08-definitive-roadmap-plan.md`
> **Purpose:** define the state-of-the-art Memongo architecture without feature bloat, and with exact reference-corpus evidence
> **Reference corpus root on this machine:** `/Users/rom.iluz/Dev/memory-referance`

---

## Why this exists

The current execution plan is real and already partially landing in code. This roadmap does a different job:

- preserve the memory-runtime thesis
- define the non-negotiable invariants that every new feature must satisfy
- capture the exact reference inspiration with file-and-line evidence
- force every adoption decision through a native-fit test so Memongo does not become a pile of clever add-ons

This document should be read together with:

- `docs/plans/2026-04-08-definitive-roadmap-plan.md`
- `docs/plans/2026-04-08-definitive-roadmap-comparison-memo.md`

---

## The north star

Memongo should become the system that can answer, with provenance:

> What did this agent believe about this subject at time T, why did it believe it, what evidence supported it, what changed later, and what should be loaded now?

That is the real bar for state-of-the-art agent memory. Not more endpoints. Not more tools. One coherent runtime.

---

## Memongo already has the right raw material

Memongo is already much closer to a category-defining memory runtime than a normal memory toolkit.

### 1. Raw evidence plane

- canonical events and chat ingestion: `packages/memory-engine/src/mongodb-events.ts`
- file sync and chunking: `packages/memory-engine/src/mongodb-sync.ts`
- knowledge base ingest and KB chunks: `packages/memory-engine/src/mongodb-kb.ts`
- caller-owned idempotency via `sourceRef`: `packages/memory-engine/src/mongodb-schema.ts:328-332`, `packages/memory-engine/src/mongodb-schema.ts:684-688`, `packages/memory-engine/src/mongodb-schema.ts:1979-2019`

### 2. Derived belief plane

- structured memory with temporal validity and revisions: `packages/memory-engine/src/mongodb-structured-memory.ts`
- procedures with validity windows: `packages/memory-engine/src/mongodb-procedures.ts`
- entities, relations, links, expansion: `packages/memory-engine/src/mongodb-graph.ts`
- episodes as time-bounded derived memory: `packages/memory-engine/src/mongodb-episodes.ts`

### 3. Hot-context plane

- active slate hydration: `packages/memory-engine/src/mongodb-active-slate.ts`
- profile synthesis: `packages/memory-engine/src/mongodb-profile.ts`
- context bundle with explicit wake-up mode: `packages/memory-engine/src/mongodb-context-bundle.ts:574-595`, `packages/memory-engine/src/types.ts:445-461`, `apps/api/src/openapi-spec.ts:543-547`
- unified state facade: `packages/memory-bridge/src/memongo-bridge.ts`, `apps/api/src/routes/v1.ts`

### 4. Feedback and review plane

- trust scoring: `packages/memory-engine/src/mongodb-trust.ts`
- access tracking: `packages/memory-engine/src/mongodb-manager.ts:767-772`
- novelty scan: `packages/memory-engine/src/mongodb-novelty.ts`
- memory mutations log: `packages/memory-engine/src/mongodb-mutations.ts`
- memory jobs and review surfaces: `packages/memory-engine/src/mongodb-memory-jobs.ts`, `packages/memory-engine/src/mongodb-recall-traces.ts`

### 5. Operator and provenance plane

- reasoning chain trace: `packages/memory-engine/src/mongodb-reasoning-chain.ts`
- benchmark and relevance harness: `packages/memory-engine/src/mongodb-relevance.ts`, `packages/memory-engine/src/mongodb-benchmark-runner.ts`
- telemetry and access events: `packages/memory-engine/src/mongodb-telemetry.ts`, `packages/memory-engine/src/mongodb-schema.ts`

The problem is not missing categories. The problem is that the categories still need stricter common laws.

### A note on "the graph"

Memongo should preserve the distinction between:

- the **entity graph**: entities, relations, links, expansion
- the **provenance graph**: reasoning chains, source events, supersession, mutations

Those are not duplicates. One answers "what is related to what." The other answers "why do we believe this." A state-of-the-art memory runtime needs both.

---

## What is already landing now

The current execution plan is not speculative. Several pieces of the target architecture are already live in the code:

- `sourceRef` is already present in runtime types and MongoDB schemas: `packages/memory-engine/src/types.ts:76-80`, `packages/memory-engine/src/mongodb-schema.ts:328-332`, `packages/memory-engine/src/mongodb-schema.ts:482-486`, `packages/memory-engine/src/mongodb-schema.ts:684-688`
- `sourceRef` uniqueness is already enforced for events, structured memory, and procedures: `packages/memory-engine/src/mongodb-schema.ts:1979-2019`
- wake-up mode is already a first-class context-bundle mode: `packages/memory-engine/src/mongodb-context-bundle.ts:574-595`, `packages/memory-engine/src/types.ts:445-461`, `apps/api/src/openapi-spec.ts:543-547`
- access tracking is already wired into manager initialization: `packages/memory-engine/src/mongodb-manager.ts:767-772`
- structured memory already has a current-truth filter based on `validFrom` and `validTo`: `packages/memory-engine/src/mongodb-structured-memory.ts:806-812`

This is why the next step is not "start over with a new architecture." The next step is to unify the remaining seams.

---

## The runtime invariants

These invariants decide whether a feature is native to Memongo or a bolt-on.

### 1. One temporal truth model

Time must mean the same thing across:

- structured memory
- procedures
- graph relations
- episodes
- recall/search/context bundle
- trust and invalidation

Today structured memory already has a real current-truth predicate:

- `packages/memory-engine/src/mongodb-structured-memory.ts:806-812`

But graph traversal still mostly filters on relation state:

- `packages/memory-engine/src/mongodb-graph.ts:896-918`

That means the first architecture priority is not "add more temporal features." It is to unify the temporal predicate across every lane.

### 2. One lifecycle model

Every memory family should support the same conceptual lifecycle:

- create or ingest
- read by stable handle
- update by revision or supersession
- delete as invalidation by default
- inspect history

Memongo should expose this cleanly, but keep its native audit semantics. Default delete should mean invalidation plus history retention, not hard removal.

### 3. One identity and namespace model

Every durable memory object should compose with the same identity system:

- `agentId`
- `scope`
- `scopeRef`
- caller-owned `sourceRef`
- family-specific stable handle
- optional perspective dimensions when the memory is observer-relative

Memongo already has a real namespace foundation in `packages/memory-engine/src/mongodb-scope.ts:6-54`. The harmony requirement is that new APIs, adapters, and perspective features must extend that model instead of bypassing it.

### 4. One recall plane

The product surface must converge around:

- `profile`
- `memory_blocks`
- `context-bundle`
- first-class conversation recall

These are not four different features. They are one recall system with different budgets and views.

### 5. One feedback and review plane

Signals that change future memory behavior should converge:

- trust
- access
- novelty
- user corrections
- contradiction detection
- review scheduling
- procedure outcomes

Memongo already has many of these parts. They should eventually speak through one model instead of parallel lanes.

### 6. One scheduler owner for background work

Consolidation, extraction, feedback processing, re-materialization, and review scheduling must not race each other through disconnected orchestration rules.

Memongo already has job tracking and consolidation surfaces in:

- `packages/memory-engine/src/mongodb-manager.ts:3954-4031`
- `apps/api/src/routes/v1.ts:974-1074`

The harmony requirement is that deferred work should converge through one scheduling policy and one auditable job model.

### 7. Provenance everywhere

Every durable belief should answer:

- where did this come from
- which events support it
- which sourceRef or external handle owns it
- what replaced it
- when did it stop being valid

### 8. Wrappers are wrappers

Hooks, IDE integrations, LangGraph adapters, browser extensions, and MCP convenience layers must be wrappers over the same runtime. They must never become a second truth store.

---

## The native-fit test

No new feature ships unless the answer to these questions is yes:

1. Does it reuse canonical events, provenance, scope, revisions, and invalidation instead of inventing another storage truth?
2. Does it strengthen one of the shared planes instead of adding a one-off lane?
3. Can it be explained as a natural extension of MongoDB-native Memongo, not as an imported product metaphor?
4. Does it preserve auditability?
5. Does it improve either correctness, recall quality, or adoption without fragmenting the runtime?

If the answer is no, it is not harmony.

---

## Exact reference inspiration, with native Memongo interpretation

The following are the high-value reference lessons that fit Memongo's architecture.

### Graphiti -> temporal graph truth, not "use a separate graph stack"

**Exact evidence**

- `graphiti/README.md:42-49` defines Graphiti as a temporal context graph that tracks how facts change over time and preserves provenance.
- `graphiti/README.md:67-80` defines facts and relationships as having validity windows, all tracing back to episodes.
- `graphiti/README.md:125-128` says facts are invalidated, not deleted, and that queries should answer what is true now or at any point in time.
- `graphiti/README.md:151-152` calls out explicit bi-temporal tracking and contradiction handling with preserved history.
- `graphiti/graphiti_core/graph_queries.py:34-40` and `graphiti/graphiti_core/graph_queries.py:76-81` index `valid_at`, `expired_at`, and `invalid_at` directly in the graph layer.

**Native Memongo lesson**

Memongo should adopt Graphiti's temporal correctness standard, but express it in MongoDB-native relations and search projections. No second graph database. No dual-truth graph tier.

**Resulting Memongo requirement**

- add a shared `asOf` predicate across structured memory, relations, procedures, episodes, and recall assembly
- treat `state` as lifecycle metadata, not the full truth predicate for historical reads

### mem0 -> lifecycle symmetry and history ergonomics

**Exact evidence**

- `mem0/server/main.py:185-260` exposes `get`, `update`, `history`, `delete`, and `delete_all` as a predictable memory lifecycle.
- `mem0/mem0/client/main.py:179-200` exposes `get(memory_id)`.
- `mem0/mem0/client/main.py:297-336` exposes `update(memory_id, ...)`.
- `mem0/mem0/client/main.py:338-389` exposes `delete` and `delete_all`.
- `mem0/mem0/client/main.py:391-412` exposes `history(memory_id)`.

**Native Memongo lesson**

Memongo should expose stable handles and lifecycle symmetry, but preserve revisions, mutations, and invalidation. The mem0 insight is API ergonomics, not hard deletion.

**Resulting Memongo requirement**

- every durable memory family should participate in a shared handle and history contract
- default delete means invalidate plus tombstone/history, not remove-and-forget

### LangMem -> framework-native persistence adapters

**Exact evidence**

- `langmem/README.md:36-57` shows memory tools built on LangGraph's `BaseStore` and namespaced persistence.
- `langmem/src/langmem/reflection.py:18` imports `BaseStore`.
- `langmem/src/langmem/reflection.py:31-49` defines store items with namespace, key, value, and timestamps.
- `langmem/src/langmem/reflection.py:101-119` and `langmem/src/langmem/reflection.py:123-140` make namespace and store first-class for reflection execution.
- `langmem/src/langmem/reflection.py:188-190` passes namespace into remote execution config.

**Native Memongo lesson**

Memongo should have a thin adapter layer for LangGraph and similar frameworks that maps namespace cleanly onto `scope` and `scopeRef`.

**Resulting Memongo requirement**

- adapter work belongs outside the core data model
- the mapping from namespace -> `scope` + `scopeRef` must be canonical and documented

### Honcho -> perspective memory

**Exact evidence**

- `honcho/README.md:89-90` exposes a session-scoped representation of a peer.
- `honcho/README.md:477-482` centers the peer paradigm and configurable observation settings.
- `honcho/README.md:543-552` says messages are labeled by source peer and processed asynchronously to update representations.
- `honcho/src/schemas/api.py:398-406` defines representation and peer card from the observer's perspective.
- `honcho/src/schemas/api.py:440-446` defines `observer` and `observed` explicitly on conclusions.
- `honcho/src/schemas/api.py:645-649` makes dream scheduling perspective-aware.
- `honcho/src/routers/workspaces.py:223-243` defaults observed to observer and schedules dream work on `observer` + `observed`.

**Native Memongo lesson**

Perspective is real and valuable, but Memongo should not clone Honcho's full peer-worldview or storage stack. It should introduce explicit perspective dimensions that compose with existing scope and provenance.

**Resulting Memongo requirement**

- add a first-class perspective model for "who observed this" and "who this is about"
- validate perspective fields instead of hiding them in ad hoc `scopeRef` strings

### Letta -> always-loaded blocks, conversation recall, and precise memory editing guidance

**Exact evidence**

- `letta/letta/prompts/system_prompts/letta_v1.py:5-9` distinguishes always-loaded memory blocks from external memory.
- `letta/letta/functions/function_sets/base.py:87-103` defines `conversation_search(query, roles, limit, start_date, end_date)`.
- `letta/letta/functions/function_sets/base.py:116-128` shows inclusive date-range conversation recall behavior.
- `letta/letta/functions/function_sets/base.py:246-279` exposes narrow block append/replace tools.
- `letta/letta/functions/function_sets/base.py:283-301` exposes block rethink/rewrite.
- `letta/letta/functions/function_sets/base.py:311-388` emphasizes precise edits for narrow changes.
- `letta/letta/functions/function_sets/base.py:488-522` separates broad rethink from edit completion.
- `letta/letta/prompts/system_prompts/sleeptime_v2.py:14-18` requires precise dates and times, not relative phrases.

**Native Memongo lesson**

Memongo should formalize `memory_blocks` over its hot-context surfaces and add a first-class conversation recall contract. The deep insight is not Letta's editing mechanics; it is the product shape: always-loaded blocks plus searchable external memory plus precise maintenance rules.

**Resulting Memongo requirement**

- formalize `memory_blocks` as the name for active-slate-style always-loaded context
- add conversation recall with role filters, time filters, tool-message policy, and citations
- make precise dates and invalidation mandatory in memory maintenance flows

### Supermemory -> product shape, ingestion hints, and document UX

**Exact evidence**

- `supermemory/README.md:38-45` describes one memory structure and ontology spanning memory, profiles, hybrid search, connectors, and multimodal extraction.
- `supermemory/README.md:288-294` shows a narrow public API shape: `add`, `profile`, `search.memories`, `search.documents`, and `documents.uploadFile`.
- `supermemory/README.md:335-345` ties contradiction resolution, freshness, and automatic forgetting to the engine rather than leaving them to prompt logic.
- `supermemory/packages/validation/api.ts:155-165` defines `customId` and `entityContext` for caller-owned identity and extraction guidance.
- `supermemory/packages/validation/api.ts:251-256` and `supermemory/packages/validation/api.ts:396-400` expose search filters as a public contract.

**Native Memongo lesson**

Memongo should keep its richer internal model, but its public product shape should feel obvious: add, profile/state, recall/search, document ingest. Ingestion hints are a clean fit.

**Resulting Memongo requirement**

- add extraction hints such as `entityContext` and schema/context steering
- keep `sourceRef` as Memongo's caller-owned idempotency primitive
- improve document ingest and citation UX without reducing the engine to a single-table filter model

### MemPalace -> wake-up contract and save discipline

**Exact evidence**

- `mempalace/README.md:266-273` defines explicit L0-L3 wake-up layering and small always-loaded identity/context tiers.
- `mempalace/README.md:497-507` defines stop and pre-compact save hooks.
- `mempalace/hooks/README.md:1-12` frames hooks as timing/orchestration, not the storage system itself.
- `mempalace/hooks/README.md:85-119` explains save-at-stop and always-save-before-compaction behavior.
- `mempalace/hooks/README.md:136-138` highlights that hooks themselves add zero extra tokens.
- `mempalace/README.md:548-563` exposes `mine` and `wake-up` as first-class routines.

**Native Memongo lesson**

Memongo already has the beginnings of this in wake-up context bundles. The right move is to formalize wake-up semantics and host capture policy, not to import AAAK or a separate storage dialect.

**Resulting Memongo requirement**

- explicitly define wake-up tiers over existing `profile`, `memory_blocks`, and `context-bundle`
- define pre-compaction and checkpoint-save host behavior
- reject lossy dialects as source-of-truth storage

### Mengram -> host capture, IDE surfaces, and procedure feedback

**Exact evidence**

- `mengram/README.md:44-52` defines a three-hook loop: Session Start, Every Prompt, After Response.
- `mengram/README.md:206-214` treats `procedure_feedback` as a first-class improvement path.
- `mengram/vscode-mengram/README.md:7-10` and `mengram/vscode-mengram/README.md:22-27` add save-selection and save-file IDE flows.
- `mengram/obsidian-plugin/README.md:7-12` and `mengram/obsidian-plugin/README.md:53-58` add autosync and search across notes into the memory system.
- `mengram/cli.py:437-445` loads cognitive profile on session start.
- `mengram/cli.py:853-857` installs a session-start hook for context injection.

**Native Memongo lesson**

The winning idea is ambient capture and recall through wrappers over the runtime. Memongo should absorb the host ergonomics, not Mengram's hosted product boundaries.

**Resulting Memongo requirement**

- build IDE and host kits on top of Memongo API or MCP
- make procedure feedback part of the shared feedback plane

### claude-mem -> non-blocking hook architecture and privacy controls

**Exact evidence**

- `claude-mem/CHANGELOG.md:3211-3214` moves lifecycle hooks to lightweight HTTP clients with a single worker truth.
- `claude-mem/src/cli/handlers/observation.ts:47-56` sends hook observations to the worker, which owns privacy and database operations.
- `claude-mem/cursor-hooks/PARITY.md:7-14` maps lifecycle hooks across host environments.
- `claude-mem/CHANGELOG.md:3422-3425` introduces privacy tags and edge stripping before persistence.
- `claude-mem/CHANGELOG.md:286-290` names progressive disclosure as an explicit token discipline.

**Native Memongo lesson**

Hooks should stay thin, privacy-aware, and transport-only. The runtime should stay in Memongo, not in duplicated hook logic.

**Resulting Memongo requirement**

- host kits must be thin HTTP or MCP clients
- privacy tags and non-persist policies should be first-class ingest controls
- progressive disclosure should guide recall and exploration surfaces

### MemOS -> unified feedback and asynchronous scheduling

**Exact evidence**

- `MemOS/README.md:98-103` defines a unified API to add, retrieve, edit, and delete memory, plus multimodal support and memory feedback/correction.
- `MemOS/README.md:118-125` and `MemOS/README.md:139-141` call out feedback, deletion by ID, filtering, and scheduler priority.
- `MemOS/examples/mem_scheduler/run_async_tasks.py:29-70` shows labeled handlers, batch submission, and task idle timing.
- `MemOS/src/memos/multi_mem_cube/single_cube.py:130-168` runs feedback through the scheduler or sync path.
- `MemOS/examples/mem_feedback/example_feedback.py:221-228` processes user correction into update operations.

**Native Memongo lesson**

Memongo should absolutely have a first-class feedback plane and scheduler policy, but it does not need MemOS's multi-store default architecture.

**Resulting Memongo requirement**

- add natural-language feedback and correction as a stable Memongo API
- keep one scheduler owner for consolidation, feedback, and review work
- do not import Redis Streams or multi-store topology unless scale proves it is necessary

### Paprwork -> document conversion, debounce policy, and citation presentation

**Exact evidence**

- `paprwork/tests/document-import.test.ts:130-171` converts DOCX to Markdown via `mammoth` and `turndown`.
- `paprwork/src/gateway/services/CodeIndexingService.ts:157-160` uses a 5-second debounce for indexing.
- `paprwork/docs/WEB_SEARCH_INTEGRATION.md:27-30` and `paprwork/docs/WEB_SEARCH_INTEGRATION.md:37-40` emphasize inline URL citations and source attribution.
- `paprwork/docs/WEB_SEARCH_INTEGRATION.md:129-135` describes sourced up-to-date answers flowing back with citations.

**Native Memongo lesson**

Paprwork is a strong reference for document pipeline mechanics and citation presentation, not for the core memory model.

**Resulting Memongo requirement**

- expand KB ingest to include DOCX conversion and cleaner citation wiring
- use debounced background indexing where it improves UX

### Cognee -> ontology grounding and entity consolidation

**Exact evidence**

- `cognee/README.md:80-82` centers ontology grounding, multimodal knowledge infrastructure, feedback learning, and traceability.
- `cognee/CLAUDE.md:405-415` documents ontology-based entity extraction and matching strategy.
- `cognee/examples/guides/temporal_cognify.py:11-19` and `cognee/examples/guides/temporal_cognify.py:24-33` expose temporal extraction and temporal search.
- `cognee/examples/guides/consolidate_entity_descriptions_example.py:10-14` and `cognee/examples/guides/consolidate_entity_descriptions_example.py:34-40` demonstrate constrained extraction and entity description consolidation.
- `cognee/cognee/modules/retrieval/graph_completion_cot_retriever.py:36-50` shows a graph-completion chain-of-thought retriever.

**Native Memongo lesson**

The valuable part is ontology grounding and entity consolidation, which can deepen Memongo's entity system. The risky part is importing a second retrieval worldview or multi-store architecture.

**Resulting Memongo requirement**

- add optional ontology grounding and better entity merge/disambiguation
- keep chain-of-thought-style graph completion out of the default runtime path

---

## What to avoid, even if a reference repo does it

Memongo should actively avoid:

- multi-database default architectures for graph, vector, queue, cache, and OLTP
- lossy compressed dialects as source-of-truth memory
- hook-side business logic that duplicates runtime truth
- LLM-on-every-tool-use architectures
- hard-delete-first lifecycle semantics
- framework-specific abstractions that leak into core storage

---

## The roadmap sequence that preserves harmony

### Current execution wave

The active plan should continue, but with these architecture priorities in mind:

1. unify temporal truth across structured memory, graph, procedures, episodes, and recall
2. formalize lifecycle semantics: handle, update, invalidate, history
3. formalize the recall family: `profile`, `memory_blocks`, `context-bundle`, conversation recall
4. unify the feedback plane: trust, access, novelty, corrections, review scheduling
5. deepen provenance and contradiction policy

### Next execution wave

After the current wave lands:

1. framework-native adapters such as LangGraph/BaseStore mapping
2. host kits for Claude Code, IDEs, and local editors
3. perspective memory
4. document ingest expansion and citation polish
5. optional ontology grounding and stronger entity resolution

---

## Bottom line

The best version of Memongo is not "Memongo plus the best features from each repo."

It is:

- Graphiti's temporal rigor
- mem0's lifecycle clarity
- LangMem's adapter simplicity
- Honcho's perspective model
- Letta's memory-block product shape
- Supermemory's public ergonomics
- MemPalace's wake-up discipline
- Mengram's ambient host capture
- claude-mem's thin hook architecture
- MemOS's feedback loop
- Paprwork's document pipeline lessons
- Cognee's ontology and entity-quality work

All of it, expressed through one MongoDB-native memory runtime.
