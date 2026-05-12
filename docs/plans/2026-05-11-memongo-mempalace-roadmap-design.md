# Memongo Roadmap: Honestly Beat MemPalace — Design

Workflow: `wf-20260511T190536Z-18f4f2e7` (CC10X PLAN)
Checkpoint commit: `bd1f5ba691`
Checkpoint tag: `checkpoint/pre-plan-2026-05-11`

## Purpose

Take Memongo from "the preference-evidence fix passes 1/type" to **the most credible MongoDB-native long-term AI memory framework on LongMemEval-S**, measured by a retrieval-only, apples-to-apples benchmark that a reasonable reviewer cannot poke holes in. We do this by fixing the harness, validating every capability claimed in `CLAUDE.md`, splitting the working tree into reviewable scopes, and publishing a methodology disclosure that exposes every MemPalace asymmetry we neutralize.

The target is not a bigger number. The target is a number no one can dismiss.

## Users

- **Primary:** coding agents (Codex, Claude Code), Hermes-style personal agents, support/research agents, multi-agent systems.
- **Secondary:** developers self-hosting Memongo who need inspectable, scoped, durable recall.
- **Reviewer / judge:** a skeptical third party reading both MemPalace's and Memongo's public benchmark tables, looking for methodology gaps.

## Success Criteria

- [ ] Saved plan under `docs/plans/` covering deliverables A–G.
- [ ] Gate 0 passes: working tree committed + tagged, 6-scope split branches exist.
- [ ] Gate 1 passes: benchmark harness emits per-scenario progress artifacts, has bounded probe/queue timeouts, fails in under 5 minutes on any strict misconfiguration.
- [ ] Gate 2 passes: `bun run lint`, `bun run check-types`, `bun run build` clean on `main` after scope merges.
- [ ] Gate 3 passes: strict 1/type canary re-runs clean (`missLedger=[]`, `any@1=1`).
- [ ] Gate 4 passes: strict 8/type canary completes 48/48 with bounded failure classification, or fails loudly inside 60 minutes.
- [ ] 6 CLAUDE.md capabilities each have **unit + integration + E2E + correctness-invariant** evidence.
- [ ] MemPalace forensic report lives in `docs/benchmarks/mempalace-forensic-audit.md` with every asymmetry documented.
- [ ] Full LongMemEval-S (500 questions, strict, zero fallback) produces raw + summary artifact with every methodology field present.
- [ ] Final claim published is phrased only as strongly as the evidence allows (see "Claim Boundaries").

## Constraints

- **Zero benchmark manipulation.** No dataset-specific hacks, no label-based boosts, no silent fallback in strict mode.
- **Apples-to-apples or clearly-labeled deviation.** Every field in `docs/benchmarks/benchmark-matrix.md#competitor-parity-checklist` must be recorded.
- **MongoDB MCP knowledge base is mandatory** for every retrieval/indexing/schema decision. Findings must be cited in the saved plan with MongoDB doc URLs.
- **Zero publish** until Gates 0–7 pass. No force-push, no history rewrite, no package publish.
- Repo-root-relative file paths only. American English. Biome style. TypeScript strict ESM. Bun 1.2+, Node 20+.
- Do NOT retry 8/type LongMemEval until Gate 1 is green.
- Keep resilience fallbacks for normal product operation; reject fallback-backed runs as benchmark evidence.

## Out of Scope

- Launch copy, marketing site polish, `apps/web` visual redesign.
- Answer-generation end-to-end lane for the first public comparison (deferred to Gate 5 full matrix).
- Reranker swap from Voyage to Haiku/Cohere (deferred; current stack is clean at 1/type).
- Hermes provider improvements beyond what's already committed (defer to Gate 6).
- Scope-level API authorization (documented as known gap; product framing stays "single-tenant self-hosted" until solved).
- Non-LongMemEval datasets for the first comparison: LoCoMo, ConvoMem, MemBench run at Gate 5.
- Any MongoDB version below 8.1 (rankFusion requires 8.1+; our target is atlas-local:preview which is on 8.x).

## Approved Decisions (locked)

1. **Local checkpoint** `bd1f5ba691` + tag `checkpoint/pre-plan-2026-05-11` created. Local only.
2. **Branch split BEFORE harness work.** 6 scopes from handoff. Rebase cost ~0.5 day; benefit is attributable bisect and credible PRs.
3. **First MemPalace comparison lane = retrieval-only LongMemEval-S.** Answer-generation deferred.
4. **Hybrid search primary = `$rankFusion`** (MongoDB 8.1+). Already wired in `packages/memory-engine/src/mongodb-conversation-recall.ts:427` with manual-RRF fallback via capability flag.
5. **Honesty posture = full forensic parity.** Publish R@5, R@10, NDCG@10, empty rate, any@1 (session + turn), dataset SHA, embedding model, retrieval unit, reranker model. Footnote every MemPalace asymmetry.
6. **Rerank stage unchanged (Voyage + provenance boost).** Reranker swap experiments deferred to Gate 5.
7. **Capability evidence bar = 4-layer: unit + integration + E2E + correctness invariant** for all 6 CLAUDE.md capabilities.
8. **3-session starter = gate-aligned, time-boxed.** Session 1 = Gate 0 + Gate 1. Session 2 = Gate 2 capability audit. Session 3 = Gate 3 + first honest Gate 4 attempt.

## MongoDB MCP Knowledge-Base Findings (evidence for retrieval-quality roadmap)

Captured during brainstorming. Planner MUST cite these findings in the saved plan.

### 1. `$rankFusion` (Atlas hybrid search)
Source: `mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search` (MongoDB Atlas main).
- `$rankFusion` is the canonical stage for hybrid `$search` + `$vectorSearch` merge. Takes named input pipelines (e.g. `text`, `vector`) and a `weights` map.
- Scoring formula: `sum(weight * (1 / (60 + rank)))` across input pipelines. **Constant is always 60.**
- Lower weight number = *higher* per-pipeline importance relative to other pipelines. Default 0.5/0.5 balanced.
- Returns `scoreDetails.details[]` with per-pipeline rank, weight, value. This is our observability surface — we should log it per case in benchmark artifacts.
- Behavior difference vs "semantic boosting" (the other hybrid approach): rank fusion deduplicates and re-sorts across both pipelines; semantic boosting only boosts `$search` hits that also appear in `$vectorSearch`. Memongo's `mongodb-conversation-recall.ts:427` uses rank fusion, which is correct for our long-memory retrieval profile.

### 2. `$vectorSearch` tuning
Source: `mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage` + `mongodb.com/docs/vector-search/benchmark/results`.
- `numCandidates` recommended ≥ 20× `limit`. For `limit=10`, use `numCandidates=200` as starting point.
- Low `limit` values require proportionally higher `numCandidates` to maintain recall (our LongMemEval top-k is 5–30 → we need to tune per-k).
- **Quantization tradeoffs:**
  - Scalar quantization (int8): 4× memory reduction, ~90-95% recall when tuned.
  - Binary quantization (int1): 32× memory reduction, but needs higher `numCandidates` and full-fidelity rescoring step (latency hit). MongoDB's own 15.3M benchmark: `≥ 1024 dimensions + quantization` retains 90-95% accuracy at `<50 ms` query latency.
- **Filter selectivity matters:** a 3% selective metadata filter made binary-quantized queries ~4× more expensive at low `limit`. Implication for Memongo: scope filters (agentId + scopeRef) are cheap now, but as KB grows, we must audit `numCandidates` vs filter selectivity.
- For MongoDB 8.x Lucene 10 with Acorn-1 HNSW search, filter selectivity cost should improve. Not a dependency, but a known upgrade path.

### 3. Compound `$search` weighting
Source: `mongodb.com/docs/atlas/atlas-search/customize-score`.
- `compound.must / should / filter / mustNot` with per-clause `score.boost.value: N` multiplier.
- We already apply `boost` in `mongodb-manager.ts` for provenance-aware rerank. Planner should audit boost values against the MongoDB guidance (explicit numeric boosts, not multiplicative stacking) to confirm we're not double-boosting.

### 4. Search index readiness
Source: `mongodb.com/docs/atlas/atlas-search/manage-indexes` + `mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes`.
- Index statuses: `Pending`, `Building`, `Ready`, `Stale`, `Failed`.
- `Stale` means queryable but replicating stale data (oplog fall-off, disk pressure). Our benchmark convergence probe must differentiate `Ready` from `Stale`.
- `$listSearchIndexes` is the API to poll. Replace the current raw `$search` probe if feasible — it's a lighter-weight readiness check than running a full aggregation just to count results.

**Planner action:** treat the findings above as durable evidence. Every retrieval or index design choice in the saved plan MUST reference one of these URLs.

## MemPalace Forensic Report (distilled from `mempalace.net/benchmarks`)

Full report target: `docs/benchmarks/mempalace-forensic-audit.md` (created in Gate 0).

### Their claims (verbatim)
- "96.6% LongMemEval R@5 — Raw Mode"
- "100% LongMemEval — Hybrid Mode with Haiku rerank"
- "highest-scoring free AI memory system"
- "the highest published result for any system that requires no API key and no external service"
- 98.4% on "unseen questions" (held-out test)
- LoCoMo R@10 = 60.3% (no explanation for the gap vs LongMemEval)

### Their disclosures (to their credit)
- Self-audit section: "⚠️ What's Been Questioned".
- Acknowledges Haiku reranking isn't purely local.
- Acknowledges AAAK compression regresses accuracy to 84.2%.
- Acknowledges `top_k=50` on LoCoMo "may exceed candidate pool size".
- Reproducibility claim: "@gizmax reproduced on M2 Ultra in under 5 minutes".

### Missing methodology (**our apples-to-apples neutralization targets**)
| Field | MemPalace | Memongo commitment |
|---|---|---|
| Dataset commit SHA | MISSING | Record `longmemeval_s_cleaned.json` SHA in every artifact |
| Retrieval unit (turn/session/memory) | MISSING | Publish both turn-level and session-level metrics |
| NDCG | MISSING | Publish `ndcg@10` |
| Embedding model | MISSING | Publish Voyage model + dimensions + quantization |
| Reranker identity | Implicit (Haiku) | Publish reranker model + version + stage placement |
| Official vs custom scorer | MISSING | Use dataset's official scorer, link + pin version |
| Latency | MISSING | Publish p50/p95 retrieval latency |
| Cost / token usage | Partial ($0 raw; "~500 calls" hybrid) | Publish strict mode cost: embedding calls, rerank calls, LLM enrichment calls |
| Storage footprint | MISSING | Publish collection byte counts + index byte counts |
| Per-case raw outputs | Aggregate only | Publish per-case JSONL + miss diagnostics |
| Competitor version pins | Tilde estimates (~85%) | Do NOT cite competitor numbers we haven't run ourselves OR clearly mark as "MemPalace-reported estimate, not our reproduction" |
| Run date | MISSING | Artifact timestamp + git SHA per run |

### MemPalace asymmetries we will NOT replicate
1. Reporting raw and hybrid as if they're comparable headline numbers.
2. Using tilde-prefixed competitor scores (e.g. "~85% Mem0") without pinning their version.
3. Framing 96.6% raw as "highest-scoring free AI memory" without retrieval-unit disclosure.

### What we CAN legitimately claim once gates pass
Allowed after strict Gate 5 passes:
- "Memongo scored X R@5 / Y NDCG@10 on the official LongMemEval-S 500-case set with [config details], reproducible at [commit SHA]."
- "Memongo outperformed our reproduction of MemPalace on [specific lane] by Z points; see [reproduction artifact]."

Not allowed:
- "Best memory framework" from LongMemEval alone.
- "Beats Mem0/Zep" without reproducing their setup ourselves.

## Capability Validation Matrix (4-layer evidence bar)

For all 6 capabilities claimed in `CLAUDE.md`. Every capability needs unit ✅ + integration ✅ + E2E ✅ + correctness invariant ✅ before publish.

| # | Capability | Key file | Silent-bug risks | Unit test | Integration test | E2E smoke | Correctness invariant |
|---|---|---|---|---|---|---|---|
| 1 | Reasoning chain | `packages/memory-engine/src/mongodb-reasoning-chain.ts` | Cycle detection; depth limits; cross-scope chain leak | Chain traversal math, depth guard | Chain through real `events`+`episodes` docs, scoped | `POST /v1/chain-trace` end-to-end | Chain never crosses `agentId`/`scopeRef` boundary; no infinite cycles |
| 2 | Surprisal novelty | `packages/memory-engine/src/mongodb-novelty.ts` | Stale baselines; scope leak; divide-by-zero on cold start | Score bounds `[0,1]`, math | Persisted baselines read/write | `POST /v1/novelty-scan` E2E | Score monotonic under identical context; stable under seed |
| 3 | Access tracking | `packages/memory-engine/src/mongodb-access-tracker.ts` | **Batched writes can lose recency on crash**; race between batch flush and read | Batch flush logic, dedup | 100 reads → verify batched write count | Engine-only smoke (no API surface) | Access count never decreases; batch drain completes on shutdown signal |
| 4 | Importance decay | `packages/memory-engine/src/mongodb-trust.ts` | **`temporalScope=permanent|ongoing` guard**: if field missing or mislabeled, important memories decay silently | `computeImportanceDecay()` property test | Decay over time window, mixed `temporalScope` | Scan + re-rank after 30-day simulation | `permanent`/`ongoing` memories NEVER decay; output in `[0,1]`; monotonic decreasing under no-access |
| 5 | Wiki categorization | KB schema (`wikiSource`, `vault`, `section`) | Schema drift; nulls leaking into search; scope bleed | Schema validation test | Insert + query with categorization filter | Search with category facet returns expected subset | Categorization field always present on KB docs; scope filter applied |
| 6 | Dreamer consolidator | `packages/memory-engine/src/mongodb-consolidator.ts` | **Cross-scope merge bug**: consolidation must never merge across `agentId`/`scope`/`scopeRef`; provenance loss | Dedup math, merge-decision logic | 10 events → consolidated memory, audit provenance preserved | `POST /v1/consolidate` + read back | Every consolidated memory lists all source eventIds; no cross-`scopeRef` merges EVER |

**Prime suspects** (allocate most audit time):
- **Capability 3 (access tracking)** — batched writes are a classic silent-failure shape.
- **Capability 4 (importance decay)** — `temporalScope` guard silently failing means important memories rot.
- **Capability 6 (Dreamer)** — newest feature, cross-scope merge would be catastrophic for product integrity.

Evidence artifact per capability: `docs/benchmarks/capability-audit/{capability-slug}-evidence.md` with commands, exit codes, counts, and at least one property-test seed.

## Harness Reliability Checklist

Partial code already in place at `packages/memory-engine/src/mongodb-manager.ts:3422` (queue settle timeout) and `:3473` (convergence probe with AbortController + Promise.race). These need finishing plus tests plus canary integration.

| # | Item | Status | Fix target |
|---|---|---|---|
| 1 | `MEMONGO_LOG_LEVEL=warn` default during benchmark runs | NOT WIRED | Default in `scripts/run-longmemeval-canary.ts`; override only with explicit `MEMONGO_CANARY_DEBUG=1` |
| 2 | Per-scenario progress artifacts | MISSING | Canary runner writes `{artifact-dir}/progress/{scenario-index}.json` *as each scenario finishes*, not at end-of-run |
| 3 | Queue-settle bounded timeout (`MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS`) | PARTIAL (code ✅, test ⚠️ partial at `mongodb-manager.test.ts:417`) | Complete test coverage: timeout fires, error message names offending queue, re-attempt logic works |
| 4 | Search convergence probe bounded (`MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS`) | PARTIAL (code ✅, test ✅ at `mongodb-manager.test.ts:377`) | Replace aggregate `$search` probe with `$listSearchIndexes` readiness poll where possible (see MongoDB MCP finding #4) |
| 5 | Failure classification taxonomy | MISSING | Canary categorizes failures: `harness-timeout`, `model-failure`, `json-parse`, `index-not-ready`, `scope-leak`, `retrieval-miss`, `other`. Emit in artifact + miss-ledger |
| 6 | Strict-mode fail-fast | PARTIAL | Any single `harness-timeout`, `model-failure`, or `json-parse` aborts the run with the scenario index + diagnostic dump |
| 7 | Canary resume semantics | MISSING | If `{artifact-dir}/progress/` has N complete scenarios, `--resume` skips them and continues. Explicit, not implicit |
| 8 | Silent-fallback audit | TBD | Walk every `try/catch` and warn/swallow site in the hot path; convert to strict-mode throw OR document as acceptable non-benchmark resilience |

Exit criterion for Gate 1: a deliberately broken configuration (e.g. unreachable Voyage endpoint) causes the canary to fail within 5 minutes with a classified failure artifact.

## Retrieval-Quality Roadmap (evidence-cited)

Every decision below cross-references the MongoDB MCP knowledge-base findings above.

### Already landed (keep)
- Post-rerank preference-evidence boost in `mongodb-manager.ts` (provenance-aware, NOT label-based). Decision log entry `2026-05-11`.
- `$rankFusion` with manual-RRF capability fallback at `mongodb-conversation-recall.ts:427`. (MCP Finding #1.)
- Scoped retrieval: `agentId + scope + scopeRef`. Filter-first, search-second.

### Planner MUST evaluate + decide (in saved plan, with evidence)
1. **`$rankFusion` weight tuning.** Default 0.5/0.5 (MCP Finding #1). Planner proposes text/vector split for LongMemEval-S profile; baseline at 0.5/0.5 before any tuning. Log `scoreDetails.details[]` per case for observability.
2. **`numCandidates` table by top-k** (MCP Finding #2). Baseline `limit=10 → numCandidates=200`. Record recall curve at `(50, 100, 200, 500)` for the 1/type canary.
3. **Quantization decision** (MCP Finding #2). Memongo's scale is smaller than MongoDB's 15.3M benchmark; default `float32` (no quantization) for LongMemEval-S. Revisit at Gate 5 for production-scale.
4. **Compound boost audit** (MCP Finding #3). Walk every `boost` application in `mongodb-manager.ts` / `mongodb-reranker.ts`; confirm no accidental multiplicative stacking.
5. **Index readiness probe upgrade** (MCP Finding #4). Prefer `$listSearchIndexes` → `status==Ready` check over aggregate `$search` probe.
6. **Turn-precision mode** (decision log `2026-05-07`). Keep behind `MEMONGO_BENCHMARK_TURN_PRECISION_MODE=enabled` until 8/type validates. Do NOT default-on before Gate 4 passes.
7. **Query decomposition** (`mongodb-query-decomposition.ts`). Keep on by default; audit that its RRF merge uses the same constant (60) as `$rankFusion` to avoid double-normalization.

### Planner must NOT
- Swap Voyage for another reranker before Gate 4. (Decision 6.)
- Add dataset-specific logic. (Constraint #1.)
- Touch LLM-enrichment defaults between canary runs. (Stability > optimization.)

## Branch-Management Plan

### Checkpoint (already done)
- Commit `bd1f5ba691`, tag `checkpoint/pre-plan-2026-05-11`. Local only, no push.
- **Rollback:** `git reset --hard checkpoint/pre-plan-2026-05-11`.

### Split strategy: 6 scopes from handoff, executed BEFORE harness work
The handoff already named the scopes. Planner must assign files to scopes and propose merge order.

| Order | Scope | Representative files | Reason to ship first |
|---|---|---|---|
| 1 | **Harness reliability** | `mongodb-manager.ts` (queue+probe), `mongodb-benchmark-runner.ts`, `scripts/run-longmemeval-canary.ts`, `docker/mongodb/docker-compose.benchmark.yml` | Blocks all future benchmark claims |
| 2 | **Retrieval/ranking** | `mongodb-manager.ts` (preference boost), `mongodb-reranker.ts`, `mongodb-retrieval-planner.ts`, `mongodb-search*.ts` | Isolates the preference fix into a credible PR |
| 3 | **Docs / benchmarks** | `docs/benchmarks/*`, `README.md` | Pairs with Scope 2 for methodology disclosure |
| 4 | **Security / scope / API validation** | `apps/api/src/app.ts`, `apps/api/src/routes/v1.ts`, `memory-bridge/memory-config.ts` | Needed before public claims; can ship after benchmark proof |
| 5 | **Hermes provider** | `integrations/hermes/memongo/*`, `docs/platform/hermes-provider.md` | Strategic wedge; lands after API stability |
| 6 | **Web console / misc** | `apps/web/app/page.tsx`, `apps/mcp/src/server.ts`, `packages/client/*` | Polish; ships last |

### Rollback per scope
Each scope branch tags `pre-merge-{scope}` before merge to `main`. A failing gate reverts the merge with `git revert` (not reset), preserving history.

### History cleanup (Gate 7 only)
- Orphan `main` history only after Gates 0–6 pass.
- Backup tag `pre-history-rewrite-{date}` (already exists for 2026-05-06 — create a fresh one before the next rewrite).
- Fresh clone verification: `bun install && bun run check-types && bun run lint && bun run build && bun run test && bun run check-publishability`.

## Gate-by-Gate Execution Order

Each gate has: **what changes | what we test | what artifact proves it | failure response.**

### Gate 0 — Stop the Bleeding
- **Changes:** none functional; create MemPalace forensic audit `docs/benchmarks/mempalace-forensic-audit.md`. Create 6 scope branches off `codex/mongodb-scoped-memory-observability`.
- **Tests:** `git status --short` is understood per file; no secrets in staged set.
- **Artifact:** `docs/benchmarks/mempalace-forensic-audit.md` + 6 branch names.
- **Failure:** if a file can't be confidently assigned to a scope, open-decision gate, ask user.

### Gate 1 — Harness Reliability (8 checklist items above)
- **Changes:** scope #1 (harness) lands on `main`.
- **Tests:** `bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts packages/memory-engine/src/mongodb-benchmark-runner.test.ts scripts/run-longmemeval-canary.test.ts`. Deliberate broken-config canary run fails inside 5 min with classified artifact.
- **Artifact:** unit tests green + `artifacts/canary-runs/gate1-forced-failure-{timestamp}/` proving failure classification.
- **Failure:** if tests pass but forced failure doesn't classify, keep Gate 1 open; do not advance.

### Gate 2 — Baseline Health + Capability Audit
- **Changes:** scopes #2, #3 land. Capability audit adds tests per matrix.
- **Tests:** `git diff --check`, `bun run lint`, `bun run check-types`, `bun run build`. Capability-matrix evidence complete for all 6.
- **Artifact:** `docs/benchmarks/capability-audit/{capability-slug}-evidence.md × 6`.
- **Failure:** a capability missing any of 4 layers → block Gate 3; remediate before continuing.

### Gate 3 — Strict 1/Type Canary (re-run post-harness)
- **Changes:** none; just run the canary.
- **Tests:** `MEMONGO_BENCHMARK_STRICT=1 MEMONGO_LLM_ENRICHMENT_STRICT=1 MEMONGO_CANARY_CASES_PER_TYPE=1`.
- **Artifact:** `artifacts/canary-runs/gate3-strict-1pertype-{timestamp}/` with `missLedger=[]`, `any@1=1`, 6/6 scored.
- **Failure:** any miss → re-investigate with miss-ledger + case-diagnostics BEFORE a retrieval-logic change (avoid the anti-pattern of tuning for 1/type success).

### Gate 4 — Strict 8/Type Canary (first honest attempt)
- **Changes:** none; this is the moment of truth.
- **Tests:** `MEMONGO_BENCHMARK_STRICT=1 MEMONGO_LLM_ENRICHMENT_STRICT=1 MEMONGO_CANARY_CASES_PER_TYPE=8`. Wall-clock budget: 60 minutes. If no progress artifact after 10 min → fail the run.
- **Artifact:** `artifacts/canary-runs/gate4-strict-8pertype-{timestamp}/` with 48/48 scored OR classified failure at exact scenario.
- **Failure:** classify (`harness-timeout` vs `retrieval-miss`); if `harness-timeout` → back to Gate 1; if `retrieval-miss` → root-cause in decision log, do not patch retrieval without a per-case diagnostic.

### Gate 5 — Full Benchmark Matrix
- **Changes:** scopes #4, #5 land. Add LoCoMo harness, record competitor setup.
- **Tests:** full LongMemEval-S (500 cases, strict, zero fallback). LoCoMo strict retrieval-only on MemPalace-compatible split. Reproduce at least one MemPalace number ourselves before citing any comparison.
- **Artifact:** `docs/benchmarks/comparison-2026-MM/` with per-system: raw JSONL, scorer identity, commit SHAs, model cards, latency, cost, storage.
- **Failure:** any missing parity field → strip the claim or label the lane "not-equivalent".

### Gate 6 — Public Launch Polish
- **Changes:** scope #6 lands. README first-screen tightened to "MongoDB-native long-term AI memory".
- **Tests:** fresh clone → `bun install && bun run check-types && bun run lint && bun run build && bun run test && bun run check-publishability`.
- **Artifact:** clean fresh-clone transcript.
- **Failure:** any step fails → fix before launch copy goes live.

### Gate 7 — History Cleanup
- **Changes:** confirm GitHub repo is standalone (not a fork); orphan `main`; force-push WITH explicit user confirmation.
- **Tests:** fresh clone post-force-push runs Gate 6 checks.
- **Artifact:** backup tag + fresh-clone transcript.
- **Failure:** revert to backup tag; stars/contributions preserved.

## 3-Session Starter Sequence (gate-aligned, time-boxed)

### Session 1 (3–4 hrs): Gate 0 + Gate 1
1. Write `docs/benchmarks/mempalace-forensic-audit.md` from this design's forensic section.
2. Open 6 scope branches from `checkpoint/pre-plan-2026-05-11`. Assign each modified file to exactly one scope.
3. Finish harness checklist items 1, 2, 3, 5, 6. Add the missing queue-settle test.
4. Run deliberate broken-config canary → verify classified failure artifact.
5. Exit criterion: **Gate 1 green**. Stop for the day if not green; do not force ahead.

### Session 2 (3–4 hrs): Gate 2 capability audit
1. 4-layer audit on capability #3 (access tracking) — prime suspect.
2. 4-layer audit on capability #4 (importance decay `temporalScope` guard).
3. 4-layer audit on capability #6 (Dreamer cross-scope merge).
4. Unit + integration audit on capabilities #1, #2, #5.
5. Merge scope #2 (retrieval/ranking) and #3 (docs).
6. Exit criterion: **Gate 2 green**. All 6 capability evidence files exist and are honest.

### Session 3 (2–3 hrs): Gate 3 + first honest Gate 4 attempt
1. Strict 1/type canary re-run. Must match or beat the pre-harness 1/type numbers.
2. If green, strict 8/type canary with a 60-minute wall-clock budget and 10-minute no-progress kill switch.
3. Outcome A (48/48 scored): update `docs/benchmarks/longmemeval-decision-log.md`, plan Gate 5.
4. Outcome B (bounded failure): classify, do NOT patch retrieval in the same session; file a specific diagnostic for the next working session.
5. Exit criterion: **Gate 4 attempted honestly** with artifact, regardless of outcome.

## Error Handling (workflow-level)

- **Harness hang beyond 60 min:** the 10-min no-progress kill switch aborts; artifact names the stalled scenario.
- **Strict LLM JSON parse failure:** abort run, classify `json-parse`, do not fall back.
- **Voyage / embedding endpoint down:** abort run, classify `model-failure`, do not fall back.
- **MongoDB Search index `Stale`:** abort run, classify `index-not-ready`, do not query stale index.
- **Capability audit reveals a silent bug:** file a scope-#2 fix branch, do NOT advance gates; land the fix, re-run prior gate.
- **MemPalace publishes new numbers:** do not chase. Finish our strict full-matrix first; then add a comparison row with their new config explicitly pinned.

## Testing Strategy

- **Unit:** Vitest, colocated `*.test.ts`. Every retrieval primitive, every capability core function.
- **Integration:** real MongoDB (atlas-local:preview on port 27018), scoped test prefix, one-shot setup + teardown.
- **E2E:** API → engine → MongoDB, scoped, with Voyage/Sonnet strict mode.
- **Correctness invariants:** fast-check property tests for decay monotonicity, score bounds, scope isolation.
- **Benchmark:** LongMemEval-S strict canary ladder (1/type → 8/type → 500-full). **No dataset-specific logic in tests.**
- **Forced-failure test:** deliberately break config → expect classified failure inside budget.

## Observability (during benchmark runs)

- **Logging:** `MEMONGO_LOG_LEVEL=warn` default in canary. `MEMONGO_CANARY_DEBUG=1` for developer mode. Benchmark-scoped progress logs are structured JSON, not raw event logs.
- **Progress artifact:** one file per scenario under `artifacts/canary-runs/{run-id}/progress/{scenario-idx}.json` written immediately on scenario completion.
- **Score details:** `$rankFusion` `scoreDetails.details[]` captured per case for observability into per-pipeline contribution.
- **Failure classification:** every non-pass scenario lists one of the taxonomy classes.
- **Run identity:** every artifact includes git SHA, branch, dataset SHA, MongoDB version, embedding model, reranker model, feature flag vector.

## Claim Boundaries (what we'll actually say publicly)

Allowed after Gate 5:
- "Memongo scored X R@5, Y NDCG@10, Z any@1 (session) on LongMemEval-S 500-case strict run at commit SHA [...]. Reproducible via [command]."
- "On our reproduction of MemPalace's raw mode, we observed [N] vs their published 96.6%. Differences: [list every asymmetry we couldn't match]."

Not allowed before Gate 5:
- "Beats MemPalace."
- "Best memory framework."
- "Production-ready."

Not allowed ever without evidence:
- Any tilde-prefixed competitor score we haven't reproduced.

## Observability & Telemetry for the workflow itself

- Every canary run gets a uuid + git SHA.
- Every gate transition writes an event to the workflow artifact (`status_history`).
- Capability audit evidence files are git-tracked in `docs/benchmarks/capability-audit/`.
- Decision log gets one entry per canary run (pass or fail), explaining what we did and what we learned.

## Questions Resolved

- Q1: Commit before plan? **A: Yes, local-only WIP commit + backup tag (done).**
- Q2: Split branch before harness work? **A: Yes.**
- Q3: First public comparison lane? **A: Retrieval-only on LongMemEval-S.**
- Q4: Hybrid strategy? **A: `$rankFusion` (MongoDB 8.1+) with manual-RRF fallback via capability flag.**
- Q5: Honesty posture? **A: Full forensic parity.**
- Q6: Rerank strategy? **A: Keep Voyage + provenance boost; swap experiments deferred.**
- Q7: Capability evidence bar? **A: 4-layer (unit + integration + E2E + correctness invariant).**
- Q8: Session granularity? **A: Gate-aligned, time-boxed.**

## Traceability — Deliverables A–G mapping

- **A. MemPalace forensic report** → "MemPalace Forensic Report" section + target file `docs/benchmarks/mempalace-forensic-audit.md` (created in Gate 0).
- **B. Capability-validation matrix** → "Capability Validation Matrix" section + `docs/benchmarks/capability-audit/*`.
- **C. Harness reliability checklist** → "Harness Reliability Checklist" section + Gate 1.
- **D. Retrieval-quality roadmap** → "Retrieval-Quality Roadmap" section citing 4 MongoDB MCP KB findings.
- **E. Branch-management plan** → "Branch-Management Plan" section with commit/tag/split/rollback.
- **F. Gate-by-gate execution order** → "Gate-by-Gate Execution Order" section mapping to handoff Gates 0–7.
- **G. 3-session starter sequence** → "3-Session Starter Sequence" section.

### Brainstorming Handoff (MACHINE-READABLE)
DESIGN_FILE: "/Users/rom.iluz/Dev/memongo/docs/plans/2026-05-11-memongo-mempalace-roadmap-design.md"
DESIGN_SUMMARY: "Take Memongo to an honestly-best MongoDB-native long-term memory framework by splitting the 38-file tree into 6 reviewable scopes, fixing the benchmark harness (per-scenario progress artifacts + bounded probe/queue timeouts), validating all 6 CLAUDE.md capabilities with a 4-layer evidence bar, running a strict LongMemEval-S retrieval-only canary ladder (1/type → 8/type → 500-full), and publishing a methodology disclosure that neutralizes every MemPalace asymmetry — all behind Gates 0–7 with zero benchmark manipulation and no publish/force-push until all gates pass."
