# Memongo benchmark operating contract

Memongo benchmark work has one rule: **numbers are product claims only when the
run proves the product path being claimed**. Internal diagnostics are valuable,
but they must not be presented as official benchmark wins.

## Benchmark lanes

| Lane | Purpose | Required trigger | Publishable? |
| --- | --- | --- | --- |
| Official retrieval | LongMemEval / LoCoMo retrieval quality | release candidate, retrieval algorithm changes, benchmark corpus changes | Yes, when dataset, build, MongoDB topology, embeddings, and command are recorded |
| Diagnostic retrieval | Fast regression signal over legacy or custom query sets | every retrieval/search/scoring change | No, unless labeled as non-comparable diagnostics |
| Conversation recall regression | Protect user-visible recall behavior | conversation recall, event schema, session/time filter, citation, or recall-plane changes | No, regression gate only |
| Query governance | Surface candidate MongoDB query-shape settings | benchmark or operator-trace review | Advisory only |
| Proof pack | Confirm build, tests, and live smoke readiness | release candidate | Yes, as release evidence |

## Required commands

Use the narrowest relevant lane while developing, then run the full gate before
release.

```bash
bun run check-types
bun run test
bun run build
```

Run `bun run build` after source edits and before starting a local API-backed
canary. The API loads workspace packages through their built `dist` entrypoints,
so a stale build can hide or invent benchmark behavior.

For benchmark-specific work, include the focused engine/API tests that cover the
touched lane. At minimum:

```bash
bunx vitest run packages/memory-engine/src/mongodb-benchmark-runner.test.ts
bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts
bunx vitest run packages/memory-engine/src/mongodb-conversation-recall-benchmark.test.ts
```

## Report envelope

Every `POST /v1/admin/relevance/benchmark` response includes a
`benchmarkReport` envelope with:

- `generatedAt`
- `build` identity from environment when available
- `corpus` identity and counts
- `metrics.internal`
- optional `metrics.official`
- `releaseGates`
- `warnings`
- `degradations`

Set at least one build identifier before release or public reporting:

```bash
export MEMONGO_BUILD_COMMIT="$(git rev-parse HEAD)"
export MEMONGO_BUILD_ID="local-$(date +%Y%m%d%H%M%S)"
export MEMONGO_BUILD_LABEL="0.0.0-dev"
```

CI providers may provide `GITHUB_SHA`, `GITHUB_RUN_ID`,
`VERCEL_GIT_COMMIT_SHA`, or `VERCEL_DEPLOYMENT_ID`; Memongo reads those as
fallbacks.

## Publishable benchmark claims

A claim may be published only when all are true:

1. `benchmarkReport.releaseGates` contains a passing `official-retrieval` gate.
2. `officialMetrics` is present and matches the dataset being claimed.
3. `corpus.cases > 0` and `corpus.scoredCases === corpus.cases`; partial or
   missing scored-case coverage is a warning, not a publishable official win.
4. The commit/build id, dataset name/version, MongoDB topology, embedding model,
   and benchmark command are recorded.
5. `warnings` and `degradations` are reviewed and disclosed when material.
6. The conversation recall regression test is run for any recall-plane change.

If `datasetKind` is `legacy-query` or `officialMetrics` is absent, the result is
an internal diagnostic, not a benchmark win.

## Query governance policy

Benchmark output may recommend query-shape governance candidates, but it must
not apply MongoDB query settings automatically.

MongoDB query settings are cluster-scoped and persistent. Treat any
`consider-setQuerySettings` candidate as an operator review item:

1. Inspect query stats and explain output.
2. Apply the setting manually in the intended environment.
3. Record the setting and rollback command.
4. Remove it with `removeQuerySettings` if it degrades behavior.

This is why `query-governance` remains `advisory-only` in `benchmarkReport`.

## PR and release delta recording

For every benchmark-affecting PR or release candidate, record:

- base commit and candidate commit
- commands run
- dataset and corpus version
- `benchmarkReport` JSON
- deltas for `hitRate`, `emptyRate`, `p95LatencyMs`, `rAt5`, `rAt10`,
  `ndcgAt10`
- any warnings, degradations, or skipped cases

Do not compare numbers from different corpora, embedding models, or MongoDB
topologies without labeling the comparison as non-equivalent.
