# Memongo New Chat Handoff - 2026-05-11

This document is the current source-of-truth handoff for continuing Memongo
publish-polish, dogfooding, and benchmark work in a fresh chat.

It intentionally records both progress and pain. Do not treat the current work
tree as publish-ready. Treat it as an active research/engineering checkpoint.

## New Chat Bootstrap Prompt

Paste this into a new chat:

```text
We are working in /Users/rom.iluz/Dev/memongo on Memongo, a MongoDB-native
long-term memory framework for agents.

Before doing anything, read:
- docs/benchmarks/memongo-new-chat-handoff-2026-05-11.md
- docs/benchmarks/longmemeval-decision-log.md

Then query Memongo dogfood memory for this workspace:
- agentId: codex
- scope: workspace
- scopeRef: workspace:/Users/rom.iluz/Dev/memongo
- query: "Memongo dogfood retrospective 8/type canary preference evidence benchmark harness reliability next action"

Important memory event:
- bdd37b4d-7f44-4efb-ab80-735780f900d2

Do not run large benchmarks immediately. First stabilize and verify the
benchmark harness. We care about honest apples-to-apples results, not benchmark
manipulation. No fallbacks are acceptable in strict benchmark gates.
```

## Dogfood Memory Proof

Memongo memory was used at the handoff boundary.

Retrieved memory:

- Event path:
  `events/bdd37b4d-7f44-4efb-ab80-735780f900d2`
- Session:
  `memongo-retrospective-2026-05-11`
- Scope:
  `workspace:/Users/rom.iluz/Dev/memongo`
- Retrieved content summary:
  Memongo remembered that the preference evidence fix passed targeted and
  strict 1/type gates, but strict 8/type LongMemEval did not complete because
  benchmark harness reliability issues surfaced.

To query it from a fresh session, start the dogfood API:

```zsh
source ~/.zshenv 2>/dev/null || true
MEMONGO_LOG_LEVEL=warn \
MEMONGO_FORCE_MONGODB_URI='mongodb://127.0.0.1:27018/?directConnection=true' \
MEMONGO_MONGODB_COLLECTION_PREFIX='memongo_dogfood_' \
MEMONGO_API_PORT=3848 \
bun --filter @memongo/api start
```

Then search:

```zsh
curl -sS -X POST 'http://127.0.0.1:3848/v1/search' \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "codex",
    "scope": "workspace",
    "scopeRef": "workspace:/Users/rom.iluz/Dev/memongo",
    "query": "Memongo dogfood retrospective 8/type canary preference evidence benchmark harness reliability next action",
    "maxResults": 5
  }'
```

Do not commit secrets. Keys live outside the repo, typically in `~/.zshenv`.

## Product Definition

Memongo is intended to be a MongoDB-native long-term memory layer for agents and
AI applications.

It is not only for coding agents. The target is any agent or app that needs
durable, scoped, auditable recall:

- Coding agents such as Codex or Claude Code.
- Hermes-style personal agents.
- Support agents.
- Research agents.
- Multi-agent systems.
- Product applications that need user/session/workspace memory.
- Operator consoles for inspecting and debugging recall.

The public story should eventually be:

> Memongo is MongoDB-native long-term AI memory: scoped, durable, inspectable
> recall for agents that already have tools, sessions, profiles, and workspaces.

Do not claim "production ready" or "best in the world" until the gates below
pass.

## Architecture And Surfaces

Current surfaces:

- `packages/memory-engine`
  Core MongoDB-backed memory engine, retrieval, event write path, structured
  memories, benchmark harness, MongoDB Search integration, and reranking logic.
- `packages/memory-bridge`
  Configuration and bridge layer used by the API and integrations.
- `apps/api`
  HTTP API for writes, search, context bundle, admin benchmark endpoints, and
  publishability checks.
- `packages/client`
  TypeScript client.
- `apps/mcp`
  MCP server for agent tools.
- `packages/tools`
  AI SDK/tooling surface.
- `apps/web`
  Operator console. It should stay practical and console-like, not a marketing
  page.
- `integrations/hermes/memongo`
  Experimental Hermes Agent memory provider using the HTTP API only.
- `docs/platform/hermes-provider.md`
  Hermes positioning and setup docs.

Supported package names to keep aligned:

- `@memongo/memory-engine`
- `@memongo/memory-bridge`
- `@memongo/memory`
- `@memongo/client`
- `@memongo/tools`

## Isolation Model

Core isolation dimensions:

- `agentId`
- `scope`
- `scopeRef`
- `sessionId`

Important scopes:

- `agent`
- `session`
- `workspace`
- `user`
- `tenant`
- `global`

Current security reality:

- `MEMONGO_API_KEY` authenticates the caller.
- It does not yet authorize the caller to specific `agentId`, `scope`, or
  `scopeRef`.
- Until API-level scope authorization exists, product claims should be
  "single-tenant self-hosted" or "trusted caller boundary".
- Scope filters are necessary for retrieval isolation, but they are not a
  substitute for authorization.

This aligns with the junior AI review: the review was not gospel, but its
scope/isolation warnings correlated with our real benchmark/dogfood concerns.

## Benchmark Philosophy

The user explicitly wants the best memory framework for real, not manipulated
benchmark wins.

Rules:

- Apples-to-apples comparisons only.
- Track benchmark version, raw/LLM modes, selected cases, flags, model, and
  dataset path.
- Strict gates must have zero silent fallback.
- If a model/API fails in strict mode, fail the run.
- If the harness hangs, fix the harness before claiming retrieval quality.
- Use MongoDB features where they genuinely solve the product problem.
- Do not add dataset-specific hacks.
- Fix product invariants, then measure.

Competitor landscape work started earlier:

- MemPalace is an important comparison target.
- Mem0 is another comparison target.
- Need a benchmark matrix covering each competitor's public benchmark modes,
  versions, raw/LLM variants, and methodology.
- Do not publish comparative claims until our runner can reproduce the exact
  competitor setup or clearly label deviations.

## Validated Progress

Preference/recommendation retrieval issue:

- Root cause:
  MongoDB retrieved scoped evidence correctly, but Voyage rerank placed
  assistant recommendation text above user-authored preference/setup evidence.
- Product invariant:
  For preference/profile memory, user-authored preferences, owned gear,
  compatibility constraints, and setup statements are primary evidence.
  Assistant advice is supporting context.
- Fix:
  Added post-rerank preference evidence boost for user-authored compatibility
  and setup evidence in `packages/memory-engine/src/mongodb-manager.ts`.
- Important:
  This is not a LongMemEval label hack. It uses provenance and event role, not
  benchmark expected ids.

Validated gates:

- Targeted replay:
  `raw-strict-pref-fix4-06878be2-2026-05-11T0800`
- Strict 1/type canary:
  `raw-strict-1pertype-pref-fix4-2026-05-11T0804`
- Targeted case:
  `missLedger=[]`, `caseDiagnostics=[]`, session `any@1=1`, turn `any@1=1`
- 1/type:
  6/6 cases scored, warnings 0, degradations 0,
  `missLedger=[]`, `caseDiagnostics=[]`
- 1/type internal:
  `hitRate=1`, `emptyRate=0`, `r@5=1`, `r@10=1`, `ndcg@10=1`,
  `p95LatencyMs=3215`
- 1/type official session:
  `any@1=1`, `all@3=1`, `all@10=1`
- 1/type official turn:
  `any@1=1`, `all@3=0.8333`, `all@10=0.8333`, `all@30=1`

Artifacts:

- `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/raw-strict-pref-fix4-06878be2-2026-05-11T0800/`
- `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/raw-strict-1pertype-pref-fix4-2026-05-11T0804/`

## What Failed Or Did Not Finish

Strict 8/type LongMemEval did not pass because it did not complete.

Observed attempts:

- `raw-strict-8pertype-pref-fix4-2026-05-11T0818`
  Started with noisy API logging. It progressed but stalled/dragged badly.
- `raw-strict-8pertype-pref-fix4-quiet2-2026-05-11T1604`
  Quiet logging fixed terminal backpressure, but the run still did not finish.
- `raw-strict-8pertype-pref-fix4-probe-timeout-2026-05-11T1632`
  Added MongoDB `maxTimeMS` on the convergence probe, but still hung.
- `raw-strict-8pertype-pref-fix4-client-timeout-2026-05-11T1644`
  Added client-side probe timeout, then another unbounded queue-settle issue
  surfaced.

Critical retrospective:

- The 8/type failure is currently a harness reliability failure, not a proven
  retrieval-quality failure.
- We should not spend more money/tokens on larger benchmark runs until the
  harness emits progress and bounded failures.

## Harness Issues Found

1. Terminal log backpressure

- `MEMONGO_LOG_LEVEL=info` emits huge event/episode logs during benchmark runs.
- The PTY can back up and throttle or stall Node writes.
- Use `MEMONGO_LOG_LEVEL=warn` for benchmark runs.
- Longer-term: add benchmark-specific progress logs instead of event-level
  logging.

2. MongoDB Search convergence probe was unbounded

- `waitForBenchmarkEventSearchConvergence()` used `$search` aggregate probes
  without a client-side timeout.
- `maxTimeMS` alone was not enough on the local search path.
- Patch in progress:
  pass `maxTimeMS` and an `AbortSignal`, then wrap `toArray()` in
  `Promise.race`.
- Targeted unit test exists for passing `maxTimeMS` and `signal`.

3. Scenario queue settling was unbounded

- `settleBenchmarkScenarioManager()` awaits `writeQueue` and `derivationQueue`.
- If a background derivation promise never resolves, the whole benchmark hangs.
- Patch in progress:
  add `MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS`, default 60s in strict mode,
  and fail loudly.
- This latest queue-timeout patch still needs tests and type/lint validation.

4. Lack of progress artifacts

- Current canary only writes artifacts after the whole HTTP benchmark returns.
- That is bad for long runs.
- The benchmark endpoint or canary runner should write per-scenario progress so
  a new session can see exactly where it stopped.

## Current Working Tree Risk

The working tree is broad and not publish-ready.

As of this handoff:

- 38 tracked files modified.
- New untracked docs/integration/docker files exist.
- Current changes include API, MCP, web console, docs, client, memory bridge,
  memory engine, benchmark runner, schema/search, tools, Hermes integration,
  and canary script changes.

Do not push to main.
Do not force-push.
Do not rewrite history.
Do not publish packages.

First split into reviewable scopes:

1. Security/scope/API validation.
2. Hermes provider.
3. Benchmark harness reliability.
4. Retrieval/ranking changes.
5. Web console polish.
6. Docs/README.

## Gates

### Gate 0 - Stop The Bleeding

Success:

- No benchmark/API processes running unexpectedly.
- No secrets in repo.
- `git status --short` understood.
- Work split into coherent change groups or at least documented.

### Gate 1 - Harness Reliability

Success:

- Benchmark runs use `MEMONGO_LOG_LEVEL=warn`.
- Convergence probes have hard per-probe client timeouts.
- Queue settling has hard strict-mode timeouts.
- Per-scenario progress is visible in logs or artifact files.
- A failed strict run returns a clear error within bounded time.
- Targeted tests pass:
  `bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts packages/memory-engine/src/mongodb-benchmark-runner.test.ts scripts/run-longmemeval-canary.test.ts`

### Gate 2 - Baseline Health

Success:

- `git diff --check`
- `bun run lint`
- `bun run check-types`
- `bun run build`
- Relevant targeted tests pass.

### Gate 3 - Strict 1/Type Canary

Success:

- 6/6 cases scored.
- No warnings/degradations.
- `missLedger=[]`.
- `caseDiagnostics=[]`.
- Official metrics present.
- Top-answer correctness remains clean.

### Gate 4 - Strict 8/Type Canary

Success:

- 48/48 cases scored.
- No silent fallback.
- No harness hangs.
- Any miss has a case diagnostic and root-cause classification.
- If clean, update `docs/benchmarks/longmemeval-decision-log.md`.

### Gate 5 - Full Benchmark Matrix

Success:

- Every benchmark mode/version is documented.
- MemPalace/Mem0/etc. comparison is apples-to-apples.
- Raw and LLM variants are separated.
- External model, embedding model, dataset version, and flags are recorded.
- Claims are phrased only as strongly as the evidence allows.

### Gate 6 - Public Launch Polish

Success:

- README first screen says "MongoDB-native long-term AI memory" clearly.
- Docs separate supported product surfaces from historical/internal notes.
- Web console is clean enough for public inspection.
- Hermes provider has tests and docs.
- Fresh clone checks pass:
  `bun install`, `bun run check-types`, `bun run lint`, `bun run build`,
  `bun run test`, `bun run check-publishability`.

### Gate 7 - History Cleanup

Only after code/docs gates pass:

- Confirm GitHub repo is standalone, not marked as fork.
- Push backup branch/tag.
- Create clean orphan `main` history.
- Force-push only with explicit confirmation.
- Fresh clone after force-push must pass checks.

## Immediate Next Work

Do not run 8/type again yet.

Next engineering tasks:

1. Add tests for `settleBenchmarkScenarioManager()` queue timeout.
2. Run:
   `bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts`
3. Run:
   `git diff --check`
   `bun run lint`
   `bun run check-types`
4. Add per-scenario progress output/artifact before another 8/type run.
5. Run strict 1/type again after harness changes.
6. Only then retry strict 8/type.

## Success Definition

Near-term success:

- The system fails fast and honestly when strict infrastructure is not ready.
- The 1/type canary remains clean after harness hardening.
- 8/type canary completes with real metrics or bounded, diagnosable failure.

Launch success:

- Fresh clone is green.
- Docs are credible and not overclaiming.
- Hermes works as first non-coding-agent proof.
- Web console is trustworthy for scoped memory inspection.
- Benchmark story is honest, reproducible, and apples-to-apples.
- History cleanup preserves stars and removes inherited fork history.

Perfection target:

- Not "perfect benchmark numbers".
- Perfect means a memory framework that is useful, isolated, inspectable,
  reproducible, safe to operate, and honestly measured.

