# Memongo Benchmark-First Release Proof Plan

> **For Claude:** REQUIRED: follow this plan stage-by-stage, keep changes scoped, and update CC10X memory plus this file after every meaningful milestone.
> **Architecture constitution:** `docs/plans/2026-04-10-harmony-memory-roadmap.md`
> **Historical execution backlog:** `docs/plans/2026-04-08-definitive-roadmap-plan.md`
> **Status:** active execution plan after the six delivery waves completed on 2026-04-11

**Goal:** turn the now-built Memongo runtime into a benchmark-credible, release-candidate product with reproducible proof, honest benchmark evidence, and clean package/release mechanics.

**Architecture:** the feature roadmap is complete enough to stop inventing new top-level waves. The remaining work is release proof and benchmark truth: validate the supported stack on Atlas Local Preview, record benchmark evidence on the product path, then cut package versions/tags only after the release gates are green.

**Tech Stack:** Bun monorepo, TypeScript ESM, Hono API, stdio MCP server, MongoDB Atlas Local Preview, Atlas Search, Atlas Vector Search, `$rankFusion`, Vitest, Biome.

**Prerequisites:**
- Phase 0 through Phase 4 Wave 6 are complete in the current branch.
- `docs/platform/PRODUCTION-READY.md`, `docs/platform/validation-pack.md`, `docs/platform/publish.md`, and `docs/benchmarks/benchmark-operating-contract.md` already define the supported proof surfaces.
- The public Memongo remote is `public`, not `origin`.

**Durable Decisions:**
- `docs/plans/2026-04-10-harmony-memory-roadmap.md` remains the architectural constitution.
- This file is the single active execution plan for the remaining work. Do not create another master roadmap unless the user explicitly asks.
- `docs/plans/2026-04-10-wave1-conversation-recall-plan.md` and older planning files are historical references, not active sequencing documents.
- Query governance remains advisory only. MongoDB query settings are cluster-scoped and persistent, so Memongo must never apply them implicitly inside request paths.
- Lifecycle delete semantics remain invalidate-with-history, never hard delete by default.
- Package version bumps, changelog/release notes, git tags, and npm publish happen only after the release-blocking proof lanes are green.

---

## Current Status Snapshot

### Shipped and verified already
- Phase 0 through Phase 3 are complete.
- Phase 4 Wave 1 through Wave 6 are complete.
- The product now ships:
  - conversation recall
  - benchmark report envelopes with official and internal retrieval metrics
  - lifecycle get/update/delete/history
  - canonical conversation import
  - targeted temporal convergence on touched truth-sensitive paths
  - semantic MCP aliases
  - public feedback and procedure-outcome provenance surfaces

### What is actually left
- Run the final package versioning / release-cut lane using the already-recorded proof artifacts.
- Decide package versions and release scope based on those green lanes.
- Cut tags / publish only after the evidence is complete.
- The active release train target is `v1.1.0`; see `docs/platform/releases/v1.1.0-rc.md`.

### What is explicitly not the active work now
- starting a new architecture wave
- adding new wrapper surfaces just because we can
- cloning reference repos without an intake reason
- creating more planning files that restate the same roadmap

### Execution evidence captured on 2026-04-11
- `repo-foundation`
  - `bun install` passed
  - `bun run check-types` passed
  - `bun run build` passed
  - `bun run test` passed
  - `bun run lint` is still blocked by pre-existing unrelated Biome formatting drift outside the proof changes; this is recorded, not treated as a fake green
- `package-publishability`
  - `bun run check-publishability` passed
- `api-contract`
  - `bun run proof-pack` passed with artifact:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/proof-pack/2026-04-11T13-06-02-440Z.json`
- `live-core`
  - `packages/memory-engine/src/production-readiness.e2e.test.ts` passed on Atlas Local Preview with `94 passed, 2 skipped`
- `live-capability`
  - `packages/memory-engine/src/real-e2e-v2.e2e.test.ts` passed on Atlas Local Preview with `72 passed, 9 skipped`
- `seeded-eval`
  - `bun run memory-eval` passed with artifact:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/real-memory-eval/2026-04-11T13-17-37-290Z.json`
- `official retrieval checkpoint`
  - `POST /v1/admin/relevance/benchmark` passed with a lightweight official-shaped LongMemEval corpus and full `benchmarkReport` artifact:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/benchmark-report/2026-04-11T13-24-12-3NZ-longmemeval-mini.json`
  - build identity in the response:
    - `commitSha=b23369b706bb`
    - `buildId=local-20260411161437`
    - `buildLabel=0.0.0-rc`
- `real-agent`
  - `bun run agent-smoke` passed with artifact:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/real-agent-smoke/2026-04-11T13-26-05-217Z.json`
- `capability-stress`
  - `bun run capability-stress` passed with artifact:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/real-capability-stress/2026-04-11T13-44-17-537Z.json`
- `benchmark corpus note`
  - the mirrored `locomo10` and `locomo1` runs are useful heavier soak inputs, but the fast release-proof checkpoint intentionally used a tiny official-shaped LongMemEval corpus to capture the full benchmark contract quickly and reproducibly
- `MongoDB topology confirmation`
  - Atlas Local Preview was confirmed through MongoDB MCP as a running local deployment on MongoDB `8.2.6`
  - MongoDB knowledge-base checks were revalidated for:
    - auto-embedding preview support on Docker-based local deployments
    - vector-search pre-filter fields requiring `type: "filter"` in the index definition

---

## Source Of Truth

| Role | File | Status |
|------|------|--------|
| Architecture constitution | `docs/plans/2026-04-10-harmony-memory-roadmap.md` | active |
| Execution sequence | `docs/plans/2026-04-10-benchmark-first-harmony-execution-plan.md` | active |
| Release gates | `docs/platform/PRODUCTION-READY.md` | active |
| Proof lanes and artifact policy | `docs/platform/validation-pack.md` | active |
| Benchmark claim policy | `docs/benchmarks/benchmark-operating-contract.md` | active |
| Publish mechanics | `docs/platform/publish.md` | active |
| Historical wave spec | `docs/plans/2026-04-10-wave1-conversation-recall-plan.md` | reference only |
| Old backlog | `docs/plans/2026-04-08-definitive-roadmap-plan.md` | reference only |

If two docs conflict, apply them in this order:
1. architecture constitution
2. this execution plan
3. release/proof docs
4. historical plans

---

## Context And Reference Intake Protocol

Use this exact order before any substantive task.

### Step 0: Load project memory
Read:
- `.claude/cc10x/v10/activeContext.md`
- `.claude/cc10x/v10/patterns.md`
- `.claude/cc10x/v10/progress.md`

### Step 1: Read the smallest active docs set
- Always read this plan.
- Read only the platform docs for the stage you are touching:
  - release gates: `docs/platform/PRODUCTION-READY.md`
  - proof lanes: `docs/platform/validation-pack.md`
  - benchmark claim policy: `docs/benchmarks/benchmark-operating-contract.md`
  - publish mechanics: `docs/platform/publish.md`

### Step 2: Use the installed skills intentionally
- Default build/review/plan routing: `cc10x-router`
- Schema/index/modeling work: `mongodb-schema-design`
- Search/vector/ranking work: `mongodb-search-and-ai`
- Query-shape / explain / performance work: `mongodb-query-optimizer`
- Topology / driver / pool work: `mongodb-connection`
- Skill gap only: `find-skills`

### Step 3: Validate MongoDB-sensitive claims with MongoDB tools first
- Use MongoDB MCP `search_knowledge` for documentation-backed product rules.
- Use MongoDB MCP live tools for real deployment checks when the local Atlas Local stack is part of the task:
  - `atlas_local_list_deployments`
  - `atlas_local_connect_deployment`
  - `collection_indexes`
  - `explain`
  - `aggregate`
  - `mongodb_logs`
- Use official MongoDB web docs only when the MCP knowledge base does not answer the question cleanly.

### Step 4: External reference intake
- First choice: use the existing local reference corpus at `/Users/rom.iluz/Dev/memory-referance/`.
- Second choice: use Octocode to inspect specific GitHub files without cloning.
- Clone into `/Users/rom.iluz/Dev/memory-referance/` only when all are true:
  - Octocode inspection is too shallow for the task,
  - multi-file offline study is actually needed,
  - the reference is expected to stay useful beyond one turn.
- Whenever a new reference repo is cloned, record the exact path in CC10X memory.

### Step 5: Milestone discipline
After each meaningful milestone:
1. update CC10X memory
2. update this plan if sequencing or status changed
3. write a short builder memo for review
4. create a scoped commit

---

## MongoDB-Validated Guardrails

These are part of the plan because they affect how we interpret proof and benchmarks.

### Query settings
Validated against MongoDB documentation via the MongoDB knowledge base:
- `setQuerySettings` applies to a query shape on the entire cluster.
- The cluster retains query settings after shutdown.
- Therefore Memongo must keep query-governance output advisory-only and operator-reviewed.

### Vector search pre-filters
Validated against Atlas Vector Search documentation via the MongoDB knowledge base:
- any field used in `$vectorSearch.filter` must be indexed with `type: "filter"` in the vector search index definition.
- this is why proof and benchmark tasks must inspect the real index definitions before blaming ranking behavior on the application.

### Document versioning
Validated against the MongoDB Document Versioning Pattern documentation:
- current documents and historical revisions belong in separate collections.
- this confirms that Memongo lifecycle/history should stay on the current-plus-revisions model rather than embedding unbounded history arrays.

### Time-series analytics
Validated against MongoDB time-series documentation:
- query stable scalar `meta.*` subfields, not the whole `meta` object.
- use the `timeField` for range filters.
- this matches Memongo’s `access_events` design and must remain true during analytics proof work.

---

## Active Execution Board

| Stage | Status | Goal |
|------|--------|------|
| R1 | complete | repo foundation, publishability, and proof artifact discipline |
| R2 | complete | live MongoDB proof on Atlas Local Preview |
| R3 | complete | benchmark truth and seeded-eval evidence |
| R4 | active | package versioning, changelog/release notes, tags, publish readiness |
| R5 | active-planning | Benchmark-to-#1 program for MemPalace tools ranking and competition credibility |

---

## Stage R1: Release Foundation And Artifact Discipline

**Why this stage exists:** before touching publish/version/tag mechanics, prove the repository, supported HTTP contract, and package surfaces are green.

### References
- `docs/platform/PRODUCTION-READY.md`
- `docs/platform/validation-pack.md`
- `docs/platform/publish.md`
- `scripts/proof-pack.ts`
- `scripts/check-publishability.ts`

### Task R1.1: repo-foundation lane

Run from repo root:

```bash
bun install
bun run check-types
bun run lint
bun run build
bun run test
```

If `bun run lint` fails only because of pre-existing unrelated drift, record the exact blocker and rerun a narrow Biome check on the touched scope before continuing.

### Task R1.2: package-publishability lane

Run from repo root:

```bash
bun run check-publishability
```

If this fails, fix package manifests / dist / tarball hygiene before running any release tag logic.

### Task R1.3: proof artifact persistence

Set an artifact directory before the proof lanes:

```bash
export MEMONGO_PROOF_ARTIFACT_DIR=".claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts"
mkdir -p "$MEMONGO_PROOF_ARTIFACT_DIR"
```

### Task R1.4: API contract proof-pack

With `apps/api` running against a real MongoDB stack:

```bash
export MEMONGO_API_URL="http://127.0.0.1:3847"
export MEMONGO_AGENT_ID="proof-main"
export MEMONGO_SESSION_ID="proof-session"
bun run proof-pack
```

### Stage R1 exit criteria
- `repo-foundation` is green or has explicitly recorded pre-existing blockers.
- `package-publishability` is green.
- `proof-pack` emits an artifact or clear JSON output.
- Any failures are converted into scoped remediation tasks, not hand-waved.

### Stage R1 recorded status
- complete on 2026-04-11
- blocker note:
  - repo-wide `bun run lint` remains red only because of unrelated existing formatting drift; this did not block `check-types`, `build`, `test`, `check-publishability`, or `proof-pack`

---

## Stage R2: Live MongoDB Proof On Atlas Local Preview

**Why this stage exists:** benchmark claims are meaningless if the supported MongoDB topology is not proven on the real product path.

### References
- `docs/platform/PRODUCTION-READY.md`
- `docs/platform/validation-pack.md`
- `packages/memory-engine/src/production-readiness.e2e.test.ts`
- `packages/memory-engine/src/real-e2e-v2.e2e.test.ts`
- `packages/memory-engine/src/mongodb-e2e.e2e.test.ts`

### Task R2.1: confirm Atlas Local preview health

Use the shared Atlas Local preview deployment. Confirm health before blaming app code:

```bash
docker inspect --format='{{.State.Health.Status}}' mongodb-atlas-local
```

If the container just became healthy, allow 10-30 seconds for Search / vector / auto-embed warmup.

### Task R2.2: live-core lane

Run:

```bash
cd packages/memory-engine
MONGODB_TEST_URI="mongodb://127.0.0.1:27017/?directConnection=true" \
bunx vitest run src/production-readiness.e2e.test.ts
```

If the preview environment lacks a valid `al-...` Atlas Model key, record vector-only assertions as skipped capability checks rather than fake failures.

### Task R2.3: live-capability lane when the environment supports it

Auto-embed/search lane:

```bash
cd packages/memory-engine
MONGODB_TEST_URI="mongodb://127.0.0.1:27017/?directConnection=true" \
bunx vitest run src/real-e2e-v2.e2e.test.ts
```

Replica-set-only lane when those features matter:

```bash
cd packages/memory-engine
MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true" \
bunx vitest run src/mongodb-e2e.e2e.test.ts
```

### Stage R2 exit criteria
- `production-readiness.e2e.test.ts` passes on Atlas Local Preview.
- Search/vector capability status is explicitly recorded as pass or skipped-by-environment.
- Any topology-specific failure is classified as product bug, environment problem, or unsupported claim.

### Stage R2 current status
- `production-readiness.e2e.test.ts` is already green on Atlas Local Preview
- `real-e2e-v2.e2e.test.ts` now passes on Atlas Local Preview with `72 passed, 9 skipped`
- current environment note:
  - the active shell/container state does not currently expose a valid `al-...` Atlas Model key, so the auto-embed and rerank-only assertions are now recorded honestly as skipped capability checks instead of false product failures

---

## Stage R3: Benchmark Truth And Seeded Evaluation

**Why this stage exists:** this is the “moment of truth” stage. The product is not benchmark-credible until the benchmark and eval evidence is recorded from the shipped runtime.

### References
- `docs/benchmarks/benchmark-operating-contract.md`
- `docs/platform/benchmark-pack.md`
- `docs/platform/validation-pack.md`
- `scripts/real-memory-eval.ts`
- `scripts/compare-memory-eval.ts`
- `scripts/real-agent-smoke.ts`
- `scripts/real-capability-stress.ts`
- `apps/api/src/routes/v1.ts`

### Task R3.1: set build identity for all recorded benchmark artifacts

```bash
export MEMONGO_BUILD_COMMIT="$(git rev-parse HEAD)"
export MEMONGO_BUILD_ID="local-$(date +%Y%m%d%H%M%S)"
export MEMONGO_BUILD_LABEL="0.0.0-rc"
```

### Task R3.2: seeded eval lane

With API running:

```bash
export MEMONGO_API_URL="http://127.0.0.1:3847"
bun run memory-eval
```

### Task R3.3: baseline-vs-candidate compare lane when a second API is available

```bash
export MEMONGO_BASELINE_API_URL="http://127.0.0.1:3847"
export MEMONGO_CANDIDATE_API_URL="http://127.0.0.1:3850"
bun run compare-memory-eval
```

Skip this lane only if a real baseline/candidate pair is not available yet, and record that skip honestly.

### Task R3.4: official retrieval benchmark lane

Run against the supported API route with a curated dataset path that resolves inside the workspace or the configured benchmark corpus root:

```bash
curl -sS -X POST "http://127.0.0.1:3847/v1/admin/relevance/benchmark" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "proof-main",
    "datasetPath": "<approved-benchmark-dataset>.json",
    "maxResults": 10,
    "minScore": 0.1
  }'
```

Persist the full response JSON. Do not summarize away `benchmarkReport`, `officialMetrics`, `warnings`, or `degradations`.

### Task R3.5: real-agent and capability-stress lanes

With API running:

```bash
export MEMONGO_API_URL="http://127.0.0.1:3847"
bun run agent-smoke
bun run capability-stress
```

### Stage R3 exit criteria
- seeded eval is recorded
- official benchmark response is recorded with `benchmarkReport`
- any claim uses the exact dataset, topology, embedding setup, and build id
- real-agent and capability-stress lanes are either green or explicitly documented as blocked by environment

### Stage R3 recorded status
- complete on 2026-04-11
- recorded artifacts:
  - seeded eval:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/real-memory-eval/2026-04-11T13-17-37-290Z.json`
  - benchmark report:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/benchmark-report/2026-04-11T13-24-12-3NZ-longmemeval-mini.json`
  - real-agent:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/real-agent-smoke/2026-04-11T13-26-05-217Z.json`
  - capability-stress:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/real-capability-stress/2026-04-11T13-44-17-537Z.json`
- note:
  - the capability-stress harness needed proof-lane hardening so its cache, benchmark-dataset, and graph checks exercised the supported Memongo path honestly

---

## Stage R4: Packaging, Versioning, And Release Cut

**Why this stage exists:** after proof is green, package and git metadata must match what we are actually shipping.

### References
- `docs/platform/publish.md`
- `docs/platform/PACKAGE-STATUS.md`
- `README.md`
- `docs/platform/releases/v1.1.0-rc.md`

### Task R4.1: version audit
- confirm which `@memongo/*` packages are part of the release
- decide semver bumps from the last published or tagged state
- update package versions intentionally, not mechanically
- version audit result on 2026-04-11:
  - npm registry baseline for `@memongo/*`: not published
  - git release baseline: repo already tagged `v1.0.0` on 2026-03-30
  - coordinated release train target: `v1.1.0`
  - package set normalized to `1.1.0` so the publishable scope no longer mixes `1.0.0` and `0.1.0`

### Task R4.2: release notes and docs hygiene
- update README / platform docs only where the supported story changed
- create or update release notes / changelog material for the exact shipped scope
- do not claim npm release readiness if a release-blocking lane is still red
- release-candidate memo lives at `docs/platform/releases/v1.1.0-rc.md`
- R4 remediation note on 2026-04-11:
  - a release-blocking benchmark regression appeared after the packaging milestone: event-backed hybrid search results were returning the correct chunk paths but dropping `canonicalId` / `sourceEventIds`, so benchmark scoring could not recover source-session evidence
  - the fix was intentionally storage-free: derive event identity from `events/{eventId}` chunk paths in `mongodb-search.ts`, and preserve merged identity/provenance metadata in `mongodb-hybrid.ts`
  - dirty-tree validation restored the supported benchmark lane on `longmemeval-mini.json` to `hitRate=1`, `R@5=1`, `R@10=1`, `NDCG@10=1`
  - committed-candidate proof is still required before tag/publish

### Task R4.3: tag and publish readiness
- create matching git tag(s) only after proof lanes are green
- publish only the intended packages under `@memongo/*`
- verify package tarballs and install smoke one last time if versions changed after R1
- committed-candidate proof refresh on 2026-04-11:
  - `bun run check-publishability` passed
  - `bun run proof-pack` passed with artifact:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/proof-pack/2026-04-11T14-22-28-952Z.json`
  - fresh benchmark artifact recorded with release build identity:
    - `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/benchmark-report/2026-04-11T14-21-20Z-02544b18ae-longmemeval-mini.json`
  - committed benchmark result remained green:
    - `build.commitSha=02544b18ae`
    - `build.buildLabel=1.1.0-rc`
    - `hitRate=1`, `R@5=1`, `R@10=1`, `NDCG@10=1`
  - conversation recall regression suite also passed separately:
    - `bun x vitest run packages/memory-engine/src/mongodb-conversation-recall-benchmark.test.ts`
- publish order:
  1. `@memongo/lib`
  2. `@memongo/memory-engine`
  3. `@memongo/memory-bridge`
  4. `@memongo/memory`
  5. `@memongo/client`
  6. `@memongo/tools`

### Stage R4 exit criteria
- package versions, docs, and tags all match the proofed release scope
- publish can happen without hidden manifest drift
- benchmark evidence and release notes point to the same commit/build
- the committed candidate has both proof-pack and benchmark artifacts recorded before tag/publish

---

## Stage R5: Benchmark-to-#1 Program

**Why this stage exists:** the user goal is to make Memongo the #1 entry on
`https://www.mempalace.tech/tools`. The current `longmemeval-mini` release
proof shows the shipped retrieval path is healthy, but it is not broad enough
to claim a public benchmark win. R5 turns the release-candidate product into a
competition-credible memory system with public evidence, simple packaging, and
a submission packet.

**Current external target, checked on 2026-04-11:**
- MemPalace.tech's ranking article says it weights:
  1. LongMemEval benchmark accuracy
  2. pricing
  3. setup time
  4. local-vs-cloud posture
  5. features
- The same article ranks MemPalace #1 with `96.6%` raw LongMemEval accuracy,
  `Free`, `Local: Yes`, `MIT`, and 19 MCP tools.
- MemPalace.tech's benchmark analysis treats `96.6% raw / zero API` as the
  credible score to beat, while calling `100% hybrid` technically real but
  caveated because targeted patches were applied after analyzing failures.
- The same benchmark analysis calls out LoCoMo `top_k=50` as a methodological
  concern because it can retrieve the whole candidate pool and test reading
  comprehension instead of memory retrieval.
- Therefore Memongo's #1 strategy must prioritize honest raw/local benchmark
  credibility over reranker-assisted marketing numbers.

### External references for R5
- MemPalace tools directory:
  - `https://www.mempalace.tech/tools`
- MemPalace ranking methodology:
  - `https://www.mempalace.tech/blog/best-ai-memory-frameworks-2026`
- MemPalace benchmark analysis:
  - `https://www.mempalace.tech/benchmarks`
- Official LongMemEval repository:
  - `https://github.com/xiaowu0162/LongMemEval`
  - current official data is the cleaned Hugging Face release referenced by the
    repo, with `longmemeval_s_cleaned`, `longmemeval_m_cleaned`, and
    `longmemeval_oracle` variants.
  - official fields to preserve: `question_id`, `question_type`,
    `question_date`, `haystack_session_ids`, `haystack_dates`,
    `haystack_sessions`, per-turn `has_answer`, and `answer_session_ids`.
- Official LoCoMo paper:
  - `https://aclanthology.org/2024.acl-long.747/`
- Stretch benchmark candidates discovered on 2026-04-11:
  - WMB-100K: `https://github.com/Irina1920/WMB-100K`
  - LifeBench: `https://github.com/1754955896/LifeBench`

### R5 non-negotiable claim policy
- Do not claim `#1` until the full public evidence packet exists.
- Do not compare `longmemeval-mini` to MemPalace's 500-question score.
- Do not publish a reranker-assisted headline without an equally visible raw
  score and held-out score.
- Do not use LoCoMo with `top_k` greater than the candidate pool as the headline.
- Do not tune on the exact failing questions and report the same split as clean
  unless the patch process is disclosed and a held-out split is also reported.
- Every public number must include:
  - commit SHA
  - Memongo version/build label
  - dataset name and version/hash
  - MongoDB topology and version
  - search indexes and embedding/rerank provider
  - command used
  - raw JSON artifact path
  - warnings/degradations/skips

### R5.0: Fix benchmark-report truth footgun before public runs

**Status:** complete on 2026-04-12.

**Problem:** an external audit found that
`buildBenchmarkRunReport()` currently marks `official-retrieval` as `passed`
whenever `officialMetrics` exists, even if `cases=0` or `scoredCases` is
missing/partial in a future call site. Current call sites pass `scoredCases`,
but the helper itself is too trusting for public benchmark work.

**Implementation tasks:**
- Update `packages/memory-engine/src/mongodb-benchmark-runner.ts` so
  `official-retrieval` only passes when:
  - `officialMetrics` exists
  - `cases > 0`
  - `scoredCases` is present
  - `scoredCases === cases`
  - no release-blocking official metric warning is present
- Make partial scoring a `warning` or `failed` gate, not a clean pass.
- Add unit tests for:
  - `officialMetrics` present but `cases=0`
  - `officialMetrics` present but `scoredCases` omitted
  - `officialMetrics` present but `scoredCases < cases`
  - `officialMetrics` present but `scoredCases > cases`
  - clean full-scored official run

**Verification:**
```bash
bunx vitest run packages/memory-engine/src/mongodb-benchmark-runner.test.ts
bun run check-types
bun run build
```

**Exit criteria:**
- a report helper cannot accidentally bless a degenerate official benchmark run
- docs and tests prove the stricter release gate
- commit this as a standalone benchmark-truth remediation

**Recorded result:**
- `official-retrieval` now passes only when `officialMetrics` exists,
  `cases > 0`, `scoredCases` is present, and `scoredCases === cases`.
- Zero-case, missing-scored-case, partial-scored-case, and mismatched
  over-scored official reports now stay at `warning`.
- `docs/benchmarks/benchmark-operating-contract.md` now documents full scored
  coverage as a publishable-claim requirement.
- Focused verification:
  - `bunx vitest run packages/memory-engine/src/mongodb-benchmark-runner.test.ts`
    passed (`13/13`).

### R5.1: Full official LongMemEval raw lane

**Goal:** produce the exact number that matters for the directory: Memongo raw
LongMemEval retrieval quality, without LLM reranking or post-processing.

**Dataset tasks:**
- Download or point at official cleaned LongMemEval data from the official repo
  and Hugging Face link.
- Support all relevant official variants:
  - `longmemeval_s_cleaned`
  - `longmemeval_m_cleaned`
  - `longmemeval_oracle` only as a diagnostic, not as the headline
- Preserve official evidence metadata:
  - `answer_session_ids` for session-level recall
  - `has_answer: true` turns for turn-level recall
  - `question_type` for breakdowns
  - `question_date` and session timestamps for temporal correctness

**Runner tasks:**
- Add a named benchmark mode:
  - `raw-local-longmemeval`
- Ensure the mode disables:
  - LLM reranking
  - answer-generation grading
  - question-specific patch logic
  - cloud-only reader assistance
- Use Memongo's native retrieval path:
  - canonical `writeConversationEvent()` ingestion
  - event chunks and derived memory
  - MongoDB Search / Vector Search / hybrid search as configured
  - `sourceEventIds` and `sessionId` provenance for scoring
- Record metrics:
  - `R@1`, `R@3`, `R@5`, `R@10`, `R@30`, `R@50`
  - `recall_any`, `recall_all`, `ndcg_any` at each k
  - turn-level and session-level metrics
  - latency p50/p95/p99
  - empty-rate
  - skipped cases
  - question-type breakdown

**Evidence tasks:**
- Write the full artifact under the CC10X proof artifact root.
- Add a public-safe summary under `docs/platform/releases/` or
  `docs/benchmarks/` only after the full run is complete.
- Keep the raw JSON local if it includes any dataset content that should not be
  republished; publish hashes and aggregate metrics instead.

**Target threshold:**
- Minimum to be listed credibly: publish a full cleaned LongMemEval raw score.
- Target to challenge #1: `R@5 > 96.6%` on the same comparable split.
- Stretch: match or exceed MemPalace's held-out `98.4%` with a disclosed
  held-out split.

**Verification:**
```bash
bun run check-types
bunx vitest run packages/memory-engine/src/mongodb-benchmark-runner.test.ts
bun run test --filter @memongo/memory-engine
```

**Exit criteria:**
- full raw LongMemEval artifact exists
- score is comparable to MemPalace's raw claim
- all caveats are disclosed
- any failure cases are saved for analysis without patching the same split as a
  clean headline

### R5.2: Held-out LongMemEval lane

**Goal:** avoid the exact criticism MemPalace received: tuning to known failing
questions and reporting the same test as clean.

**Tasks:**
- Define train/dev/test or analysis/held-out split policy before looking at
  failure details.
- If we analyze failures from the 500-question set, only report those
  improvements as tuned-run results.
- Build a separate held-out run:
  - either the official cleaned data with a pre-declared split
  - or a regenerated/custom LongMemEval-style corpus using the official custom
    history pipeline guidance
- Record both:
  - raw full-set result
  - held-out result

**Exit criteria:**
- Memongo can say "we ran raw and held-out" without hiding patch/tuning history
- benchmark docs explain which number is the headline and which is diagnostic

### R5.3: Strict LoCoMo lane

**Goal:** produce a LoCoMo result that cannot be dismissed as top-k inflation.

**Methodology rules:**
- `top_k` must be less than the candidate pool and explicitly recorded.
- Run at multiple k values:
  - `k=1`, `k=3`, `k=5`, `k=10`, `k=20`
- Do not use `top_k=50` as the headline if it retrieves the whole pool.
- Preserve dialog/evidence IDs when available.
- Separate retrieval quality from answer-generation quality.

**Tasks:**
- Verify current LoCoMo normalizer preserves `expectedDialogIds`.
- Add or validate strict scoring modes:
  - dialog evidence recall
  - session evidence recall
  - answer-generation score only as secondary
- Record methodology caveats in the benchmark report.

**Target threshold:**
- Beat MemPalace's public `88.9%` LoCoMo claim on a stricter retrieval setup, or
  publish an honest result with methodology stronger than theirs.

**Exit criteria:**
- strict LoCoMo artifact exists
- no whole-corpus retrieval loophole
- report separates retrieval from reader/LLM comprehension

### R5.4: Failure analysis without benchmark theater

**Goal:** use failures to improve Memongo without contaminating claims.

**Tasks:**
- Build a failure ledger for each benchmark:
  - question id
  - question type
  - expected evidence ids
  - retrieved ids
  - missing provenance field, if any
  - retrieval recipe used
  - MongoDB explain/index snapshot when useful
- Classify failures:
  - ingestion/normalization bug
  - provenance scoring bug
  - retrieval ranking miss
  - stale/temporal truth miss
  - query rewrite issue
  - benchmark ambiguity
  - answer/evidence mismatch
- Only fix generalizable categories, not individual question hacks.
- After fixes, rerun:
  - focused regression
  - full raw lane
  - held-out lane

**MongoDB-specific analysis tools:**
- `collection_indexes` for benchmark collections
- `explain` for slow/odd retrieval shapes
- `$rankFusion` and `$scoreFusion` capability checks
- vector pre-filter validation for fields used in `$vectorSearch.filter`
- query-governance advisory output, never implicit `setQuerySettings`

**Exit criteria:**
- no benchmark fix merges without a failure category and a regression test
- no public score is silently improved by question-specific patches

### R5.5: Search recipe tournament

**Goal:** choose the best Memongo retrieval recipe for the public raw benchmark
without hardcoding a benchmark-only path.

**Candidate recipes:**
- `fast`
- `hybrid`
- `deep`
- `temporal`
- `chain-of-thought`
- raw event-only search
- derived-memory-assisted search
- context-bundle-assisted retrieval as a non-headline diagnostic

**Rules:**
- The winning recipe must use a public product path, not a hidden benchmark-only
  executor.
- Recipe config must appear in `resolvedSearchConfig`.
- Cache keys must include recipe-sensitive inputs.
- Any MongoDB query-governance suggestion stays advisory.

**Metrics:**
- R@5 / R@10 / NDCG@10
- official LongMemEval metrics at k=1/3/5/10/30/50
- p95 latency
- empty-rate
- cost/key requirements
- setup complexity

**Exit criteria:**
- one default public benchmark recipe is selected
- at least one local-only/raw recipe is published
- any reranker/hybrid-assisted number is clearly labeled as assisted

### R5.6: Setup simplicity lane

**Goal:** score well on MemPalace.tech's setup factor.

**Tasks:**
- Make "zero to working memory" a first-class proof lane:
  - `bun install`
  - start MongoDB Atlas Local Preview
  - start API
  - run one memory write/search
  - run mini benchmark
- Add a single copy-paste quickstart command sequence in the README and docs.
- Add a troubleshooting note for:
  - Docker/Atlas Local memory pressure
  - Atlas Model key vs direct Voyage key
  - `mongot` warmup
  - replica-set-only tests vs preview-stack tests
- Add a "3-minute smoke" script if the existing proof pack is too heavy for a
  new evaluator.

**Scoring target:**
- MemPalace currently markets "install in 3 commands".
- Memongo should aim for:
  - one install command
  - one local MongoDB command
  - one smoke/benchmark command

**Exit criteria:**
- a new evaluator can prove Memongo in under 10 minutes on a healthy laptop
- docs do not require reading old roadmap files

### R5.7: Public comparison and submission packet

**Goal:** give MemPalace.tech everything needed to list Memongo and justify a
top ranking.

**Deliverables:**
- `docs/benchmarks/memongo-benchmark-results.md`
  - headline raw LongMemEval score
  - held-out score
  - LoCoMo strict score
  - topology/build/dataset matrix
  - commands
  - caveats
- `docs/platform/versus-mempalace.md`
  - honest comparison:
    - MemPalace advantage: simplest local story, current directory position,
      SQLite/Chroma simplicity, strong raw LongMemEval claim
    - Memongo advantage: MongoDB-native unified runtime, provenance, temporal
      truth, access analytics, full API/MCP/client/tool surface, benchmark
      governance, operator readiness
- `docs/platform/submission-mempalace-tools.md`
  - product name: Memongo
  - link: GitHub repo
  - license
  - pricing: free/open-source
  - local/cloud: local/self-host first
  - setup commands
  - benchmark numbers
  - best-for sentence
  - caveats and artifact links

**Directory submission angle:**
- Do not ask them to rank us #1 by opinion.
- Submit Memongo as "MongoDB-native memory framework with full raw benchmark
  artifact and public reproducibility packet".

**Exit criteria:**
- submission packet is short, factual, and evidence-backed
- public docs contain no stale benchmark or API claims

### R5.8: Docs cleanup before public submission

**Goal:** remove doc confusion that could make a reviewer think Memongo is
messy or overclaimed.

**Tasks:**
- Mark pre-2026-04-10 roadmap files as historical at the top, or move them into
  a clearly named archive folder.
- Fix stale novelty wording:
  - replace old "centroid distance" wording with current per-observation k-NN
    surprisal wording.
- Fix stale hybrid wording:
  - describe capability-gated `$rankFusion` / `$scoreFusion`, not only one
    fusion operator.
- Expand API overview docs to include the actual public surfaces:
  - search-detailed
  - active slate hydration
  - discovery projection
  - context bundle
  - conversation recall
  - chain trace
  - novelty scan
  - consolidate
  - feedback/outcome surfaces
- Keep historical docs, but make the active path impossible to miss.

**Exit criteria:**
- a reviewer can identify the active roadmap and benchmark docs in under one
  minute
- public docs no longer describe old implementations as current behavior

### R5.9: Stretch benchmark expansion

**Goal:** move beyond the MemPalace scoreboard after the LongMemEval/LoCoMo
head-to-head is credible.

**Candidate stretch lanes:**
- WMB-100K:
  - 100,000-turn benchmark
  - synthetic, English-only, vendor-created caveat
  - useful for scale and false-memory stress, not a first headline
- LifeBench:
  - long-horizon, multi-source memory
  - full-year personal life and digital trace data
  - useful for showing Memongo's event/provenance model beyond chat-only memory
- Future task-oriented memory benchmarks:
  - include only after the runner can preserve tool/task evidence IDs

**Exit criteria:**
- at least one stretch benchmark proves Memongo is not merely tuned to
  LongMemEval
- stretch results are clearly labeled by maturity and caveats

### R5.10: Release and public claim gates

Memongo is ready to seek #1 placement only when all are true:
- R5.0 benchmark-report truth footgun is fixed and committed
- full LongMemEval raw run is complete
- held-out LongMemEval run is complete or explicitly scheduled with a published
  caveat
- strict LoCoMo run is complete
- docs cleanup is complete enough that stale plans cannot be mistaken for active
  work
- setup path is documented and smoke-tested
- public comparison/submission packet exists
- `bun run check-types`, relevant benchmark tests, `bun run build`, and the
  selected live benchmark lanes pass
- every claim has an artifact

### R5 forbidden shortcuts
- no hidden benchmark-only retriever
- no second truth store
- no score improvement by patching individual known failures and calling it raw
- no vague "state of the art" claim without a comparable benchmark matrix
- no public "100%" unless it is tied to a named corpus, split, and methodology
- no tag/publish/submission after only a mini benchmark

---

## Remediation Loop Rule

If any proof or benchmark lane fails:

1. create a scoped remediation task
2. reproduce with the narrowest failing command
3. fix only that failure
4. rerun the focused failing lane
5. rerun the parent gate if the fix changed shared behavior
6. update CC10X memory and this plan status
7. commit the remediation before moving on

---

## Definition Of Success

Memongo reaches 100% for this roadmap when all are true:
- the six-wave product roadmap remains green
- the release-blocking proof lanes are green or honestly marked skipped-by-environment
- benchmark evidence is recorded with `benchmarkReport`, build identity, dataset identity, and topology
- package versioning/tagging/publish scope matches the proved artifact
- CC10X memory and this plan both reflect reality without stale “next wave” drift
