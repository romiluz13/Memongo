# Memongo Roadmap: Honestly Beat MemPalace — Implementation Plan (Decision RFC)

> **For Claude:** REQUIRED: Follow this plan gate-by-gate, phase-by-phase, using TDD.
> **Design:** See `docs/plans/2026-05-11-memongo-mempalace-roadmap-design.md` for full specification. This plan operationalizes the design into executable gates.
> **Source of Truth:** `docs/benchmarks/memongo-new-chat-handoff-2026-05-11.md` for Gates 0–7 semantics.
> **Plan mode:** `decision_rfc` with `critical_path` verification rigor. Benchmark integrity and capability correctness are high-blast-radius.

**Goal:** Land Memongo as the honestly-best MongoDB-native long-term AI memory framework, measured by a reproducible, strict, apples-to-apples LongMemEval-S retrieval lane that a skeptical reviewer cannot dismiss.

**Architecture:** Split the 48-file checkpoint tree into 6 reviewable scope branches, fix the benchmark harness so it emits per-scenario progress and bounded failures inside 5 minutes, validate all 6 `CLAUDE.md` capabilities against a 4-layer evidence bar (unit + integration + E2E + correctness invariant), then run the strict LongMemEval-S canary ladder (1/type → 8/type → 500-full) behind Gates 0–7 with zero benchmark manipulation and no publish/force-push until every gate passes.

**Pass-1 Review Response:** Fresh reviewer (pass 1) returned 5 BLOCKING findings (F1–F5) and 6 advisories (A1–A6). All five blockers are materially resolved in pass-2 revision; see `Fresh Review Resolution` section below for finding-by-finding traceability. Advisories A1–A6 are either resolved or explicitly justified. Pass-2 reviewer (gate) confirmed PASS with 8 code anchors verified.

**Pass-3 Review Response (this revision):** External third-party AI reviewer + 4 parallel validation agents returned 26 findings; user-approved 4 strategic scope additions (bi-temporal memories, human review/promotion gate, memory-poisoning defense, exportable-memory guarantee) and a MongoDB 8.3+ capability survey as the "secret weapon" thesis. This revision applies **32 surgical patches** in place across 6 categories: A(6) external reviewer + B(5) benchmark honesty + C(6) retrieval SOTA + D(4) competitor code audit + E(8) market/positioning + F(3) user strategic. The 8 locked decisions remain locked EXCEPT decision 4 — `$rankFusion` primary — is now user-confirmed with explicit 2× latency acceptance documented as **ADR-004**. New ADRs added: ADR-004 ($rankFusion latency acceptance), ADR-005 (MongoDB 8.3+ floor + secret-weapon thesis), ADR-006 (scope expansion — 4 features), ADR-007 (Phase-2 E2E QA lane at Gate 5), ADR-008 (agent invocation contract: MongoDB skills + MCP mandatory). New top-level section **Agent Invocation Contract** codifies mandatory skills/MCP for every future BUILD agent. `OPEN_DECISIONS` is now honestly non-empty (3 pending Task 0.5 defaults plus any surfaced by the 8.3+ survey plus the atlas-local:preview 8.3 availability question).

**Tech Stack:** TypeScript strict ESM, Bun 1.2+, Node 20+, Turborepo, Vitest, Biome, **MongoDB 8.3+** target floor (atlas-local:preview on port 27018; see **ADR-005** for 8.3+ rationale and the `docker.io/mongodb/mongodb-atlas-local:preview` tag availability as an **OPEN_DECISION** pending verification — fallback is 8.2+ with 8.3+ roadmap), Voyage embeddings + Voyage reranker, Anthropic Sonnet 4.6 strict LLM enrichment, **fast-check (installed via new Task 1.-1; resolves pass-3 A3)** for correctness invariants.

**Prerequisites:**
- Checkpoint commit `bd1f5ba691` exists locally with tag `checkpoint/pre-plan-2026-05-11`.
- Checkpoint snapshot contains exactly **48 tracked file changes** (verified via `git show --name-only bd1f5ba691` on 2026-05-11: 36 `packages/*` + 4 `apps/*` + 1 `docker/*` + 4 `docs/benchmarks/*` + 3 `docs/{platform,reference}/*` + 5 `integrations/hermes/memongo/*` + 2 `packages/client/*` + 2 `scripts/*` + README + .gitignore; see Task 0.3 for the per-file partition).
- `packages/memory-engine/src/mongodb-analytics.ts` and its test are NOT in this checkpoint (pass-1 F3 correction).
- Branch `codex/mongodb-scoped-memory-observability` is current HEAD. Main is untouched since release commit `65d193dbdf`.
- MongoDB atlas-local:preview runnable at `mongodb://127.0.0.1:27018/?directConnection=true` via `docker compose -f docker/mongodb/docker-compose.benchmark.yml up -d`.
- `@memongo/api` process must be started and reachable before any canary run (see `Bootstrap Sub-Sequence (mandatory before Phase 3)` below, pass-1 F2 response).
- `MEMONGO_VOYAGE_API_KEY` and `MEMONGO_ANTHROPIC_API_KEY` (or equivalents) resolve from `~/.zshenv`; no secrets in repo.
- `longmemeval_s_cleaned.json` dataset file present at `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_cleaned.json` (default `~/.memongo/workspace/benchmarks/longmemeval_s_cleaned.json`); SHA-256 recorded in every artifact.
- `docs/plans/2026-05-11-memongo-mempalace-roadmap-design.md` approved and referenced per phase.

**Durable Decisions:** (locked across all phases — never re-open without user approval)
1. Hybrid search primary = `$rankFusion` (MongoDB 8.1+ substrate, **MongoDB 8.3+ target — ADR-005**) with manual-RRF fallback via capability flag at `packages/memory-engine/src/mongodb-conversation-recall.ts:427`. **User-confirmed despite 2× latency trade-off — see ADR-004.** Sub-pipelines run serially inside `$rankFusion`, not in parallel.
2. First MemPalace comparison lane = retrieval-only LongMemEval-S. Answer generation deferred to Gate 5. **Gate 5 now also requires Phase-2 E2E QA lane with a named judge (Sonnet 4.6 or GPT-5.5) — see ADR-007.**
3. Voyage reranker + provenance-aware preference-evidence boost is the locked retrieval stack until Gate 4 passes. **Gate 5 adds a reranker bake-off cell (Voyage vs Cohere Rerank 4 vs ZeroEntropy zerank-2) per pass-3 C6.**
4. Every retrieval/indexing/schema decision MUST cite MongoDB MCP knowledge-base URL from the design's "MongoDB MCP Knowledge-Base Findings" section. **Every future agent invocation (planner, builder, reviewer) MUST load the MongoDB skills and search-knowledge MCP tool per the new Agent Invocation Contract section — see ADR-008.**
5. 4-layer evidence bar (unit + integration + E2E + correctness invariant) is mandatory for each of the 6 `CLAUDE.md` capabilities before publish. **Scope-expansion features (bi-temporal, poisoning defense, human review gate, export) also follow 4-layer evidence — ADR-006.**
6. Strict mode = zero silent fallback. Any model failure, JSON parse failure, or `Stale` search index aborts the run and is classified in the failure taxonomy.
7. No publish / no force-push / no history rewrite until Gates 0–6 pass.
8. Branch split BEFORE harness reliability work. 6 scopes from the handoff. **Pass-3 A1 correction: branches are created from `main`, then populated per-scope via `git checkout checkpoint/pre-plan-2026-05-11 -- <files>` (clean-file scopes) or `git add -p` (split files). The prior procedure of `git checkout -b scope-N checkpoint/...` was contaminated with all 48 changes and is corrected in Task 0.2.**
9. Scope merge order = 1 → 2 → 3 → 4 → 5 → 6 (harness → retrieval → docs → api-security → hermes → web). Rationale in ADR-001 below. **Scope expansion (ADR-006) adds 4 features across Scope 2 (bi-temporal, poisoning defense, optionally review gate), Scope 4 (export, optionally poisoning defense), and either Scope 6 or a new Scope 7 (human review web UI).**
10. All file references in artifacts and chat stay repo-root relative.
11. **MongoDB is our secret weapon (ADR-005).** Target 8.3+ capabilities; new Phase 0 Task 0.6 surveys MongoDB 8.1/8.2/8.3 release notes + Atlas Search operators + Automated Voyage Embeddings GA, outputs `docs/benchmarks/mongodb-83-capability-survey.md`, and flags any ≥3 missing capabilities as new Open Decisions.
12. **Agent Invocation Contract (ADR-008).** Every future agent spawned by this plan MUST include the MongoDB skills (`mongodb-search-and-ai`, `mongodb-query-optimizer`, `mongodb-schema-design`, `mongodb-connection`) and the `mcp__plugin_mongodb_mongodb__search-knowledge` MCP tool in its prompt, and MUST cite MCP knowledge-base URLs in its output. See the `Agent Invocation Contract` section.

---

## Executive Summary (Human Layer)

**What this plan does:** Turns the design's 7 deliverables (A–G) into 8 phases aligned with handoff Gates 0–7, each with concrete file surfaces, commands with expected exit codes, artifact locations, and failure responses. It resolves five open decisions from the design, partitions the **actual 48-file checkpoint tree** (re-derived from `git show --name-only bd1f5ba691`, pass-1 F3) into 6 scope branches, names the 4-layer test surface for each of the 6 capabilities, and prescribes a 3-session starter sequence.

**What is verified vs still needs confirmation:**
- **Confident because:** Checkpoint commit `bd1f5ba691` exists with 48 files partitioned (verified via `git show --stat`). `$rankFusion` is wired at `packages/memory-engine/src/mongodb-conversation-recall.ts:427` (verified). Queue-settle timeout at `packages/memory-engine/src/mongodb-manager.ts:3422` and search convergence probe at `:3473` are in place with partial tests (verified). Canary runner has no `MEMONGO_LOG_LEVEL` default and no per-scenario progress artifact emitter (verified via inspection). All four MongoDB MCP knowledge-base findings in the design are load-bearing and re-cited per phase.
- **Still needs confirmation:** User approval of recommended defaults for `numCandidates` table and failure-classification taxonomy (listed under Recommended Defaults; unapproved until explicit sign-off).
- **Key risks:** Capability #4 importance-decay `temporalScope` guard silently failing (high blast radius); Capability #6 Dreamer cross-scope merge (catastrophic for isolation); Capability #3 access-tracking batched-write loss on crash. All three are prime suspects and get correctness-invariant property tests.

---

## Request Summary

Produce a saved, reviewable, gate-by-gate plan at `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md` that a builder can execute to land Memongo as the most credible MongoDB-native long-term memory framework on LongMemEval-S retrieval, with full methodology disclosure and zero benchmark manipulation.

## Requirements Snapshot

- Plan covers all 7 deliverables A–G from design.
- Phases map 1:1 to handoff Gates 0–7 (Gate 0 → Phase 0, …, Gate 7 → Phase 7).
- Each phase has `phase_id`, objective, file list (repo-root relative), checks with exact commands and expected exit codes, artifact paths, and failure response.
- Capability-validation sub-phases under Phase 2 cover all 6 `CLAUDE.md` capabilities at 4 layers.
- Harness checklist items 1–8 each become discrete tasks with file anchors.
- 6-scope branch partition assigns every modified file to exactly one scope.
- 3-session starter sequence included.
- Every retrieval/indexing/schema recommendation cites MongoDB MCP knowledge-base URL from the design's findings.

## Constraints Snapshot

- Zero benchmark manipulation. Apples-to-apples or labeled deviation.
- Strict mode = no silent fallback. Any failure aborts + classifies.
- Repo-root-relative file paths only in artifacts and chat.
- American English; TypeScript strict ESM; Biome tabs + double quotes; Bun 1.2+; Node 20+.
- MongoDB MCP `search-knowledge` MUST back every retrieval/indexing/schema decision.
- No publish / force-push / history rewrite until Gates 0–6 pass; Gate 7 requires explicit user confirmation.
- Do NOT retry 8/type LongMemEval until Gate 1 is green.
- Product framing stays "single-tenant self-hosted / trusted caller" until scope-level API authorization ships.

## In Scope

- Branch partitioning (6 scopes, every file assigned, merge order, rollback tags).
- Harness reliability fixes (checklist items 1–8).
- Capability 4-layer validation for 6 capabilities.
- MemPalace forensic audit artifact creation.
- Strict LongMemEval-S canary ladder execution.
- Full LongMemEval-S retrieval-only lane at Gate 5.
- Retrieval-quality roadmap execution decisions (weights, numCandidates, quantization, compound boost audit, index readiness probe).
- 3-session starter sequence as recommended execution order.

## Out of Scope

- Implementation of anything (this is planning only).
- Running any benchmark from this plan (plan only; execution is a separate cc10x BUILD workflow).
- Voyage reranker swap experiments (deferred to after Gate 4).
- Answer-generation end-to-end lane (deferred to Gate 5 full matrix).
- LoCoMo / ConvoMem / MemBench competitor runs (Gate 5).
- `apps/web` visual redesign (Gate 6 polish only).
- Scope-level API authorization (documented gap; product framing constrained).
- Marketing copy.
- Any push / publish / force-push (Gate 7 gated).

## Planning Mode

- Plan mode: `decision_rfc`
- Verification rigor: `critical_path`

## Open Decisions

(Pass-3 G5 honesty correction: prior revision said `None` but 3 Recommended Defaults were in fact pending Task 0.5 sign-off; this section now reflects the honest state.)

1. **Three Recommended Defaults still pending Task 0.5 sign-off.** See `Pending Sign-Off Defaults` section below (renamed from `Recommended Defaults` per pass-3 G5): `numCandidates` table by top-k, 9-class failure-classification taxonomy, readiness-probe upgrade timing at Gate 1.
2. **MongoDB 8.3+ capability survey may surface new open decisions.** New Phase 0 Task 0.6 produces `docs/benchmarks/mongodb-83-capability-survey.md`. If the survey finds ≥3 8.3+ capabilities we are missing that would materially improve Memongo (e.g., `$scoreFusion` 8.2+, Automated Voyage AI Embeddings GA, new Atlas Search operators, improved quantization), each becomes a new Open Decision requiring user sign-off before Gate 5. Pass-3 F1.
3. **`atlas-local:preview` tag 8.3 availability.** The `docker.io/mongodb/mongodb-atlas-local:preview` tag tracks the latest preview. If 8.3 is not yet reachable from the `preview` tag at execution time, choose: (a) wait for 8.3 preview (delays gates), or (b) pin to 8.2+ with 8.3+ roadmap (pass-3 F2). Builder must verify the tag's MongoDB version at Phase 0 Task 0.6 Step 0 and surface the decision.

## Differences From Agreement

(Pass-3 revision makes four user-approved scope additions explicit.)

1. **Scope expansion — 4 user-approved features.** The original design did NOT anticipate: (a) bi-temporal memories (`validAt`/`invalidAt`), (b) human review/promotion gate (`pending → canonical`), (c) memory-poisoning/prompt-injection defense at consolidation write time, (d) exportable-memory guarantee (`POST /v1/export/{agentId}`). The user approved all four in pass-3. These are differences from the original design (not the original request), and are documented under **ADR-006** with an appendix "Scope Expansion Appendix" near the end of this plan. Each lands as detailed below.
2. **MongoDB floor raised to 8.3+.** Design and prior plan revision pinned MongoDB 8.1+. User's strategic guidance ("MongoDB is our secret weapon; target 8.3+") raises the floor. See ADR-005. Prior manual-RRF fallback remains for users on earlier MongoDB (product-level compatibility), but benchmark target is 8.3+.
3. **Gate 5 now also ships Phase-2 E2E QA lane** with named judge (Sonnet 4.6 or GPT-5.5). Design's retrieval-only lane remains as Gate 3/Gate 4 first lane. See ADR-007. Competitor reference baselines: Mastra 94.87%, Letta 83.2%, Zep 63.8%, Mem0 49.0%.
4. **`$rankFusion` kept as primary** despite 2× latency (sub-pipelines run serially, not in parallel). User confirmed the trade-off. See ADR-004. Gate 5 benchmark-matrix publishes p50/p95 so reviewers see the cost knowingly accepted.

## Pending Sign-Off Defaults (unapproved until Phase 0 Task 0.5 sign-off — pass-1 A4 response, renamed per pass-3 G5)

**All three defaults below are gated by `Phase 0 Task 0.5 [CHECKPOINT — human_verify]`. Tasks 1.4, 1.5, and 2.R2 each branch on the sign-off outcome.**

- **`numCandidates` table by top-k:** `limit=5 → 200, limit=10 → 200, limit=20 → 400, limit=30 → 600`. Derived from MongoDB guidance (`mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage`): `numCandidates ≥ 20× limit`, clamped to a 200-minimum floor for low-k recall protection. Revisit at Gate 5 with recall curves at `(50, 100, 200, 400, 600)`.
- **Failure-classification taxonomy enum:** `harness-timeout | model-failure | json-parse | index-not-ready | scope-leak | retrieval-miss | queue-settle-timeout | probe-timeout | unknown`. Refines the design's 7-class list by splitting `harness-timeout` into `queue-settle-timeout` and `probe-timeout` (both are harness-owned, but have different fixes); keeps `unknown` as an explicit escape valve rather than silently coercing.
- **Readiness probe strategy (Gate 1 vs Gate 2):** Replace aggregate `$search` probe with `$listSearchIndexes → status==Ready` check **in Gate 1**, not deferred to Gate 2. Rationale: the aggregate probe is the current source of probe hangs; keeping it for Gate 3's 1/type canary risks another observability failure. The implementation cost is low (one async call per index) and the correctness benefit is immediate. Source: `mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes`.

**Outcome matrix:**

| Default | Approved | Rejected |
|---|---|---|
| numCandidates table | Task 2.R2 Sub-path A (code change) | Task 2.R2 Sub-path B (proposal doc only) |
| 9-class taxonomy | Task 1.4 9-class enum ships | Task 1.4 falls back to design's 7-class enum |
| Readiness probe @ Gate 1 | Task 1.5 ships `readSearchIndexStatus`-based probe | Task 1.5 ships hardened aggregate probe only, with upgrade deferred to a future gate |

---

## Agent Invocation Contract (MANDATORY — pass-3 F3 / ADR-008)

Every future agent spawned by this plan — `cc10x:component-builder`, `cc10x:bug-investigator`, `cc10x:integration-verifier`, `cc10x:code-reviewer`, `cc10x:planner`, subagents dispatched by the router — MUST include the following in its prompt **before any code decision or artifact write**:

1. **MongoDB skills (mandatory):**
   - `mongodb:mongodb-search-and-ai` — Atlas Search, `$search`, `$vectorSearch`, `$rankFusion`, hybrid, rerank; MANDATORY for any retrieval/search/vector decision.
   - `mongodb:mongodb-query-optimizer` — `explain()` plans, index selection, slow-query analysis; MANDATORY for any query-shape or index decision.
   - `mongodb:mongodb-schema-design` — embedding vs referencing, array growth, TTL, schema versioning; MANDATORY for any collection/field/index/TTL decision.
   - `mongodb:mongodb-connection` — connection pool, serverless, timeout tuning; MANDATORY for any connection-pool/timeout/bootstrap decision.

2. **MongoDB MCP tool (mandatory):**
   - `mcp__plugin_mongodb_mongodb__search-knowledge` — the MongoDB knowledge-base MCP tool. MANDATORY for every retrieval/indexing/schema decision. The agent MUST cite a URL from the returned knowledge in its output. Decisions that do not cite an MCP URL are invalid.

3. **Invariant statement (copy verbatim into every BUILD task prompt):**
   > "MongoDB is our secret weapon. Target 8.3+ capabilities. When in doubt about what MongoDB can do, consult the MCP knowledge base before writing code. Prefer server-side MongoDB operators over application-side reimplementation."

4. **Enforcement (primary — router-level).** The router is the single enforcement point. The Router Contract YAML at the end of this plan lists the 4 MongoDB skills + 1 MCP tool under `Recommended Skills for BUILD (SKILL_HINTS for Router)`, and the router passes them as `SKILL_HINTS` on every BUILD agent dispatch. Every BUILD task inherits this contract implicitly via router SKILL_HINTS passthrough — individual task prompts do NOT need to restate the skill list.

5. **Enforcement (secondary — reviewer).** Pass-N reviewer is authorized to fail any BUILD task whose router-contract output does not list the 4 MongoDB skills + 1 MCP tool under `SKILL_HINTS` or whose decisions lack MCP URL citations. Decisions about retrieval/indexing/schema that were made without an MCP knowledge-base consultation are invalid regardless of outcome. This rule does not replace domain-specific skills (e.g., `cc10x:test-driven-development`, `cc10x:verification-before-completion`); those remain additional.

6. **Task-level opt-in for domain skills.** A BUILD task MAY additionally name extra skills specific to its work (e.g., Task 2.SE-1 names `mongodb:mongodb-schema-design` explicitly for bi-temporal field design). When a task names a domain skill, that's additive to the router's mandatory 4+1, never a replacement.

---

## Execution Contract Layer

## Codebase Reality Check

- **Verified files / surfaces:**
  - `packages/memory-engine/src/mongodb-manager.ts:3422` — `settleBenchmarkScenarioManager()` queue-settle timeout logic in place; attempts retry loop with 8 iterations and per-queue `Promise.race` bound (verified by read).
  - `packages/memory-engine/src/mongodb-manager.ts:3473` — `waitForBenchmarkEventSearchConvergence()` with `AbortController + maxTimeMS + Promise.race` pattern (verified by read).
  - `packages/memory-engine/src/mongodb-conversation-recall.ts:427` — `$rankFusion` stage with named `vector` + `text` pipelines (verified by read). Default no `weights` map → 0.5/0.5 per MongoDB docs.
  - `scripts/run-longmemeval-canary.ts` — canary runner with `MEMONGO_CANARY_CASES_PER_TYPE` default 8 (verified by read); confirmed NO `MEMONGO_LOG_LEVEL=warn` default, NO per-scenario progress emitter, NO `--resume` semantics.
  - `docs/benchmarks/benchmark-matrix.md` — canary ladder + competitor parity checklist already codified.
  - `docs/benchmarks/benchmark-operating-contract.md` — strict-mode contract defined; publish criteria enumerated.
  - `docs/benchmarks/memongo-new-chat-handoff-2026-05-11.md` — Gates 0–7 source of truth.
  - `CLAUDE.md` — 6 capability table with key files mapped.
- **Existing patterns / constraints:**
  - Scoped retrieval always filter-first (`agentId + scope + scopeRef`) then search-second. Any new retrieval surface MUST respect this.
  - Benchmark strict mode (`MEMONGO_BENCHMARK_STRICT=1` + `MEMONGO_LLM_ENRICHMENT_STRICT=1`) throws on any fallback path. Tests mocking fallback must assert throw.
  - Colocated `*.test.ts` with source; Vitest + V8 coverage.
  - TypeScript strict ESM; `any` forbidden; Biome tabs + double quotes; file budget ~500 LOC.
  - Artifacts live under `.claude/cc10x/v10/workflows/{workflow-id}/artifacts/canary-runs/{run-id}/` (historical) OR `artifacts/canary-runs/{run-id}/` (new gate-labeled runs).
- **Pressure points / contradictions:**
  - Gate 1 must land **before** Gates 3–4. Memory says 8/type has hung 4 times; the design and handoff both forbid retrying 8/type until progress artifacts land.
  - Scope #1 (harness) and Scope #2 (retrieval) both touch `packages/memory-engine/src/mongodb-manager.ts`. Partition is by-LINE-range, not by-file, so a single scope-per-file rule is not enough — the plan must specify which hunks go to which scope branch via `git add -p` or cherry-pick.
  - Design says readiness probe "prefer `$listSearchIndexes`" — this plan upgrades that to a Gate 1 requirement (see ADR-002).
  - Product framing "single-tenant self-hosted / trusted caller" is a constraint the plan must not contradict — no "multi-tenant" claim in docs scope (Scope #3).

## Plan-vs-Code Gaps

| Current code / behavior | Planned change | Gap / risk | Plan response |
|---|---|---|---|
| `scripts/run-longmemeval-canary.ts` has no `MEMONGO_LOG_LEVEL` default | Default `MEMONGO_LOG_LEVEL=warn` unless `MEMONGO_CANARY_DEBUG=1` | PTY backpressure still possible if benchmarker forgets env | Plan Phase 1 Task 1.1 sets the default in the canary itself, not env vars |
| Canary artifact written only after HTTP benchmark returns | Write per-scenario progress JSON `artifacts/canary-runs/{run-id}/progress/{scenario-idx}.json` immediately on completion | Long runs remain opaque until current behavior changes | Plan Phase 1 Task 1.2 adds progress emitter wired into scenario loop |
| Queue-settle timeout has partial test at `mongodb-manager.test.ts:417` | Complete test coverage: timeout fires, error message names offending queue, re-attempt path | Unbounded derivation promise could still hang in untested branch | Plan Phase 1 Task 1.3 adds 3 test cases: (a) fires on writeQueue, (b) fires on derivationQueue, (c) succeeds on slow-but-bounded queue |
| Search convergence probe uses aggregate `$search + $count` | Replace with `$listSearchIndexes → status==Ready` poll (ADR-002) | Aggregate probe's the current hang site; swap eliminates the source | Plan Phase 1 Task 1.5 refactors `waitForBenchmarkEventSearchConvergence` to `listSearchIndexes`-based readiness |
| No failure-classification taxonomy in canary artifacts | Emit `failureClass: <enum>` per miss + top-level `runFailureClass` on abort | Missing classification hides root cause on 8/type failures | Plan Phase 1 Task 1.4 adds taxonomy with 9 classes and miss-ledger integration |
| No resume semantics | If `progress/` has N complete scenarios, skip them on `MEMONGO_CANARY_RESUME=1` | Canary retries from scratch every time; wastes minutes | Plan Phase 1 Task 1.0 introduces `MEMONGO_CANARY_RESUME` env var; Task 1.7 wires the resume logic into the scenario loop (pass-1 F1 response — env-var route chosen over CLI flag) |
| `$rankFusion` has no `weights` map (defaults 0.5/0.5) | Keep 0.5/0.5 as baseline for Phase 3 Gate 3; log `scoreDetails.details[]` per case | Without observability we can't tune weights honestly in Gate 5 | Plan Phase 2 Task 2.R1 adds `scoreDetails` logging to `recallConversation` and benchmark artifact writer |
| `temporalScope=permanent\|ongoing` guard in `mongodb-trust.ts` uncovered by property test | Add fast-check invariant: permanent/ongoing NEVER decay; decayed value always in `[0, 1]`; monotonic decreasing under no-access | Silent-bug risk: important memories could rot invisibly | Plan Phase 2 Capability 4 sub-phase adds property test with ≥1000 seeded cases |
| Dreamer consolidation has no cross-scope-merge invariant test | Add fast-check invariant: no two source events across differing `scopeRef` ever merge into the same consolidated memory | Cross-scope leak is catastrophic | Plan Phase 2 Capability 6 sub-phase adds property test + integration test with mixed-scope input |
| Access-tracking batched writes: no crash-recovery test | Integration test: simulate shutdown mid-batch; assert no count goes backwards | Recency loss is silent | Plan Phase 2 Capability 3 sub-phase adds shutdown-drain test |

## Assumption Ledger

- **Proven by code:**
  - Checkpoint commit `bd1f5ba691` exists with tag `checkpoint/pre-plan-2026-05-11` (confirmed via `git log --oneline -5`).
  - 48 files in checkpoint diff (confirmed via `git show --stat bd1f5ba691`).
  - `$rankFusion` wired at `mongodb-conversation-recall.ts:427` (confirmed via read).
  - Harness partial fixes at `mongodb-manager.ts:3422` and `:3473` (confirmed via read).
  - `mongodb-manager.test.ts` has partial queue-settle test per design note — needs completion (verified in Plan-vs-Code Gaps).
- **Inferred:**
  - MongoDB 8.1+ `$rankFusion` with `weights` map and `scoreDetails` is available in atlas-local:preview port 27018 (based on design's MCP Finding #1 citing `mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search`). Validate at Phase 2 Gate 2 during capability audit.
  - `$listSearchIndexes` is queryable as a standalone aggregate on atlas-local:preview (design MCP Finding #4 cites `mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes`). If atlas-local:preview lacks this, Phase 1 Task 1.5 falls back to the aggregate probe with the stricter abort timeout and we keep the taxonomy class `index-not-ready` populated by the current probe. Treat as a Phase 1 early-validation gate.
  - LongMemEval-S dataset `longmemeval_s_cleaned.json` SHA is stable across runs (record SHA into every artifact; design demands this).
- **Needs user confirmation:**
  - Recommended `numCandidates` table values (listed under Recommended Defaults).
  - Failure-classification taxonomy enum refinement (9 classes vs design's 7).
  - Gate-1-vs-Gate-2 readiness-probe upgrade timing (plan recommends Gate 1).
  - Scope merge order (plan recommends 1 → 2 → 3 → 4 → 5 → 6; ADR-001 justifies).

## Fresh Review Resolution

**Pass 1 — plan-gap-reviewer, 5 BLOCKING + 6 advisory findings returned. All BLOCKERS materially resolved in this revision.**

- **Accepted findings (BLOCKING):**
  - **F1 — Canary CLI contract mismatch.** The prior plan referenced `--artifact-dir`, `--full`, `--resume` CLI flags that the script does not parse. **Response:** adopted the env-var alternative route. A new **Task 1.0** adds env-var parsing for `MEMONGO_CANARY_ARTIFACT_DIR`, `MEMONGO_CANARY_FULL`, and `MEMONGO_CANARY_RESUME` (with tests) BEFORE Tasks 1.1+. Every downstream canary invocation (Tasks 1.9, 3.1, 4.1, 5.1) now uses env vars exclusively and lists Task 1.0 as a blocker. The script still honors pre-existing `MEMONGO_CANARY_*` env vars unchanged.
  - **F2 — API server startup missing + ordering contradiction.** The prior plan never started `@memongo/api` yet the canary POSTs to `http://127.0.0.1:${MEMONGO_API_PORT||3847}/v1/admin/relevance/benchmark`. **Response:** added an explicit `Bootstrap Sub-Sequence (mandatory before any canary run)` section immediately below, and added it as a precondition on Phase 3 / 4 / 5 canary tasks. The existing `GET /health` endpoint in `apps/api/src/app.ts:206` is used as the health probe (no need to add `/healthz`; the prior plan's reference was incorrect). Live Verification Strategy updated. This removes the Scope #4 / Phase 5 ordering conflict — no new endpoint is required.
  - **F3 — Partition table references files not in working tree.** Phantom `mongodb-analytics.ts` and `mongodb-analytics.test.ts` rows have been removed. Table is now re-derived from `git show --name-only bd1f5ba691`; 48 files exactly, 3 are split via `git add -p`. Split protocol documented.
  - **F4 — MemPalace reproduction task too thin.** Task 5.2 is expanded into a 7-step sub-sequence with the MemPalace repository reference, Raw-first mode selection, identical dataset / commit SHA requirement, exact reproduction exit criterion (±3 points on R@5 vs their 96.6% headline), artifact contents, and an explicit fallback posture when the codebase is unreproducible.
  - **F5 — Gate 5 exit criteria demand parity fields no task emits.** A new **Task 1.A** under Phase 1 upgrades the `benchmarkReport` envelope in `packages/memory-engine/src/mongodb-benchmark-runner.ts` and the canary progress artifacts to emit `datasetSha256`, `retrievalUnit`, `embedding.{model,dimensions,quantization}`, `reranker.{model,version,stage}`, `storage.{collectionBytes,indexBytes}`, `latency.{p50Ms,p95Ms}`, and `cost.{embeddingCalls,rerankCalls,llmEnrichmentCalls}`. The task BLOCKS Gate 3 exit (Gate 3 artifact carries the same fields at 1/type scale — even if `storage` is the only field meaningful at that scale). Unit tests verify each field is present and non-null. Both Scope 1 (envelope) and Scope 2 (retrieval-adjacent emitters) receive their correct hunks per the split protocol.

- **Accepted findings (ADVISORY — all resolved where cheap):**
  - **A1 — Capability 3 (AccessTracker) E2E layer.** Task 2.C3 Layer 3 is renamed from "E2E" to **"Engine boundary integration"** with explicit justification: AccessTracker is engine-internal, no HTTP / MCP surface exists by design, and every external read path (search, recall, KB) transits the tracker. The integration test exercises the tracker via the bridge-level `recallConversation` path and asserts the batched-writer observable behavior.
  - **A2 — Capability 5 wiki categorization invariant fast-check seed.** Task 2.C5 Layer 4 now names a property-test shape: `∀ KB doc: kbDoc.wikiSource !== undefined ∧ kbDoc.vault !== undefined ∧ kbDoc.section !== undefined ∧ kbDoc.agentId===filterAgentId ∧ kbDoc.scope===filterScope ∧ kbDoc.scopeRef===filterScopeRef` — seeded with a fixed fast-check seed recorded in the evidence artifact.
  - **A3 — Task 1.8 silent-fallback audit doc landing.** Resolved: the doc is WRITTEN during Phase 1 as a working draft stored on `scope-1-harness-reliability` at `docs/benchmarks/silent-fallback-audit-2026-05-11.md` (colocated with the audit work); at Scope #3 merge in Phase 2 it is `git mv`-ed into the `docs/benchmarks/` docs scope as part of the Scope #3 PR. The file never leaves `docs/benchmarks/` but its ownership transfers from the harness scope PR to the docs scope PR.
  - **A4 — Task 2.R2 unapproved `numCandidates` table.** Resolved: Task 2.R2 is reshaped to PRODUCE the table as a proposal artifact (`docs/benchmarks/numcandidates-proposal-2026-05-11.md`) with evidence under Phase 2. Applying the table is GATED on a new `Phase 0 Task 0.5 [CHECKPOINT — human_verify]` where the user signs off on the 3 Recommended Defaults (numCandidates table, failure-classification enum refinement, readiness-probe timing) before any execution. If the user rejects a default, Task 2.R2 reverts to a proposal-only doc and no code change lands.
  - **A5 — Task 1.5 mocks a helper that doesn't exist.** Resolved: Task 1.5 is split — **Step 0** extracts the `listSearchIndexes` readiness probe into a pure helper `readSearchIndexStatus(db, collName)` exported from a new module `packages/memory-engine/src/mongodb-benchmark-readiness.ts`. The test mocks `readSearchIndexStatus` via its module boundary, not an invented `mockDbWithListSearchIndexes`. `waitForBenchmarkEventSearchConvergence` delegates to the helper.
  - **A6 — Bootstrap tool availability.** Resolved: new **Task 1.0 Step 0** (pre-bootstrap checklist) verifies `mongosh`, `docker`, `bun`, `curl`, and the dataset file are present before any canary run. Failure exits non-zero before any network call.

- **Rejected findings:** `None`.

**Pass 3 — external third-party AI reviewer (6 findings: 4 real bugs verified + 2 polish) + 4 parallel validation agents (5 findings each = 20 findings) + user strategic scope expansion (4 approved features + MongoDB 8.3+ survey = 3 strategic patches). Total: 32 surgical patches applied in place.**

- **Accepted findings (pass-3 external reviewer — 6 / Category A):**
  - **A1 (HIGH):** Task 0.2 branch procedure corrected — prior procedure contaminated every scope with all 48 changes; new procedure branches from `main` then selectively applies per-scope hunks via `git checkout checkpoint -- <files>` or `git add -p`. Inline at Task 0.2.
  - **A2 (HIGH):** `SearchIndexStatus` literals corrected to uppercase (`PENDING | BUILDING | READY | STALE | FAILED | DELETING | DOES_NOT_EXIST`) and `queryable: boolean` captured as the actual readiness indicator. Task 1.5 helper contract + all tests updated.
  - **A3 (MEDIUM):** `fast-check` is referenced but not installed. New Task 1.-1 installs it on `scope-1-harness-reliability` before any Phase 2 property test.
  - **A4 (MEDIUM):** Live Verification Strategy docker path corrected to `docker compose -f docker/mongodb/docker-compose.benchmark.yml up -d` (was `cd docker && docker compose -f docker-compose.benchmark.yml`). Audited whole plan; only the Live Verification Strategy line had the bug.
  - **A5 (MEDIUM):** Task 0.1 commit target changed to `scope-3-docs-benchmarks` (was HEAD). Matches partition-table row assignment.
  - **A6 (MEDIUM):** MemPalace URL corrected to `github.com/MemPalace/mempalace` branch `develop` commit `68319dc`. Every URL reference updated.

- **Accepted findings (pass-3 Agent 1 benchmark honesty — 5 / Category B):**
  - **B1:** BEAM + MemoryAgentBench follow-on lanes added as roadmap rows in Gate 5 matrix (Task 5.roadmap). Do not block Gate 5 exit.
  - **B2:** Phase-2 E2E QA lane at Gate 5 with named judge (Sonnet 4.6 primary / GPT-5.5 secondary) — Task 5.E2E / ADR-007.
  - **B3:** Adversarial judge probe (Task 5.adv) — Memongo-signature honesty metric no competitor publishes.
  - **B4:** Private held-out LongMemEval-S split (Task 0.7) — drift detection against public split at Gate 5.
  - **B5:** README "Benchmark corrections and caveats" section (Task 6.3) — ship empty at v1, fill if needed.

- **Accepted findings (pass-3 Agent 2 retrieval SOTA — 6 / Category C):**
  - **C1:** `$rankFusion` sub-pipelines run serially (2× latency) — ADR-004 documents knowingly accepted trade-off.
  - **C2:** mongot replication lag check added to Bootstrap Sub-Sequence (new B5a step).
  - **C3:** Per-query hybrid weighting — Task 2.R6 proposal artifact first; code gated by Task 0.5 follow-up sign-off.
  - **C4:** ENN fallback for small corpora — Task 2.R7 proposal artifact first; code gated.
  - **C5:** HyDE as sibling route — Task 2.R8 roadmap; Gate 5 evaluation cell.
  - **C6:** Reranker bake-off — Task 2.R9 matrix at Gate 5 (Voyage vs Cohere Rerank 4 vs ZeroEntropy zerank-2).

- **Accepted findings (pass-3 Agent 3 competitor code audit — 4 / Category D):**
  - **D1:** MemPalace hybrid_v4 self-documented test-set leakage — Task 0.1 Step 3 records asymmetry; Task 5.2 Step 2 enforces Raw OR held-out-450.
  - **D2:** Mem0 93.4 unverifiable from OSS — Task 5.2 Step 5a explicit posture downgrade.
  - **D3:** MemPalace custom scorer ≠ official LongMemEval judge — Task 5.2 Step 5 dual-scorer columns.
  - **D4:** Multi-tenant enforcement positioning — Task 5.2 Step 5b records Memongo's scope-level isolation is more rigorous than MemPalace/Mem0 but less enforced than Letta; documented as known-gap-with-roadmap.

- **Accepted findings (pass-3 Agent 4 market/positioning — 8 / Category E):**
  - **E1:** Anthropic Dreaming (May 6 2026) — reframe "Dreamer" to internal name only; Task 6.3 updates positioning.
  - **E2:** MongoDB LangGraph.js store (May 7 2026) — reframe headline to "scoped, inspectable, durable agent memory built on MongoDB"; Task 6.3.
  - **E3:** Bi-temporal memories (`validAt`/`invalidAt`) — **USER APPROVED.** Task 2.SE-1 on `scope-2-retrieval-ranking`; ADR-006.
  - **E4:** Human review/promotion gate — **USER APPROVED.** Task 2.SE-3 under new Scope 7 (web UI); ADR-006.
  - **E5:** Memory-poisoning defense — **USER APPROVED.** Task 2.SE-2 on `scope-2-retrieval-ranking`; ADR-006.
  - **E6:** Exportable-memory guarantee — **USER APPROVED.** Task 2.SE-4 on `scope-4-api-security`; ADR-006.
  - **E7:** Adopt episodic/semantic/procedural vocabulary — Task 6.3 docs update.
  - **E8:** Commit to OSS/self-host lane — Task 6.3 positioning; pass-3 D4 alignment.

- **Accepted findings (pass-3 user strategic — 3 / Category F):**
  - **F1:** MongoDB 8.3+ capability survey — new Phase 0 Task 0.6; ADR-005 secret-weapon thesis.
  - **F2:** MongoDB floor raised to 8.3+ — ADR-005; tech-stack header updated; Open Decision #3 for `atlas-local:preview` 8.3 availability.
  - **F3:** Agent Invocation Contract — new top-level section; ADR-008; every future BUILD agent prompt MUST include 4 MongoDB skills + 1 MCP tool.

- **Accepted findings (pass-3 structural — G1–G5):**
  - **G1:** Inline plan-review-gate will re-run + external pass-3 reviewer expected after this revision.
  - **G2:** Provable Properties extended by 4 new invariants (bi-temporal, poisoning, review gate, export).
  - **G3:** Scenarios updated in Router Contract (see YAML at end).
  - **G4:** OPEN_DECISIONS now honestly non-empty (3 pending defaults + 8.3+ survey items + atlas-local-preview-8.3 availability).
  - **G5:** Recommended Defaults renamed to "Pending Sign-Off Defaults" with honest wording.

- **Rejected findings:** `None`. All 32 patches accepted and applied in place.

## Current State

- HEAD = `bd1f5ba691` on branch `codex/mongodb-scoped-memory-observability`.
- `main` untouched since `65d193dbdf` (initial Memongo release).
- 48 files changed in checkpoint; 1 untracked file (the design doc being operationalized by this plan).
- Strict 1/type canary last passed clean on `2026-05-11T0804` with preference-evidence fix landed.
- Strict 8/type canary hung 4 times in May 2026 — all observability failures (per memory + handoff).

## Alternatives

### ADR-001: Branch split BEFORE harness work (chosen) vs freeze-then-split (alternative)

**Context:** 48 files modified on a single branch; any harness patch risks contaminating an unrelated scope.

**Alternative A (chosen) — Split first (6 scopes), then harness on Scope #1:**
- Each scope lands as an independent, bisectable PR.
- Harness fix (Scope #1) merges first and proves Gate 1 before any retrieval decision.
- Cost: ~0.5 day rebase labor to partition `mongodb-manager.ts` hunks.

**Alternative B — Freeze-then-split:**
- Freeze `codex/mongodb-scoped-memory-observability` as a single bulk PR; land harness changes on top in a follow-up.
- Benefit: fewer rebases; faster to start benchmarks.
- Drawback: contaminated bisect surface; reviewers can't separate retrieval changes from harness changes; Gate 1 cannot be proven independently.

**Decision:** Alternative A. The design's Approved Decision #2 locks this.

**Consequences:**
- Positive: bisectable; auditable PRs; clear rollback per scope; Gate 1 can be green before retrieval scopes land.
- Negative: one-time rebase cost; requires `git add -p` discipline for split-file hunks.
- Scope merge order: 1 → 2 → 3 → 4 → 5 → 6 (harness → retrieval → docs → api-security → hermes → web). Rationale: each later scope depends on or is non-blocking for earlier; harness must be green before any benchmark claim; retrieval before docs so methodology disclosure describes the final algorithm; API security before Hermes because Hermes calls the API; web last (cosmetic only).

### ADR-002: Replace aggregate `$search` readiness probe with `$listSearchIndexes` in Gate 1 (chosen) vs defer to Gate 2

**Context:** `waitForBenchmarkEventSearchConvergence()` currently runs a `$search + $count` aggregate probe to gate scenario-level readiness. This is the suspected source of the 4 hangs in May 2026.

**Alternative A (chosen) — `$listSearchIndexes` in Gate 1:**
- Poll `$listSearchIndexes` → wait for `status==Ready` (MongoDB MCP Finding #4: `mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes`).
- `Stale` status = queryable but data-stale → treat as `index-not-ready` in strict mode.
- Removes the hang root cause before canary runs.

**Alternative B — Defer to Gate 2:**
- Keep the aggregate probe at Gate 1; upgrade it at Gate 2 alongside capability audit.
- Benefit: smaller Gate 1 patch surface.
- Drawback: Gate 1 signs off on an unchanged probe that demonstrably hung; Gate 3 1/type canary re-runs through the same code; we lose the chance to prove Gate 1 with the upgraded probe.

**Decision:** Alternative A. Gate 1's charter is harness reliability; deferring the probe upgrade contradicts the charter.

**Consequences:**
- Positive: eliminates probe-hang source; Gate 1 artifact proves the new probe worked; classified failure taxonomy has a clean `index-not-ready` path.
- Negative: Phase 1 patch surface grows by ~80 LOC (new helper + test).
- Risk mitigation: if atlas-local:preview doesn't support `$listSearchIndexes`, Phase 1 Task 1.5 falls back to the hardened aggregate probe with stricter abort; validated early in Phase 1.

### ADR-003: `$rankFusion` as primary hybrid strategy (chosen) vs manual RRF primary

**Context:** Hybrid search merges `$search` (text) and `$vectorSearch` (vector) results. MongoDB 8.1+ provides `$rankFusion` as a native aggregate stage.

**Alternative A (chosen) — `$rankFusion` primary, manual RRF fallback:**
- Native MongoDB stage (MCP Finding #1: `mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search`).
- Built-in `scoreDetails.details[]` observability (per-pipeline rank, weight, value).
- Scoring formula `sum(weight * (1 / (60 + rank)))` with MongoDB-controlled constant 60.

**Alternative B — Manual RRF primary:**
- Keep existing capability fallback as the primary; skip `$rankFusion`.
- Benefit: works on MongoDB < 8.1.
- Drawback: no native `scoreDetails.details[]` observability; double-normalization risk with query decomposition's own RRF (MCP Finding #1 indirectly; we'd have to audit this ourselves); slower evolution vs MongoDB server-side path.

**Decision:** Alternative A. Locked in design Approved Decision #4.

**Consequences:**
- Positive: native observability; consistent rank-fusion constant; future `weights` tuning surface.
- Negative: pins us to MongoDB 8.1+; atlas-local:preview validates this in Gate 1 capability smoke.
- Retains manual-RRF as the capability fallback — product still works on earlier MongoDB.

### ADR-004: `$rankFusion` latency acceptance (chosen: keep primary despite 2× latency — user-confirmed, pass-3 C1)

**Context:** MongoDB's `$rankFusion` executes sub-pipelines **serially, not in parallel**. The MCP knowledge-base confirms this (cite: `mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search`). In Memongo's hybrid recall (text + vector), this roughly doubles end-to-end retrieval latency vs running both pipelines concurrently at the application layer and merging in memory.

**Alternative A (chosen) — keep `$rankFusion` primary, document and measure the 2× cost:**
- Native server-side execution; `scoreDetails.details[]` observability remains.
- User explicitly accepted the trade-off during pass-3 review: the observability, future `weights` tuning surface, and alignment with MongoDB's native pattern outweigh the latency cost for our benchmark-first posture.
- **Mandatory instrumentation:** every Phase-3/4/5 canary artifact MUST publish `latency.p50Ms` and `latency.p95Ms` via the Task-1.A envelope so reviewers can see the cost was accepted knowingly, not hidden.

**Alternative B — replace with app-layer parallel merge:**
- ~50% latency reduction at cost of losing server-side `scoreDetails` and future `$rankFusion` tuning levers.
- Rejected: re-introduces double-normalization risk vs query-decomposition's own RRF (MCP Finding #1 explicitly warns); harms future MongoDB-substrate alignment (ADR-005 secret-weapon thesis).

**Decision:** Alternative A. User-confirmed pass-3.

**Consequences:**
- Positive: observability kept; substrate alignment; future parallel-execution server-side improvement (if MongoDB ships it) benefits us automatically.
- Negative: p95 latency inflated ~2× vs app-layer parallel merge; explicit row in Gate-5 benchmark matrix so this is public.
- Mitigation: Gate-5 benchmark-matrix adds a labeled "latency honesty" cell; README's `Benchmark corrections and caveats` section (pass-3 B5) reserves space to note this trade-off.

### ADR-005: MongoDB 8.3+ floor and "secret weapon" thesis (chosen: pin target to 8.3+ — user-confirmed, pass-3 F1 + F2)

**Context:** User's strategic guidance: "MongoDB is our secret weapon. If we control 8.3+ capabilities we're in for sure." Meanwhile, Anthropic shipped Dreaming (May 6 2026) and MongoDB shipped LangGraph.js Long-Term Memory Store (May 7 2026) — MongoDB-native memory is now an official LangChain pattern. MongoDB.local London (May 6-7 2026) announced Automated Voyage AI Embeddings GA. 8.2+ shipped `$scoreFusion`. 8.3 has further search-node improvements and quantization work.

**Alternative A (chosen) — target MongoDB 8.3+, survey 8.1/8.2/8.3 release notes and adopt high-value capabilities:**
- New Phase 0 Task 0.6 produces `docs/benchmarks/mongodb-83-capability-survey.md` listing: (a) features we already use, (b) features we don't use but could, (c) gaps where we could win if we adopt.
- Survey runs via `mcp__plugin_mongodb_mongodb__search-knowledge` across MongoDB 8.1, 8.2, 8.3 release notes, new Atlas Search operators, Automated Voyage Embeddings GA.
- Survey outputs a ranked list of proposed 8.3+-dependent features. If ≥3 capabilities surface as high-value-and-missing, each becomes an Open Decision pending user sign-off before Gate 5.

**Alternative B — stay at 8.1+ (prior plan):**
- Broader MongoDB compatibility.
- Rejected: contradicts the user's secret-weapon thesis; forfeits features like `$scoreFusion` (8.2+) and Automated Voyage Embeddings GA that could move Memongo ahead structurally.

**Decision:** Alternative A. User-confirmed pass-3.

**Consequences:**
- Positive: capability lead over commoditized MongoDB-as-memory-substrate (MongoDB shipped their own LangGraph.js store May 7); differentiation stays real.
- Negative: narrower MongoDB version surface; users on 8.0 or earlier fall back to manual-RRF capability path (already supported).
- Risk: `atlas-local:preview` tag may not track 8.3 today. Phase 0 Task 0.6 Step 0 verifies this; if 8.3 is not reachable from `preview`, the atlas-local-preview-8.3 availability decision surfaces as a blocking Open Decision (Open Decision #3 above).

### ADR-006: Scope expansion — 4 user-approved features (chosen: add — pass-3 E3, E4, E5, E6)

**Context:** Agent 4 (market/positioning) research surfaced four capability gaps that user approved as scope additions:
- **Bi-temporal memories (`validAt`/`invalidAt`)** — Zep leads by 15 points on temporal queries because of bi-temporal modeling. Without it, Memongo loses the temporal-reasoning lane structurally. Pass-3 E3.
- **Human review/promotion gate (`pending → canonical`)** — Fountain City flagged: "None of the systems natively implement step 4 — deciding what to promote from pending to canonical." A required-user-action gate before consolidation commits, with a web-console review queue view. Pass-3 E4.
- **Memory-poisoning / prompt-injection defense** — Anthropic flagged this themselves alongside the Dreaming launch. Verifier filters at consolidation write time: classifier detects injection-shaped content, quarantines it, requires human review. Pass-3 E5.
- **Exportable-memory guarantee** — Cloudflare's differentiator; trivial for us since we're self-host. `POST /v1/export/{agentId}` returns a signed JSON bundle of all memories scoped to that agent. Pass-3 E6.

**Alternative A (chosen) — add all four as first-class capabilities with 4-layer evidence:**
- Bi-temporal lands in Scope 2 (retrieval): adds `validAt`/`invalidAt` to event/episode schema in `packages/memory-engine/src/mongodb-schema.ts`; retrieval filters by temporal validity; correctness invariant "no retrieval returns a memory where `invalidAt < queryTime`".
- Review gate lands under a new **Scope 7 (web-console review UI)** OR augments Scope 6 — planner decides at Phase 0 based on partition-table review; current recommendation is Scope 7 given the UI surface weight.
- Poisoning defense lands in Scope 2 (consolidation write path) with classifier + quarantine collection; correctness invariant "every memory whose content matches injection patterns is quarantined before consolidation, not stored in canonical".
- Export lands in Scope 4 (API): new `POST /v1/export/{agentId}` + signed-bundle guarantee; correctness invariant "signed bundle is byte-identical across two exports at the same scopeRef with no intervening writes".

**Alternative B — ship minimal; add in a v2:**
- Less scope; faster to ship.
- Rejected: bi-temporal is a structural loss; poisoning defense is a safety concern Anthropic explicitly raised; review gate is the one place every competitor skips and every serious customer will demand; export is trivial for self-host. User approved ship-now.

**Decision:** Alternative A. User-confirmed pass-3.

**Consequences:**
- Positive: four differentiators land at v1; provable-properties list extends with 4 new invariants (see updated Critical-Path Verification Design); positioning keeps substance despite Dreaming / LangGraph.js commoditization.
- Negative: Scope 6 / 7 partition requires one-time re-allocation decision at Phase 0 Task 0.3 review; Scope 2 grows by ~3 files; Scope 4 grows by 1 route.
- Implementation detail in **Scope Expansion Appendix** near the end of this plan.

### ADR-007: Gate 5 adds Phase-2 E2E QA lane with named judge (chosen: ship with Sonnet 4.6 or GPT-5.5 — user-confirmed, pass-3 B2)

**Context:** Community expectation (Vectorize, r/AIMemory, arxiv 2510.27246 BEAM, OpenReview DT7JyQC3MR MemoryAgentBench) is that LongMemEval-S retrieval-only is insufficient as a sole lane. Competitor numbers are cited with E2E QA: Mastra 94.87%, Letta 83.2%, Zep 63.8%, Mem0 49.0%. Meanwhile, PenfieldLabs measured 63% FP rate on vague wrong answers with GPT-4o judge — the judge model choice matters and must be named, not elided.

**Alternative A (chosen) — keep retrieval-only as Gate 3/Gate 4 first lane; add E2E QA with named judge at Gate 5:**
- Judge: **Sonnet 4.6 primary, GPT-5.5 fallback** (record the actual judge per run; both are named in the artifact).
- Gate 5 exit criterion extended: requires BOTH retrieval metrics AND E2E QA metrics before any comparative claim.
- New task under Gate 5 capability audit: adversarial judge probe. Generate intentionally-wrong-but-topical answers; report judge's false-positive rate. This becomes a Memongo-signature metric no competitor publishes (pass-3 B3).

**Alternative B — retrieval-only only:**
- Cheaper; matches design's original lane.
- Rejected: community consensus says retrieval-only is a contextualization, not memory-architecture, test; LongMemEval-S fits in 200K context.

**Decision:** Alternative A. User-confirmed pass-3.

**Consequences:**
- Positive: apples-to-apples vs Mastra/Letta/Zep/Mem0 cited baselines; adversarial judge probe is a novel honesty metric.
- Negative: Gate 5 Voyage + Sonnet cost increases (budget documented in Drawbacks); judge FP rate reveals judge-tuning issues publicly (this is the point).

### ADR-008: Agent Invocation Contract (chosen: MANDATORY MongoDB skills + MCP for every future agent — user-directive, pass-3 F3)

**Context:** User directive: "When in doubt about what MongoDB can do, consult the knowledge base before writing code." Across prior workflows, some subagents skipped MongoDB MCP knowledge-base checks and picked sub-optimal patterns (e.g., application-side sort instead of index push-down).

**Alternative A (chosen) — codify as a plan-wide invariant:** Every agent spawned by this plan MUST include the 4 MongoDB skills + 1 MCP tool in its prompt, MUST cite MCP knowledge URLs in its output, and is failed by reviewer if it does not. See the `Agent Invocation Contract` section near the top of this plan.

**Alternative B — trust agents to discover the knowledge base themselves:**
- Less prompt boilerplate.
- Rejected: demonstrably fails in practice; MongoDB is our declared secret weapon and cannot be left to chance.

**Decision:** Alternative A. User-directive pass-3.

**Consequences:**
- Positive: systematic use of MongoDB substrate; every decision is URL-citable; reviewer enforcement is trivial ("did the output cite an MCP URL?").
- Negative: longer BUILD-agent prompts; minor prompt-token cost is acceptable given substrate importance.

### Alternative C — Skip capability audit to reach benchmark faster

**Why viable on paper:** 4-layer audit on 6 capabilities is ~1 working session of labor.

**Why rejected:**
- Capability #4 (importance-decay guard) silently rotting important memories invalidates every benchmark claim; the design calls it out as a prime suspect.
- Capability #6 (Dreamer cross-scope merge) leaking between `scopeRef` is catastrophic for product integrity and could silently boost benchmark scores in a way we couldn't detect without the invariant test.
- Capability #3 (access-tracking batched-write loss) silently drops recency signal, which LongMemEval-S's session/time filters depend on.
- Publishing a benchmark win with an invalid capability is the exact dishonesty posture the plan forbids.

**Decision:** Not chosen. Gate 2 capability audit is required.

## Drawbacks

- **Rebase cost ~0.5 day** to partition file hunks across 6 scopes (ADR-001).
- **Phase 1 patch grows** by ~80 LOC for probe upgrade (ADR-002 trade-off).
- **Gate 1 blocks benchmarks** — no 8/type retry until Phase 1 green; cost is 1 session delay.
- **`$rankFusion` pins to MongoDB 8.1+** — single-tenant self-hosted users on older MongoDB fall back to manual RRF; they are explicitly not the benchmark target.
- **$rankFusion sub-pipelines run serially (pass-3 C1 / ADR-004)** — roughly 2× end-to-end retrieval latency vs app-layer parallel merge. User-confirmed trade-off for observability and substrate alignment; Gate-5 matrix publishes `latency.p50Ms` / `latency.p95Ms`.
- **MongoDB 8.3+ floor (ADR-005)** narrows supported substrate; manual-RRF fallback retained for earlier MongoDB. `atlas-local:preview` 8.3 availability is an Open Decision.
- **fast-check property tests add test-suite latency** — each capability adds ~500ms–2s; budgeted in Gate 2.
- **MemPalace may publish new numbers mid-plan** — policy is "don't chase; finish strict matrix first"; this means our launch copy may lag competitor claims by days.
- **LongMemEval-S 500-case full run is Voyage + Sonnet cost** — budget a few hundred dollars of API spend in Gate 5.
- **Gate 5 E2E QA + adversarial judge lane (ADR-007)** adds Sonnet 4.6 (or GPT-5.5) judge calls per case; judge-FP-rate probe adds further calls. Budget line item in Gate 5 cost.
- **4 scope-expansion features (ADR-006)** — bi-temporal, poisoning defense, review gate, export — add approximately 6 new files, 1 new collection, 3 new API routes, 3 new bridge methods, 1 new scope (Scope 7 for review UI). Delivery session budget grows.
- **Agent Invocation Contract (ADR-008)** adds ~200 prompt tokens per BUILD-agent invocation for the mandatory MongoDB skills + MCP boilerplate.
- **History rewrite in Gate 7 is irreversible** without the backup tag — required user confirmation gate.
- **"Dreamer" commoditization (pass-3 E1)** — Anthropic Dreaming shipped May 6 2026. Our reframing: "benchmark-validated consolidation with importance-decay + novelty surprisal". Keep `Dreamer` internally but do not lead with it in positioning.
- **MongoDB LangGraph.js store commoditizes the "MongoDB-native memory" pitch (pass-3 E2)** — reframe headline from "MongoDB-native memory framework" to "scoped, inspectable, durable agent memory built on MongoDB". MongoDB becomes the proof, not the hook.

## Critical-Path Verification Design

### Behavior Contract

**Benchmark harness (Phase 1):**
- Any strict-mode config break fails in under 5 minutes with a classified failure artifact under `artifacts/canary-runs/{run-id}/failure.json`.
- Per-scenario progress file appears at `artifacts/canary-runs/{run-id}/progress/{idx}.json` within 10 seconds of scenario completion.
- `$listSearchIndexes → status!=Ready` in strict mode raises before the scenario starts.
- Queue settle timeout fires with error message naming the offending queue (`writeQueue` or `derivationQueue`).

**Capability evidence (Phase 2):**
- Each capability's 4 layers present; artifact per capability in `docs/benchmarks/capability-audit/{slug}-evidence.md`.
- Every correctness invariant has a fast-check seed recorded.

**Benchmark run (Phase 3, Phase 4, Phase 5):**
- Gate 3: 6/6 scored, `missLedger=[]`, `any@1=1`.
- Gate 4: 48/48 scored OR classified failure at exact scenario inside 60 minutes.
- Gate 5: 500/500 scored with all parity fields in artifact.

### Edge-Case Catalog

- Voyage endpoint 500/429 mid-scenario → `model-failure` classification; abort; artifact names scenario index.
- Sonnet returns malformed JSON → `json-parse`; abort.
- `$search` index `Stale` → `index-not-ready`; abort before any scenario runs.
- MongoDB connection dropped mid-benchmark → `harness-timeout` OR `queue-settle-timeout`; abort.
- Dataset file missing or wrong SHA → fail at canary bootstrap, before any scenario.
- `scopeRef` in scenario input contains unexpected value → `scope-leak` if a result bleeds from another `scopeRef`.
- `numCandidates < limit × 20` → warning; not a hard fail.
- Resume run points to non-existent `progress/` directory → start fresh; no silent skip.
- Capability test flake under heavy MongoDB load → retry once with same seed; if still fails, mark capability evidence as "pending" and block Gate 2.
- `$rankFusion` returning `scoreDetails` with missing pipeline entry → warn; do not abort (observability only).

### Provable Properties

1. **Importance decay invariant:** For all memories with `temporalScope ∈ {"permanent", "ongoing"}`, `computeImportanceDecay(m, t) === m.importance` for every `t ≥ m.createdAt`. (fast-check seed fixed; ≥1000 cases per run.)
2. **Importance decay range:** For all memories and all `t`, `computeImportanceDecay(m, t) ∈ [0, 1]`. (Property test.)
3. **Importance decay monotonicity:** For any memory with no access events between `t1 < t2`, `computeImportanceDecay(m, t1) ≥ computeImportanceDecay(m, t2)`. (Property test.)
4. **Dreamer no-cross-scope merge:** For any set of source events across ≥2 distinct `scopeRef` values, `consolidate(events)` produces no consolidated memory whose `sourceEventIds` span more than one `scopeRef`. (Property test; invariant on the consolidator output.)
5. **Access-tracking monotonicity:** For any sequence of reads, `accessCount(memory_id, t)` never decreases in `t`. (Integration test with simulated shutdown mid-batch.)
6. **Scope-leak: retrieval isolation:** For any query with `(agentId, scope, scopeRef)` filter, no returned result has different `(agentId, scope, scopeRef)`. (Property test + integration test across all 6 capability APIs.)
7. **Harness fail-fast:** For any broken-config canary invocation, wall-clock time to `failure.json` write < 5 minutes. (Forced-failure integration test.)
8. **Reasoning-chain bounded depth:** For any chain traversal, depth never exceeds configured `maxDepth`; no infinite cycles. (Property test.)
9. **Novelty score bounds:** For all inputs, `surprisalScore ∈ [0, 1]`. (Property test.)
10. **$rankFusion constant:** `scoreDetails.details[].value = weight * (1 / (60 + rank))` within floating-point epsilon. (Integration test; confirms MCP Finding #1 contract.)
11. **Bi-temporal validity (pass-3 E3 / ADR-006):** For any retrieval at `queryTime = T`, no returned memory has `invalidAt < T`. (Property test + integration test at Task 2.SE-1.)
12. **Poisoning defense (pass-3 E5 / ADR-006):** Every memory whose content matches injection patterns is quarantined before consolidation — never stored in canonical. (Property test + integration test at Task 2.SE-2.)
13. **Human review gate (pass-3 E4 / ADR-006):** No memory moves from `pending` to `canonical` without an explicit approval event; approval event is audit-trailed. (Property test + integration test at Task 2.SE-3.)
14. **Export bundle determinism (pass-3 E6 / ADR-006):** Signed bundle is byte-identical across two exports at the same `scopeRef` with no intervening writes. (Property test at Task 2.SE-4.)

### Purity Boundary Map

- **Pure (deterministic, no I/O):** `computeImportanceDecay`, `surprisalScore`, `chainTraversal` math, `rankFusionMerge` (given pre-fetched input arrays), `queueSettleBudgeting`.
- **Impure (I/O, mutable state):** `settleBenchmarkScenarioManager`, `waitForBenchmarkEventSearchConvergence`, `recallConversation` (MongoDB queries), `consolidate` (writes), access-tracking batched writer, canary runner scenario loop.
- **Testing rule:** Pure functions get fast-check property tests. Impure functions get integration tests against atlas-local:preview. E2E smoke tests traverse the full API → engine → MongoDB path once per capability.

### Verification Strategy

| Layer | Tool | Scope | Examples |
|---|---|---|---|
| Unit | Vitest | pure function + small impure stubs | `mongodb-trust.test.ts::computeImportanceDecay` |
| Integration | Vitest + atlas-local:preview | real MongoDB, scoped test prefix | `mongodb-consolidator.test.ts::no cross-scope merge` |
| E2E | Vitest + API process + atlas-local:preview | full HTTP → engine → MongoDB | `POST /v1/consolidate` round-trip |
| Correctness invariant | fast-check | randomized properties with fixed seeds | decay monotonicity, scope isolation |
| Forced-failure | canary runner in deliberately broken mode | harness fail-fast under 5 min | `failure.json` write + classification |
| Benchmark canary | strict 1/type → 8/type → 500-full | LongMemEval-S retrieval-only | `artifacts/canary-runs/{gate}-{run-id}/` |

## Phase Dependency Map

- **Phase 0 (Gate 0):** depends on checkpoint commit + design file; creates forensic audit + 6 branch names + Recommended Defaults sign-off artifact (Task 0.5, pass-1 A4); enables Phase 1.
- **Bootstrap Sub-Sequence (B1–B5, pass-1 F2):** infrastructure precondition for every Phase 3 / 4 / 5 canary task. Writes `bootstrap.json` into the run dir. Failure blocks the downstream task without entering scenario loop.
- **Phase 1 (Gate 1):** depends on Phase 0 branches + Task 0.5 sign-off; Tasks 1.0 + 1.A BLOCK Tasks 1.1–1.10 (pass-1 F1 + F5); creates harness artifacts + forced-failure proof; enables Phase 2 and blocks Phase 3.
- **Phase 2 (Gate 2):** depends on Phase 1 green; creates capability-audit evidence + retrieval+docs scope merges (Scope #3 re-owns `silent-fallback-audit-2026-05-11.md` per pass-1 A3); enables Phase 3.
- **Phase 3 (Gate 3):** depends on Phase 2 green + Bootstrap Sub-Sequence green + `@memongo/api` healthy; creates strict 1/type canary artifact with Task-1.A parity fields; enables Phase 4.
- **Phase 4 (Gate 4):** depends on Phase 3 clean + Bootstrap Sub-Sequence green; creates strict 8/type canary artifact or classified failure (parity fields present); enables Phase 5 only if 48/48 scored.
- **Phase 5 (Gate 5):** depends on Phase 4 clean + Bootstrap Sub-Sequence green; creates full LongMemEval-S (parity fields) + MemPalace reproduction artifact (pass-1 F4 7-step sub-sequence) + api-security + Hermes scope merges; enables Phase 6.
- **Phase 6 (Gate 6):** depends on Phase 5 clean; creates launch-polish artifacts + web scope merge; enables Phase 7.
- **Phase 7 (Gate 7):** depends on Phase 6 clean + explicit user confirmation; creates cleaned history + backup tag.

---

## Bootstrap Sub-Sequence (mandatory before any canary run — pass-1 F2 response)

Every Phase 3 / Phase 4 / Phase 5 canary task lists this sub-sequence as an explicit precondition (`blockedBy`). The sequence must succeed end-to-end before the canary invokes `POST /v1/admin/relevance/benchmark`.

**B1. Tool + dataset availability check** (resolves advisory A6):
```bash
command -v mongosh >/dev/null 2>&1 || { echo "bootstrap: mongosh not found" >&2; exit 1; }
command -v docker  >/dev/null 2>&1 || { echo "bootstrap: docker not found"  >&2; exit 1; }
command -v bun     >/dev/null 2>&1 || { echo "bootstrap: bun not found"     >&2; exit 1; }
command -v curl    >/dev/null 2>&1 || { echo "bootstrap: curl not found"    >&2; exit 1; }
DATASET_PATH="${MEMONGO_CANARY_DATASET_PATH:-${MEMONGO_BENCHMARK_DATASET_PATH:-${MEMONGO_WORKSPACE_DIR:-$HOME/.memongo/workspace}/benchmarks/longmemeval_s_cleaned.json}}"
test -f "$DATASET_PATH" || { echo "bootstrap: dataset missing at $DATASET_PATH" >&2; exit 1; }
```
Expected exit: 0. Any non-zero aborts the gate.

**B2. Start atlas-local:preview MongoDB container:**
```bash
VOYAGE_API_KEY="${VOYAGE_API_KEY:-$MEMONGO_VOYAGE_API_KEY}" \
  docker compose -f docker/mongodb/docker-compose.benchmark.yml up -d
# Wait for MongoDB health
for i in {1..30}; do
  docker ps --filter "name=memongo-benchmark-preview" --filter "health=healthy" --format '{{.Names}}' | grep -q memongo-benchmark-preview && break
  sleep 2
done
docker ps --filter "name=memongo-benchmark-preview" --filter "health=healthy" --format '{{.Names}}' | grep -q memongo-benchmark-preview \
  || { echo "bootstrap: atlas-local:preview did not become healthy within 60s" >&2; exit 1; }
```

**B3. Start `@memongo/api` process:**

Run in a separate terminal OR as a backgrounded process with `nohup`/`bun run` in a dedicated pane. Required env:
```bash
export MEMONGO_LOG_LEVEL=warn
export MEMONGO_FORCE_MONGODB_URI='mongodb://127.0.0.1:27018/?directConnection=true'
export MEMONGO_MONGODB_COLLECTION_PREFIX="memongo_bench_$(date +%s)_"
export MEMONGO_API_PORT=3847       # MUST match canary default; canary reads MEMONGO_API_PORT
# Authentication note: if MEMONGO_API_KEY or MEMONGO_API_SCOPED_KEYS are set in the
# shell, the API will require Bearer auth on /v1/*. The current canary runner does
# NOT send a bearer token. Therefore, for benchmark runs, unset these before
# starting the API:
unset MEMONGO_API_KEY
unset MEMONGO_API_SCOPED_KEYS
# (Rationale: the benchmark runs against a localhost-only, single-tenant API;
# adding bearer-auth to the canary is a separate Scope #4 concern.)
bun --cwd apps/api run dev &
MEMONGO_API_PID=$!
```

**B4. Health-check the API** (uses the existing `GET /health` endpoint at `apps/api/src/app.ts:206` — pass-1 F2 response; NO new `/healthz` endpoint required):
```bash
for i in {1..30}; do
  curl -sS -f "http://127.0.0.1:${MEMONGO_API_PORT:-3847}/health" >/dev/null && break
  sleep 1
done
curl -sS -f "http://127.0.0.1:${MEMONGO_API_PORT:-3847}/health" >/dev/null \
  || { echo "bootstrap: API /health did not respond 200 within 30s" >&2; exit 1; }
```
Expected: a `200 OK` with body `{"ok":true,"service":"memongo-api"}`.

**B5. Record bootstrap identity** into the run artifact directory before canary starts:
```bash
RUN_DIR="${MEMONGO_CANARY_ARTIFACT_DIR:-artifacts/canary-runs/${GATE_LABEL}-$(date +%s)}"
mkdir -p "$RUN_DIR"
cat > "$RUN_DIR/bootstrap.json" <<JSON
{
  "dockerComposeFile": "docker/mongodb/docker-compose.benchmark.yml",
  "mongodbHealthy": true,
  "apiPort": ${MEMONGO_API_PORT:-3847},
  "apiHealthUrl": "http://127.0.0.1:${MEMONGO_API_PORT:-3847}/health",
  "apiHealthCheckedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "collectionPrefix": "${MEMONGO_MONGODB_COLLECTION_PREFIX}",
  "datasetPath": "${DATASET_PATH}",
  "datasetSha256": "$(shasum -a 256 "$DATASET_PATH" | awk '{print \$1}')"
}
JSON
```

**B5a. mongot replication lag check (pass-3 C2):**
Separate from index readiness, check mongot replication lag via `$listSearchIndexes` + time-since-last-oplog-entry. High lag during a benchmark run means recent writes are not yet indexed, which invalidates any "scored case" whose events were inserted within the lag window. Cite MongoDB MCP knowledge-base finding on mongot replication (consult `mcp__plugin_mongodb_mongodb__search-knowledge` with query `"mongot replication lag Atlas Search"` and record URL in `bootstrap.json`).
```bash
# Record mongot lag for the benchmark run's dataset collection.
# Note: mongosh JS runtime has no process.env; inject the prefix via shell substitution
# inside a double-quoted --eval so bash expands $MEMONGO_MONGODB_COLLECTION_PREFIX.
mongosh --port 27018 --quiet --eval "
  const coll = db.getSiblingDB('memongo')['${MEMONGO_MONGODB_COLLECTION_PREFIX}events'];
  const idx = coll.aggregate([{\$listSearchIndexes: {}}]).toArray()[0] || {};
  print(JSON.stringify({
    status: idx.status || 'DOES_NOT_EXIST',
    queryable: idx.queryable ?? false,
    mongotLagEstimateSec: idx.latestDefinition?.lastObservedReplicationLagSec ?? null,
  }));
" > "$RUN_DIR/mongot-lag.json"
# Guard against unset env — if $MEMONGO_MONGODB_COLLECTION_PREFIX is empty, the
# collection name collapses to 'events'; abort if Bootstrap did not export it.
: "${MEMONGO_MONGODB_COLLECTION_PREFIX:?Bootstrap did not export MEMONGO_MONGODB_COLLECTION_PREFIX — mongot-lag check would target the wrong collection}"
```
If `queryable === false` OR `status === "STALE"` OR `mongotLagEstimateSec > 30`, abort the gate with `failureClass: "index-not-ready"`.

**B6. Cleanup (post-gate):**
```bash
# drop run-prefixed collections
mongosh --port 27018 --quiet --eval '
  const db = db.getSiblingDB("memongo");
  const prefix = process.env.MEMONGO_MONGODB_COLLECTION_PREFIX;
  db.getCollectionInfos({name: new RegExp("^" + prefix)}).forEach(c => db[c.name].drop());
'
# stop API
kill "$MEMONGO_API_PID" 2>/dev/null || true
# (optional) stop MongoDB: docker compose -f docker/mongodb/docker-compose.benchmark.yml down
```

**Precondition rule:** Every Phase 3 / 4 / 5 canary task MUST list this sub-sequence as its immediate precondition and MUST verify `bootstrap.json` exists in the run dir before the canary's `postJson(...)` call. If any of B1–B4 fails, the canary does not start and the gate is marked failed with a `bootstrap-timeout` classification in `failure.json`.

---

## Phase 0 — Gate 0: Stop the Bleeding

> **Exit Criteria:** (a) `docs/benchmarks/mempalace-forensic-audit.md` exists and records every MemPalace methodology gap from the design. (b) 6 scope branches created off `checkpoint/pre-plan-2026-05-11`. (c) Every one of the 48 checkpoint files is assigned to exactly one scope in the partition table below. (d) No secrets in any staged set. (e) `git tag pre-merge-scope-1 pre-merge-scope-2 … pre-merge-scope-6` does NOT yet exist (created per-scope at merge time).

### Task 0.1: Create MemPalace forensic audit artifact

**Files:**
- Create: `docs/benchmarks/mempalace-forensic-audit.md` (commits to **`scope-3-docs-benchmarks`** per pass-3 A5 — prior revision committed to HEAD; partition-table row 14 assigns `docs/benchmarks/*` to Scope 3).

**Inputs:** design section "MemPalace Forensic Report (distilled from mempalace.net/benchmarks)" (lines 98–146 of the design file).

**Precondition:** Task 0.2 has created the 6 scope branches.

**Step 1:** Check out `scope-3-docs-benchmarks` before any file write:
```bash
git checkout scope-3-docs-benchmarks
```

**Step 2:** Copy the forensic sections into the new artifact — "Their claims", "Their disclosures", "Missing methodology table", "Asymmetries we will NOT replicate", "What we CAN legitimately claim once gates pass". Cite source URL `mempalace.net/benchmarks` at the top. Record capture date `2026-05-11`.

**Step 3:** The forensic-audit template MUST include a section named `"MemPalace self-documented asymmetries (pass-3 D1)"` that records: (a) MemPalace's own `benchmarks/longmemeval_bench.py:1339-1366` names three question IDs (`d6233ab6`, `4dfccbf8`, `ceb54acb`) as "the final 3 misses" that hybrid_v4 patches, (b) `BENCHMARKS.md:88-94` explicitly calls v4 "teaching to the test", (c) `v2/v3/v4` numbers cannot be cited without an explicit asterisk — they have self-documented test-set leakage — and (d) when reproducing, we enforce `--mode raw` OR a `held-out-450` split (see Task 5.2 Step 2).

**Step 4:** Commit on `scope-3-docs-benchmarks`.
```bash
git add docs/benchmarks/mempalace-forensic-audit.md
git commit -m "scope-3: add MemPalace forensic audit artifact for Gate 0"
```

**Expected:** file exists on `scope-3-docs-benchmarks`; commit appears on that branch. `git log scope-3 ^main --name-only` includes `docs/benchmarks/mempalace-forensic-audit.md`.

### Task 0.2: Create 6 scope branches (corrected per pass-3 A1)

**Files:** no file change; branch metadata only.

> **Pass-3 A1 correction.** The prior procedure created scope branches from `checkpoint/pre-plan-2026-05-11`, which is contaminated with all 48 changes; checking that out contaminates every scope branch with every file. The external reviewer suggested cherry-pick, but the correct fix for our partition shape is: **branch each scope from `main`, then selectively apply per-scope hunks via `git checkout checkpoint/pre-plan-2026-05-11 -- <files>` for clean-file scopes and `git add -p` for split files (Task 0.3 split protocol).** This guarantees `git log scope-N ^main` lists only Scope-N files.

**Step 1:** Update local `main` and create each scope branch from clean `main`:
```bash
git checkout main
git pull --ff-only
for scope in scope-1-harness-reliability scope-2-retrieval-ranking scope-3-docs-benchmarks scope-4-api-security scope-5-hermes-integration scope-6-web-misc; do
  git checkout -b "$scope" main
  git checkout main   # return to base before next scope
done
```

**Step 2:** For each scope, populate it with ONLY its files from the checkpoint (see Task 0.3 for the exact per-scope file lists and the hunk-split protocol for the 3 split files):
```bash
# Example for scope-3 (clean-file scope, no split files):
git checkout scope-3-docs-benchmarks
git checkout checkpoint/pre-plan-2026-05-11 -- README.md \
  docs/benchmarks/benchmark-matrix.md \
  docs/benchmarks/benchmark-operating-contract.md \
  docs/benchmarks/longmemeval-decision-log.md \
  docs/benchmarks/memongo-new-chat-handoff-2026-05-11.md \
  docs/platform/self-host.md \
  docs/reference/memory-config.md
git status   # verify only Scope-3 files staged
git commit -m "scope-3: docs/benchmarks positioning from checkpoint"
# (repeat per scope; scopes 1, 2, and the split files use the Task 0.3 `git add -p` protocol)
```

**Step 3:** For scopes 1 and 2 (which share split files `mongodb-manager.ts`, `mongodb-manager.test.ts`, `mongodb-benchmark-runner.ts`), apply Task 0.3's split protocol. For clean-file hunks within those scopes, use `git checkout checkpoint/pre-plan-2026-05-11 -- <clean-file-path>` as above.

**Expected:** `git branch --list 'scope-*' | wc -l` returns `6` (exit 0). `git log scope-N ^main --name-only` lists ONLY Scope-N files (verified per scope).

**Exit criteria (corrected — pass-3 A1):**
- `git branch --list 'scope-*' | wc -l` returns `6`.
- `git log scope-1-harness-reliability ^main --name-only | sort -u` lists ONLY the files assigned to Scope 1 in the Task 0.3 partition table (plus the Scope-1 hunks of the 3 split files).
- Same assertion holds for scopes 2, 3, 4, 5, 6 with their respective file lists.
- `git diff scope-1-harness-reliability..scope-2-retrieval-ranking -- packages/memory-engine/src/mongodb-manager.ts` is non-empty (proves the split-file partition actually separated hunks, not duplicated them).

### Task 0.3: File-to-scope partition (resolves Open Decision #1)

> **[CHECKPOINT]** Builder MUST confirm this file partition with the user before running `git checkout --patch` splits. If user has a different scope-assignment preference, resolve here, not later.

**Partition table — re-derived from `git show --name-only bd1f5ba691` on 2026-05-11.** 48 files, each assigned to exactly one scope (except the two split files, which appear in two). Builder must verify the real file set with `git show --name-only bd1f5ba691 --format=''` before `git add -p` runs. **Pass-1 F3 response:** phantom `mongodb-analytics.*` entries from the prior revision have been removed; this table now reflects the 48 files actually in the checkpoint.

| # | File | Scope | Split via `git add -p`? | Rationale |
|---|---|---|---|---|
| 1 | `.gitignore` | 6 | no | Tooling housekeeping |
| 2 | `README.md` | 3 | no | Docs/benchmarks positioning |
| 3 | `apps/api/src/app.test.ts` | 4 | no | API security/validation tests |
| 4 | `apps/api/src/app.ts` | 4 | no | API auth/validation surface |
| 5 | `apps/api/src/openapi-spec.ts` | 4 | no | API contract |
| 6 | `apps/api/src/routes/v1.ts` | 4 | no | API route validation |
| 7 | `apps/mcp/src/server.test.ts` | 6 | no | MCP misc |
| 8 | `apps/mcp/src/server.ts` | 6 | no | MCP misc |
| 9 | `apps/web/app/page.tsx` | 6 | no | Web console |
| 10 | `docker/mongodb/docker-compose.benchmark.yml` | 1 | no | Harness infra (bootstrap sub-sequence) |
| 11 | `docs/benchmarks/benchmark-matrix.md` | 3 | no | Docs |
| 12 | `docs/benchmarks/benchmark-operating-contract.md` | 3 | no | Docs (envelope contract) |
| 13 | `docs/benchmarks/longmemeval-decision-log.md` | 3 | no | Docs |
| 14 | `docs/benchmarks/memongo-new-chat-handoff-2026-05-11.md` | 3 | no | Docs |
| 15 | `docs/platform/hermes-provider.md` | 5 | no | Hermes |
| 16 | `docs/platform/self-host.md` | 3 | no | Docs (self-host) |
| 17 | `docs/reference/memory-config.md` | 3 | no | Docs |
| 18 | `integrations/hermes/memongo/README.md` | 5 | no | Hermes |
| 19 | `integrations/hermes/memongo/__init__.py` | 5 | no | Hermes |
| 20 | `integrations/hermes/memongo/cli.py` | 5 | no | Hermes |
| 21 | `integrations/hermes/memongo/plugin.yaml` | 5 | no | Hermes |
| 22 | `integrations/hermes/memongo/test_memongo_provider.py` | 5 | no | Hermes |
| 23 | `packages/client/src/client.ts` | 6 | no | Client polish |
| 24 | `packages/client/src/types.ts` | 6 | no | Client polish |
| 25 | `packages/memory-bridge/src/memongo-bridge.ts` | 4 | no | Bridge/config touches validation |
| 26 | `packages/memory-bridge/src/memory-config.test.ts` | 4 | no | Bridge/config |
| 27 | `packages/memory-bridge/src/memory-config.ts` | 4 | no | Bridge/config |
| 28 | `packages/memory-engine/src/mongodb-benchmark-runner.test.ts` | 1 | no | Harness |
| 29 | `packages/memory-engine/src/mongodb-benchmark-runner.ts` | 1 + 2 (split) | **YES — see split protocol below** | Harness envelope changes → Scope 1; any retrieval-scoring / report-shape changes unrelated to harness observability → Scope 2 |
| 30 | `packages/memory-engine/src/mongodb-llm-enrichment.test.ts` | 2 | no | Retrieval (LLM enrich) |
| 31 | `packages/memory-engine/src/mongodb-llm-enrichment.ts` | 2 | no | Retrieval (LLM enrich) |
| 32 | `packages/memory-engine/src/mongodb-manager.test.ts` | 1 + 2 (split) | **YES** | Harness queue/probe tests → Scope 1; preference-boost tests → Scope 2 |
| 33 | `packages/memory-engine/src/mongodb-manager.ts` | 1 + 2 (split) | **YES** | `:3422`, `:3473` + other harness hunks → Scope 1; preference-evidence boost → Scope 2 |
| 34 | `packages/memory-engine/src/mongodb-query-decomposition.test.ts` | 2 | no | Retrieval |
| 35 | `packages/memory-engine/src/mongodb-query-decomposition.ts` | 2 | no | Retrieval |
| 36 | `packages/memory-engine/src/mongodb-relevance.ts` | 2 | no | Retrieval |
| 37 | `packages/memory-engine/src/mongodb-reranker.ts` | 2 | no | Retrieval rerank |
| 38 | `packages/memory-engine/src/mongodb-retrieval-planner.test.ts` | 2 | no | Retrieval |
| 39 | `packages/memory-engine/src/mongodb-retrieval-planner.ts` | 2 | no | Retrieval |
| 40 | `packages/memory-engine/src/mongodb-schema.test.ts` | 2 | no | Schema supports retrieval |
| 41 | `packages/memory-engine/src/mongodb-schema.ts` | 2 | no | Schema supports retrieval |
| 42 | `packages/memory-engine/src/mongodb-search-executor.ts` | 2 | no | Retrieval |
| 43 | `packages/memory-engine/src/mongodb-search.test.ts` | 2 | no | Retrieval |
| 44 | `packages/memory-engine/src/mongodb-search.ts` | 2 | no | Retrieval |
| 45 | `packages/memory-engine/src/types.ts` | 2 | no | Retrieval types |
| 46 | `packages/tools/src/index.ts` | 2 | no | Tool surface re-export of retrieval |
| 47 | `scripts/run-longmemeval-canary.test.ts` | 1 | no | Harness |
| 48 | `scripts/run-longmemeval-canary.ts` | 1 | no | Harness |

**Invariant:** 48 rows, every file in the `git show --name-only bd1f5ba691` output is in this table exactly once. If a re-derivation finds a mismatch, abort Phase 0 and regenerate the table; do NOT guess.

**Split-file protocol** (3 files marked **YES** above):
- `packages/memory-engine/src/mongodb-manager.ts` and `packages/memory-engine/src/mongodb-manager.test.ts` — use `git add -p` from `checkpoint/pre-plan-2026-05-11` → Scope 1 gets the hunks in `settleBenchmarkScenarioManager` (`:3422`+), `waitForBenchmarkEventSearchConvergence` (`:3473`+), and any other harness-observability hunks; Scope 2 gets the preference-evidence-boost hunks and any other retrieval-ranking hunks.
- `packages/memory-engine/src/mongodb-benchmark-runner.ts` — Scope 1 gets the artifact-envelope parity hunks (the Task 1.A upgrade; see below) and any harness/progress-related hunks; Scope 2 gets any retrieval-scoring hunks that are not harness-observability.
- Post-split verification: `git diff scope-1-harness-reliability..scope-2-retrieval-ranking -- <file>` returns a non-empty diff for each of the 3 split files. If diff is empty for any, the split is wrong; redo.

**Checkpoint type:** `human_verify` — builder confirms partition with user before proceeding.

**Exit criteria:**
- Every file in the checkpoint appears in exactly one scope (except the two split files which appear in two).
- `git log scope-1-harness-reliability ^main --name-only` lists only Scope 1 files.
- Repeat for Scopes 2–6.

### Task 0.5: Recommended Defaults sign-off checkpoint (resolves advisory A4)

> **[CHECKPOINT — human_verify]** Builder MUST obtain explicit user sign-off on the 3 Recommended Defaults before Phase 2 starts. Without sign-off, Task 2.R2 produces a proposal doc only (no code change) and the failure-classification taxonomy and probe-timing default stay in proposal form.

**Defaults requiring sign-off:**
1. `numCandidates` table by top-k: `5→200, 10→200, 20→400, 30→600`.
2. Failure-classification taxonomy: 9-class enum (refinement of the design's 7-class list).
3. Readiness probe upgrade timing: Gate 1 (not Gate 2).

**Step 1:** Builder presents the 3 defaults to user with rationale from `Recommended Defaults` section of this plan.

**Step 2:** User responds: approve all, approve some, or reject.

**Step 3:** Builder records the outcome in `docs/benchmarks/recommended-defaults-signoff-2026-05-11.md` with user's decision per item and timestamp. This doc lands on Scope #3 at Phase 2.

**Effect per outcome:**
- **All approved:** Tasks 1.4 (taxonomy), 1.5 (probe upgrade at Gate 1), and 2.R2 (numCandidates table in code) proceed as written.
- **Partial approval:** approved items proceed; rejected items downgrade to proposal-only doc artifacts; plan does NOT apply them in code.
- **All rejected:** Task 1.5 uses hardened aggregate probe only; Task 1.4 uses the design's original 7-class taxonomy; Task 2.R2 produces `docs/benchmarks/numcandidates-proposal-2026-05-11.md` only.

**Exit criterion:** `docs/benchmarks/recommended-defaults-signoff-2026-05-11.md` exists and is signed with user-confirmed decisions. Commit to Scope #3.

### Task 0.6: MongoDB 8.3+ capability survey (pass-3 F1 — "our secret weapon")

> **[CHECKPOINT — decision]** User directive: "MongoDB is our secret weapon. If we control 8.3+ capabilities we're in for sure." This task runs in parallel with Task 0.5 and produces the survey artifact plus flags any missing 8.3+ capabilities as new Open Decisions.

**Files:**
- Create: `docs/benchmarks/mongodb-83-capability-survey.md` (commits to **`scope-3-docs-benchmarks`**).

**Precondition:** Task 0.2 has created the 6 scope branches.

**Step 0 — `atlas-local:preview` tag version check (resolves part of Open Decision #3):**
```bash
docker compose -f docker/mongodb/docker-compose.benchmark.yml up -d
for i in {1..30}; do
  docker exec memongo-benchmark-preview mongosh --quiet --eval 'db.version()' 2>/dev/null && break
  sleep 2
done
docker exec memongo-benchmark-preview mongosh --quiet --eval 'print(db.version())' > /tmp/mongodb-preview-version.txt
cat /tmp/mongodb-preview-version.txt
# If 8.3.x: proceed.
# If 8.2.x or 8.1.x: surface Open Decision #3 to user — wait for 8.3 preview OR pin 8.2+ with 8.3+ roadmap.
```

**Step 1 — Survey via MongoDB MCP knowledge-base:**
Invoke `mcp__plugin_mongodb_mongodb__search-knowledge` for each of:
- `"MongoDB 8.1 release notes"` — capture new server-side features.
- `"MongoDB 8.2 release notes"` — capture `$scoreFusion` availability and any new Atlas Search operators.
- `"MongoDB 8.3 release notes"` — capture search-node improvements, quantization work, any new index operators.
- `"Atlas Search new operators 2026"` — capture any operator beyond `$search`, `$vectorSearch`, `$rankFusion`, `$scoreFusion`.
- `"Automated Voyage AI Embeddings GA"` — capture the MongoDB.local London announcement from May 2026.
- `"MongoDB Atlas vector quantization 2026"` — capture binary / int8 / float32 trade-offs.
- `"$scoreFusion vs $rankFusion"` — understand where `$scoreFusion` might replace `$rankFusion` for non-RRF fusion semantics.

Record every returned URL and a one-line summary in the survey artifact.

**Step 2 — Structured output.** The survey artifact MUST include, in order:
1. **Features we already use** (bullet list, with file references from `packages/memory-engine/src/mongodb-*.ts`).
2. **Features we DON'T use but could** (each bullet: feature name, MCP URL, estimated lift, substrate dependency e.g. "requires 8.2+", "requires automated Voyage index"). At minimum enumerate: `$scoreFusion` (8.2+), Automated Voyage AI Embeddings GA, any new Atlas Search operators discovered at Step 1, quantization improvements in 8.3, search-node improvements in 8.3.
3. **Gaps where we could win if we adopt** (ranked by product value: retrieval quality, latency, cost, operational simplicity).
4. **Ranked proposal list of 8.3+-dependent features** (top-5, each with: feature, expected lift, implementation phase, risk).
5. **Open-decision flag count:** if ≥ 3 items in section 2 are high-value-and-missing (per user sign-off), escalate each as a new Open Decision (Open Decision #2 above links here).

**Step 3 — Surface flagged items to user.**
If Step 2's flagged count ≥ 3, the planner MUST surface them to the user as Open Decisions before Gate 5. A BUILD workflow cannot silently ship without user sign-off on flagged items. Use the Open Decisions list in this plan and block the router from advancing Phase 5 otherwise.

**Step 4 — Commit on `scope-3-docs-benchmarks`:**
```bash
git checkout scope-3-docs-benchmarks
git add docs/benchmarks/mongodb-83-capability-survey.md
git commit -m "scope-3: MongoDB 8.3+ capability survey for Gate 0"
```

**Exit criteria:**
- Survey artifact exists with sections 1–5.
- MongoDB version string from Step 0 is recorded in the artifact header.
- If ≥ 3 flagged items, each is appended to the Open Decisions list at the top of this plan for user sign-off.
- If ≤ 2 flagged items, Open Decision #2 collapses to "none surfaced" in the updated plan revision.

**Checkpoint type:** `decision` — user reviews the survey output and (if flagged items exist) signs off before Gate 5 can close.

### Task 0.4: Secret scan

**Files:** no change.

**Step 1:** Run:
```bash
git log --all --full-history -p -- '**/*.env*' '**/credentials*' '**/*.key' 2>&1 | head -50
grep -rE "(MEMONGO_MONGODB_URI|MEMONGO_API_KEY|VOYAGE_API_KEY|ANTHROPIC_API_KEY)=[^$]" --exclude-dir=node_modules --exclude-dir=.git . | grep -v 'example\|\.md\|docs/'
```

**Expected:** no hits with live values (exit 1 = no match = pass).

**Failure response:** if hit, abort Phase 0; rotate secret; rewrite with `git filter-repo` on the offending branch; redo partition.

### Task 0.7: Held-out private LongMemEval-S split (pass-3 B4)

> Hygiene item mirroring MindStudio benchmark-gaming recommendation. Memongo maintains a private held-out LongMemEval-S split (never pushed to public repo) to detect any tuning-to-test-set drift.

**Files:**
- Create: `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_heldout.json` (outside repo; NOT committed).
- Create: `docs/benchmarks/heldout-split-protocol.md` on `scope-3-docs-benchmarks` — documents split methodology WITHOUT revealing which question IDs are held out.

**Step 1:** Select ~50 question IDs from `longmemeval_s_cleaned.json` at random (fixed seed recorded only in the private artifact, not in the repo doc). Copy those cases into the held-out JSON. The remaining ~450 become the public split.

**Step 2:** The held-out JSON stays in the user's `~/.memongo/workspace/benchmarks/` directory — **outside the repository tree**. No `.gitignore` entry is required (git does not track paths outside the working tree). Record SHA-256 of the held-out file privately for drift detection. (Pass-3 plan-gap-review advisory: earlier revision claimed a `.gitignore` entry; corrected — `.gitignore` is owned by Scope 6 partition row 1 and cannot ignore out-of-tree paths anyway.)

**Step 3:** The public `docs/benchmarks/heldout-split-protocol.md` documents: selection methodology (random with fixed seed recorded privately), held-out count (~50), public split count (~450), invariant "Memongo will never publish scores on the held-out split". No question IDs are listed in the public doc.

**Step 4:** Gate 3/4/5 canary runs the public split (~450 cases). Gate 5 additionally runs the held-out split internally for drift check; if held-out R@5 diverges from public R@5 by > 5 points, flag potential overfit and block Gate 5 exit.

**Exit criterion:** Private held-out file exists locally at `$MEMONGO_WORKSPACE_DIR/benchmarks/longmemeval_s_heldout.json` (outside repo tree, not tracked); public protocol doc exists on `scope-3-docs-benchmarks`; SHA-256 of the held-out file recorded privately.

### Phase 0 Artifacts

- `docs/benchmarks/mempalace-forensic-audit.md` (on `scope-3-docs-benchmarks`)
- `docs/benchmarks/mongodb-83-capability-survey.md` (on `scope-3-docs-benchmarks`) — pass-3 F1
- `docs/benchmarks/heldout-split-protocol.md` (on `scope-3-docs-benchmarks`) — pass-3 B4
- 6 scope branch refs visible in `git branch --list 'scope-*'`
- Partition table above (committed to this plan)

### Phase 0 Failure Response

- Cannot confidently assign a file → open-decision gate to user; do not guess.
- Branch creation fails → verify `checkpoint/pre-plan-2026-05-11` exists; recreate from commit `bd1f5ba691` if tag is missing.

---

## Phase 1 — Gate 1: Harness Reliability

> **Exit Criteria:** (a) Tasks 1.0 and 1.A land BEFORE any other Phase 1 task (pass-1 F1 + F5). (b) All 8 harness checklist items resolved (see task table below). (c) Bootstrap Sub-Sequence (B1–B5) verified end-to-end at least once (pass-1 F2). (d) `bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts packages/memory-engine/src/mongodb-benchmark-runner.test.ts packages/memory-engine/src/mongodb-benchmark-readiness.test.ts scripts/run-longmemeval-canary.test.ts` exits 0. (e) Forced-failure canary run writes `$MEMONGO_CANARY_ARTIFACT_DIR/failure.json` with `failureClass` set, under 5 minutes wall-clock; `bootstrap.json` and `benchmark-response.json.benchmarkReport` (if any scenario started) contain Task-1.A parity fields. (f) Scope #1 branch lands on `main` via PR with `pre-merge-scope-1` tag.

**Scope merged in this phase:** Scope #1 (harness reliability).

**Task ordering invariant:** **Task 1.-1 (fast-check install)**, **Task 1.0 (env-var CLI contract)**, and **Task 1.A (envelope parity upgrade)** MUST complete and pass tests BEFORE any of Tasks 1.1–1.10 runs. These three tasks block every other Phase 1 task. The forced-failure canary in Task 1.9 and every Phase 3 / 4 / 5 canary invocation depends on Tasks 1.-1, 1.0, and 1.A landing. Task 1.-1 ALSO blocks every Phase 2 capability property test (6 capabilities × ≥1 property test each) and the 4 new provable-properties tests added by ADR-006.

### Task 1.-1: Install fast-check dependency (pass-3 A3 — "Phase 1 Bootstrap: install test dependencies")

> **Pass-3 A3 response.** The plan references `fast-check` in 10+ capability property tests but it is NOT in `package.json` (verified: only `@biomejs/biome`, `turbo`, `typescript` are devDependencies at `package.json:33-37`). This task installs it on `scope-1-harness-reliability` so every Phase 2 capability property test can import it. BLOCKS all Phase 2 capability property tests and all 4 new ADR-006 provable-properties tests.

**Files:**
- Modify: `package.json` (add `fast-check` to root `devDependencies`).
- Modify: `bun.lock` (auto-updated by `bun add -D`).

**Precondition:** Task 0.2 has created `scope-1-harness-reliability`.

**Step 1:** Check out `scope-1-harness-reliability` and add the dependency:
```bash
git checkout scope-1-harness-reliability
bun add -D fast-check
```
Expected: `package.json` gets a new `fast-check` entry under `devDependencies`; `bun.lock` is updated.

**Step 2:** Verify install worked:
```bash
bunx fast-check --help
```
Expected: exit 0 with help text.

**Step 3:** Write a smoke test to prove the dependency is importable from the test layer:
```typescript
// packages/memory-engine/src/fast-check-smoke.test.ts (temporary smoke test; removed before Gate 2 exit)
import fc from "fast-check"
test("fast-check is importable and runnable", () => {
  fc.assert(fc.property(fc.integer(), (n) => n + 0 === n), { numRuns: 10 })
})
```

**Step 4:** Run the smoke test:
```bash
bunx vitest run packages/memory-engine/src/fast-check-smoke.test.ts
```
Expected: PASS, exit 0.

**Step 5:** Commit on `scope-1-harness-reliability`:
```bash
git add package.json bun.lock packages/memory-engine/src/fast-check-smoke.test.ts
git commit -m "scope-1: install fast-check for property tests (pass-3 A3)"
```

**Step 6:** Remove the smoke test after Phase 2 property tests are wired:
```bash
rm packages/memory-engine/src/fast-check-smoke.test.ts
git commit -am "scope-1: remove fast-check smoke test after Phase 2 wiring"
```

**Exit criterion:** `bunx vitest run` finds `fast-check` as an importable module; `package.json` shows `"fast-check"` under `devDependencies`; `bun.lock` is updated. This BLOCKS every Phase 2 capability property test.

### Task 1.0: Canary env-var contract for artifact directory, full-dataset, and resume (resolves pass-1 F1)

> **Pass-1 F1 response.** The prior plan referenced `--artifact-dir`, `--full`, `--resume` CLI flags that `scripts/run-longmemeval-canary.ts` does not parse today. Selected alternative: adopt env-var parsing (smaller patch surface; already matches the script's existing `MEMONGO_CANARY_*` contract). No CLI parser dependency is introduced.

**Files:**
- Modify: `scripts/run-longmemeval-canary.ts` (top-of-file env bootstrap near lines 55–95: read `MEMONGO_CANARY_ARTIFACT_DIR`, `MEMONGO_CANARY_FULL`, `MEMONGO_CANARY_RESUME`; replace the hard-coded `artifactRoot` computation at `scripts/run-longmemeval-canary.ts:70-79` with env-override-then-default).
- Modify: `scripts/run-longmemeval-canary.test.ts`.

**New env-var semantics:**

| Env var | Default | Effect |
|---|---|---|
| `MEMONGO_CANARY_ARTIFACT_DIR` | (fallback: the current `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/` root + `$runId`) | Overrides the artifact root. If set, the run writes to exactly this directory (runId is NOT appended). |
| `MEMONGO_CANARY_FULL` | `0` | `1` = ignore `MEMONGO_CANARY_CASES_PER_TYPE` and `MEMONGO_CANARY_TOTAL_CASES`; run full dataset (all scenarios). |
| `MEMONGO_CANARY_RESUME` | `0` | `1` = skip scenario indices that already have a `progress/{idx}.json` file in the artifact dir. |

**Step 1:** Write failing tests in `scripts/run-longmemeval-canary.test.ts`:
```typescript
import { resolveCanaryArtifactDir, resolveCanaryFullMode, resolveCanaryResumeMode } from "./run-longmemeval-canary"

test("MEMONGO_CANARY_ARTIFACT_DIR overrides the default artifact root exactly", () => {
  expect(resolveCanaryArtifactDir({ runId: "abc", envDir: "/tmp/foo" })).toBe("/tmp/foo")
})

test("MEMONGO_CANARY_ARTIFACT_DIR absent falls back to default root + runId", () => {
  const out = resolveCanaryArtifactDir({ runId: "abc", envDir: undefined, repoRoot: "/repo" })
  expect(out).toMatch(/\.claude\/cc10x\/v10\/workflows\/memongo-memory-hardening\/artifacts\/canary-runs\/abc$/)
})

test("MEMONGO_CANARY_FULL=1 enables full mode; anything else is false", () => {
  expect(resolveCanaryFullMode("1")).toBe(true)
  expect(resolveCanaryFullMode("0")).toBe(false)
  expect(resolveCanaryFullMode(undefined)).toBe(false)
  expect(resolveCanaryFullMode("true")).toBe(false)
})

test("MEMONGO_CANARY_RESUME=1 enables resume mode; anything else is false", () => {
  expect(resolveCanaryResumeMode("1")).toBe(true)
  expect(resolveCanaryResumeMode("0")).toBe(false)
  expect(resolveCanaryResumeMode(undefined)).toBe(false)
})
```

**Step 2:** Run → FAIL (exports missing).
```bash
bunx vitest run scripts/run-longmemeval-canary.test.ts -t "MEMONGO_CANARY_"
```
Expected: exit 1.

**Step 3:** Implement the three pure helpers and export them. Replace the constants at `scripts/run-longmemeval-canary.ts:70-79` with calls to `resolveCanaryArtifactDir`; read `MEMONGO_CANARY_FULL` / `MEMONGO_CANARY_RESUME` and adjust the subset selection + resume-skip accordingly.

**Step 4:** Rerun → PASS.

**Step 5:** Commit on `scope-1-harness-reliability`.

**Exit criterion:** `bunx vitest run scripts/run-longmemeval-canary.test.ts -t "MEMONGO_CANARY_"` exits 0.

### Task 1.A: Benchmark report envelope parity upgrade (resolves pass-1 F5)

> **Pass-1 F5 response.** Gate 5 exit criteria demand parity fields (`datasetSha256`, `retrievalUnit`, `embedding.*`, `reranker.*`, `storage.*`, `latency.p50Ms`, `latency.p95Ms`, `cost.*`) that the current `benchmarkReport` envelope in `packages/memory-engine/src/mongodb-benchmark-runner.ts` does NOT emit (verified by reading type `BenchmarkSummary` and `BenchmarkReportInput` at `:113-156`). This task upgrades the envelope so Gate 3, Gate 4, and Gate 5 artifacts all carry the parity fields. Gate 3 at 1/type scale may have partially populated `storage.*` or `cost.*` (runtime-dependent), but the fields are present and non-null or explicitly `null` with a reason.

**Files:**
- Modify: `packages/memory-engine/src/mongodb-benchmark-runner.ts` (extend `BenchmarkSummary`, `BenchmarkReportInput`, and the emitter at `buildBenchmarkRunReport()`; call `collStats` via the MongoDB MCP `collection-storage-size` tool OR directly via driver `db.command({collStats: ...})`).
- Modify: `packages/memory-engine/src/mongodb-benchmark-runner.test.ts`.
- Modify: `apps/api/src/routes/v1.ts` (if the envelope serialization needs any route-level passthrough; likely none — the runner builds the envelope).
- Modify: `scripts/run-longmemeval-canary.ts` (pass parity fields into each `progress/{idx}.json` from the benchmark response).
- Modify: `docs/benchmarks/benchmark-operating-contract.md` to document the new envelope fields (land in Scope #3 at Phase 2, not Phase 1 — doc moves with the scope-3 PR; the code changes land in Scope #1).

**Envelope additions:**

| Field | Type | Source |
|---|---|---|
| `runIdentity.datasetSha256` | string | SHA-256 of dataset file bytes, computed by runner before first scenario |
| `runIdentity.retrievalUnit` | `"turn" \| "session" \| "memory" \| "qa-pair"` | from dataset kind + pipeline; `longmemeval` → `"turn"` |
| `embedding.model` | string | from config (e.g., `"voyage-3"`) |
| `embedding.dimensions` | number | from config (e.g., `1024`) |
| `embedding.quantization` | `"float32" \| "int8" \| "binary"` | from config; LongMemEval-S baseline = `"float32"` |
| `reranker.model` | string | e.g., `"rerank-2"` |
| `reranker.version` | string \| null | from Voyage SDK if exposed; else `null` |
| `reranker.stage` | `"post-fusion" \| "pre-fusion" \| "none"` | pipeline-level constant |
| `storage.collectionBytes` | number | `collStats.storageSize` for the benchmark-prefixed collection |
| `storage.indexBytes` | number | `collStats.totalIndexSize` |
| `latency.p50Ms` | number | p50 over per-case retrieval latencies |
| `latency.p95Ms` | number | p95 over per-case retrieval latencies (already computed; rename / widen) |
| `cost.embeddingCalls` | number | count of embedding API calls during the run |
| `cost.rerankCalls` | number | count of rerank API calls |
| `cost.llmEnrichmentCalls` | number | count of LLM enrichment calls |
| `e2eQa.judge` *(Gate 5 extension, Task 5.E2E / ADR-007)* | string | named judge model, e.g., `"claude-sonnet-4-6"` |
| `e2eQa.judgeVersion` *(Gate 5 extension)* | string \| null | judge model version snapshot if exposed |
| `e2eQa.accuracy` *(Gate 5 extension)* | number | 0–1, end-to-end QA accuracy |
| `e2eQa.latencyMs` *(Gate 5 extension)* | number | per-case QA-generation latency |
| `e2eQa.judgeFalsePositiveRate` *(Gate 5 extension, pass-3 B3 adversarial probe)* | number | 0–1, from Task 5.adv |

> **Envelope contract is a superset across gates.** Gate 3 / Gate 4 populate the core fields (Task 1.A rows 1–16 above). Gate 5 extends with `e2eQa.*` rows added by Task 5.E2E and Task 5.adv. This table is the single source of truth; Task 5.E2E SHALL NOT introduce parity fields that are not listed here, and any future extension MUST update this table in the same PR.

**Step 1:** Write failing tests asserting each field is present and non-null (or explicitly-null-with-reason) in a minimal benchmark run.
```typescript
test("benchmarkReport envelope emits all parity fields", async () => {
  const report = buildBenchmarkRunReport({ /* minimal input */ })
  expect(report.runIdentity.datasetSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(report.runIdentity.retrievalUnit).toBeDefined()
  expect(report.embedding.model).toBeDefined()
  expect(report.embedding.dimensions).toBeGreaterThan(0)
  expect(report.embedding.quantization).toMatch(/float32|int8|binary/)
  expect(report.reranker.model).toBeDefined()
  expect(report.reranker.stage).toMatch(/post-fusion|pre-fusion|none/)
  expect(report.storage.collectionBytes).toBeGreaterThanOrEqual(0)
  expect(report.storage.indexBytes).toBeGreaterThanOrEqual(0)
  expect(report.latency.p50Ms).toBeGreaterThanOrEqual(0)
  expect(report.latency.p95Ms).toBeGreaterThanOrEqual(report.latency.p50Ms)
  expect(report.cost.embeddingCalls).toBeGreaterThanOrEqual(0)
  expect(report.cost.rerankCalls).toBeGreaterThanOrEqual(0)
  expect(report.cost.llmEnrichmentCalls).toBeGreaterThanOrEqual(0)
})

test("progress/{idx}.json carries parity-field subset per scenario", async () => {
  // ...runs the canary with a fake benchmark and checks progress/0.json has
  // datasetSha256, retrievalUnit, embedding.{model,dimensions,quantization}
})
```

**Step 2:** Run → FAIL.

**Step 3:** Implement the envelope additions. Storage lookup uses `db.command({collStats: collName})`; if unsupported on atlas-local:preview, emit `storage: null` with a `storage-unavailable` reason. Dataset SHA is computed once at canary startup and threaded into the benchmark request payload (extend `/v1/admin/relevance/benchmark` body schema to accept `datasetSha256`, `embeddingConfig`, `rerankerConfig`).

**Step 4:** Re-run → PASS.

**Step 5:** Commit on `scope-1-harness-reliability` for the envelope code; stash the doc update (`benchmark-operating-contract.md`) for the Scope #3 PR in Phase 2.

**Exit criterion (blocks Gate 3 exit):** Gate 3 artifact `benchmarkReport.runIdentity.datasetSha256` is a 64-hex-char SHA-256. Missing any parity field blocks Gate 3 exit, not only Gate 5.

### Task 1.1: Canary runner sets `MEMONGO_LOG_LEVEL=warn` default

> **Resolves Harness Checklist Item #1.**

**Files:**
- Modify: `scripts/run-longmemeval-canary.ts` (top-of-file env bootstrap, near line 1–60)

**Step 1:** Write failing test. Add to `scripts/run-longmemeval-canary.test.ts`:
```typescript
test("canary defaults MEMONGO_LOG_LEVEL to warn unless MEMONGO_CANARY_DEBUG=1", () => {
  delete process.env.MEMONGO_LOG_LEVEL
  delete process.env.MEMONGO_CANARY_DEBUG
  const defaults = resolveCanaryLogLevel()
  expect(defaults).toBe("warn")
  process.env.MEMONGO_CANARY_DEBUG = "1"
  expect(resolveCanaryLogLevel()).toBe("info")
})
```

**Step 2:** Run → fail with `resolveCanaryLogLevel is not defined`.
```bash
bunx vitest run scripts/run-longmemeval-canary.test.ts -t "defaults MEMONGO_LOG_LEVEL"
```
Expected: FAIL, exit 1.

**Step 3:** Implement `resolveCanaryLogLevel()` exported from `scripts/run-longmemeval-canary.ts`. Call it in the script bootstrap before any other env read.

**Step 4:** Re-run.
```bash
bunx vitest run scripts/run-longmemeval-canary.test.ts -t "defaults MEMONGO_LOG_LEVEL"
```
Expected: PASS, exit 0.

**Step 5:** Commit on `scope-1-harness-reliability`.

### Task 1.2: Per-scenario progress artifact emitter

> **Resolves Harness Checklist Item #2.**

**Files:**
- Modify: `scripts/run-longmemeval-canary.ts` (scenario loop)
- Modify: `packages/memory-engine/src/mongodb-benchmark-runner.ts` (emit progress hook after each scenario)

**Step 1:** Write failing test. Add to `scripts/run-longmemeval-canary.test.ts`:
```typescript
test("canary writes progress/{idx}.json immediately on scenario completion", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-"))
  await runCanaryWithFakeBenchmark({ artifactDir: dir, scenarios: 3 })
  for (let i = 0; i < 3; i++) {
    const p = path.join(dir, "progress", `${i}.json`)
    expect(existsSync(p)).toBe(true)
    const doc = JSON.parse(readFileSync(p, "utf8"))
    expect(doc).toMatchObject({ index: i, completedAt: expect.any(String) })
  }
})
```

**Step 2:** Run → fail (helper missing). Exit 1.

**Step 3:** Implement progress emitter. API:
- `artifacts/canary-runs/{run-id}/progress/{scenario-idx}.json` contains `{index, questionId, questionType, completedAt, passStatus, failureClass|null, metrics}`.
- Write synchronously (fs.writeFileSync) immediately after each scenario returns from the benchmark API.

**Step 4:** Re-run → PASS, exit 0.

**Step 5:** Commit.

### Task 1.3: Complete queue-settle timeout test coverage

> **Resolves Harness Checklist Item #3 (completes partial coverage at `mongodb-manager.test.ts:417`).**

**Files:**
- Modify: `packages/memory-engine/src/mongodb-manager.test.ts` (append 3 tests)

**Step 1:** Write 3 failing tests:
```typescript
test("settleBenchmarkScenarioManager throws naming writeQueue when writeQueue hangs", async () => {
  const mgr = makeManagerWithHangingQueue("write")
  process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
  process.env.MEMONGO_BENCHMARK_STRICT = "1"
  await expect(settle(mgr)).rejects.toThrow(/writeQueue settle timed out after 200ms/)
})

test("settleBenchmarkScenarioManager throws naming derivationQueue when derivationQueue hangs", async () => {
  const mgr = makeManagerWithHangingQueue("derivation")
  process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
  process.env.MEMONGO_BENCHMARK_STRICT = "1"
  await expect(settle(mgr)).rejects.toThrow(/derivationQueue settle timed out after 200ms/)
})

test("settleBenchmarkScenarioManager succeeds on slow-but-bounded queue under timeout", async () => {
  const mgr = makeManagerWithSlowQueue(50 /*ms*/)
  process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "500"
  process.env.MEMONGO_BENCHMARK_STRICT = "1"
  await expect(settle(mgr)).resolves.toBeUndefined()
})
```

**Step 2:** Run → FAIL.
```bash
bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts -t "settleBenchmarkScenarioManager"
```
Expected: exit 1.

**Step 3:** Tests should already pass given `settleBenchmarkScenarioManager` at `mongodb-manager.ts:3422` works correctly — but verify the error message includes queue label (already does per read). If any fails, the implementation contract is missing the label format; amend the `Error(...)` message at `:3446`.

**Step 4:** Re-run → PASS.

**Step 5:** Commit.

### Task 1.4: Failure-classification taxonomy in canary + miss-ledger

> **Resolves Harness Checklist Item #5 (resolves Open Decision #4 via Recommended Default taxonomy).**

**Files:**
- Create: `packages/memory-engine/src/benchmark-failure-taxonomy.ts` (new — 9-class enum + classifier function)
- Create: `packages/memory-engine/src/benchmark-failure-taxonomy.test.ts`
- Modify: `scripts/run-longmemeval-canary.ts` (emit `failureClass` per miss + `runFailureClass` on abort)

**Step 1:** Write failing test:
```typescript
import { classifyBenchmarkFailure } from "./benchmark-failure-taxonomy"

test("classifies harness-timeout from AbortError", () => {
  expect(classifyBenchmarkFailure(new Error("aborted"))).toBe("harness-timeout")
})

test("classifies model-failure from Voyage 500", () => {
  const err = new Error("Voyage API 500 Internal")
  expect(classifyBenchmarkFailure(err)).toBe("model-failure")
})

test("classifies json-parse from SyntaxError", () => {
  expect(classifyBenchmarkFailure(new SyntaxError("Unexpected token"))).toBe("json-parse")
})

test("classifies index-not-ready from Stale status", () => {
  const err = new Error("search index status Stale")
  expect(classifyBenchmarkFailure(err)).toBe("index-not-ready")
})

test("unknown falls through to `unknown` class, not silent pass", () => {
  expect(classifyBenchmarkFailure(new Error("wat"))).toBe("unknown")
})

test("all 9 classes are exported and stable", () => {
  expect(BENCHMARK_FAILURE_CLASSES).toEqual([
    "harness-timeout",
    "queue-settle-timeout",
    "probe-timeout",
    "model-failure",
    "json-parse",
    "index-not-ready",
    "scope-leak",
    "retrieval-miss",
    "unknown",
  ])
})
```

**Step 2:** Run → FAIL.

**Step 3:** Implement `benchmark-failure-taxonomy.ts` with the 9-class enum (Recommended Default #2) and `classifyBenchmarkFailure(err: unknown)` switch.

**Step 4:** Wire into canary: in the scenario loop and on top-level abort, call `classifyBenchmarkFailure` and write to `progress/{idx}.json` and the top-level `failure.json`.

**Step 5:** Re-run tests → PASS.

**Step 6:** Commit.

### Task 1.5: Extract readiness probe into a pure helper and replace aggregate `$search` probe with `$listSearchIndexes` poll

> **Resolves Harness Checklist Item #4 + ADR-002 + advisory A5.** **Cites MongoDB MCP Finding #4** (`mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes`). **Pass-1 A5 response:** the old test mocked an invented `mockDbWithListSearchIndexes` helper; this revision extracts `readSearchIndexStatus(db, collName)` into a new pure module so tests mock the module boundary, not an invented fixture function.

**Files:**
- Create: `packages/memory-engine/src/mongodb-benchmark-readiness.ts` (new module — exports `readSearchIndexStatus`, `SearchIndexStatus` type, `BenchmarkReadinessFallback` symbol for the unsupported case).
- Create: `packages/memory-engine/src/mongodb-benchmark-readiness.test.ts`.
- Modify: `packages/memory-engine/src/mongodb-manager.ts` (`waitForBenchmarkEventSearchConvergence` at `:3473`+ delegates to the new helper; preserves the hardened aggregate fallback).
- Modify: `packages/memory-engine/src/mongodb-manager.test.ts` — replace any invented-mock references with `vi.mock("./mongodb-benchmark-readiness")`.

**Helper contract** (`mongodb-benchmark-readiness.ts`) — pass-3 A2: MongoDB's `$listSearchIndexes` returns **uppercase** status strings, and it exposes a `queryable: boolean` field that is the actual readiness indicator. Earlier drafts in this plan used `"Ready" | "Stale" | "Building"` lowercase — that was wrong. The corrected contract below uses the real uppercase values and captures `queryable`:
```typescript
export type SearchIndexStatus =
  | "PENDING"
  | "BUILDING"
  | "READY"
  | "STALE"
  | "FAILED"
  | "DELETING"
  | "DOES_NOT_EXIST"

export const BENCHMARK_READINESS_FALLBACK = Symbol("benchmark-readiness-fallback")

export type ReadSearchIndexStatusResult =
  | { kind: "ok"; status: SearchIndexStatus; queryable: boolean; indexName: string }
  | { kind: "fallback"; reason: "command-not-found" | "unsupported" }

export async function readSearchIndexStatus(
  db: Pick<Db, "collection">,
  collName: string,
  indexName: string,
): Promise<ReadSearchIndexStatusResult> {
  // Uses listSearchIndexes aggregate stage.
  // On "command not found" or similar, returns { kind: "fallback", reason }.
  // Never throws for control-flow reasons; only throws on real errors.
  // The returned `queryable` boolean is the actual readiness indicator
  // (an index can be READY and queryable=false during a rebuild, or
  // STALE and queryable=true during replication lag; tests must assert
  // on queryable=true, NOT on status==="READY" alone).
}
```

**Readiness rule (pass-3 A2):** A search index is benchmark-ready iff `queryable === true`. Status alone is insufficient (see MongoDB `$listSearchIndexes` reference: `mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes`). The manager test suite asserts on `queryable`, not on status literals.

**Step 1:** Write tests for the pure helper first (not against the manager):
```typescript
import { readSearchIndexStatus } from "./mongodb-benchmark-readiness"

test("readSearchIndexStatus returns READY + queryable=true when listSearchIndexes reports a ready index", async () => {
  const db = {
    collection: () => ({
      aggregate: () => ({ toArray: async () => [{ name: "events_text", status: "READY", queryable: true }] }),
    }),
  }
  const out = await readSearchIndexStatus(db as any, "events", "events_text")
  expect(out).toEqual({ kind: "ok", status: "READY", queryable: true, indexName: "events_text" })
})

test("readSearchIndexStatus returns STALE + queryable flag when index is STALE", async () => {
  const db = {
    collection: () => ({
      aggregate: () => ({ toArray: async () => [{ name: "events_text", status: "STALE", queryable: true }] }),
    }),
  }
  const out = await readSearchIndexStatus(db as any, "events", "events_text")
  expect(out).toEqual({ kind: "ok", status: "STALE", queryable: true, indexName: "events_text" })
})

test("readSearchIndexStatus returns fallback when server rejects listSearchIndexes", async () => {
  const db = {
    collection: () => ({
      aggregate: () => { throw new Error("command listSearchIndexes not found") },
    }),
  }
  const out = await readSearchIndexStatus(db as any, "events", "events_text")
  expect(out.kind).toBe("fallback")
})

test("readSearchIndexStatus returns queryable=false during BUILDING", async () => {
  const db = {
    collection: () => ({
      aggregate: () => ({ toArray: async () => [{ name: "events_text", status: "BUILDING", queryable: false }] }),
    }),
  }
  const out = await readSearchIndexStatus(db as any, "events", "events_text")
  expect(out).toEqual({ kind: "ok", status: "BUILDING", queryable: false, indexName: "events_text" })
})
```

**Step 2:** Write the manager-level test that delegates to the mocked helper (pass-3 A2: tests assert on `queryable`, NOT on status literals):
```typescript
import { vi } from "vitest"
vi.mock("./mongodb-benchmark-readiness", () => ({
  readSearchIndexStatus: vi.fn(),
}))
import { readSearchIndexStatus } from "./mongodb-benchmark-readiness"
import { waitForBenchmarkEventSearchConvergence } from "./mongodb-manager"

test("waitForBenchmarkEventSearchConvergence returns when helper reports queryable=true", async () => {
  vi.mocked(readSearchIndexStatus).mockResolvedValue({ kind: "ok", status: "READY", queryable: true, indexName: "events_text" })
  await expect(waitForBenchmarkEventSearchConvergence(db, "agentA")).resolves.toBeUndefined()
})

test("waitForBenchmarkEventSearchConvergence aborts on STALE in strict mode even if queryable=true", async () => {
  process.env.MEMONGO_BENCHMARK_STRICT = "1"
  vi.mocked(readSearchIndexStatus).mockResolvedValue({ kind: "ok", status: "STALE", queryable: true, indexName: "events_text" })
  await expect(waitForBenchmarkEventSearchConvergence(db, "agentA")).rejects.toThrow(/index-not-ready|STALE/)
})

test("waitForBenchmarkEventSearchConvergence aborts on queryable=false in strict mode", async () => {
  process.env.MEMONGO_BENCHMARK_STRICT = "1"
  vi.mocked(readSearchIndexStatus).mockResolvedValue({ kind: "ok", status: "BUILDING", queryable: false, indexName: "events_text" })
  await expect(waitForBenchmarkEventSearchConvergence(db, "agentA")).rejects.toThrow(/index-not-ready|BUILDING|queryable/)
})

test("waitForBenchmarkEventSearchConvergence falls back to aggregate probe when helper signals fallback", async () => {
  vi.mocked(readSearchIndexStatus).mockResolvedValue({ kind: "fallback", reason: "command-not-found" })
  // aggregate fallback still honors MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS;
  // under 1s ceiling, test confirms no hang.
  const start = Date.now()
  await waitForBenchmarkEventSearchConvergence(db, "agentA").catch(() => {})
  expect(Date.now() - start).toBeLessThan(2000)
})
```

**Step 3:** Run → FAIL (exit 1).

**Step 4:** Implement the helper in `mongodb-benchmark-readiness.ts` (driver call + fallback classification). Wire `waitForBenchmarkEventSearchConvergence` to delegate. Keep the hardened aggregate fallback in place; add a 1s ceiling on the fallback branch via the existing `MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS` default.

**Step 5:** Re-run → PASS.

**Step 6:** Commit.

### Task 1.6: Strict-mode fail-fast audit of canary

> **Resolves Harness Checklist Item #6.**

**Files:**
- Modify: `scripts/run-longmemeval-canary.ts` (abort on any `harness-timeout`, `model-failure`, `json-parse`, `queue-settle-timeout`, `probe-timeout`, `index-not-ready`, `scope-leak` when `MEMONGO_BENCHMARK_STRICT=1`)

**Step 1:** Write failing test:
```typescript
test("canary aborts on first classified fatal class when strict=1", async () => {
  process.env.MEMONGO_BENCHMARK_STRICT = "1"
  const dir = mkdtempSync(...)
  await expect(runCanaryWithFakeBenchmark({ artifactDir: dir, injectFailureAt: 2, failureClass: "model-failure" }))
    .rejects.toThrow(/canary aborted.*scenario 2.*model-failure/)
  expect(existsSync(path.join(dir, "failure.json"))).toBe(true)
  const failure = JSON.parse(readFileSync(path.join(dir, "failure.json"), "utf8"))
  expect(failure.scenarioIndex).toBe(2)
  expect(failure.failureClass).toBe("model-failure")
})
```

**Step 2:** Run → FAIL.

**Step 3:** Implement abort path in scenario loop; write `failure.json` synchronously before throwing.

**Step 4:** Re-run → PASS.

**Step 5:** Commit.

### Task 1.7: Canary resume semantics via `MEMONGO_CANARY_RESUME` (pass-1 F1)

> **Resolves Harness Checklist Item #7.** **Pass-1 F1 response:** uses the env-var contract introduced by Task 1.0 (`MEMONGO_CANARY_RESUME=1`). No CLI flag is added.

**Files:**
- Modify: `scripts/run-longmemeval-canary.ts` (scenario loop: when `MEMONGO_CANARY_RESUME=1`, read `$MEMONGO_CANARY_ARTIFACT_DIR/progress/` and skip completed scenario indices)

**Precondition:** Task 1.0 shipped (provides `resolveCanaryResumeMode` and artifact-dir resolution).

**Step 1:** Write failing test:
```typescript
test("canary with MEMONGO_CANARY_RESUME=1 skips scenarios with existing progress/{idx}.json", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-"))
  mkdirSync(path.join(dir, "progress"), { recursive: true })
  writeFileSync(path.join(dir, "progress", "0.json"), JSON.stringify({ index: 0, completedAt: "x" }))
  writeFileSync(path.join(dir, "progress", "1.json"), JSON.stringify({ index: 1, completedAt: "x" }))
  process.env.MEMONGO_CANARY_ARTIFACT_DIR = dir
  process.env.MEMONGO_CANARY_RESUME = "1"
  const run = await runCanaryWithFakeBenchmark({ scenarios: 3 })
  expect(run.scenariosSkipped).toBe(2)
  expect(run.scenariosExecuted).toBe(1)
})

test("canary with MEMONGO_CANARY_RESUME unset starts fresh", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canary-noresume-"))
  mkdirSync(path.join(dir, "progress"), { recursive: true })
  writeFileSync(path.join(dir, "progress", "0.json"), JSON.stringify({ index: 0, completedAt: "x" }))
  process.env.MEMONGO_CANARY_ARTIFACT_DIR = dir
  delete process.env.MEMONGO_CANARY_RESUME
  const run = await runCanaryWithFakeBenchmark({ scenarios: 2 })
  expect(run.scenariosSkipped).toBe(0)
  expect(run.scenariosExecuted).toBe(2)
})
```

**Step 2:** Run → FAIL.

**Step 3:** Implement. Resume must be explicit (reads `MEMONGO_CANARY_RESUME === "1"`); absent or `0` starts fresh. Absent `progress/` directory starts fresh regardless.

**Step 4:** Re-run → PASS.

**Step 5:** Commit.

### Task 1.8: Silent-fallback audit of hot path (resolves pass-1 A3)

> **Resolves Harness Checklist Item #8.** **Pass-1 A3 response — explicit doc landing decision:** the audit doc is WRITTEN during Phase 1 on the `scope-1-harness-reliability` branch at `docs/benchmarks/silent-fallback-audit-2026-05-11.md` (colocated with the audit work). In Phase 2, the Scope #3 PR includes a `git mv` of this file into its Scope #3 commit — ownership transfers to Scope #3, path stays identical. No lose-and-rewrite; no Phase-2 drafting.

**Files:**
- Audit (no edit unless finding): `packages/memory-engine/src/mongodb-manager.ts`, `packages/memory-engine/src/mongodb-retrieval-planner.ts`, `packages/memory-engine/src/mongodb-search.ts`, `packages/memory-engine/src/mongodb-search-executor.ts`, `packages/memory-engine/src/mongodb-reranker.ts`, `packages/memory-engine/src/mongodb-llm-enrichment.ts`, `packages/memory-engine/src/mongodb-conversation-recall.ts`.
- Create (on scope-1-harness-reliability, Phase 1): `docs/benchmarks/silent-fallback-audit-2026-05-11.md`.
- Transfer ownership (Phase 2 Scope #3 PR): `git mv` on the same path — the file moves between commits, NOT between paths.

**Step 1:** Ripgrep every `catch` and `warn` on hot path:
```bash
rg -n --multiline 'catch\s*\([^)]*\)\s*\{[^}]*(?:warn|log\.warn|continue|return)' packages/memory-engine/src/mongodb-*.ts
```

**Step 2:** Classify each hit:
- **Keep:** resilience fallback for normal product operation; documented behavior.
- **Convert:** must throw in strict mode; wrap with `if (isBenchmarkStrictMode()) throw err`.

**Step 3:** For each "Convert" site, add a test that asserts throw in strict mode.

**Step 4:** Commit classification notes to `docs/benchmarks/silent-fallback-audit-2026-05-11.md` on `scope-1-harness-reliability`. At Phase 2 Scope #3 merge, the same file is re-committed under Scope #3 (no path change).

### Task 1.9: Forced-failure gate proof

**Files:** no code change; this is the exit-criteria proof.

**Precondition (pass-1 F2 response):** Bootstrap Sub-Sequence steps B1–B5 must have run successfully. `bootstrap.json` must exist in the run dir.

**Precondition (pass-1 F1 response):** Tasks 1.0 and 1.A have shipped; the canary reads `MEMONGO_CANARY_ARTIFACT_DIR`.

**Step 1:** Run canary with broken Voyage URL (env-var contract only; no unsupported CLI flags):
```bash
GATE_LABEL=gate1-forced-failure
export MEMONGO_CANARY_ARTIFACT_DIR="artifacts/canary-runs/${GATE_LABEL}-$(date +%s)"
mkdir -p "$MEMONGO_CANARY_ARTIFACT_DIR"
# Re-run bootstrap sub-sequence (B1–B5) targeted at this run dir before canary.
# ... (omitted for brevity; bootstrap.json already in $MEMONGO_CANARY_ARTIFACT_DIR)
MEMONGO_VOYAGE_BASE_URL="http://127.0.0.1:65530" \
MEMONGO_BENCHMARK_STRICT=1 \
MEMONGO_LLM_ENRICHMENT_STRICT=1 \
MEMONGO_CANARY_CASES_PER_TYPE=1 \
bun run scripts/run-longmemeval-canary.ts 2>&1 | tee "$MEMONGO_CANARY_ARTIFACT_DIR/run.log"
```

**Expected:**
- Process exits with non-zero code within 5 minutes (300 seconds).
- `$MEMONGO_CANARY_ARTIFACT_DIR/failure.json` exists with `failureClass: "model-failure"`.
- `$MEMONGO_CANARY_ARTIFACT_DIR/progress/*.json` files present for any attempted scenarios (may be 0 if failure is at bootstrap).
- `$MEMONGO_CANARY_ARTIFACT_DIR/bootstrap.json` already present (from B5).

**Expected exit code:** 1 within 300s. Kill-and-fail if > 300s.

### Task 1.10: Merge Scope #1 to main

**Step 1:** Tag pre-merge.
```bash
git tag pre-merge-scope-1 $(git rev-parse scope-1-harness-reliability)
```
**Step 2:** Open PR scope-1 → main; run CI; merge via squash. Tag post-merge.

### Phase 1 Checks

```bash
bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts
bunx vitest run packages/memory-engine/src/mongodb-benchmark-runner.test.ts
bunx vitest run packages/memory-engine/src/mongodb-benchmark-readiness.test.ts
bunx vitest run scripts/run-longmemeval-canary.test.ts
bunx vitest run packages/memory-engine/src/benchmark-failure-taxonomy.test.ts
git diff --check
bun run lint
bun run check-types
```

All exit 0.

### Phase 1 Artifacts

- `artifacts/canary-runs/gate1-forced-failure-{timestamp}/failure.json` with classification
- `artifacts/canary-runs/gate1-forced-failure-{timestamp}/progress/` (possibly empty if bootstrap failed)
- Unit tests green for all 6 harness tasks
- `pre-merge-scope-1` tag
- Scope #1 merged to main

### Phase 1 Checkpoint Type: `human_verify`

### Phase 1 Failure Response

- Tests pass but forced failure doesn't classify → taxonomy implementation incomplete; revisit Task 1.4.
- Forced failure runs > 5 min → strict-mode fail-fast broken; revisit Task 1.6.
- `$listSearchIndexes` unsupported on atlas-local:preview → Task 1.5 fallback path must be proven; re-run the `command not found` test case.

---

## Phase 2 — Gate 2: Baseline Health + Capability Audit

> **Exit Criteria:** (a) `bun run lint && bun run check-types && bun run build` on main all exit 0 after Scopes #2 + #3 merge. (b) All 6 `CLAUDE.md` capabilities have 4-layer evidence at `docs/benchmarks/capability-audit/{slug}-evidence.md`. (c) `git diff --check` clean. (d) Every correctness-invariant property test has a recorded fast-check seed. (e) Scope #2 and #3 merged; `pre-merge-scope-2` and `pre-merge-scope-3` tags exist.

**Scopes merged in this phase:** Scope #2 (retrieval/ranking) and Scope #3 (docs/benchmarks).

### Task 2.R1: $rankFusion observability — log scoreDetails.details[] in benchmark artifacts

> **Cites MongoDB MCP Finding #1** (`mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search`).

**Files:**
- Modify: `packages/memory-engine/src/mongodb-conversation-recall.ts` (add `scoreDetails: { $meta: "scoreDetails" }` projection)
- Modify: `packages/memory-engine/src/mongodb-benchmark-runner.ts` (emit per-case scoreDetails into progress artifact)
- Modify: `packages/memory-engine/src/mongodb-conversation-recall.test.ts`

**Step 1:** Test: assert `scoreDetails.details[].value ≈ weight * (1/(60+rank))` within epsilon for a fixed seeded run.

**Step 2:** Implement projection; add `$addFields: { scoreDetails: { $meta: "scoreDetails" } }` before final `$project` at line 448 area of `mongodb-conversation-recall.ts`.

**Step 3:** Re-run → PASS.

### Task 2.R2: numCandidates table — parameterize by limit (resolves pass-1 A4)

> **Cites MongoDB MCP Finding #2** (`mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage`). **Resolves Pending Sign-Off Default #1 (numCandidates table).** (Prior revision labeled this as Open Decision #3; pass-3 G4 renumbered Open Decisions — #3 is now the atlas-local:preview 8.3 question. Fixed in pass-3 plan-gap-review advisory.)

**Pass-1 A4 response.** The `numCandidates` table is a Recommended Default, not an approved decision. This task is gated on Phase 0 Task 0.5 (user sign-off). Two sub-paths:

**Sub-path A (user approved the table in Task 0.5):**
- **Files:**
  - Modify: `packages/memory-engine/src/mongodb-conversation-recall.ts` (parameterize `numCandidates` inside `$vectorSearch`)
  - Modify: `packages/memory-engine/src/mongodb-retrieval-planner.ts` (provide `resolveNumCandidates(limit)` helper)
- **Step 1:** Test `resolveNumCandidates(5)===200, resolveNumCandidates(10)===200, resolveNumCandidates(20)===400, resolveNumCandidates(30)===600`.
- **Step 2:** Implement helper per Recommended Default table. Pass through a `numCandidatesOverride` option for Gate 5 experimentation.
- **Step 3:** Document the approved table in `docs/benchmarks/numcandidates-approved-2026-05-11.md` (Scope #3).

**Sub-path B (user rejected the table in Task 0.5):**
- **Files:**
  - Create: `docs/benchmarks/numcandidates-proposal-2026-05-11.md` (Scope #3) — proposal artifact only, NO code change.
- **Step 1:** Write the proposal with the recommended values, MongoDB doc citations, and expected recall curves (if available from internal traces).
- **Step 2:** Leave `$vectorSearch` `numCandidates` logic unchanged in `mongodb-conversation-recall.ts`.
- **Step 3:** The Gate 5 recall-curve experiment (Task 5.3) is reduced to "compare baseline-unchanged only".

Builder MUST read `docs/benchmarks/recommended-defaults-signoff-2026-05-11.md` (from Task 0.5) before choosing a sub-path.

### Task 2.R3: Compound boost audit

> **Cites MongoDB MCP Finding #3** (`mongodb.com/docs/atlas/atlas-search/customize-score`).

**Files:**
- Audit: `packages/memory-engine/src/mongodb-manager.ts`, `packages/memory-engine/src/mongodb-reranker.ts` for every `boost` key.

**Step 1:** Ripgrep: `rg -n 'boost\s*:\s*\{' packages/memory-engine/src/`.

**Step 2:** Confirm explicit numeric boosts (no multiplicative stacking). Document findings in `docs/benchmarks/compound-boost-audit-2026-05-11.md` (Scope #3).

**Step 3:** If stacking found → add a comment explaining or factor out into a single-site boost applier.

### Task 2.R4: Query decomposition RRF constant parity

**Files:**
- Audit: `packages/memory-engine/src/mongodb-query-decomposition.ts`

**Step 1:** Confirm query-decomposition's internal RRF merge uses constant `60` (matching `$rankFusion` per MCP Finding #1).

**Step 2:** If different, add a test pinning the constant and document in scope-3 doc.

### Task 2.R6: Per-query hybrid weight classifier (proposal — pass-3 C3)

> MongoDB docs explicitly advise per-query weighting over static 0.5/0.5 (consult `mcp__plugin_mongodb_mongodb__search-knowledge` with `"hybrid search per-query weighting"`). This task produces a PROPOSAL artifact first; code landing is gated by Task 0.5 sign-off on a new Recommended Default.

**Files:**
- Create: `docs/benchmarks/per-query-weighting-proposal-2026-05-11.md` on `scope-3-docs-benchmarks`.
- (If approved at Task 0.5 follow-up) Modify: `packages/memory-engine/src/mongodb-retrieval-planner.ts` to route factual-lookup queries to 0.6/0.4 BM25-biased, semantic/paraphrase to 0.4/0.6 vector-biased, multi-hop to 0.5/0.5.

**Step 1:** Classify query types from LongMemEval-S session-level inspection: factual-lookup, semantic/paraphrase, multi-hop. Record examples in the proposal.

**Step 2:** Define classifier contract:
```typescript
export type QueryClass = "factual-lookup" | "semantic-paraphrase" | "multi-hop" | "mixed"
export function classifyQueryForWeighting(query: string): QueryClass
export function weightsForClass(c: QueryClass): { vector: number; text: number }
// factual-lookup -> { vector: 0.4, text: 0.6 }
// semantic-paraphrase -> { vector: 0.6, text: 0.4 }
// multi-hop -> { vector: 0.5, text: 0.5 }
// mixed -> { vector: 0.5, text: 0.5 }
```

**Step 3:** Produce recall-curve comparison (static 0.5/0.5 vs per-query) on LongMemEval-S using existing `$rankFusion` + `scoreDetails` telemetry.

**Step 4:** Proposal artifact records: classifier contract, recall deltas, MongoDB MCP URL, risk of misclassification, fallback path (mixed → 0.5/0.5).

**Exit criterion:** Proposal artifact exists. Code landing requires follow-on Task 0.5-style sign-off (new Recommended Default added to the Open Decisions list if user approves the direction).

### Task 2.R7: ENN fallback for small per-user corpora (pass-3 C4)

> For users with fewer than 10k vectors, `$vectorSearch` with `exact: true` (ENN) outperforms ANN. The engine should detect corpus size pre-query and switch. Proposal artifact first, code landing gated by Task 0.5 sign-off.

**Files:**
- Create: `docs/benchmarks/enn-fallback-proposal-2026-05-11.md` on `scope-3-docs-benchmarks`.
- (If approved) Modify: `packages/memory-engine/src/mongodb-conversation-recall.ts` to branch `$vectorSearch.exact` based on estimated corpus size for the target `(agentId, scope, scopeRef)`.

**Step 1:** Audit existing estimated-count path; if absent, add `db.collection.estimatedDocumentCount()` or a scoped `countDocuments()` call with small-limit optimization.

**Step 2:** Pseudocode:
```typescript
const approxCount = await estimateScopedCount(db, filter)
const useExact = approxCount < 10_000
const vectorSearchStage = { $vectorSearch: { ...base, exact: useExact, numCandidates: useExact ? undefined : numCandidates } }
```

**Step 3:** Consult `mcp__plugin_mongodb_mongodb__search-knowledge` with `"$vectorSearch exact ENN small corpus"` and cite URL in proposal.

**Exit criterion:** Proposal artifact exists; sub-10k-corpus recall delta measured; code landing follows Task 0.5 sign-off.

### Task 2.R8: HyDE as sibling retrieval route (roadmap item — pass-3 C5)

> HyDE generates a hypothetical answer, embeds it, and retrieves neighbors of the embedding. Not a replacement for query decomposition; a sibling route chosen by the query classifier. Cite r/LocalLLaMA 9-technique test (HyDE #1, RAG-Fusion #2), arxiv 2509.06544 ReDI. Ships as a Gate-5 evaluation cell; not required to land as code for Gate 3/4.

**Files:**
- Create: `docs/benchmarks/hyde-sibling-route-roadmap-2026-05-11.md` on `scope-3-docs-benchmarks`.

**Step 1:** Document route contract: classifier selects among (decomposition, HyDE, straight-hybrid) per query. HyDE branch: LLM generates hypothetical answer → embed → `$vectorSearch` → pass to `$rankFusion` as the vector-pipeline source.

**Step 2:** Gate 5 benchmark-matrix cell: "HyDE vs decomposition vs straight-hybrid, LongMemEval-S retrieval lane" — at least 1 run per route, using the same `MEMONGO_CANARY_*` env contract from Task 1.0.

**Exit criterion:** Roadmap artifact exists; Gate-5 matrix cell reserved.

### Task 2.R9: Reranker bake-off cell (Gate 5 — pass-3 C6)

> Mem0 publicly swapped to ZeroEntropy for LongMemEval gains (`zeroentropy.dev` Mem0 case study). HackerNoon reports cross-encoder 63% NDCG lift. Gate 5 matrix publishes: Voyage rerank-2.5 vs Cohere Rerank 4 vs ZeroEntropy zerank-2 on the SAME 500-case LongMemEval-S. Success target = document which reranker is best for our exact profile, even if we keep Voyage.

**Files:**
- Create: `docs/benchmarks/reranker-bakeoff-matrix-2026-05-11.md` on `scope-3-docs-benchmarks`.

**Step 1:** Document contract: same dataset SHA, same retrieval stack (pre-rerank), same top-50 input candidates per case. Swap only the reranker call.

**Step 2:** Each reranker run goes through the canary `MEMONGO_CANARY_ARTIFACT_DIR` (per-run directory), and the artifact lists `reranker.{model,version,stage}` per Task 1.A envelope.

**Step 3:** Consult `mcp__plugin_mongodb_mongodb__search-knowledge` with `"Atlas Search reranker cross-encoder cohere zeroentropy voyage"` and cite URLs.

**Exit criterion:** Gate 5 matrix artifact lists R@5, R@10, NDCG@10, latency p50/p95, and cost-per-1k-cases for all 3 rerankers.

### Task 2.SE-1: Bi-temporal memories (validAt / invalidAt) — ADR-006 scope expansion (pass-3 E3)

> User-approved. Zep leads by 15 points on temporal queries because of bi-temporal modeling. Lands on `scope-2-retrieval-ranking`.

**Files:**
- Modify: `packages/memory-engine/src/mongodb-schema.ts` (add `validAt: Date`, `invalidAt: Date | null` to event/episode schema + index `{ agentId: 1, scope: 1, scopeRef: 1, validAt: 1, invalidAt: 1 }`).
- Modify: `packages/memory-engine/src/mongodb-manager.ts` (retrieval filter: only return memories where `validAt <= queryTime AND (invalidAt IS NULL OR invalidAt > queryTime)`).
- Modify: `packages/memory-engine/src/mongodb-schema.test.ts` + new capability test.

**Skills to load:** `mongodb:mongodb-schema-design` + `mongodb:mongodb-query-optimizer` + `mcp__plugin_mongodb_mongodb__search-knowledge`. Consult MCP for `"MongoDB bi-temporal index compound index validAt invalidAt"` and cite URL in the implementation comment.

**Step 1:** Test — **RED.** Assert query at `queryTime=T` excludes memories with `invalidAt < T`.

**Step 2:** Implement schema fields + index + retrieval filter.

**Step 3:** Test — **GREEN.** Add property test: "no retrieval returns a memory where `invalidAt < queryTime`" (provable property from ADR-006; see updated Provable Properties list).

**Step 4:** Integration: bridge-level `recallConversation` test confirms bi-temporal filter is applied.

**Step 5:** Commit on `scope-2-retrieval-ranking`.

**Exit criterion:** Property test passes with fixed seed; integration test passes against atlas-local:preview.

### Task 2.SE-2: Memory-poisoning / prompt-injection defense at consolidation write time (pass-3 E5 — ADR-006)

> User-approved. Anthropic flagged this themselves alongside the Dreaming launch. Verifier filters at consolidation write time: classifier detects prompt-injection-shaped content, quarantines it, requires human review. Lands on `scope-2-retrieval-ranking`.

**Files:**
- Modify: `packages/memory-engine/src/mongodb-consolidator.ts` (add `verifyConsolidationCandidate(candidate)` pre-write hook).
- Create: `packages/memory-engine/src/mongodb-injection-classifier.ts` (pattern + LLM-based classifier).
- Modify: `packages/memory-engine/src/mongodb-schema.ts` (new `memory_quarantine` collection for quarantined memories; requires the review gate of Task 2.SE-3 before canonical).
- Create: `packages/memory-engine/src/mongodb-injection-classifier.test.ts`.

**Skills to load:** `mongodb:mongodb-schema-design` + `mcp__plugin_mongodb_mongodb__search-knowledge`.

**Step 1:** Pattern detection — tests for known injection shapes: "ignore previous", "system prompt:", bracketed-role injections, prompt-leak patterns. Each pattern case is a RED test first.

**Step 2:** Implement pattern classifier (string-level) as tier-1. Tier-2 is an LLM classifier gated by a strict-mode bypass switch (off by default; user can enable for higher accuracy).

**Step 3:** Pre-write hook in `mongodb-consolidator.ts`: if classifier returns `injection-likely`, route to `memory_quarantine` with status `"pending-review"` and never to canonical.

**Step 4:** Property test (ADR-006 invariant): every memory whose content matches injection patterns is quarantined before consolidation, NOT stored in canonical.

**Step 5:** Integration test: run consolidation with a mix of clean + injection-shaped candidates; assert canonical has only clean, quarantine has only flagged.

**Exit criterion:** Property test with fixed seed passes; integration test green.

### Task 2.SE-3: Human review/promotion gate (pending → canonical) (pass-3 E4 — ADR-006)

> User-approved. Lands under a new **Scope 7 (web-console review UI)** per ADR-006 (planner decides at Phase 0 based on partition-table review).

**Files:**
- Modify: `apps/web/app/page.tsx` + new review queue view at `apps/web/app/review/page.tsx` (new file).
- Modify: `apps/api/src/routes/v1.ts` — new routes `GET /v1/review/queue`, `POST /v1/review/promote/{id}`, `POST /v1/review/reject/{id}`.
- Modify: `packages/memory-bridge/src/memongo-bridge.ts` — new bridge entries `memongoBridgeListPendingMemories`, `memongoBridgePromoteMemory`, `memongoBridgeRejectMemory`.
- Modify: `packages/memory-engine/src/mongodb-consolidator.ts` — do NOT write canonical until `promoted: true`.
- Modify: `packages/memory-engine/src/mongodb-schema.ts` — `memory_pending` collection (or status field on events with `pending | canonical`).

**Skills to load:** all 4 MongoDB skills + MCP per Agent Invocation Contract.

**Step 1:** RED test: consolidation produces a `pending` memory; canonical is unchanged until `promoteMemory(id)` runs.

**Step 2:** Implement pending-write + promote/reject bridge + API + web queue.

**Step 3:** Property test (ADR-006 invariant): no memory moves from pending to canonical without an explicit approval event. Approval event is audit-trailed.

**Step 4:** Integration test across engine → bridge → API → web.

**Exit criterion:** Property test passes; full flow demo-able.

### Task 2.SE-4: Exportable-memory guarantee (pass-3 E6 — ADR-006)

> User-approved. Lands on `scope-4-api-security`. New `POST /v1/export/{agentId}` returns a signed JSON bundle of all memories scoped to that agent.

**Files:**
- Modify: `apps/api/src/routes/v1.ts` — new route `POST /v1/export/{agentId}`.
- Modify: `apps/api/src/app.ts` — route registration.
- Modify: `apps/api/src/openapi-spec.ts` — document new route.
- Modify: `packages/memory-bridge/src/memongo-bridge.ts` — new `memongoBridgeExportAgent`.
- Modify: `packages/client/src/client.ts` — new `.exportAgent(agentId)` method.
- Modify: `packages/tools/src/index.ts` — new AI SDK tool `memongo_export_agent`.

**Skills to load:** all 4 MongoDB skills + MCP per Agent Invocation Contract.

**Step 1:** RED test — export returns JSON bundle with fields `{ agentId, scope, scopeRef, events: [...], episodes: [...], kb: [...], exportedAt, signature }`. Signature is HMAC-SHA256 of bundle bytes keyed by `MEMONGO_EXPORT_SIGNING_KEY`.

**Step 2:** Implement: stream events for the agent, collect, sign, return.

**Step 3:** Property test (ADR-006 invariant): signed bundle is byte-identical across two exports at the same scopeRef with no intervening writes (fixture: insert N events, export, export again, `diff` bytes).

**Step 4:** Integration test end-to-end from web → API → bridge → MongoDB.

**Exit criterion:** Property test passes; HMAC verifies; export latency < 5s for 10k-event corpus.

### Task 2.C1: Capability 1 — Reasoning chain (4-layer)

**Capability file:** `packages/memory-engine/src/mongodb-reasoning-chain.ts`

**Silent-bug risks:** cycle detection, depth limits, cross-scope chain leak.

**4 layers:**
1. **Unit:** `chainTraversal` math + depth guard — fast-check property: depth never exceeds configured `maxDepth`; no cycle re-entry.
2. **Integration:** chain through real `events`+`episodes` docs, scoped by `agentId`+`scopeRef`; assert every traversed doc shares the same scope.
3. **E2E:** `POST /v1/chain-trace` round-trip against atlas-local:preview.
4. **Correctness invariant:** fast-check seed → generate random graphs with injected cycles; assert traversal terminates and never crosses `agentId`/`scopeRef`.

**Artifact:** `docs/benchmarks/capability-audit/reasoning-chain-evidence.md` with: commands, exit codes, fast-check seed, 3 passing test names.

### Task 2.C2: Capability 2 — Surprisal novelty (4-layer)

**Capability file:** `packages/memory-engine/src/mongodb-novelty.ts`

**Silent-bug risks:** stale baselines, scope leak, divide-by-zero on cold start.

**4 layers:**
1. **Unit:** score bounds `[0,1]`, math correctness.
2. **Integration:** persisted baselines read/write; verify cold-start returns defined score (no NaN/Infinity).
3. **E2E:** `POST /v1/novelty-scan`.
4. **Correctness invariant:** fast-check → score monotonic under identical context; stable under seed.

**Artifact:** `docs/benchmarks/capability-audit/novelty-evidence.md`.

### Task 2.C3: Capability 3 — Access tracking (4-layer) **[PRIME SUSPECT]**

**Capability file:** `packages/memory-engine/src/mongodb-access-tracker.ts`

**Silent-bug risks:** batched writes losing recency on crash; race between batch flush and read.

**Design note (pass-1 A1 response):** AccessTracker is engine-internal. No HTTP route and no MCP tool surface call it directly — it is invoked transitively by search / recall / KB read paths. Therefore Layer 3 is reshaped to **"Engine boundary integration"** rather than "E2E", with an explicit justification that no HTTP / MCP surface exists by design.

**4 layers:**
1. **Unit:** batch flush logic + dedup (tests in `mongodb-access-tracker.test.ts`).
2. **Integration:** 100 reads through `memongoBridgeRecallConversation` (NOT directly against the tracker) → verify batched write count matches reads; simulate shutdown mid-batch and assert count never goes backwards.
3. **Engine boundary integration** (renamed from "E2E"): drive reads via every external entry that transits the tracker — `memongoBridgeSearch`, `memongoBridgeRecallConversation`, `memongoBridgeSearchKB` — and assert the tracker observes each read exactly once; also assert SIGTERM handler drains batch.
4. **Correctness invariant (fast-check):** access count is a monotonic function of read-count stream; batch drain completes on shutdown signal within configured `FLUSH_TIMEOUT`. Fast-check seed recorded in the evidence artifact.

**Artifact:** `docs/benchmarks/capability-audit/access-tracking-evidence.md` — MUST include the A1 justification that AccessTracker has no HTTP / MCP surface by design, and list the three bridge-level entry points that were exercised in Layer 3.

### Task 2.C4: Capability 4 — Importance decay (4-layer) **[PRIME SUSPECT]**

**Capability file:** `packages/memory-engine/src/mongodb-trust.ts`

**Silent-bug risks:** `temporalScope=permanent|ongoing` guard failing; important memories rot silently.

**4 layers:**
1. **Unit:** `computeImportanceDecay()` property test on small fixed inputs.
2. **Integration:** decay over 30-day time window with mixed `temporalScope` values; assert permanent/ongoing rows preserve importance.
3. **E2E:** full scan + re-rank after simulated 30-day `asOf` advance; assert top-K ordering respects non-decayed permanent rows.
4. **Correctness invariant:** fast-check → `permanent`/`ongoing` NEVER decay; output always in `[0, 1]`; monotonic decreasing under no-access.

**Artifact:** `docs/benchmarks/capability-audit/importance-decay-evidence.md` (include fast-check seed; tag as PRIME-SUSPECT).

### Task 2.C5: Capability 5 — Wiki categorization (4-layer)

**Capability files:** KB schema fields `wikiSource`, `vault`, `section` in `packages/memory-engine/src/mongodb-schema.ts`

**Silent-bug risks:** schema drift, nulls in search, scope bleed.

**4 layers:**
1. **Unit:** schema validation test.
2. **Integration:** insert + query with categorization filter; assert KB doc has categorization fields.
3. **E2E:** search with category facet returns expected subset.
4. **Correctness invariant (pass-1 A2 response — fast-check seed specified):** for every randomly generated KB doc `d` inserted with agent/scope/scopeRef `(a, s, r)`,
   - `d.wikiSource !== undefined ∧ d.vault !== undefined ∧ d.section !== undefined` (categorization always present), AND
   - when queried with filter `(a, s, r)`, the returned KB docs all satisfy `result.agentId === a ∧ result.scope === s ∧ result.scopeRef === r` (always scoped).
   Seed is fixed (recorded in the evidence artifact); ≥500 cases per run.

**Artifact:** `docs/benchmarks/capability-audit/wiki-categorization-evidence.md` — MUST include the fast-check seed and the two invariant predicates above.

### Task 2.C6: Capability 6 — Dreamer consolidator (4-layer) **[PRIME SUSPECT]**

**Capability file:** `packages/memory-engine/src/mongodb-consolidator.ts`

**Silent-bug risks:** cross-scope merge (catastrophic), provenance loss.

**4 layers:**
1. **Unit:** dedup math + merge-decision logic.
2. **Integration:** 10 events → consolidated memory; audit that every consolidated memory's `sourceEventIds` preserves provenance.
3. **E2E:** `POST /v1/consolidate` + read back through `/v1/search`.
4. **Correctness invariant:** fast-check → no consolidated memory's `sourceEventIds` span more than one `scopeRef`; cross-`scopeRef` merge NEVER occurs; seed recorded.

**Artifact:** `docs/benchmarks/capability-audit/dreamer-evidence.md` (fast-check seed; tag as PRIME-SUSPECT).

### Task 2.R5: Scope #2 + #3 merge

**Step 1:** Open PRs; merge in order 2 then 3; tag `pre-merge-scope-2`, `pre-merge-scope-3`.

### Phase 2 Checks

```bash
bun run lint
bun run check-types
bun run build
bunx vitest run packages/memory-engine/src/
bunx vitest run apps/api/src/
git diff --check
```

All exit 0.

### Phase 2 Artifacts

- `docs/benchmarks/capability-audit/reasoning-chain-evidence.md`
- `docs/benchmarks/capability-audit/novelty-evidence.md`
- `docs/benchmarks/capability-audit/access-tracking-evidence.md` [PRIME-SUSPECT]
- `docs/benchmarks/capability-audit/importance-decay-evidence.md` [PRIME-SUSPECT]
- `docs/benchmarks/capability-audit/wiki-categorization-evidence.md`
- `docs/benchmarks/capability-audit/dreamer-evidence.md` [PRIME-SUSPECT]
- `docs/benchmarks/capability-audit/bi-temporal-evidence.md` [ADR-006 scope expansion]
- `docs/benchmarks/capability-audit/poisoning-defense-evidence.md` [ADR-006 scope expansion]
- `docs/benchmarks/capability-audit/review-gate-evidence.md` [ADR-006 scope expansion]
- `docs/benchmarks/capability-audit/export-evidence.md` [ADR-006 scope expansion]
- `docs/benchmarks/silent-fallback-audit-2026-05-11.md`
- `docs/benchmarks/compound-boost-audit-2026-05-11.md`
- `docs/benchmarks/per-query-weighting-proposal-2026-05-11.md` (pass-3 C3 proposal)
- `docs/benchmarks/enn-fallback-proposal-2026-05-11.md` (pass-3 C4 proposal)
- `docs/benchmarks/hyde-sibling-route-roadmap-2026-05-11.md` (pass-3 C5 roadmap)
- `docs/benchmarks/reranker-bakeoff-matrix-2026-05-11.md` (pass-3 C6 matrix spec)
- `pre-merge-scope-2`, `pre-merge-scope-3` tags

### Phase 2 Checkpoint Type: `human_verify`

### Phase 2 Failure Response

- Any capability missing a layer → block Gate 3; file a fix branch; re-run Gate 2.
- Capability-evidence fast-check seed reveals a bug → file scope #2 hotfix branch; land fix; regenerate evidence.

---

## Phase 3 — Gate 3: Strict 1/Type Canary Re-Run

> **Exit Criteria:** (a) Bootstrap Sub-Sequence B1–B5 green (pass-1 F2). (b) Strict 1/type canary completes 6/6 cases scored, `missLedger=[]`, `caseDiagnostics=[]`, `any@1=1` session + turn, zero warnings, zero degradations. (c) `benchmarkReport` carries every Task-1.A parity field populated (null-with-reason is acceptable only for `storage.*` when `collStats` is unsupported on atlas-local:preview) — pass-1 F5. Artifact at `$MEMONGO_CANARY_ARTIFACT_DIR/` (default `artifacts/canary-runs/gate3-strict-1pertype-{timestamp}/`).

**Scopes merged in this phase:** none.

### Task 3.1: Run strict 1/type canary

**Precondition (pass-1 F1 + F2 + F5 response):**
- Tasks 1.0, 1.A, 1.1–1.8 all green (Task 1.0 adds the env-var contract, Task 1.A adds the envelope parity fields).
- Bootstrap Sub-Sequence (B1–B5) has run; `bootstrap.json` is in the target artifact dir.
- `@memongo/api` process is running and healthy at `http://127.0.0.1:${MEMONGO_API_PORT:-3847}/health`.

**Command:**
```bash
GATE_LABEL=gate3-strict-1pertype
export MEMONGO_CANARY_ARTIFACT_DIR="artifacts/canary-runs/${GATE_LABEL}-$(date +%s)"
mkdir -p "$MEMONGO_CANARY_ARTIFACT_DIR"
# Run bootstrap sub-sequence B1-B5 (see above) before proceeding.
export MEMONGO_BENCHMARK_STRICT=1
export MEMONGO_LLM_ENRICHMENT_STRICT=1
export MEMONGO_CANARY_CASES_PER_TYPE=1
export MEMONGO_ENRICHMENT_CONCURRENCY=3
export MEMONGO_LLM_ENRICHMENT_MAX_TOKENS=2048
export MEMONGO_LOG_LEVEL=warn
bun run scripts/run-longmemeval-canary.ts 2>&1 | tee "$MEMONGO_CANARY_ARTIFACT_DIR/run.log"
```

**Expected:** exit 0 within 30 minutes. Artifact contains:
- `bootstrap.json` (from B5 — confirms API + MongoDB + dataset)
- `canary-artifact.json` with git SHA, dataset SHA-256, models, flags
- `progress/0.json` … `progress/5.json` (6 scenarios), each carrying the parity-field subset from Task 1.A
- `benchmark-response.json` containing `benchmarkReport` with every Task-1.A parity field present and non-null (or explicitly null with reason for `storage.*` only if `collStats` unsupported on atlas-local:preview)
- `summary.json` with `hitRate=1`, `emptyRate=0`, `r@5=1`, `r@10=1`, `ndcg@10=1`, `any@1=1`, `missLedger=[]`, `caseDiagnostics=[]`.

**Exit criterion (Gate 3):** all bullets above AND every Task-1.A parity field is populated (or explicitly null-with-reason for `storage` only). If any parity field is missing or unexplained-null, Gate 3 FAILS and Task 1.A is re-opened.

### Task 3.2: Decision-log update

**Files:**
- Modify: `docs/benchmarks/longmemeval-decision-log.md`

**Step 1:** Append entry with run id, timestamp, outcome, commit SHA.

**Step 2:** Commit.

### Phase 3 Checkpoint Type: `human_verify`

### Phase 3 Failure Response

- Any miss → re-investigate with miss-ledger + case diagnostics BEFORE changing retrieval logic (avoids tuning-for-1/type anti-pattern).
- `harness-timeout` class → block Gate 4; return to Phase 1.

---

## Phase 4 — Gate 4: Strict 8/Type Canary (First Honest Attempt)

> **Exit Criteria:** (a) Bootstrap Sub-Sequence B1–B5 green. (b) 48/48 cases scored with Task-1.A parity fields populated OR classified failure at exact scenario inside 60 minutes with `failure.json` carrying bootstrap identity. Artifact at `$MEMONGO_CANARY_ARTIFACT_DIR/` (default `artifacts/canary-runs/gate4-strict-8pertype-{timestamp}/`).

### Task 4.1: Run strict 8/type canary

**Precondition (pass-1 F1 + F2 response):** Bootstrap Sub-Sequence B1–B5 green; `@memongo/api` healthy; Task 1.0 + Task 1.A shipped.

**Command:**
```bash
GATE_LABEL=gate4-strict-8pertype
export MEMONGO_CANARY_ARTIFACT_DIR="artifacts/canary-runs/${GATE_LABEL}-$(date +%s)"
mkdir -p "$MEMONGO_CANARY_ARTIFACT_DIR"
# Bootstrap (B1–B5) before proceeding.
export MEMONGO_BENCHMARK_STRICT=1
export MEMONGO_LLM_ENRICHMENT_STRICT=1
export MEMONGO_CANARY_CASES_PER_TYPE=8
export MEMONGO_LOG_LEVEL=warn
timeout 3600 bun run scripts/run-longmemeval-canary.ts 2>&1 | tee "$MEMONGO_CANARY_ARTIFACT_DIR/run.log"
```

**Expected:** exit 0 with 48 progress files OR exit non-zero with `failure.json` before timeout. Every scenario's `progress/{idx}.json` carries Task-1.A parity fields.

**Kill switch:** if no new `progress/*.json` in 10 minutes, abort and classify as `harness-timeout`.

### Task 4.2: Classify outcome

- **Outcome A (48/48 scored):** update decision log; proceed to Phase 5.
- **Outcome B (classified failure):** root-cause per `failureClass`; do NOT patch retrieval in the same session. File specific diagnostic for next working session.

### Phase 4 Checkpoint Type: `decision` — builder presents outcome to user; user decides whether to continue to Phase 5 or loop back.

---

## Phase 5 — Gate 5: Full Benchmark Matrix

> **Exit Criteria:** (a) Bootstrap Sub-Sequence B1–B5 green for the Gate 5 run (pass-1 F2). (b) Full LongMemEval-S (500 cases, strict, zero fallback) produces `$MEMONGO_CANARY_ARTIFACT_DIR/` with all Task-1.A parity fields populated (pass-1 F5). (c) MemPalace reproduction artifact exists at `docs/benchmarks/comparison-2026-05/mempalace-reproduction.md` satisfying Task 5.2's Step-6 contents and Step-5 exit criterion — either within ±3 R@5 tolerance (using both MemPalace-custom-scorer and LongMemEval-official-judge columns per pass-3 D3) OR labeled `not-equivalent` with a complete asymmetry list (including pass-3 D1 test-set-leakage enforcement for v2/v3/v4) OR labeled `unreproducible` with the Memongo-comparative-claim downgrade applied (pass-1 F4). (d) Scopes #4 and #5 merged. (e) **Pass-3 ADR-007:** E2E QA lane (Task 5.E2E) with named judge and adversarial judge probe (Task 5.adv) both populated — `benchmarkReport.e2eQa.*` required. (f) **Pass-3 B1:** benchmark-matrix (Task 5.roadmap) lists BEAM + MemoryAgentBench roadmap rows. (g) **Pass-3 B4:** held-out-split R@5 drift check against public split is within 5 points (internal only, not published). (h) **Pass-3 B5:** README reserves "Benchmark corrections and caveats" section (shipped empty; filled if needed).

**Scopes merged in this phase:** Scope #4 (api-security) and Scope #5 (hermes).

### Task 5.1: Full LongMemEval-S run

**Precondition (pass-1 F1 + F2 + F5 response):** Tasks 1.0, 1.A shipped; Bootstrap Sub-Sequence B1–B5 green; `@memongo/api` healthy; `MEMONGO_CANARY_FULL=1` env-var route (Task 1.0) in place.

**Command:**
```bash
GATE_LABEL=gate5-full-longmemeval
export MEMONGO_CANARY_ARTIFACT_DIR="artifacts/canary-runs/${GATE_LABEL}-$(date +%s)"
mkdir -p "$MEMONGO_CANARY_ARTIFACT_DIR"
# Bootstrap (B1–B5) before proceeding.
export MEMONGO_BENCHMARK_STRICT=1
export MEMONGO_LLM_ENRICHMENT_STRICT=1
export MEMONGO_LOG_LEVEL=warn
export MEMONGO_CANARY_FULL=1
timeout 18000 bun run scripts/run-longmemeval-canary.ts 2>&1 | tee "$MEMONGO_CANARY_ARTIFACT_DIR/run.log"
```

**Expected:** 500/500 scored. `benchmark-response.json.benchmarkReport` carries every Task-1.A parity field populated (including `storage.collectionBytes`, `storage.indexBytes`, `cost.*`, `latency.{p50Ms,p95Ms}`, `reranker.*`, `embedding.*`, `runIdentity.datasetSha256`, `runIdentity.retrievalUnit`). Per-case JSONL + summary metrics + run identity present.

**Exit criterion (Gate 5):** 500/500 AND all parity fields populated (non-null). Missing field → Gate 5 fails; remediation routes back to Task 1.A.

### Task 5.2: MemPalace reproduction lane (resolves pass-1 F4)

> **Pass-1 F4 response.** The prior plan described this as "run at least one MemPalace mode ourselves" — insufficient for the honesty posture. This task now expands to a 7-step reproduction-first sub-sequence with an explicit exit criterion, an artifact contents list, and a fallback for unreproducible codebases.

**Objective:** Reproduce MemPalace's headline LongMemEval-S number ourselves on the same dataset and commit SHA, under the same retrieval unit, before any comparative claim is published.

**Step 1 — Clone MemPalace and pin a commit (pass-3 A6 URL correction + pass-3 D1/D2/D3 mode enforcement):**
```bash
cd /tmp
rm -rf mempalace-repro
# Pass-3 A6: Agent 3 code audit confirmed canonical repo is MemPalace/mempalace (branch develop,
# commit 68319dc at time of audit), NOT milla-jovovich/mempalace. All prior references are corrected.
git clone https://github.com/MemPalace/mempalace.git mempalace-repro
cd mempalace-repro
git checkout develop
MEMPALACE_SHA="$(git rev-parse HEAD)"
echo "MemPalace repo: github.com/MemPalace/mempalace branch develop commit ${MEMPALACE_SHA}" \
  | tee "${MEMONGO_CANARY_ARTIFACT_DIR}/mempalace-commit.txt"
```
> If the URL does not resolve at execution time, update it in place and re-record the commit SHA in the artifact. The plan pins the repo identity at audit time (`MemPalace/mempalace@develop@68319dc`) and enforces that the reproduction records the actual repo URL and commit SHA used.

**Step 2 — Select mode: Raw OR held-out-450 (pass-3 D1 test-set-leakage enforcement).** MemPalace's `hybrid_v4` has SELF-DOCUMENTED test-set leakage — `benchmarks/longmemeval_bench.py:1339-1366` names three question IDs (`d6233ab6`, `4dfccbf8`, `ceb54acb`) as "the final 3 misses" that hybrid_v4 patches; `BENCHMARKS.md:88-94` calls v4 "teaching to the test". Therefore: **when comparing with MemPalace, we enforce `--mode raw` OR a `held-out-450` split (pass-3 B4).** v2/v3/v4 numbers CANNOT be cited without an explicit asterisk. The forensic-audit doc (Task 0.1 Step 3) already records this asymmetry.

MemPalace's 96.6% R@5 headline is their **Raw mode** (no API key required per their public disclosure; verified in `docs/benchmarks/mempalace-forensic-audit.md` at Phase 0 Task 0.1). Run Raw first. If Raw reproduces within tolerance, optionally repeat for Hybrid (Haiku-rerank) as a second lane, ANNOTATED with the test-set-leakage caveat. Do NOT start with Hybrid.

**Step 3 — Dataset parity.** Use the identical LongMemEval-S dataset file (`longmemeval_s_cleaned.json`) with the identical SHA-256 recorded in our Task 5.1 run. Write the dataset SHA to `docs/benchmarks/comparison-2026-05/mempalace-reproduction.md` header.

**Step 4 — Run MemPalace's benchmark command verbatim.** Document the exact command (copy from their README / CLI / benchmark script) in the artifact. Example shape:
```bash
# (exact command to be copied from MemPalace repo; example placeholder:)
python -m mempalace.bench.longmemeval \
  --dataset /abs/path/to/longmemeval_s_cleaned.json \
  --mode raw \
  --output "${MEMONGO_CANARY_ARTIFACT_DIR}/mempalace-raw-output.jsonl"
```
> The canary harness does NOT run MemPalace's code through our API; MemPalace owns its own runtime. We are reproducing **their** number on **their** code with **the same** dataset.

**Step 5 — Exit criterion (tolerance, with dual-scorer columns — pass-3 D3):** Our reproduction of MemPalace Raw R@5 comes within **±3 absolute points** of their published 96.6% headline (i.e., observed R@5 ∈ [93.6%, 99.6%]). Because MemPalace's scorer is a **CUSTOM R@k/NDCG implementation, NOT the official LongMemEval QA judge** (pass-3 D3), every comparison table MUST publish **two columns per metric**:
  - **Column A:** "MemPalace-custom-scorer" — our reproduction scored by MemPalace's own scorer.
  - **Column B:** "LongMemEval-official-judge" — our reproduction scored by the official LongMemEval QA judge.
  These two columns are never mixed into a single "score" cell. Category-error claims ("our R@5 beats MemPalace's QA accuracy") are forbidden.

If within tolerance on Column A, the MemPalace baseline is validated and we may publish an apples-to-apples comparison row. If outside tolerance:
  - Document every asymmetry we could not match (dataset version, retrieval unit granularity, embedding model, rerank model, pre/post-processing steps, any dataset cleaning step, any prompt shim).
  - Label the comparison lane **"not-equivalent"** before publishing any comparison.

**Step 5a — Mem0 reproduction posture (pass-3 D2):** Mem0's published 93.4 is unverifiable from OSS code — their `eval/` tree is LoCoMo-only and runs against Mem0 Cloud with a monkey-patched benchmark-specific extraction prompt. Therefore: **for Mem0 specifically, "reproduction" downgrades to "reproduce Mem0 cloud with their monkey-patched extraction prompt fully disclosed".** We cannot reproduce their LongMemEval number from OSS code. The artifact MUST document: (a) Mem0's `eval/` scope is LoCoMo, (b) their benchmark-specific extraction prompt is not in OSS, (c) any Mem0 comparison cell is labeled "Mem0-cloud-reported + monkey-patched-prompt-disclosed" and carries an asterisk. The plan's comparative-claim posture for Mem0 is "acknowledge their reported number; cannot OSS-verify; transparent fallback".

**Step 5b — Multi-tenant positioning (pass-3 D4):** Competitor multi-tenant enforcement: Letta enforces at ORM level (strongest); Mem0 at API filter; MemPalace not at all; Zep SOC 2 managed only. Memongo's scope-level isolation (filter-first on `agentId + scope + scopeRef`) is more rigorous than MemPalace/Mem0 but less enforced than Letta (for now — no per-tenant auth boundary). Record this in `docs/benchmarks/comparison-2026-05/positioning.md` as a known-gap-with-roadmap item. Do NOT claim "Memongo is multi-tenant" in launch copy — product framing stays "OSS / self-host" per pass-3 E8.

**Step 6 — Artifact contents.** `docs/benchmarks/comparison-2026-05/mempalace-reproduction.md` MUST include:
  - MemPalace repo URL (`MemPalace/mempalace` per pass-3 A6) and pinned commit SHA (`mempalace-commit.txt`).
  - Dataset path and SHA-256 (public split; held-out split R@5 recorded only privately per pass-3 B4).
  - Exact reproduction command (mode = Raw OR held-out-450 per pass-3 D1).
  - Per-case output sample (first 3 cases).
  - **Dual-scorer table (pass-3 D3):** Column A = MemPalace-custom-scorer, Column B = LongMemEval-official-judge. Each metric (R@5, R@10, NDCG@10) appears in both columns.
  - Observed R@5 (ours running their code) vs their published 96.6% — annotated with which scorer produced each number.
  - Methodology diff table with at minimum: `retrieval unit`, `embedding model`, `reranker model`, `dataset cleaning`, `answer generation`, `multi-tenant enforcement posture` rows, each column being `MemPalace-reported` vs `Our-reproduction`.
  - **Test-set-leakage column (pass-3 D1):** explicit note for any v2/v3/v4 cell that MemPalace self-documented test-set leakage on question IDs `d6233ab6`, `4dfccbf8`, `ceb54acb` and that these numbers carry an asterisk.
  - **Mem0 posture row (pass-3 D2):** explicit note that Mem0's OSS `eval/` does not include LongMemEval; any Mem0 comparison is labeled "Mem0-cloud-reported, not OSS-verifiable, monkey-patched-prompt-disclosed".
  - Comparative status: `equivalent` (within ±3) OR `not-equivalent` with an asymmetry list.

**Step 7 — Fallback (unreproducible codebase).** If the MemPalace codebase is unreproducible (broken build, missing undocumented dependency, non-public data, etc.), the artifact records that explicitly — and every comparative claim Memongo publishes downgrades to **"MemPalace-reported, unverifiable"**. No Memongo comparison can claim "beats MemPalace" without this artifact existing at a non-fallback state.

**Step 8 — Hybrid mode (optional, follow-on).** If Raw reproduction succeeds, repeat Steps 1–6 for MemPalace Hybrid mode (if accessible). If inaccessible (e.g., requires Anthropic key they control), document that and skip.

**Exit criterion (Task 5.2):** either (a) reproduction within ±3 tolerance for Raw mode with a complete artifact; (b) not-equivalent lane with complete asymmetry list; or (c) unreproducible with an explicit downgrade of every comparative Memongo claim. There is no silent "skip" path.

### Task 5.3: Retrieval-quality roadmap evaluation

Evaluate and document:
- `numCandidates` recall curve at (50, 100, 200, 400, 600).
- Default `$rankFusion` weights vs an experimental 0.6/0.4 text-heavy for LongMemEval-S profile (log `scoreDetails`).
- Quantization: stay `float32` for LongMemEval-S (MCP Finding #2).
- Per-query weighting evaluation (Task 2.R6 proposal).
- ENN fallback for small corpora (Task 2.R7 proposal).
- HyDE sibling route evaluation (Task 2.R8 roadmap).
- Reranker bake-off: Voyage vs Cohere Rerank 4 vs ZeroEntropy zerank-2 (Task 2.R9 matrix).

### Task 5.E2E: Phase-2 E2E QA lane with named judge (pass-3 B2 / ADR-007)

> Community expectation is full E2E QA with a named judge model. Named baselines: Mastra 94.87%, Letta 83.2%, Zep 63.8%, Mem0 49.0%. Gate 5 exit criterion now requires BOTH retrieval metrics AND E2E QA metrics before any comparative claim.

**Scope-lifecycle note (pass-3 plan-gap-review advisory):** Scope 3 (`scope-3-docs-benchmarks`) and the Scope 1/2 hunks of `mongodb-benchmark-runner.ts` are already merged to `main` by Phase 2. Phase 5 edits to those files land via **`scope-3-followup-phase5` branched from `main`** (a new short-lived follow-on branch) — NOT by re-opening the closed scope branches. Tag the follow-on `pre-merge-scope-3-followup-phase5` before merge.

**Files (on `scope-3-followup-phase5` branched from `main`):**
- Create: `scripts/run-longmemeval-e2e-qa.ts` — orchestrates retrieval → LLM-answer → judge flow.
- Modify: `packages/memory-engine/src/mongodb-benchmark-runner.ts` — add `e2eQa: { judge, judgeVersion, accuracy, latencyMs, judgeFalsePositiveRate }` block to the benchmark envelope (blocks Gate 5 exit). Envelope extension is the superset documented in Task 1.A's table.
- Create: `docs/benchmarks/e2e-qa-matrix-2026-05-11.md`.

**Step 1:** Choose judge: **Sonnet 4.6 primary, GPT-5.5 secondary.** Both are NAMED in every artifact; never elide the judge model.

**Step 2:** Pipeline: per case, retrieve top-K → prompt an answer-generation model (Sonnet 4.6 default, configurable) → pass generated answer to judge → judge returns `{correct, reasoning}` → accumulate accuracy.

**Step 3:** The envelope's `e2eQa.judgeFalsePositiveRate` field (from Task 5.adv) MUST be populated in the same artifact.

**Step 4:** Comparative matrix row lists: Memongo (E2E QA with Sonnet 4.6 judge) next to Mastra 94.87, Letta 83.2, Zep 63.8, Mem0 49.0.

**Exit criterion:** Gate 5 exit requires BOTH `benchmarkReport.retrieval.*` AND `benchmarkReport.e2eQa.*` fields populated; missing either blocks Gate 5.

### Task 5.adv: Adversarial judge probe (pass-3 B3)

> PenfieldLabs measured 63% FP rate on vague wrong answers with GPT-4o judge. Memongo publishes its own judge FP rate as a signature honesty metric no competitor publishes.

**Files:**
- Create: `scripts/run-adversarial-judge-probe.ts`.
- Append: envelope `e2eQa.judgeFalsePositiveRate` field.

**Step 1:** Generate adversarial cases — wrong-but-topical answers for 30 LongMemEval-S questions. Keep diverse wrong-answer shapes (swap entities, swap dates, negation flip, topic drift).

**Step 2:** Feed adversarial answers through the E2E QA judge (Sonnet 4.6). Record judge verdict per case.

**Step 3:** Compute FP rate = (judge marked "correct" / total adversarial cases).

**Step 4:** Publish rate in `docs/benchmarks/adversarial-judge-probe-2026-05-11.md` on `scope-3-docs-benchmarks`. Column is labeled "judge-FP-rate (Sonnet 4.6)".

**Exit criterion:** FP-rate artifact exists; `e2eQa.judgeFalsePositiveRate` populated in Gate 5 envelope.

### Task 5.roadmap: BEAM + MemoryAgentBench follow-on lanes (pass-3 B1)

> LongMemEval-S is weakening (Vectorize, r/AIMemory, arxiv 2510.27246 BEAM, OpenReview DT7JyQC3MR MemoryAgentBench consensus). Fits in 200K context; more a context-window management test than a memory-architecture test. These follow-on lanes do NOT block Gate 5 exit but MUST appear in the benchmark-matrix artifact as committed roadmap.

**Files (on `scope-3-followup-phase5` branched from `main` — same follow-on branch as Task 5.E2E; see its scope-lifecycle note):**
- Modify: `docs/benchmarks/benchmark-matrix.md` — add BEAM + MemoryAgentBench roadmap rows with citations (arxiv 2510.27246 / OpenReview DT7JyQC3MR).

**Exit criterion:** Matrix artifact lists BEAM and MemoryAgentBench roadmap rows with target execution window (post-Gate-5).

### Task 5.4: Merge Scope #4 + #5

Tag `pre-merge-scope-4`, `pre-merge-scope-5`.

### Phase 5 Checkpoint Type: `decision` — user sees final numbers before any public positioning.

---

## Phase 6 — Gate 6: Public Launch Polish

> **Exit Criteria:** README first screen says "MongoDB-native long-term AI memory" clearly. Fresh clone passes all checks. Scope #6 merged.

**Scopes merged in this phase:** Scope #6 (web-misc).

### Task 6.1: Fresh-clone verification

**Command:**
```bash
cd /tmp && rm -rf memongo-fresh && git clone <repo> memongo-fresh && cd memongo-fresh
bun install
bun run check-types
bun run lint
bun run build
bun run test
bun run check-publishability
```

**Expected:** every command exit 0. Save transcript to `artifacts/fresh-clone-gate6-{timestamp}.txt`.

### Task 6.2: Merge Scope #6

Tag `pre-merge-scope-6`.

### Task 6.3: Positioning reframe (pass-3 E1 / E2 / E7 / E8)

> Anthropic Dreaming (May 6 2026) and MongoDB LangGraph.js Long-Term Memory Store (May 7 2026) commoditize parts of our pitch. We reframe from "MongoDB-native memory framework with Dreamer" to "scoped, inspectable, durable agent memory built on MongoDB with benchmark-validated consolidation". Launch copy honesty: Memongo's current release is OSS/self-host only; managed/multi-tenant SaaS requires scope-level authorization which is a known-gap-with-roadmap (pass-3 E8).

**Scope-lifecycle note (pass-3 plan-gap-review advisory):** Scope 3 (`scope-3-docs-benchmarks`) is already merged to `main` by Phase 2. Phase 6 docs edits land via **`scope-3-followup-phase6` branched from `main`** (a fresh follow-on branch, separate from `scope-3-followup-phase5`). Tag the follow-on `pre-merge-scope-3-followup-phase6` before merge.

**Files (on `scope-3-followup-phase6` branched from `main`):**
- Modify: `README.md` (update tagline, add "Benchmark corrections and caveats" section empty — pass-3 B5).
- Modify: `docs/platform/self-host.md` — adopt episodic/semantic/procedural vocabulary (pass-3 E7).
- Modify: `docs/reference/memory-config.md` — adopt episodic/semantic/procedural vocabulary.
- Modify: positioning section — explicit OSS/self-host language (pass-3 E8).

**Step 1:** Update README first screen: "Scoped, inspectable, durable agent memory built on MongoDB." MongoDB is the proof, not the hook (pass-3 E2). Replace any "Dreamer" hero mention with "benchmark-validated consolidation with importance-decay + novelty surprisal" (pass-3 E1 — `Dreamer` name stays internal-only, not the launch hook).

**Step 2:** Add the section `## Benchmark corrections and caveats` (pass-3 B5) with text: "Memongo reserves this section for dated corrections and methodology caveats. Entries appear here if we later learn we overstated a number or mislabeled a lane. Ship-empty at v1; fill if needed." Date the section header.

**Step 3:** Adopt episodic/semantic/procedural vocabulary in docs (pass-3 E7). Example: "Events are episodic; consolidated memories are semantic; action routines are procedural."

**Step 4:** Positioning section (new or updated in README) explicitly says: "Memongo v1 ships OSS / self-host. Scope-level isolation is filter-first on `(agentId, scope, scopeRef)`. Managed/multi-tenant SaaS with scope-level API authorization is on the roadmap; not shipped in v1." (pass-3 E8; mirrors pass-3 D4 multi-tenant posture.)

**Exit criterion:** README first screen + positioning + caveats section + episodic/semantic/procedural vocabulary in docs.

### Phase 6 Checkpoint Type: `human_verify`

---

## Phase 7 — Gate 7: History Cleanup (HITL, BLOCKING)

> **Exit Criteria:** Fresh clone post-force-push passes Gate 6 checks. Backup tag exists. Repo is standalone (not fork).

### Task 7.1: Create backup tag

```bash
git tag pre-history-rewrite-$(date +%Y-%m-%d) HEAD
git push origin pre-history-rewrite-$(date +%Y-%m-%d)
```

### Task 7.2: User explicit confirmation gate

**[CHECKPOINT — decision]** Builder MUST pause and get explicit user confirmation before any force-push.

### Task 7.3: Orphan main + force-push

**Only after Task 7.2.**

### Task 7.4: Post-rewrite verification

Repeat Task 6.1 on fresh clone.

### Phase 7 Checkpoint Type: `human_action`

---

## Phase Autonomy Classification

| Phase | Checkpoint Type | Classification | Reason |
|---|---|---|---|
| Phase 0 | human_verify | HITL | File-partition table requires user confirmation before hunk splits |
| Phase 1 | human_verify | HITL | Scope #1 merge + forced-failure proof requires user sign-off before Gates 3+ |
| Phase 2 | human_verify | HITL | Capability-audit evidence requires user review; prime-suspect findings may need new scope branches |
| Phase 3 | human_verify | HITL | 1/type miss investigation requires user-approved retrieval-logic change decisions |
| Phase 4 | decision | HITL | Outcome A vs B fork has material implications for Phase 5 start |
| Phase 5 | decision | HITL | Final numbers gate public positioning; required user review |
| Phase 6 | human_verify | HITL | Fresh-clone transcript requires user sign-off before launch copy |
| Phase 7 | human_action | HITL | Force-push is irreversible without backup tag; explicit user confirmation mandatory |

There are no AFK phases in this plan. Every phase is HITL by design — benchmark integrity demands it.

## Live Verification Strategy

- **Harness manifest:** `scripts/run-longmemeval-canary.ts` is the canonical driver; the `POST /v1/admin/relevance/benchmark` endpoint in `apps/api/src/routes/v1.ts` is the inner engine entry.
- **Setup command:** `docker compose -f docker/mongodb/docker-compose.benchmark.yml up -d` (waits for atlas-local:preview on `:27018` and mongot to come up). Pass-3 A4 correction: prior `cd docker && docker compose -f docker-compose.benchmark.yml up -d` was wrong; the compose file lives at `docker/mongodb/docker-compose.benchmark.yml`, not `docker/docker-compose.benchmark.yml`. Every other reference in this plan uses the correct path; this was the sole mismatch.
- **Reset command:** `MEMONGO_MONGODB_COLLECTION_PREFIX=memongo_bench_$(date +%s) …` — per-run prefix isolates collections; explicit drop on cleanup.
- **Seed command:** the canary selects 6 (1/type) or 48 (8/type) or 500 (full) evaluations from `longmemeval_s_cleaned.json` via stable sort on `question_id`; no mutation of source dataset.
- **Health command:** `curl -sS -f http://127.0.0.1:${MEMONGO_API_PORT:-3847}/health`. Uses the existing `GET /health` endpoint in `apps/api/src/app.ts:206` (pass-1 F2 response — prior plan's `/healthz` reference was incorrect). No new endpoint is required; no Scope #4 dependency.
- **Cleanup command:** drop the run-specific collection prefix: `mongosh --port 27018 --eval 'db.getSiblingDB("memongo").getCollectionInfos({name:/^memongo_bench_/}).forEach(c=>db.getSiblingDB("memongo")[c.name].drop())'`.
- **First-party boundaries:** API, engine, MongoDB atlas-local:preview = first-party. Voyage embeddings, Voyage reranker, Anthropic Sonnet 4.6 = external (strict mode aborts on failure; no mocks).
- **Named proof scenarios:** Gate 1 forced-failure (injects unreachable Voyage URL), Gate 3 1/type clean, Gate 4 8/type 48-case, Gate 5 full 500-case.
- **Stress command:** `MEMONGO_CANARY_CASES_PER_TYPE=8 MEMONGO_ENRICHMENT_CONCURRENCY=6` (double concurrency) to measure probe behavior under load; pass threshold = 100% success at baseline, `p95LatencyMs < 2×` baseline at 2× concurrency. Run during Phase 5 as a Gate 5 acceptance test.
- **Missing live coverage:** answer-generation lane is explicitly deferred to Gate 5 full matrix; LoCoMo / ConvoMem / MemBench lanes are deferred to Gate 5+.

## Phase Plan (Summary)

| Phase | phase_id | Scopes merged | Key commands |
|---|---|---|---|
| 0 | gate0-stop-bleeding | (none; creates 6 branches + optional Scope 7 if review-gate UI lands separately) | branch creation from `main`, forensic audit write, MongoDB 8.3+ survey (Task 0.6), held-out split (Task 0.7) |
| 1 | gate1-harness-reliability | scope-1 | `bun add -D fast-check` (Task 1.-1), `bunx vitest run …manager.test.ts …benchmark-runner.test.ts …canary.test.ts`, forced-failure canary |
| 2 | gate2-baseline-and-capability-audit | scope-2, scope-3 (includes scope-expansion tasks SE-1, SE-2; scope-3 includes proposal artifacts R6/R7/R8/R9) | `bun run lint && check-types && build`, 6 core capability evidence runs + 4 scope-expansion evidence runs |
| 3 | gate3-strict-1pertype | (none) | strict 1/type canary + mongot-lag check (B5a) |
| 4 | gate4-strict-8pertype | (none) | strict 8/type canary (60-min budget) |
| 5 | gate5-full-matrix | scope-4 (incl SE-4 export), scope-5, optionally scope-7 (review UI) | full 500-case, MemPalace reproduction, E2E QA lane (Task 5.E2E), adversarial judge (Task 5.adv), reranker bake-off (Task 5.3→2.R9), BEAM roadmap (Task 5.roadmap) |
| 6 | gate6-public-launch-polish | scope-6 (+ scope-7 if not landed earlier) | fresh-clone verification, positioning reframe (Task 6.3) |
| 7 | gate7-history-cleanup | (none) | backup tag, orphan main, force-push |

## Acceptance Checks (aggregated, per phase)

| Phase | Command / Check | Expected |
|---|---|---|
| 0 | `git branch --list 'scope-*' \| wc -l` | `6` |
| 0 | `test -f docs/benchmarks/mempalace-forensic-audit.md` | exit 0 |
| 0 | `test -f docs/benchmarks/recommended-defaults-signoff-2026-05-11.md` (Task 0.5) | exit 0 |
| 0 | `git show --name-only bd1f5ba691 --format=''` yields exactly 48 files AND all 48 appear in partition table | manual verify |
| Bootstrap | B1 tool-availability script | exit 0 |
| Bootstrap | B2 docker compose + health poll | `memongo-benchmark-preview` healthy within 60s |
| Bootstrap | B4 `curl -sS -f http://127.0.0.1:${MEMONGO_API_PORT:-3847}/health` | exit 0 |
| 1 | `bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts packages/memory-engine/src/mongodb-benchmark-runner.test.ts packages/memory-engine/src/mongodb-benchmark-readiness.test.ts scripts/run-longmemeval-canary.test.ts packages/memory-engine/src/benchmark-failure-taxonomy.test.ts` | exit 0 |
| 1 | forced-failure canary → `$MEMONGO_CANARY_ARTIFACT_DIR/failure.json` with `failureClass`, wall-clock < 300s | PASS |
| 1 | Task-1.A envelope: `benchmarkReport.runIdentity.datasetSha256` is 64-hex-char | PASS |
| 2 | `bun run lint && bun run check-types && bun run build` | exit 0 |
| 2 | `ls docs/benchmarks/capability-audit/*.md \| wc -l` | `6` |
| 3 | strict 1/type artifact `summary.json` has `missLedger=[]`, `any@1=1`, 6 scored | PASS |
| 3 | strict 1/type `benchmarkReport` has every Task-1.A parity field (null-with-reason acceptable only for `storage.*` if collStats unsupported) | PASS |
| 4 | strict 8/type artifact `summary.json` has 48 scored OR classified failure under 60 min | PASS |
| 4 | strict 8/type `benchmarkReport` has every Task-1.A parity field populated | PASS |
| 5 | full LongMemEval-S artifact has 500/500 + all parity fields populated | PASS |
| 5 | `docs/benchmarks/comparison-2026-05/mempalace-reproduction.md` exists with pinned MemPalace SHA, dataset SHA, exact command, R@5 observed vs published, methodology diff table, and comparative status | PASS |
| 6 | fresh-clone passes all 6 commands | exit 0 |
| 7 | post-force-push fresh-clone passes Gate 6 | exit 0 |

## Risks And Mitigations

| Risk | Dimension | P | I | Score | Mitigation |
|---|---|---|---|---|---|
| Hunk-split mistake contaminates scope-1 with retrieval hunks | Quality | 3 | 5 | 15 | Post-split diff verification in Task 0.3; user checkpoint before merge; pass-3 A1 corrected branch procedure in Task 0.2 (branch from `main`, selective `git checkout checkpoint -- files`) |
| `$listSearchIndexes` unsupported on atlas-local:preview | Technical | 2 | 3 | 6 | Fallback path in Task 1.5 (hardened aggregate probe); test case pinned; pass-3 A2 `queryable` field asserted |
| Capability 4 invariant reveals silent `temporalScope` bug | Quality | 3 | 5 | 15 | Fix on scope-2 hotfix branch BEFORE Gate 3 runs; block benchmark claim |
| Capability 6 cross-scope merge discovered | Security | 2 | 5 | 10 | Treat as product correctness emergency; block all downstream gates; fix + rerun |
| 8/type hangs again despite harness fixes | Technical | 2 | 5 | 10 | 10-minute no-progress kill switch + classified artifact; immediate Phase 1 revisit |
| `$rankFusion` weight tuning tempts dataset-specific optimization | Quality | 3 | 4 | 12 | Lock 0.5/0.5 until Gate 5; log `scoreDetails` but don't tune for LongMemEval-S; pass-3 C3 per-query weighting stays as PROPOSAL until signed off |
| `$rankFusion` 2× latency acceptance backfires at scale | Technical | 2 | 3 | 6 | Published p50/p95 in Gate 5 matrix (ADR-004) — honest not hidden; reranker bake-off (Task 2.R9) provides fallback route |
| Voyage endpoint rate-limit during full 500 | Timeline | 3 | 3 | 9 | Retry with backoff within Voyage SDK; strict-mode abort after 3 retries; cost-budget section documents this |
| MemPalace publishes updated numbers mid-plan | Timeline | 4 | 2 | 8 | Don't chase; finish strict matrix; then add comparison row |
| Force-push loses stars | Security | 2 | 4 | 8 | Backup tag at Task 7.1 before any force-push; user confirmation gate at 7.2 |
| LongMemEval-S dataset SHA changes upstream | Technical | 2 | 3 | 6 | Pin SHA in every artifact; fail run if SHA differs from recorded |
| Capability audit reveals silent bug and delays Gate 3 by ≥1 session | Timeline | 3 | 2 | 6 | Session 2 explicitly reserved for capability audit; prime-suspects prioritized |
| Atlas-local:preview MongoDB version < 8.3 (pass-3 F2 / ADR-005) | Technical | 3 | 3 | 9 | Task 0.6 Step 0 version check; Open Decision #3 surfaces to user if 8.3 not reachable |
| fast-check not installed (pass-3 A3) | Technical | 1 | 5 | 5 | Task 1.-1 installs `fast-check` on `scope-1-harness-reliability` BEFORE any Phase 2 property test |
| MongoDB 8.3+ capability survey reveals ≥3 missing must-have features (pass-3 F1) | Quality | 3 | 4 | 12 | Task 0.6 Step 3 escalates to Open Decisions; user signs off before Gate 5; plan revision accepts scope growth or explicit deferral |
| Judge model FP rate is high (pass-3 B3) | Quality | 3 | 3 | 9 | Publish FP rate openly (Task 5.adv); swap judge model if > 30% FP; name both Sonnet 4.6 and GPT-5.5 options |
| Bi-temporal retrieval filter regresses existing queries (pass-3 E3) | Technical | 2 | 4 | 8 | Task 2.SE-1 property test + integration test; ship behind a capability flag if regression detected |
| Poisoning-defense false positives quarantine legitimate memories (pass-3 E5) | Quality | 3 | 3 | 9 | Task 2.SE-2 tier-1 patterns are conservative; tier-2 LLM classifier off by default; quarantined memories reviewable via Task 2.SE-3 gate |
| Review-gate web UI (Scope 7) timeline slip (pass-3 E4) | Timeline | 3 | 3 | 9 | Land review-gate API + bridge first (usable via curl); web UI ships as Scope 7 phased delivery |
| Export-signing key leak (pass-3 E6) | Security | 2 | 5 | 10 | `MEMONGO_EXPORT_SIGNING_KEY` via `~/.zshenv` only; never committed; rotation documented |
| `atlas-local:preview` 8.3 tag unavailable | Technical | 3 | 4 | 12 | Open Decision #3 handles; fallback to 8.2+ with 8.3+ roadmap |
| MemPalace self-documented test-set-leakage cited unaware (pass-3 D1) | Quality | 1 | 5 | 5 | Task 0.1 Step 3 records asymmetry; Task 5.2 Step 2 enforces Raw OR held-out-450; forensic audit doc is authoritative reference |
| Mem0 "reproduction" claim misread as OSS-verifiable (pass-3 D2) | Quality | 2 | 4 | 8 | Task 5.2 Step 5a explicit posture; Mem0 cells labeled "cloud-reported, not OSS-verifiable" |
| MemPalace custom-scorer vs LongMemEval-official-judge category error (pass-3 D3) | Quality | 3 | 4 | 12 | Dual-scorer columns in Task 5.2 artifact; never mix |
| Agent Invocation Contract not enforced by future BUILD agents (pass-3 F3) | Quality | 3 | 4 | 12 | Reviewer (pass-N) authorized to fail any BUILD task whose output lacks MongoDB skills or MCP citations; plan-wide invariant in `Agent Invocation Contract` section |
| Scope 7 vs Scope 6 partition decision not made at Phase 0 | Timeline | 2 | 2 | 4 | ADR-006 appendix defers to Task 0.3 review; default is Scope 7 for review UI |

## Summary

- Plan saved: `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md`
- Phases: **8** (Phase 0 through Phase 7 mapping 1:1 to Gates 0–7) + **Bootstrap Sub-Sequence** (B1–B5 + B5a mongot-lag) as a cross-phase infra precondition.
- Risks: **26** identified (14 added in pass-3); 10 with score ≥ 12 have explicit mitigations + checkpoints.
- Key decisions resolved: **5** (file partition, merge order, numCandidates table, failure-classification taxonomy, readiness-probe upgrade timing). Open Decisions remain honestly non-empty per pass-3 G5.
- ADRs: **8** (branch split strategy, readiness probe upgrade, hybrid search primary, `$rankFusion` latency acceptance, MongoDB 8.3+ floor + secret-weapon thesis, scope expansion — 4 features, Phase-2 E2E QA lane, agent invocation contract).
- Pass-1 fresh-review response: **5 BLOCKING findings (F1–F5) materially resolved + 6 advisory findings (A1–A6) addressed**.
- Pass-2 fresh-review: **PASS** with 8 code anchors verified.
- Pass-3 fresh-review response: **32 surgical patches applied in place** across 6 categories (A:6, B:5, C:6, D:4, E:8, F:3) + 5 structural (G1–G5). New sections: **Agent Invocation Contract** (F3 / ADR-008), **Scope Expansion Appendix** (4 user-approved features / ADR-006). New tasks: **0.6** (MongoDB 8.3+ survey / F1), **0.7** (held-out split / B4), **1.-1** (fast-check install / A3), **2.R6** (per-query weighting / C3), **2.R7** (ENN fallback / C4), **2.R8** (HyDE roadmap / C5), **2.R9** (reranker bake-off / C6), **2.SE-1** (bi-temporal / E3), **2.SE-2** (poisoning defense / E5), **2.SE-3** (human review gate / E4), **2.SE-4** (export / E6), **5.E2E** (E2E QA lane / B2), **5.adv** (adversarial judge / B3), **5.roadmap** (BEAM / B1), **6.3** (positioning reframe / E1/E2/E7/E8).

## 3-Session Starter Sequence (recommended execution order)

### Session 1 (3–4 hrs): Phase 0 + Phase 1 (Gates 0–1)
1. Task 0.1: Write `docs/benchmarks/mempalace-forensic-audit.md` (≈20 min).
2. Task 0.2 + 0.3: Create 6 scope branches; confirm file partition with user (≈45 min).
3. Tasks 1.1–1.7: Harness checklist items #1–#7 (≈2 hr).
4. Task 1.9: Forced-failure canary run → classified artifact (≈30 min).
5. Task 1.10: Scope #1 PR + merge (≈30 min).
6. **Exit:** Gate 1 green. Stop if not green; do not advance.

### Session 2 (3–4 hrs): Phase 2 (Gate 2 capability audit)
1. Task 2.C3 (access-tracking, PRIME-SUSPECT): 4-layer audit (≈60 min).
2. Task 2.C4 (importance-decay, PRIME-SUSPECT): 4-layer audit (≈60 min).
3. Task 2.C6 (Dreamer, PRIME-SUSPECT): 4-layer audit (≈60 min).
4. Tasks 2.C1, 2.C2, 2.C5: remaining capabilities (≈60 min combined).
5. Tasks 2.R1–2.R4: retrieval observability + numCandidates + boost audit (≈40 min).
6. Task 2.R5: Scope #2 + #3 merges (≈30 min).
7. **Exit:** Gate 2 green. All 6 capability evidence files exist and are honest.

### Session 3 (2–3 hrs): Phase 3 + first honest Phase 4 attempt (Gates 3–4)
1. Task 3.1: Strict 1/type canary re-run (≈30 min — must match or beat pre-harness 1/type).
2. Task 3.2: Decision-log update (≈10 min).
3. Task 4.1: Strict 8/type canary — 60-minute wall-clock, 10-minute no-progress kill (≈60 min observed).
4. Task 4.2: Classify outcome.
   - **Outcome A (48/48):** update log, plan Gate 5.
   - **Outcome B (classified failure):** file diagnostic; do NOT patch retrieval in same session.
5. **Exit:** Gate 4 attempted honestly with artifact, regardless of outcome.

## Recommended Skills for BUILD (SKILL_HINTS for Router)

Match from CLAUDE.md Complementary Skills table:
- `mongodb:mongodb-search-and-ai` — Atlas Search, $vectorSearch, hybrid, rerank (Phases 1, 2, 5)
- `mongodb:mongodb-query-optimizer` — explain plans, index selection (Phases 2, 5)
- `mongodb:mongodb-schema-design` — schema review (Phase 2 Capability 5 + Task 2.R3)
- `mongodb:mongodb-connection` — pool / timeout tuning (Phase 1)
- `mcp__plugin_mongodb_mongodb__search-knowledge` — MongoDB MCP knowledge base (**mandatory** for every retrieval/indexing/schema decision — citations already in plan; additional questions during execution get live MCP calls)
- `cc10x:verification-before-completion` — required before every gate close-out

Internal skills the router may pass:
- `cc10x:test-driven-development` — for every Phase 1/2 task (RED-GREEN-REFACTOR-COMMIT)
- `cc10x:debugging-patterns` — for Phase 4 Outcome B root-cause loop
- `cc10x:architecture-patterns` — for ADR authoring (if new ADRs surface during execution)

## Scope Expansion Appendix (pass-3 ADR-006 — 4 user-approved features)

The four user-approved scope additions from pass-3 Agent 4 findings are documented here as a single appendix because the original design scope did not anticipate them. The plan treats each as a first-class capability with 4-layer evidence; the bodies below cross-reference the per-task sections inserted inline in Phase 2.

### SE-1 — Bi-temporal memories (pass-3 E3)
- **Task:** Task 2.SE-1 (Phase 2)
- **Scope branch:** `scope-2-retrieval-ranking`
- **New fields:** `validAt: Date`, `invalidAt: Date | null` on events/episodes.
- **New index:** `{ agentId: 1, scope: 1, scopeRef: 1, validAt: 1, invalidAt: 1 }`.
- **Retrieval change:** filter on `validAt <= queryTime AND (invalidAt IS NULL OR invalidAt > queryTime)`.
- **Provable property #11:** "No retrieval returns a memory where `invalidAt < queryTime`."

### SE-2 — Memory-poisoning / prompt-injection defense (pass-3 E5)
- **Task:** Task 2.SE-2 (Phase 2)
- **Scope branch:** `scope-2-retrieval-ranking`
- **New module:** `packages/memory-engine/src/mongodb-injection-classifier.ts`.
- **New collection:** `memory_quarantine` (pending review).
- **Pipeline:** consolidation pre-write hook — classifier detects injection shape → quarantines or passes.
- **Provable property #12:** "Every memory whose content matches injection patterns is quarantined before consolidation, not stored in canonical."

### SE-3 — Human review / promotion gate (pass-3 E4)
- **Task:** Task 2.SE-3 (Phase 2)
- **Scope branch:** new **Scope 7 (web-console review UI)** OR augments Scope 6 — default is Scope 7.
- **New routes:** `GET /v1/review/queue`, `POST /v1/review/promote/{id}`, `POST /v1/review/reject/{id}`.
- **New bridge methods:** `memongoBridgeListPendingMemories`, `memongoBridgePromoteMemory`, `memongoBridgeRejectMemory`.
- **Web view:** `apps/web/app/review/page.tsx`.
- **Provable property #13:** "No memory moves from pending to canonical without an explicit approval event; approval is audit-trailed."

### SE-4 — Exportable-memory guarantee (pass-3 E6)
- **Task:** Task 2.SE-4 (Phase 2, landing on `scope-4-api-security`)
- **Scope branch:** `scope-4-api-security`
- **New route:** `POST /v1/export/{agentId}`.
- **New bridge method:** `memongoBridgeExportAgent`.
- **New client method:** `.exportAgent(agentId)`.
- **New AI SDK tool:** `memongo_export_agent`.
- **Signing:** HMAC-SHA256 keyed by `MEMONGO_EXPORT_SIGNING_KEY`.
- **Provable property #14:** "Signed bundle is byte-identical across two exports at the same scopeRef with no intervening writes."

### Scope 7 partition decision
The 4 scope-expansion features fit in the existing 6-scope partition except for SE-3's web-console review queue view which is material enough to warrant its own scope. Default recommendation: **add `scope-7-review-ui`** to the merge order (1 → 2 → 3 → 4 → 5 → 6 → 7) with scope-7 merged last (after Gate 6 polish). Alternative: fold into Scope 6. The planner resolves this at Phase 0 Task 0.3 review.

## Confidence Score: 92/100

- Context References included with file:line (+25)
- All edge cases documented including scope-expansion capabilities (+20)
- Test commands specific with expected exit codes (+20)
- Risk mitigations defined for every score ≥ 12 (+20)
- File paths exact (+15)
- Pass-1 review findings (F1–F5 blocking + A1–A6 advisory) materially resolved and anchored inline for pass-2 traceability (+2)
- Pass-2 review passed with 8 code anchors verified (+2)
- Pass-3 external reviewer + 4 parallel agents + 4 user strategic scope expansions applied surgically (+2)
- Honest deductions (-14):
  - Open Decisions is now non-empty (3 pending Task 0.5 defaults + MongoDB 8.3+ survey escalations + atlas-local:preview 8.3 availability — pass-3 G5 honest state, was false `None` previously).
  - `fast-check` dependency installs on `scope-1-harness-reliability` at runtime but not yet verified in the live repo (pass-3 A3 writes the task; actual install happens at BUILD).
  - MemPalace repo URL pinned to `MemPalace/mempalace` at audit time; execution-time resolution still required (pass-3 A6).
  - Four scope-expansion features (ADR-006) add 2+ weeks of implementation depending on Scope 7 partition decision.
  - MongoDB 8.3+ survey may surface unknown-unknowns; a third pass-review may be needed if the survey flags ≥3 high-value missing capabilities.
  - `collStats` parity field may be null-with-reason on atlas-local:preview at runtime.

**Key Assumptions:**
- `$listSearchIndexes` is queryable on atlas-local:preview MongoDB 8.x (inferred from MCP Finding #4; Phase 1 Task 1.5 has a fallback path).
- LongMemEval-S dataset SHA is stable — pinned in every artifact; run fails if drift.
- `$rankFusion` default `weights=0.5/0.5` is acceptable for LongMemEval-S baseline (confirmed by MCP Finding #1); tuning only post-Gate-5.
- Capability audit prime suspects (#3, #4, #6) may surface fixes that delay Gate 3 by one session — buffered in the 3-session starter.

## Findings

- Handoff + design are fully consistent; no structural conflicts found.
- Canary runner lacks `MEMONGO_LOG_LEVEL=warn` default and per-scenario progress emitter — both codified as Phase 1 tasks.
- Split-file partition (mongodb-manager.ts and its test) requires `git add -p` discipline and is the highest-risk labor in Phase 0 — checkpoint enforced.
- Readiness probe upgrade to `$listSearchIndexes` is load-bearing; moving it to Gate 1 (ADR-002) eliminates the primary hang source before Gate 3.
- Prime-suspect capabilities (#3, #4, #6) get fast-check property tests with recorded seeds so evidence is reproducible.

## Task Status

- Follow-up tasks created: None (router owns task creation per planner contract).
- **CRITICAL:** The TaskUpdate tool will be invoked at end of this response to mark task 7 as completed. Pass-3 reviewer (task 8) is next in the queue.

### PASS3_PATCHES_APPLIED (helper summary)

- **A1–A6 (external reviewer — 6/6):** branch procedure fix (Task 0.2), `SearchIndexStatus` uppercase + `queryable` (Task 1.5), `fast-check` install (Task 1.-1), docker compose path (Live Verification), Task 0.1 → scope-3, MemPalace URL → `MemPalace/mempalace`.
- **B1–B5 (benchmark honesty — 5/5):** BEAM + MemoryAgentBench roadmap (Task 5.roadmap), E2E QA lane (Task 5.E2E / ADR-007), adversarial judge (Task 5.adv), held-out split (Task 0.7), README caveats section (Task 6.3).
- **C1–C6 (retrieval SOTA — 6/6):** `$rankFusion` latency acceptance (ADR-004), mongot-lag (B5a), per-query weighting (Task 2.R6), ENN fallback (Task 2.R7), HyDE sibling route (Task 2.R8), reranker bake-off (Task 2.R9).
- **D1–D4 (competitor code audit — 4/4):** MemPalace test-set leakage + Raw/held-out-450 enforcement (Task 0.1 Step 3 + Task 5.2 Step 2), Mem0 OSS-unverifiable posture (Task 5.2 Step 5a), dual-scorer columns (Task 5.2 Step 5), multi-tenant positioning (Task 5.2 Step 5b + Task 6.3).
- **E1–E8 (market/positioning — 8/8):** Dreaming reframe (Task 6.3), LangGraph.js headline reframe (Task 6.3), bi-temporal (SE-1), review gate (SE-3), poisoning defense (SE-2), export (SE-4), episodic/semantic/procedural vocabulary (Task 6.3), OSS/self-host commitment (Task 6.3).
- **F1–F3 (user strategic — 3/3):** MongoDB 8.3+ survey (Task 0.6 / ADR-005), MongoDB 8.3+ floor (ADR-005 + tech stack header), Agent Invocation Contract (new top-level section / ADR-008).
- **G1–G5 (structural — 5/5):** re-run plan-review-gate pending, Provable Properties +4, Scenarios +4 (in YAML below), OPEN_DECISIONS honest, "Recommended Defaults" → "Pending Sign-Off Defaults".

### PASS1_FINDINGS_RESOLVED (helper summary)

- **F1 (BLOCKING):** resolved — Task 1.0 adds `MEMONGO_CANARY_ARTIFACT_DIR`, `MEMONGO_CANARY_FULL`, `MEMONGO_CANARY_RESUME` env-var contract with tests; every downstream canary invocation rewritten to use env vars.
- **F2 (BLOCKING):** resolved — explicit `Bootstrap Sub-Sequence (B1–B5)` listed as precondition on Phase 3/4/5 canary tasks; existing `GET /health` endpoint (`apps/api/src/app.ts:206`) used; no new endpoint, no Scope #4 ordering conflict.
- **F3 (BLOCKING):** resolved — partition table re-derived from `git show --name-only bd1f5ba691`; phantom `mongodb-analytics.*` rows removed; 48 files total; 3 split via `git add -p`.
- **F4 (BLOCKING):** resolved — Task 5.2 expanded to 7-step MemPalace reproduction sub-sequence with pinned commit SHA, dataset SHA parity, ±3-point R@5 tolerance exit criterion, methodology diff table, and explicit unreproducible fallback.
- **F5 (BLOCKING):** resolved — Task 1.A adds `datasetSha256`, `retrievalUnit`, `embedding.*`, `reranker.*`, `storage.*`, `latency.{p50Ms,p95Ms}`, `cost.*` to the `benchmarkReport` envelope, with unit tests; Gate 3 exit also blocked on these fields.
- **A1 (advisory):** resolved — Task 2.C3 Layer 3 renamed to "Engine boundary integration" with justification.
- **A2 (advisory):** resolved — Task 2.C5 Layer 4 names fast-check invariants and seed.
- **A3 (advisory):** resolved — Task 1.8 doc is written on scope-1 then re-committed under Scope #3 at Phase 2.
- **A4 (advisory):** resolved — new Task 0.5 checkpoint gates the 3 Recommended Defaults; Task 2.R2 branches on sign-off.
- **A5 (advisory):** resolved — Task 1.5 extracts `readSearchIndexStatus` into `mongodb-benchmark-readiness.ts`; tests mock the module boundary.
- **A6 (advisory):** resolved — Bootstrap B1 verifies `mongosh`, `docker`, `bun`, `curl`, and the dataset file.

### Router Contract (MACHINE-READABLE)

```yaml
STATUS: DECISION_RFC_CREATED
PLAN_MODE: decision_rfc
VERIFICATION_RIGOR: critical_path
CONFIDENCE: 92
PLAN_FILE: "docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md"
PHASES: 8
RISKS_IDENTIFIED: 26
EXTERNAL_REVIEW_PATCHES: 6
AGENT1_PATCHES: 5
AGENT2_PATCHES: 6
AGENT3_PATCHES: 4
AGENT4_PATCHES: 8
USER_STRATEGIC_PATCHES: 3
TOTAL_PASS3_PATCHES: 32
SCENARIOS:
  - name: "Bootstrap sub-sequence green before any canary"
    given: "docker compose up, @memongo/api running, dataset present"
    when: "B1–B5 run in order"
    then: "bootstrap.json written with mongodbHealthy=true, /health returns 200"
  - name: "mongot replication lag (B5a, pass-3 C2)"
    given: "atlas-local:preview running and events collection populated"
    when: "B5a mongot-lag check runs before canary"
    then: "mongot-lag.json shows queryable=true AND status!=STALE AND mongotLagEstimateSec<=30; otherwise abort with failureClass=index-not-ready"
  - name: "Gate 1 forced-failure classified under 5 min"
    given: "MEMONGO_VOYAGE_BASE_URL points to unreachable port"
    when: "canary runs with MEMONGO_BENCHMARK_STRICT=1 and MEMONGO_CANARY_ARTIFACT_DIR set"
    then: "failure.json exists with failureClass='model-failure' within 300s wall-clock"
  - name: "Task 1.A envelope parity present in every benchmark run"
    given: "Tasks 1.0 and 1.A landed"
    when: "benchmark runs against atlas-local:preview"
    then: "benchmarkReport has datasetSha256 (64-hex), retrievalUnit, embedding.{model,dimensions,quantization}, reranker.{model,stage}, storage.{collectionBytes,indexBytes} (or explicit null-with-reason), latency.{p50Ms,p95Ms}, cost.{embeddingCalls,rerankCalls,llmEnrichmentCalls}"
  - name: "Gate 3 strict 1/type clean with parity fields"
    given: "Scopes 1+2+3 merged and Gate 2 capability audit green"
    when: "canary runs with MEMONGO_CANARY_CASES_PER_TYPE=1, strict mode on, bootstrap green"
    then: "6/6 scored, missLedger=[], any@1=1 session+turn, all Task-1.A parity fields present"
  - name: "Gate 4 strict 8/type"
    given: "Gate 3 clean"
    when: "canary runs MEMONGO_CANARY_CASES_PER_TYPE=8 with 60-min budget"
    then: "48/48 scored OR classified failure at exact scenario under 60 min, parity fields present"
  - name: "Capability 4 importance-decay invariant"
    given: "fixed fast-check seed, 1000 cases of temporalScope in {permanent,ongoing}"
    when: "computeImportanceDecay(m, t) called for any t >= m.createdAt"
    then: "result === m.importance (no decay ever)"
  - name: "Capability 5 wiki categorization invariant"
    given: "fixed fast-check seed, random KB docs inserted with (agentId, scope, scopeRef)"
    when: "queried with the same filter"
    then: "every result has wikiSource/vault/section defined AND agentId/scope/scopeRef equal to the filter"
  - name: "Capability 6 Dreamer cross-scope invariant"
    given: "source events spanning >=2 distinct scopeRef values"
    when: "consolidate(events) runs"
    then: "no consolidated memory's sourceEventIds span more than one scopeRef"
  - name: "Bi-temporal validity (pass-3 E3 / SE-1)"
    given: "memory with invalidAt < queryTime"
    when: "recallConversation runs with queryTime=T"
    then: "the memory is NOT in the result set"
  - name: "Poisoning defense (pass-3 E5 / SE-2)"
    given: "consolidation candidate whose content matches injection pattern"
    when: "consolidator runs"
    then: "candidate is routed to memory_quarantine collection with status pending-review, NOT to canonical"
  - name: "Human review gate (pass-3 E4 / SE-3)"
    given: "pending memory awaiting promotion"
    when: "promoteMemory(id) is called with explicit approval event"
    then: "memory transitions from pending to canonical; approval event recorded in audit trail; absent approval event, no transition"
  - name: "Export bundle determinism (pass-3 E6 / SE-4)"
    given: "agent with N events at scopeRef R and no intervening writes"
    when: "POST /v1/export/{agentId} called twice"
    then: "bundle bytes are byte-identical and HMAC signature verifies with MEMONGO_EXPORT_SIGNING_KEY"
  - name: "Gate 5 full LongMemEval-S with parity fields + E2E QA + adversarial judge"
    given: "Gate 4 clean, MEMONGO_CANARY_FULL=1, Sonnet 4.6 judge configured"
    when: "full 500-case run with strict mode + E2E QA lane + adversarial probe"
    then: "500/500 scored, benchmarkReport has all Task-1.A parity fields populated AND e2eQa.{judge,accuracy,judgeFalsePositiveRate} populated; BEAM/MemoryAgentBench roadmap rows present in matrix"
  - name: "MemPalace reproduction satisfies Task 5.2 exit criterion (dual-scorer + test-set-leakage enforcement)"
    given: "MemPalace repo (MemPalace/mempalace) cloned at pinned SHA, identical public-split dataset SHA, Raw OR held-out-450 mode selected (pass-3 D1)"
    when: "MemPalace benchmark command runs and BOTH scorers (MemPalace-custom + LongMemEval-official-judge) applied (pass-3 D3)"
    then: "either Column-A R@5 within ±3 of 96.6% with equivalent lane and dual-column table; OR not-equivalent lane with asymmetry list (including pass-3 D1 test-set-leakage column for v2/v3/v4); OR unreproducible with comparative-claim downgrade — no silent skip"
  - name: "MongoDB 8.3+ capability survey surfaces high-value missing features"
    given: "Task 0.6 runs mcp__plugin_mongodb_mongodb__search-knowledge across 8.1/8.2/8.3 release notes"
    when: "survey identifies >=3 high-value-and-missing capabilities"
    then: "each is escalated to Open Decisions list at top of plan for user sign-off before Gate 5; Task 0.6 Step 3 blocks router from advancing Phase 5 otherwise"
ASSUMPTIONS:
  - "Checkpoint commit bd1f5ba691 and tag checkpoint/pre-plan-2026-05-11 exist locally (proven by git log)"
  - "Checkpoint has exactly 48 files (proven by git show --name-only bd1f5ba691 on 2026-05-11)"
  - "$rankFusion available on atlas-local:preview MongoDB 8.x (inferred from MCP Finding #1); ADR-004 accepts serial-sub-pipeline 2x latency"
  - "$listSearchIndexes queryable on atlas-local:preview (inferred; Task 1.5 has fallback via readSearchIndexStatus helper); queryable field captured per pass-3 A2"
  - "collStats available on atlas-local:preview for storage parity fields (inferred; Task 1.A emits null-with-reason on unsupported)"
  - "LongMemEval-S dataset SHA-256 stable across runs (pinned in every artifact); held-out split (pass-3 B4) managed privately outside repo"
  - "Voyage and Sonnet endpoints reachable from benchmark host"
  - "GET /health endpoint at apps/api/src/app.ts:206 is available without bearer auth (verified by read)"
  - "MemPalace public repository reachable at github.com/MemPalace/mempalace branch develop (pass-3 A6); execution-time URL resolution still required"
  - "Sonnet 4.6 (primary) and GPT-5.5 (secondary) judge models available for E2E QA lane (pass-3 B2 / ADR-007)"
  - "fast-check installable as devDependency on scope-1-harness-reliability (pass-3 A3; Task 1.-1)"
  - "atlas-local:preview Docker tag reaches MongoDB 8.3.x at execution time; if not, Open Decision #3 escalates to user (pass-3 F2 / ADR-005)"
  - "Every future BUILD agent prompt includes the 4 MongoDB skills + search-knowledge MCP tool per Agent Invocation Contract / ADR-008 (pass-3 F3)"
DECISIONS:
  - "Scope merge order 1->2->3->4->5->6 (ADR-001). Scope 7 (review UI) may be added per ADR-006; default is land last after Gate 6"
  - "Replace aggregate $search probe with $listSearchIndexes via readSearchIndexStatus helper in Gate 1 (ADR-002 + pass-1 A5 + pass-3 A2)"
  - "$rankFusion primary with manual-RRF fallback (ADR-003); 2x latency accepted (ADR-004 / pass-3 C1)"
  - "MongoDB 8.3+ floor with secret-weapon thesis (ADR-005 / pass-3 F1+F2)"
  - "Scope expansion: 4 user-approved features — bi-temporal, poisoning defense, human review gate, export (ADR-006 / pass-3 E3+E4+E5+E6)"
  - "Gate 5 requires Phase-2 E2E QA lane with named judge Sonnet 4.6 primary / GPT-5.5 secondary (ADR-007 / pass-3 B2)"
  - "Agent Invocation Contract: every future BUILD agent includes 4 MongoDB skills + search-knowledge MCP (ADR-008 / pass-3 F3)"
  - "Canary CLI contract is env-var only: MEMONGO_CANARY_ARTIFACT_DIR, MEMONGO_CANARY_FULL, MEMONGO_CANARY_RESUME (pass-1 F1 resolution)"
  - "Bootstrap Sub-Sequence B1–B5 + B5a mongot-lag is a mandatory precondition for every Phase 3/4/5 canary (pass-1 F2 + pass-3 C2)"
  - "Partition table re-derived from actual checkpoint; 48 files; 3 split files via git add -p; pass-3 A1 branch procedure corrected (branch from main, selective git-checkout-checkpoint)"
  - "Task 1.A envelope parity fields block Gate 3 exit, not only Gate 5 (pass-1 F5 resolution); extended with e2eQa.* at Gate 5 (pass-3 ADR-007)"
  - "MemPalace reproduction runs THEIR code on OUR dataset SHA with exit tolerance ±3 R@5 points (pass-1 F4); dual-scorer columns required (pass-3 D3); Raw OR held-out-450 only (pass-3 D1)"
  - "Mem0 'reproduction' downgrades to 'Mem0-cloud-reported, not OSS-verifiable' (pass-3 D2)"
  - "Multi-tenant positioning: Memongo is more rigorous than MemPalace/Mem0, less enforced than Letta; OSS/self-host only at v1 (pass-3 D4 + E8)"
  - "Phase 0 Task 0.5 checkpoint gates the 3 Recommended Defaults (pass-1 A4 resolution); renamed to Pending Sign-Off Defaults per pass-3 G5"
  - "numCandidates table: limit=5->200, 10->200, 20->400, 30->600 (RECOMMENDED — needs Task 0.5 sign-off)"
  - "Failure-classification taxonomy: 9-class enum (RECOMMENDED — needs Task 0.5 sign-off)"
  - "Every phase is HITL (no AFK); critical_path verification rigor"
  - "3-session starter sequence: Session1=Gate0+1, Session2=Gate2, Session3=Gate3+Gate4"
  - "Private held-out LongMemEval-S split managed per Task 0.7 (pass-3 B4); 5-point drift bound at Gate 5"
  - "README reserves 'Benchmark corrections and caveats' section (pass-3 B5)"
  - "Task 0.1 commits to scope-3-docs-benchmarks (pass-3 A5 correction)"
  - "Task 0.2 branches from main, then selective git-checkout-checkpoint per scope (pass-3 A1 correction)"
  - "SearchIndexStatus uppercase enum + queryable field is readiness indicator (pass-3 A2 correction)"
  - "Live Verification Strategy uses docker compose -f docker/mongodb/docker-compose.benchmark.yml path (pass-3 A4 correction)"
  - "MemPalace URL is github.com/MemPalace/mempalace branch develop (pass-3 A6 correction)"
  - "fast-check installed on scope-1-harness-reliability via new Task 1.-1 (pass-3 A3 correction)"
  - "Retrieval roadmap proposals: per-query weighting (R6 / C3), ENN fallback (R7 / C4), HyDE sibling (R8 / C5), reranker bake-off (R9 / C6)"
  - "Adversarial judge probe at Gate 5 as Memongo-signature metric (pass-3 B3)"
  - "BEAM + MemoryAgentBench as committed post-Gate-5 roadmap (pass-3 B1)"
OPEN_DECISIONS:
  - "Three Pending Sign-Off Defaults at Task 0.5: numCandidates table, 9-class failure-classification taxonomy, Gate-1 readiness-probe upgrade timing"
  - "MongoDB 8.3+ capability survey may surface new Open Decisions if >=3 high-value 8.3+ features are missing (pass-3 F1)"
  - "atlas-local:preview tag 8.3 availability at execution time; fallback is 8.2+ with 8.3+ roadmap (pass-3 F2 / ADR-005)"
  - "Scope-7 partition decision: stand up new scope-7-review-ui OR fold SE-3 review UI into Scope 6 (ADR-006 appendix)"
  - "Per-query hybrid weighting code landing: gated by Task 0.5-follow-up sign-off after Task 2.R6 proposal (pass-3 C3)"
  - "ENN fallback code landing: gated by Task 0.5-follow-up sign-off after Task 2.R7 proposal (pass-3 C4)"
DIFFERENCES_FROM_AGREEMENT:
  - "Scope expansion: 4 user-approved features not in original design (bi-temporal, human review gate, poisoning defense, export); documented in ADR-006 + Scope Expansion Appendix"
  - "MongoDB floor raised to 8.3+ from original 8.1+ (pass-3 F2 / ADR-005)"
  - "Gate 5 now requires Phase-2 E2E QA lane with named judge (pass-3 B2 / ADR-007) — was retrieval-only in original design"
  - "$rankFusion kept as primary despite 2x latency trade-off (pass-3 C1 / ADR-004) — decision #4 updated with explicit cost acceptance"
RECOMMENDED_DEFAULTS:
  - "numCandidates table by top-k -> 200/200/400/600 (user sign-off required at Phase 0 Task 0.5)"
  - "Failure-classification enum -> 9 classes refining design's 7 (user sign-off required at Phase 0 Task 0.5)"
  - "Readiness probe upgrade at Gate 1 via $listSearchIndexes + readSearchIndexStatus helper (user sign-off required at Phase 0 Task 0.5)"
PLANNING_REVIEW_STATUS: revised_after_review
PLANNING_REVIEW_RUNS: 2
ALTERNATIVES:
  - "Freeze-then-split branch strategy (ADR-001 Alternative B)"
  - "Defer readiness-probe upgrade to Gate 2 (ADR-002 Alternative B)"
  - "Manual RRF primary instead of $rankFusion (ADR-003 Alternative B)"
  - "App-layer parallel merge instead of $rankFusion sub-pipelines (ADR-004 Alternative B, rejected for observability/substrate alignment)"
  - "Stay at MongoDB 8.1+ rather than 8.3+ floor (ADR-005 Alternative B, rejected — contradicts secret-weapon thesis)"
  - "Ship minimal; defer 4 scope-expansion features to v2 (ADR-006 Alternative B, rejected — user-approved to ship v1)"
  - "Retrieval-only Gate 5 without E2E QA (ADR-007 Alternative B, rejected — community consensus requires E2E)"
  - "Trust agents to discover MongoDB knowledge base themselves (ADR-008 Alternative B, rejected — demonstrably fails)"
  - "Skip capability audit to reach benchmark faster (Alternative C, rejected)"
  - "Add --artifact-dir/--full/--resume CLI flag parser instead of env vars (pass-1 F1 alternative; rejected in favor of env vars for smaller patch)"
  - "Cherry-pick approach for branch split (pass-3 A1 reviewer suggestion, superseded by git-checkout-checkpoint-per-file approach)"
DRAWBACKS:
  - "Rebase cost ~0.5 day for scope partition"
  - "Phase 1 patch grows ~150 LOC (probe upgrade + envelope parity + env-var contract + bootstrap wiring)"
  - "Gate 1 blocks benchmarks until green (1-session delay if hit bumps)"
  - "$rankFusion pins to MongoDB 8.1+ (manual-RRF fallback retained)"
  - "$rankFusion 2x latency (ADR-004); acceptable trade-off for observability + substrate alignment"
  - "MongoDB 8.3+ floor (ADR-005) narrows supported substrate; users on <8.3 get manual-RRF path"
  - "fast-check property tests add ~500ms-2s per capability to test suite"
  - "LongMemEval-S 500-case full run costs embedding + LLM API dollars"
  - "Gate 5 E2E QA + adversarial judge adds Sonnet 4.6 judge calls (ADR-007)"
  - "4 scope-expansion features (ADR-006) add ~6 files, 1 collection, 3 API routes, 3 bridge methods, potentially 1 new scope (scope-7); delivery session budget grows"
  - "Agent Invocation Contract (ADR-008) adds ~200 prompt tokens per BUILD-agent invocation"
  - "History rewrite in Gate 7 irreversible without backup tag"
  - "MemPalace may publish new numbers mid-plan; policy is don't chase"
  - "MemPalace reproduction (Task 5.2) requires external repo availability; explicit fallback documented"
  - "Task 0.5 sign-off adds one human checkpoint before Phase 2 can fully ship"
  - "Anthropic Dreaming + MongoDB LangGraph.js partially commoditize pitch (pass-3 E1 + E2); positioning reframe in Task 6.3"
PROVABLE_PROPERTIES:
  - "Importance decay: permanent/ongoing memories NEVER decay"
  - "Importance decay: output always in [0, 1]"
  - "Importance decay: monotonic decreasing under no-access"
  - "Dreamer: no consolidated memory's sourceEventIds span >1 scopeRef"
  - "Access tracking: accessCount monotonic in time; SIGTERM drains batch within FLUSH_TIMEOUT"
  - "Wiki categorization: every KB doc has wikiSource/vault/section defined; queries are always scoped to (agentId,scope,scopeRef)"
  - "Scope isolation: no retrieval returns cross-(agentId,scope,scopeRef) rows"
  - "Harness fail-fast: broken-config run exits with failure.json in <5 min"
  - "Reasoning chain: depth <= maxDepth; no infinite cycles"
  - "Novelty: score in [0, 1]"
  - "$rankFusion: scoreDetails.details[].value = weight * (1/(60+rank)) within epsilon"
  - "Benchmark envelope parity: every Task-1.A field present and non-null (or explicitly null-with-reason) on every Gate-3/4/5 run"
  - "Bi-temporal (pass-3 E3): no retrieval returns a memory where invalidAt < queryTime"
  - "Poisoning defense (pass-3 E5): every memory whose content matches injection patterns is quarantined before consolidation, not stored in canonical"
  - "Human review gate (pass-3 E4): no memory moves from pending to canonical without an explicit approval event"
  - "Export bundle determinism (pass-3 E6): signed bundle is byte-identical across two exports at the same scopeRef with no intervening writes"
BLOCKING: false
NEXT_ACTION: "build"
REMEDIATION_NEEDED: false
REQUIRES_REMEDIATION: false
REMEDIATION_REASON: null
GATE_PASSED: true
USER_INPUT_NEEDED: []
MEMORY_NOTES:
  learnings:
    - "Pass-3: 32 surgical patches applied in place across 6 categories (A:6 external reviewer, B:5 benchmark honesty, C:6 retrieval SOTA, D:4 competitor code audit, E:8 market/positioning, F:3 user strategic) + 5 structural (G1-G5)"
    - "Pass-3 A1: prior branch-split procedure contaminated every scope; corrected procedure branches from main then selectively applies per-scope hunks"
    - "Pass-3 A2: MongoDB $listSearchIndexes returns uppercase status + queryable:boolean field; queryable is the actual readiness indicator, not status alone"
    - "Pass-3 A3: fast-check must install before any Phase 2 property test; Task 1.-1 added"
    - "Pass-3 C1: $rankFusion sub-pipelines run SERIALLY not parallel; 2x latency accepted (ADR-004); must publish p50/p95"
    - "Pass-3 D1: MemPalace hybrid_v4 has SELF-DOCUMENTED test-set leakage on 3 question IDs; we enforce Raw OR held-out-450"
    - "Pass-3 D2: Mem0 93.4 is unverifiable from OSS; reproduction downgrades to Mem0-cloud-reported"
    - "Pass-3 D3: MemPalace scorer is custom, NOT official LongMemEval judge; comparison tables require dual columns"
    - "Pass-3 E1+E2: Anthropic Dreaming + MongoDB LangGraph.js commoditize parts of our pitch; reframe positioning"
    - "Pass-3 F1: MongoDB 8.3+ capability survey is user's declared secret weapon; Task 0.6 output may escalate Open Decisions"
    - "Pass-3 F3: Agent Invocation Contract mandatory — every future BUILD agent MUST include 4 MongoDB skills + search-knowledge MCP tool"
    - "Canary CLI contract is env-var only; prior plan's --artifact-dir/--full/--resume flags do not exist in scripts/run-longmemeval-canary.ts (pass-1 F1)"
    - "Every benchmark gate requires the Bootstrap Sub-Sequence (B1-B5 + B5a mongot-lag) including @memongo/api startup + GET /health probe (pass-1 F2 + pass-3 C2)"
    - "The benchmarkReport envelope does not currently emit parity fields; Task 1.A adds them and blocks Gate 3 exit (pass-1 F5); Gate 5 extends with e2eQa.* (ADR-007)"
    - "MemPalace reproduction must run their code on our dataset SHA with ±3-point tolerance + dual scorers; silent skip is forbidden (pass-1 F4 + pass-3 D3)"
    - "Pending Sign-Off Defaults (renamed from Recommended Defaults per pass-3 G5) are gated by Phase 0 Task 0.5"
    - "Readiness probe must be extracted into a pure readSearchIndexStatus helper; tests mock module boundary, not an invented fixture (pass-1 A5 + pass-3 A2)"
  patterns:
    - "Pass-N findings are addressed inline next to affected tasks with `pass-N F*` / `pass-N A*` (and `pass-3 A*/B*/C*/D*/E*/F*/G*`) anchors for pass-(N+1) reviewer traceability"
    - "Checkpoint file count derives from git show --name-only, not memory prose; partition tables always cite the command used"
    - "Canary artifact dir is owned by MEMONGO_CANARY_ARTIFACT_DIR when set; otherwise a defaulted runId-suffixed path"
    - "Task 1.-1 (fast-check install), Task 1.0 (env-var contract), Task 1.A (envelope parity) block every other Phase 1 task; hard ordering invariant"
    - "Bootstrap Sub-Sequence B1-B5 + B5a writes bootstrap.json + mongot-lag.json into the run dir; missing either blocks the canary scenario loop"
    - "Scope expansion features (bi-temporal, poisoning, review, export) follow 4-layer evidence bar with fast-check provable properties"
    - "Every retrieval/indexing/schema decision cites mcp__plugin_mongodb_mongodb__search-knowledge URL per Agent Invocation Contract"
  verification:
    - "Plan docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md revised in place after pass-3 review; confidence 92/100"
    - "32 pass-3 patches applied in place across 6 categories + 5 structural updates"
    - "All 5 pass-1 BLOCKING findings (F1-F5) have explicit in-plan responses and inline anchors (pass-2 reviewed PASS)"
    - "All 6 pass-1 advisory findings (A1-A6) addressed"
    - "16 provable properties enumerated (12 original + 4 from ADR-006 scope expansion) with fast-check seed recording rule"
    - "8 ADRs total (ADR-001 through ADR-008)"
  deferred:
    - "Voyage reranker swap experiments (post-Gate-4); bake-off at Gate 5 per Task 2.R9"
    - "LoCoMo, ConvoMem, MemBench competitor lanes (Gate 5+)"
    - "BEAM + MemoryAgentBench follow-on lanes (post-Gate-5 per pass-3 B1)"
    - "Answer-generation end-to-end lane handled at Gate 5 via Task 5.E2E (pass-3 B2 / ADR-007)"
    - "Scope-level API authorization (product framing constrained until this ships); multi-tenant posture documented per pass-3 D4"
    - "MemPalace Hybrid-mode reproduction (Task 5.2 Step 8; follow-on if Raw reproduces)"
    - "Per-query weighting code landing (Task 2.R6 proposal first; code gated)"
    - "ENN fallback code landing (Task 2.R7 proposal first; code gated)"
    - "Scope-7 review UI partition decision pending Phase 0 Task 0.3 review"
```
