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
bunx vitest run scripts/benchmark/mongodb-benchmark-runner.test.ts
bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts
bunx vitest run scripts/benchmark/mongodb-conversation-recall-benchmark.test.ts
```

## Report envelope

Every standalone benchmark run through `bun run benchmark` includes a
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

## Private QA diagnostic capture

For a fresh official or custom-judge QA run, set
`MEMONGO_BENCHMARK_QA_CAPTURE=1` to retain provider requests and outcomes.
Omitted, empty or `0` leaves capture disabled; other values fail before provider
calls. Capture requires absent prediction and capture paths and no completed
resume scenarios. Default prediction privacy and resume behavior are unchanged.

Capture creates `<checkpoint>.predictions.json.capture` as a new private `0700`
directory. Each provider invocation writes an exclusive `0600` request file
before the call and a separate outcome file afterward, including preflight and
transport or judge-content retries. Files are synced and closed. Existing paths,
symlinks, directory replacement and changed directory permissions are refused.
A capture-write failure stops QA before another provider attempt; a request
without a completed outcome remains incomplete and may already have incurred a
provider charge. Filesystem checks cover the owned local POSIX path; they do not
establish power-loss directory durability or protection against concurrent
same-user path replacement.

Requests retain whitelisted model, messages and settings. Outcomes retain the
adapted completion, finish metadata and available usage, or a fixed failure
classification and HTTP status. Known configured API-key values are redacted.
The opt-in artifacts contain private context, gold answers and hypotheses; keep
them private. They do not capture HTTP headers, raw failed response bodies or
live wire traffic. Missing usage stays missing, and reasoning-token detail must
not be added again to output usage.

On the supported HTTP QA path, a fresh single case is bounded by three
preflight, three answer and six judge requests. Logical scoring counters count
answer and judge operations separately from those transport attempts. This
bound excludes ingestion, additional cases, resume and provider-internal
retries, and does not enforce a monetary or whole-run budget. Capture and
injected-request tests are diagnostic evidence, not benchmark-quality results.

## Checkpoint-sidecar comparison

The `b2-join.ts` reader refuses duplicate or inconsistent supplied scenario
IDs, unexpected completed scenarios, duplicate selected final-pass case IDs,
and prediction rows with a mismatched question ID or invalid stage/verdict.
Judged rows require `yes` or `no`; answered and unreliable rows require null.
For declared LongMemEval runs identified by selected LongMemEval metrics, each
scenario has one matching case and prediction IDs must belong to the declared
population. Generic scenarios can retain several distinct case IDs. Earlier
measurement passes are not treated as duplicate final-pass results.

Missing legacy declarations, optional R-only sidecars and partial primary
coverage remain supported. A partial comparison can still emit descriptive
`REAL`; it does not certify complete workload coverage, equal effective
settings, causal improvement or a publishable win. Supplied complete-repeat,
minimum-judged and known declared dataset-inequality guards remain separate.

Build environment labels do not attest the full loaded graph or effective
requests. Record actual entrypoints, loaded artifacts and intended-target
requests before qualification; different single-file compiler output alone
cannot establish a stale or behaviorally different build.

## QA summary population

The official and custom-judge QA summary validates its declared case IDs and
prediction rows before computing metrics or writing an export. Case IDs must
be nonblank and unique. Each row key must match its question ID and belong to
the declared case population. Judged verdicts require `yes` or `no`; answered
and unreliable rows require null. Inconsistent inputs raise the existing
sidecar error without including artifact values or rewriting stored rows.

Valid missing, answered and unreliable cases still withhold whole-workload
accuracy. Declared orphan rows retain incomplete-accounting disclosure; an
empty population stays unavailable, and generic scenarios may contain multiple
cases. This check rejects corrupt or foreign restored inputs at aggregation.
It does not provide admission before provider calls, complete-run coverage or
proof of a matched benchmark result.

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
