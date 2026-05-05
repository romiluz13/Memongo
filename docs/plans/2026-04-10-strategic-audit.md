# Memongo Strategic Audit

> **Date:** 2026-04-10
> **Author:** Independent audit by a different AI (Opus 4.6), not the one that produced the harmony roadmap
> **Scope:** Full codebase re-learn + critical evaluation of all strategic documents produced by the prior AI
> **Status:** READ-ONLY audit -- no code changes, only assessment

---

## 1. Executive Summary

### What the Other AI Got Right

1. **The "one runtime, not a pile of add-ons" thesis is correct.** The harmony roadmap's central argument -- that Memongo should become one coherent memory runtime rather than accumulating features -- is the right framing. The comparison memo's "70% aligned, 20% too narrow, 10% risky" assessment of the original roadmap was honest and well-calibrated.

2. **The temporal mismatch diagnosis is real and precisely located.** Graph traversal at `mongodb-graph.ts:899-943` filters exclusively on `state: { $ne: "invalidated" }` while structured memory at `mongodb-structured-memory.ts:806-812` has a proper `currentOnly` predicate using `validFrom`/`validTo`. Relations DO have `validFrom`/`validTo` fields (defined at `mongodb-graph.ts:83-84`) but they are ignored during traversal. This is not theoretical -- it is a concrete truth-model inconsistency.

3. **The entity-graph vs provenance-graph distinction is real and important.** The codebase genuinely has two separate graph structures: entity relations (`mongodb-graph.ts`) and reasoning chains (`mongodb-reasoning-chain.ts`). They serve different questions ("what relates to what" vs "why do we believe this"). The other AI correctly identified this and correctly recommended preserving rather than merging them.

4. **Conversation recall as the highest-priority next feature is the right call.** The codebase has 34 MCP tools, 27+ collections, a 5-phase Dreamer, trust scoring, novelty detection, benchmark infrastructure -- but no way for an agent to say "what did we discuss last Tuesday?" This is the most visible gap.

5. **The benchmark-first discipline is correct.** The execution plan's insistence that retrieval-affecting changes must show benchmark deltas before and after is exactly right. The benchmark infrastructure (harness, runner, LongMemEval/LoCoMo parity) is already built but not yet used as a gate.

6. **The "incremental temporal cleanup, not a purity refactor" approach is pragmatically wise.** Forcing a repo-wide temporal unification before shipping user-visible features would stall the project.

### What the Other AI Got Wrong

1. **It undercounted the MCP tools.** `patterns.md` claims 29 MCP tools; the actual count is **34** (verified by `grep -c 'name: "memongo_' apps/mcp/src/server.ts`). This is a factual error in the memory files that would propagate into future planning.

2. **The "one feedback plane" invariant is premature and over-abstracted.** Invariant 5 ("trust, access, novelty, corrections, review scheduling, procedure outcomes must converge") conflates fundamentally different things. Trust scoring is a read-time ranking signal. Access tracking is a time-series analytics feed. Novelty detection is a batch computation. User corrections are write operations. These do not need to "converge" into one model -- they need clear interfaces. The execution plan itself acknowledges this by deferring it to Wave 6, but it should not be an invariant at all. It should be a "nice to have if we find natural seams."

3. **It over-indexes on reference repos at the expense of Memongo's actual strengths.** The harmony roadmap dedicates significant space to parsing 12 reference repos, extracting lessons, and filtering them through a "native fit test." But several of the "lessons" are things Memongo already does better than the reference repo:
   - Memongo's trust scoring (9-signal composite at `mongodb-trust.ts`) is already more sophisticated than any reference repo's quality signal
   - Memongo's 5-phase Dreamer (`mongodb-consolidator.ts`) already has conservative extraction + aggressive consolidation, which is more nuanced than mem0's ADD/UPDATE/DELETE/NOOP
   - Memongo's provenance chain traversal via `$graphLookup` (`mongodb-reasoning-chain.ts`) is already more powerful than Cognee's graph-completion retriever
   
   The other AI spent too much analysis capital on "what can we learn from X" and not enough on "what should we double down on that we already have."

4. **The `asOf` contract in the Wave 1 plan is misscoped.** The plan introduces `asOf` as "only for conversation recall" but then says it "gates temporal validity for any derived memory cross-referenced during recall." That is not narrow -- that is the beginning of the repo-wide temporal refactor they explicitly said they were deferring. The Wave 1 plan should use `asOf` purely as a timestamp upper bound on the events query (which is just an `endTime` alias) and not hint at cross-referencing derived memory validity. That belongs in Wave 4.

5. **It missed the search executor entirely.** The harmony roadmap and execution plan discuss search and recall but never mention `mongodb-search-executor.ts`, which is the actual orchestration layer for multi-collection search. The Wave 1 plan creates a new `mongodb-conversation-recall.ts` that queries events directly -- which is fine -- but never acknowledges how this relates to the existing search executor's `"conversation"` source preference. This could lead to two parallel conversation search paths.

### What the Other AI Missed Entirely

1. **The derived memory extractor path is architecturally significant and under-discussed.** `mongodb-derived-memory.ts` promotes structured memory and procedures from events and bypasses `MongoDBMemoryManager`. The harmony roadmap mentions this in passing (the "canonical write rule") but never grapples with the fact that this is the only path that creates derived beliefs from evidence. The extraction pipeline is the heart of the intelligence system, and neither roadmap gives it proper attention.

2. **The search executor is the most complex single surface and was not audited.** `mongodb-search-executor.ts` orchestrates multi-lane search with fallback cascades, constraint relaxation, MMR reranking, and evidence coverage computation. It is the primary retrieval path. Neither roadmap discusses its architecture, limitations, or improvement opportunities.

3. **The query cache is never mentioned.** `mongodb-query-cache.ts` provides a caching layer that affects retrieval behavior. Neither roadmap acknowledges it.

4. **The 6123-line manager file is an architectural smell that nobody addressed.** `mongodb-manager.ts` at 6123 lines is the God Object antipattern. It imports from 25+ modules and has 30+ public async methods. Neither roadmap suggests decomposing it. The Wave 1 and Wave 2 plans both add more methods to it. This will only get worse.

5. **The retrieval planner is sophisticated and under-leveraged.** `mongodb-retrieval-planner.ts` classifies queries and builds retrieval plans. This is exactly the kind of "intelligence" infrastructure that should be highlighted. Neither roadmap mentions it.

6. **The KB (Knowledge Base) subsystem is never discussed.** `mongodb-kb.ts` and `mongodb-kb-search.ts` provide file sync, chunking, and knowledge base search. The harmony roadmap mentions "document ingest expansion" in the next execution wave but never examines the existing KB infrastructure.

---

## 2. Codebase Reality Check

### What Actually Exists (verified from source)

| Capability | Status | Key File(s) | Notes |
|---|---|---|---|
| Canonical event storage + retrieval | Complete | `mongodb-events.ts` | `writeEvent()`, `getEventsByTimeRange()`, `getEventsBySession()`, `renderEventChunkText()` |
| Structured memory with temporal validity | Complete | `mongodb-structured-memory.ts` | `validFrom`/`validTo` + `currentOnly` predicate at line 806 |
| Procedures with revisions + temporal | Complete | `mongodb-procedures.ts` | `validFrom`/`validTo` + revision history + `evolveProcedure()` |
| Entity graph + relations | Complete | `mongodb-graph.ts` | `expandGraph()` uses `$graphLookup` with `$facet` |
| Entity links + disambiguation | Complete | `mongodb-graph.ts` | `ambiguousFlags`, `confidenceSource`, autocomplete |
| Reasoning chain traversal | Complete | `mongodb-reasoning-chain.ts` | `$graphLookup` multi-hop, forward + reverse |
| Trust scoring (9-signal) | Complete | `mongodb-trust.ts` | Composite: exactness, freshness, contradiction, scope, provenance, diversity, confidence, source reliability, reinforcement |
| Novelty detection (k-NN surprisal) | Complete | `mongodb-novelty.ts` | Per-observation k-NN with autoEmbed |
| 5-phase Dreamer consolidation | Complete | `mongodb-consolidator.ts` | Gate -> Orient -> Extract+Decide -> Deduction stub -> Prune+Profile |
| Active slate / memory blocks | Complete | `mongodb-active-slate.ts` | `hydrateActiveSlate()`, `materializeBlocks()` |
| Profile synthesis | Complete | `mongodb-profile.ts` | Aggregates structured memory into a profile |
| Context bundle + wake-up mode | Complete | `mongodb-context-bundle.ts` | `mode: "wake-up"`, 250 token budget variant |
| Access tracking (time-series) | Complete | `mongodb-access-tracker.ts` | `access_events` time-series + canonical counters + trends/summaries |
| Benchmark infrastructure | Complete | `mongodb-benchmark-harness.ts`, `mongodb-benchmark-runner.ts` | LongMemEval/LoCoMo parity, scenario isolation, R@5/R@10/NDCG@10 |
| Multi-lane search executor | Complete | `mongodb-search-executor.ts` | Multi-pass, constraint relaxation, MMR, evidence coverage |
| Mutation audit log | Complete | `mongodb-mutations.ts` | Fire-and-forget audit trail |
| Recall traces | Complete | `mongodb-recall-traces.ts` | Operator observability for search paths |
| Memory jobs | Complete | `mongodb-memory-jobs.ts` | Background job tracking |
| Query cache | Complete | `mongodb-query-cache.ts` | Semantic query dedup |
| Background extraction | Complete | `mongodb-derived-memory.ts` | Event-scoped, idempotent via job ID |
| Importance decay | Complete | `mongodb-trust.ts` | `computeImportanceDecay()` with temporal scope awareness |
| Episode materialization | Complete | `mongodb-episodes.ts` | Time-bounded summaries from events |
| Retrieval planner | Complete | `mongodb-retrieval-planner.ts` | Query classification + plan building |
| KB sync + search | Complete | `mongodb-kb.ts`, `mongodb-kb-search.ts` | File sync, chunking, search |
| Conversation recall | **Missing** | -- | No dedicated surface exists |
| Lifecycle ergonomics (get/update/delete/history) | **Partial** | Procedures have `evolveProcedure()`; structured memory has revisions; but no unified public handle contract | |
| Unified temporal predicate | **Missing** | Only structured memory has `currentOnly`; graph uses `state` only; procedures have no temporal filter in search | |
| Perspective memory | **Missing** | No observer/observed fields | |
| Framework adapters (LangGraph, etc.) | **Missing** | Only Vercel AI SDK middleware exists | |

### What the Other AI Claimed vs Reality

| Claim | Accuracy | Evidence |
|---|---|---|
| MCP tools: 29 | **Wrong -- actual: 34** | `grep -c 'name: "memongo_' apps/mcp/src/server.ts` = 34 |
| Collections: 28 | **Close -- actual: 27 collection functions** + `access_events` time-series = 28 total | Schema file has 27 named collection helpers; access_events is created separately |
| Standard indexes: 81 | Not independently verified but plausible | Would require counting all `createIndex` calls in `ensureStandardIndexes()` |
| Search index budget: 12 | Plausible | Matches pattern history |
| Graph filters "mainly on state" | **Correct** | All 8 `$ne: "invalidated"` filters in `mongodb-graph.ts` use state only |
| Structured memory has current-truth predicate | **Correct** | `mongodb-structured-memory.ts:806-812` |
| Procedures have `validFrom`/`validTo` | **Correct** | `mongodb-procedures.ts:59-60` |
| Conversation recall is missing | **Correct** | No `recallConversation` anywhere in codebase |
| `sourceRef` is already in schemas | **Correct** | Present on events, structured memory, procedures |
| Wake-up mode exists | **Correct** | `mongodb-context-bundle.ts` with mode: "wake-up" |

---

## 3. Invariant-by-Invariant Evaluation

### Invariant 1: One Temporal Truth Model
**Verdict: Valid and important, but over-weighted as a priority.**

The diagnosis is accurate. There IS a mismatch between structured memory (which uses `validFrom`/`validTo`) and graph traversal (which uses `state` only). But the practical impact today is limited because:
- Graph traversal with `state: { $ne: "invalidated" }` is functionally correct for the current product surface
- No user-facing feature currently depends on "what was true at time T" for graph relations
- The gap becomes important only when conversation recall or lifecycle operations need to cross-reference derived memory

**Recommendation:** Keep this as a real concern but do not elevate it to a blocking architectural priority. Fix it incrementally as Wave 1 and Wave 2 create the demand.

### Invariant 2: One Lifecycle Model
**Verdict: Valid and second-highest priority after conversation recall.**

The gap is real. There is no unified get/update/invalidate/history contract across memory families. Procedures have `evolveProcedure()` which does revision-style updates with history. Structured memory has revision collections. But there is no public API surface that says "give me memory X by handle" or "show me the history of memory X."

**Recommendation:** This is correctly placed as Wave 2.

### Invariant 3: One Identity and Namespace Model
**Verdict: Already substantially solved.**

The existing `agentId` + `scope` + `scopeRef` + `sessionId` model in `mongodb-scope.ts` is consistent across all collections. `sourceRef` provides caller-owned idempotency. This invariant is more of a maintenance rule than a gap.

**Recommendation:** Treat as a constraint, not a work item.

### Invariant 4: One Recall Plane
**Verdict: Valid. Conversation recall is the missing piece.**

Profile, memory_blocks, and context-bundle are already cohesive. Conversation recall is the gap. The other AI correctly identified this.

**Recommendation:** Build conversation recall (Wave 1). The other 3 members are already solid.

### Invariant 5: One Feedback and Review Plane
**Verdict: Overcorrection. These are naturally separate concerns.**

Trust is a read-time signal. Access tracking is a time-series analytics feed. Novelty is a batch computation. User corrections are write operations. Procedure outcomes are a specific feedback loop. Forcing these into "one model" would create an unnecessary abstraction layer.

**Recommendation:** Demote from invariant to aspiration. Let natural seams emerge as the product matures. The current parallel-lanes architecture is fine.

### Invariant 6: One Scheduler Owner
**Verdict: Correct in principle, low urgency.**

The consolidator, extraction pipeline, and job system are already loosely coordinated. There is no competing scheduler today. This becomes important only when background work becomes complex enough to race.

**Recommendation:** Keep as a design rule. Do not build scheduler infrastructure until there is a concrete scheduling conflict.

### Invariant 7: Provenance Everywhere
**Verdict: Already substantially implemented. Strongest Memongo differentiator.**

`sourceEventIds`, `sourceRef`, mutation log, reasoning chain traversal, and the trust scoring system already provide rich provenance. This is Memongo's most powerful differentiator vs every reference repo.

**Recommendation:** Double down on this in documentation and marketing. Do not treat it as a gap.

### Invariant 8: Wrappers Are Wrappers
**Verdict: Already enforced by architecture.**

The bridge/API/client/MCP/tools stack is already thin wrappers over the engine. No wrapper has become a second truth store.

**Recommendation:** Maintenance constraint, not a work item.

### Summary: Invariant Value Assessment

| Invariant | Real Gap? | Priority | Action |
|---|---|---|---|
| 1. Temporal truth | Yes | Medium | Fix incrementally in W1/W2/W4 |
| 2. Lifecycle | Yes | High | Wave 2 |
| 3. Identity/namespace | No | Maintenance | Already solved |
| 4. Recall plane | Yes | Highest | Wave 1 |
| 5. Feedback plane | No | Low | Demote from invariant |
| 6. Scheduler | No | Low | Design rule only |
| 7. Provenance | No | Marketing | Already strong -- promote it |
| 8. Wrappers | No | Maintenance | Already enforced |

---

## 4. Wave Ordering Critique

### The Current Wave Ordering

| Wave | Title | My Assessment |
|---|---|---|
| W1 | Conversation Recall | **Correct -- ship this next** |
| W2 | Lifecycle Ergonomics | **Correct placement** |
| W3 | Benchmark Operations | **Should be W2, not W3** |
| W4 | Targeted Temporal Convergence | **Correct -- incrementally after W1/W2** |
| W5 | Distribution and Import | **Too late -- import should be W3** |
| W6 | Feedback and Provenance | **Correct -- defer** |

### My Recommended Reordering

1. **Wave 1: Conversation Recall** (agree)
   - This is the single most visible gap. Ship it.
   
2. **Wave 2: Benchmark Operations** (moved up from W3)
   - The benchmark infrastructure is already built but not operationalized. Formalizing benchmark gates should happen BEFORE lifecycle work because lifecycle changes affect retrieval behavior. You need the benchmark discipline in place before you start changing how memories are updated/invalidated.

3. **Wave 3: Lifecycle Ergonomics + Conversation Import** (merged W2+W5)
   - Lifecycle (get/update/invalidate/history) and import are closely related. Import creates events; lifecycle lets users manage derived memories. Build them together. Import should not wait until Wave 5 because it is a primary adoption driver -- new users need to import their conversation history.

4. **Wave 4: Targeted Temporal Convergence** (agree)
   - Fix graph temporal filtering on paths touched by W1/W3.

5. **Wave 5: Framework Adapters + Distribution** (agree with original W5 scope)
   - LangGraph adapters, semantic MCP aliases, host kits.

6. **Wave 6: Feedback Expansion** (agree -- defer)

### Justification for Moving Benchmark Operations Up

The execution plan says "benchmarks are not a side project" and "benchmarks decide whether retrieval work is accepted." If that is true, the benchmark operating contract should be in place BEFORE Wave 2 (lifecycle), because lifecycle changes to structured memory and procedures can affect search result quality. You do not want to ship lifecycle ergonomics and then discover that your invalidation semantics degraded recall quality without having a benchmark to catch it.

### Justification for Merging Import Into Wave 3

The execution plan defers import to Wave 5, but conversation import is the single biggest adoption barrier. A new user who wants to try Memongo needs to import their Claude Code / GPT / LangChain conversation history. This is not a "nice to have after recall is stable" -- it is the primary funnel for new users. Ship it with lifecycle, not after temporal convergence.

---

## 5. Reference Repo Lesson Evaluation

### High-Value Lessons (Actually Useful)

| Source | Lesson | Value |
|---|---|---|
| Graphiti | Temporal graph truth with validity windows | Real architectural insight. Memongo should adopt the `asOf` predicate concept. |
| mem0 | Lifecycle symmetry (get/update/history/delete) | Valid product gap. API ergonomics matter for adoption. |
| Letta | Conversation recall with role filters + exact timestamps | Directly shaped the Wave 1 plan. Good concrete reference. |
| Letta | Always-loaded blocks vs searchable external memory | Already implemented as memory_blocks. Validates the existing design. |
| MemPalace | Wake-up tiers | Already implemented as wake-up mode. Validates existing design. |

### Medium-Value Lessons (Directionally Useful)

| Source | Lesson | Value |
|---|---|---|
| LangMem | Namespace-to-scope adapter pattern | Useful for future adapter work. Not urgent. |
| Supermemory | Narrow public API shape (add, profile, search) | Good framing for docs/marketing. |
| Mengram | Procedure feedback loop | Already partially implemented via `recordProcedureOutcome()`. |
| claude-mem | Thin hook architecture | Already the default pattern in Memongo. |

### Low-Value Lessons (Over-Indexed)

| Source | Lesson | Value |
|---|---|---|
| Honcho | Perspective memory (observer/observed) | Premature for Memongo. No user has asked for observer-relative memory. Building it adds schema complexity for a theoretical use case. |
| Cognee | Ontology grounding | Interesting research direction but not a product differentiator for the current target audience. |
| MemOS | Unified feedback model | Over-abstraction as discussed in Invariant 5 critique. |
| Paprwork | DOCX conversion + debounce | Implementation details, not architectural insights. |

### The Overcorrection Risk

The harmony roadmap tries to absorb the "best of" from 12 repos. But Memongo's competitive advantage is not "we learned from everyone." It is:

1. **MongoDB-native** -- one database instead of 7 services
2. **Trust scoring** -- 9-signal composite that nobody else has
3. **Provenance** -- reasoning chain traversal via `$graphLookup`
4. **Conservative extraction** -- the Dreamer's rule-based pattern matching + similarity gating

The other AI should have spent more analysis on "how do we make THESE strengths more visible" and less on "what can we learn from Honcho's perspective model."

---

## 6. Wave 1 Plan Detailed Critique

### What Is Good

1. **Querying canonical events, not a separate transcript store.** Correct decision. No new collections, no new write paths.
2. **Two query paths (standard + semantic).** Clean separation between filter-only recall and vector/hybrid recall.
3. **Citation shape with provenance.** `ConversationRecallCitation` with `eventId`, `sessionId`, `role`, `timestamp`, `sourceRef`, `preview` is well-designed.
4. **Tool-message exclusion by default.** Correct default matching real-world usage.
5. **Using existing indexes.** No new indexes needed -- the events vector search index already has `timestamp` as a filter field.
6. **Regression suite design.** The 6 scenarios in Batch C are comprehensive.

### What Needs Correction

1. **The `asOf` parameter should be simplified.** The current plan says `asOf` "gates temporal validity for any derived memory cross-referenced during recall." For Wave 1, `asOf` should mean ONE thing: `timestamp <= asOf` on events. Period. No cross-referencing of derived memory validity until Wave 4. Rename it to `before` or just use `endTime` to avoid confusion.

2. **The hybrid recall path needs more specificity.** The plan mentions `$rankFusion` for hybrid recall but the implementation sketch in Batch A does not actually implement it -- it only implements vector search. The hybrid path should either be fully specified or explicitly deferred.

3. **The `ConversationRecallToolPolicy` type is defined but never used.** The plan defines `"exclude" | "include" | "summary"` but the actual implementation only uses boolean `includeToolMessages`. Either use the type or remove it.

4. **The `resolveTimeBoundary` function reinvents date parsing.** Using `Intl.DateTimeFormat` for timezone resolution in a Node.js environment is non-trivial and edge-case-heavy. Consider using the existing `temporal-polyfill` or simply requiring ISO timestamps with offsets from the client. The timezone resolution can be a Phase 2 enhancement.

5. **Missing: relationship to existing search executor.** The plan never mentions `mongodb-search-executor.ts` or its `"conversation"` source preference. When a user does `memongo_search` with a conversation-focused query, results already come from events. The new `memongo_recall_conversation` tool needs clear guidance on when to use which.

6. **The bridge function signature takes `manager` in Step 5 of Batch B but the bridge pattern is standalone functions.** The bridge uses `memongoBridgeGetManager(params.agentId)` internally -- not a passed-in `manager`. The MCP handler at Batch B Step 5 passes `manager` which contradicts the bridge facade pattern. This would cause a type error.

### Type Completeness Assessment

The type definitions are well-designed but:
- `ConversationRecallToolPolicy` is dead code
- `matchType: "hybrid"` is defined but the implementation never produces hybrid results
- `asOf: Date` on `ConversationRecallRequest` should be `asOf?: string` (ISO format) at the API boundary, converted to `Date` internally -- otherwise the OpenAPI spec cannot represent it

---

## 7. Recommended Corrections

### Immediate Corrections (Before Building Wave 1)

1. **Fix the MCP tool count in `patterns.md`.** Change 29 to 34.

2. **Simplify `asOf` in Wave 1.** Make it a pure timestamp upper bound on events. Do not hint at cross-referencing derived memory.

3. **Remove `ConversationRecallToolPolicy` type.** Use boolean `includeToolMessages` only. The `"summary"` mode is unimplemented and speculative.

4. **Add search executor awareness.** Document how `memongo_recall_conversation` differs from `memongo_search` with conversation source preference.

5. **Fix the bridge function signature in the Wave 1 plan.** The bridge uses standalone functions that resolve the manager internally.

### Medium-Term Corrections (Within Next 2 Waves)

6. **Reorder waves:** Move benchmark operations to W2, merge import into W3 with lifecycle.

7. **Demote Invariant 5 (One Feedback Plane).** Remove it from the harmony invariant list. Keep trust, access, novelty, corrections as separate concerns with clean interfaces.

8. **Start decomposing `mongodb-manager.ts`.** This 6123-line file needs at least 3 extractions: search methods, lifecycle methods, and admin/diagnostic methods. Every wave adds more methods to it.

### Strategic Corrections (Ongoing)

9. **Double down on Memongo's unique strengths in docs and marketing.** Trust scoring, provenance chains, conservative extraction, and MongoDB-native architecture are the differentiators. The docs and README should lead with these, not with feature parity against mem0/Letta.

10. **Stop treating reference repos as a feature menu.** The harmony roadmap lists lessons from 12 repos. Most of these are already implemented or irrelevant. Future work should be driven by user needs and benchmark evidence, not by "Cognee does X, therefore we should consider X."

---

## 8. The Single Most Important Thing To Do Next

**Ship conversation recall (Wave 1), but with the corrections above.**

This is not a close call. Conversation recall is:
- The single most visible gap in the product
- The feature every reference repo has that Memongo does not
- The simplest to build (it is a read surface over existing events -- no new collections, no new write paths)
- The best way to demonstrate MongoDB's power (vector search + standard query + role filters + time range, all on one collection)
- The feature that makes benchmarks meaningful (you cannot claim recall quality without a recall surface)

After conversation recall ships:
- Operationalize benchmarks (Wave 2 in my reordering)
- Build lifecycle ergonomics + import together (Wave 3)
- Then temporal convergence on touched paths (Wave 4)

**What to STOP doing:** Stop producing more strategic documents. The project now has a harmony roadmap, an execution plan, a wave 1 plan, a comparison memo, a definitive roadmap plan, a definitive roadmap design, and this audit. That is 7 planning documents for a project that needs ONE more engine file. The next commit should be code, not markdown.

**What to START doing that neither roadmap covers:**
1. **Decompose `mongodb-manager.ts` incrementally.** Extract search methods, lifecycle methods, and admin methods into separate files. Do this during Wave 1/2 as you touch the file.
2. **Write a "Memongo for mem0 users" and "Memongo for Letta users" migration guide.** This is the highest-leverage adoption work -- show people how to switch.
3. **Audit the search executor.** `mongodb-search-executor.ts` is the most complex retrieval path and has never been strategically examined. Its constraint relaxation, MMR reranking, and evidence coverage logic deserve dedicated attention.

---

## Appendix: File Reference Summary

| File | Lines | Role | Notes |
|---|---|---|---|
| `packages/memory-engine/src/mongodb-manager.ts` | 6123 | God Object -- needs decomposition | 30+ public async methods |
| `packages/memory-engine/src/mongodb-schema.ts` | 3139 | Collections, indexes, validators | 27 collection helpers, 81+ indexes |
| `packages/memory-engine/src/mongodb-search-executor.ts` | ~800 | Multi-lane search orchestration | Most complex retrieval path |
| `packages/memory-engine/src/mongodb-events.ts` | ~300 | Event storage/retrieval | Foundation for conversation recall |
| `packages/memory-engine/src/mongodb-structured-memory.ts` | ~830 | Temporal validity + revisions | Has `currentOnly` predicate |
| `packages/memory-engine/src/mongodb-graph.ts` | ~1000 | Entity graph + relations | Temporal gap: uses `state` not `validFrom`/`validTo` |
| `packages/memory-engine/src/mongodb-trust.ts` | ~400 | 9-signal trust scoring | Strongest differentiator |
| `packages/memory-engine/src/mongodb-consolidator.ts` | ~600 | 5-phase Dreamer | Conservative extraction pattern |
| `packages/memory-engine/src/mongodb-reasoning-chain.ts` | ~200 | `$graphLookup` provenance chains | Unique capability |
| `packages/memory-engine/src/mongodb-access-tracker.ts` | ~300 | Time-series access tracking | Split pattern: raw events + denormalized counters |
| `packages/memory-engine/src/mongodb-benchmark-runner.ts` | ~400 | Benchmark scoring | R@5/R@10/NDCG@10 |
| `apps/mcp/src/server.ts` | 1306 | MCP tools | **34 tools** (not 29) |
| `packages/memory-bridge/src/memongo-bridge.ts` | 963 | Bridge facade | Standalone functions, not methods |
| `apps/api/src/routes/v1.ts` | 1143 | HTTP API routes | Hono router |
| `packages/client/src/client.ts` | 920 | Typed HTTP client | SDK surface |

---

## Verdict

The other AI did good strategic work. Its diagnosis of the temporal mismatch, the conversation recall gap, and the "ship simple, evolve if needed" approach are all correct. The harmony invariants provide a useful architectural compass even though 3 of the 8 are already solved and 1 (feedback plane) is over-abstracted.

The main correction needed is **less analysis, more shipping.** The codebase has more planning documents than it needs and fewer user-facing features than it should. The next 2000 lines of code this project writes should be TypeScript, not Markdown.
