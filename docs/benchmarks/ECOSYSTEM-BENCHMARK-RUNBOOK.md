# Ecosystem Benchmark Runbook

Status: operational runbook for fresh Atlas benchmark batches.

This runbook is the execution layer for
[BENCHMARKS.md](./BENCHMARKS.md) and
[COMPETITOR-BENCHMARK-INVENTORY.md](./COMPETITOR-BENCHMARK-INVENTORY.md).
It exists to prevent benchmark chaos: no reused MongoDB state, no hidden
fallback, no mixed metrics, no untracked claims.

MongoDB capability decisions are governed by
[MONGODB-BENCHMARK-CAPABILITY-DOCTRINE.md](./MONGODB-BENCHMARK-CAPABILITY-DOCTRINE.md).
Do not change retrieval, index, schema, fusion, or answer-context behavior for a
benchmark without a MongoDB docs/MCP-backed decision record.

## Core Rules

- Use `codex/benchmark-ecosystem-evidence` for ecosystem benchmark work.
- Use Atlas Local Preview and managed Atlas as dual proof lanes where feasible.
  Atlas Local Preview is the default development/reproducibility lane; managed
  Atlas remains the publication control lane for rows that need cloud parity.
- Do not migrate old benchmark data into the publication cluster.
- Use one exact prefix per run:
  `memongo_bench_<competitor>_<benchmark>_<lane>_<date>_<suffix>_`.
- Never drop an entire database during benchmark work.
- Run exact-prefix dry-run cleanup before and after every benchmark.
- Keep retrieval recall, hit@k, and judged answer accuracy in separate tables.
- Do not publish any row without a Memongo artifact, competitor artifact or
  scorer output, dataset SHA, command, metric definition, warning/degradation
  state, and cleanup proof.
- Query the `memongo-benchmark-campaign` dogfood namespace before every future
  handoff, then verify every remembered fact against local artifacts before
  treating it as evidence.

## MongoDB Preflight

Set the required values in the shell or secret manager. Do not paste them into
docs or artifacts.

```bash
export MEMONGO_MONGODB_URI="..."
export VOYAGE_API_KEY="<atlas-model-api-key>"
export GROVE_API_KEY="..."
export GROVE_BASE_URL="..."
export MEMONGO_DB_NAME="memongo"
```

For a new publication cluster, the first preflight should require an empty DB:

```bash
bun run benchmark:cluster-preflight -- \
  --prefix=memongo_bench_preflight_20260527_a_ \
  --require-empty-db
```

For later runs, require the exact benchmark prefix to be empty and require no
old `memongo_bench_` collections:

```bash
bun run benchmark:cluster-preflight -- \
  --prefix=memongo_bench_mempalace_lme_raw_20260527_a_
```

Prepare the MongoDB runtime only after the read-only preflight passes:

```bash
MEMONGO_MONGODB_COLLECTION_PREFIX=memongo_bench_mempalace_lme_raw_20260527_a_ \
MEMONGO_PREPARE_WAIT_MS=180000 \
bun run mongodb:prepare
```

Before a measured run, wait for Search and Vector Search indexes to be
queryable. MongoDB Vector Search benchmark guidance treats recall, cost, and
latency/throughput as separate concerns; capture all three where possible. Do
not measure while indexes are building or immediately after heavy indexing if
Search CPU, memory, or page faults indicate warmup instability.

## Run Lifecycle

1. Pick a unique run id and exact prefix.
2. Refresh the campaign ledger:

   ```bash
   bun run benchmark:campaign-ledger -- --out-dir=artifacts/benchmark-campaign-ledger/<date>
   ```

3. Run `bun run check-types`, `bun run build`, and relevant focused tests.
4. Run `benchmark:cluster-preflight`.
5. Run `mongodb:prepare` for the exact prefix.
6. Run a smoke or canary before expensive full runs.
7. Run the benchmark command with build identity env set.
8. Save `benchmark-response.json`, status, logs, command, dataset SHA, artifact
   SHA, latency, storage/cost, warnings, degradations, and miss ledger.
9. Run the scorer/status checker for that lane.
10. For judged or failed artifacts, run miss analysis and capability gates:

    ```bash
    bun run benchmark:mem0-answerer-misses -- <result-json> --out-dir=<artifact-dir>
    bun run benchmark:memory-fixtures -- --out-dir=<artifact-dir>
    bun run benchmark:memory-fixture-gates -- --out-dir=<artifact-dir> --fail-on-error
    bun run benchmark:memory-capabilities -- \
      <result-json> \
      --miss-analysis=<artifact-dir>/answerer-miss-analysis.json \
      --out-dir=<artifact-dir>
    ```

11. Dry-run exact-prefix cleanup:

   ```bash
   bun run mongodb:drop-benchmark-prefix -- \
     --prefix=memongo_bench_mempalace_lme_raw_20260527_a_
   ```

12. Drop only the exact prefix after artifact capture:

    ```bash
    bun run mongodb:drop-benchmark-prefix -- \
      --prefix=memongo_bench_mempalace_lme_raw_20260527_a_ \
      --yes
    ```

13. Verify inventory is clean:

    ```bash
    bun run mongodb:prefix-inventory -- --include-search-indexes
    ```

## Grove For Official Python Harnesses

Some official competitor harnesses use the OpenAI Python SDK directly. Grove's
OpenAI-compatible gateway requires an `api-key` header, so use the Memongo
transport wrapper instead of editing competitor scorer code:

```bash
/path/to/competitor/.venv/bin/python \
  /path/to/memongo/scripts/run-memory-benchmarks-grove.py \
  benchmarks.longmemeval.run \
  --project-name memongo-compat-smoke \
  --evaluate-only \
  --provider openai \
  --answerer-model Kimi-K2.6 \
  --judge-model Kimi-K2.6
```

This wrapper only adds Grove transport headers and sets OpenAI-compatible env
defaults from `GROVE_API_KEY` and `GROVE_BASE_URL`. It must not modify prompts,
scorers, datasets, cutoffs, case filters, or saved retrieval artifacts.

Use conservative transport bounds for Grove/Kimi judged runs. The official
structured-output calls can occasionally time out or return empty JSON over the
same saved retrieval artifacts. Treat this as transport instability, not a
retrieval miss, and preserve the failed artifact. Standard judged rehearsals
should use at least:

```bash
export MEMONGO_GROVE_LLM_TIMEOUT_SECONDS=180
export MEMONGO_GROVE_LLM_MAX_RETRIES=5
export MEMONGO_GROVE_LLM_MIN_MAX_TOKENS=8192
export MEMONGO_GROVE_BLANK_GENERATION_RETRIES=2
```

Do not lower these values for publication rehearsals unless the artifact records
why. If a first judge pass fails with empty `generated_answer` or `{}` while
retrieval evidence is clearly present, rerun only `--evaluate-only --rejudge`
from the saved prediction files. Do not rerun MongoDB ingestion/search just to
paper over a judge transport failure.

## Mem0 Memory-Benchmarks Notes

Run official `memory-benchmarks` commands from the competitor repo root:

```bash
cd /Users/rom.iluz/Dev/memongo-competitors/memory-benchmarks
```

Running the module from another working directory can fail with
`ModuleNotFoundError: No module named 'benchmarks'`.

### Completed rehearsal: 2026-06-09 72-case predict-only and saved-artifact judge

The 2026-06-09 Mem0 rehearsal used this exact identity:

```bash
export RUN_ID="memongo-compat-72-predict-local-lmeprofile-20260609a"
export PREFIX="memongo_bench_mem0_memorybenchmarks_lme72_20260609_a_"
export OUT_DIR="/Users/rom.iluz/Dev/memongo-world-class-replay/artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-72-predict-local-lmeprofile-20260609a"
export MEMONGO_MONGODB_COLLECTION_PREFIX="$PREFIX"
export MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE="longmemeval"
export MEMONGO_MEM0_COMPAT_PORT="8898"
export MEMONGO_MEM0_COMPAT_RERANKING_ENABLED="false"
export MEMONGO_BENCHMARK_DERIVED_WORK_MODE="disabled"
```

Before starting the harness:

```bash
bun run check-types
bun run build
bun run benchmark:cluster-preflight -- --prefix="$PREFIX"
MEMONGO_PREPARE_WAIT_MS=180000 bun run mongodb:prepare
bun run benchmark:mem0-compat
```

Then run the official harness from
`/Users/rom.iluz/Dev/memongo-competitors/memory-benchmarks`:

```bash
OPENAI_API_KEY=unused .venv/bin/python -m benchmarks.longmemeval.run \
  --project-name "$RUN_ID" \
  --run-id "$RUN_ID" \
  --dataset-path /Users/rom.iluz/.memongo/workspace/benchmarks/longmemeval_s_cleaned.json \
  --per-type 12 \
  --top-k 50 \
  --top-k-cutoffs 10,50 \
  --predict-only \
  --mem0-host http://localhost:8898 \
  --max-workers 1 \
  --output-dir "$OUT_DIR"
```

The rehearsal passed: it produced 72/72 prediction files and 72/72 ingestion
ledgers, no empty retrievals, no hidden fallback, no rerank mentions, no
request failures, no OOM, and exact-prefix cleanup proof.

The saved-artifact judged pass then used `--evaluate-only --rejudge` with
`gpt-5` answerer and `gpt-5` judge through the Grove transport wrapper. It
scored top-50 72/72 and top-10 71/72. `top_200` was not present. The result
artifact is:

```text
artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-72-predict-local-lmeprofile-20260609a/longmemeval_results_20260609_125540.json
```

The 2026-06-10 full Mem0 LongMemEval-S attempt completed but did not win:
top-50 scored 88.4% and top-200 scored 88.2% under saved-artifact GPT-5
evaluation, below Mem0's committed 90.4%/93.4% platform rows. Keep the same
split for the next attempt: predict-only retrieval first, exact-prefix cleanup
proof, then saved-artifact judge/evaluate-only. Do not rerun judged evaluation
as a substitute for fixing generic miss categories.

The 2026-06-12 domainfix full Mem0 LongMemEval-S sharded Atlas Local Preview
rehearsal improved the result but still did not win. It completed 20/20 shards,
500/500 prediction files, 500/500 ingestion ledgers, zero empty retrievals, no
hidden fallback, no rerank lane, and exact-prefix cleanup proof. Saved-artifact
GPT-5/Grove evaluation scored top-50 448/500 (89.6%) and top-200 452/500
(90.4%), below Mem0's committed 90.4%/93.4% platform rows. The top-200 answerer
artifact checker passed; top-50 failed one blank non-abstention generated
answer. The miss ledger showed 100 cutoff misses: retrieval-missing evidence
(45), stale-or-conflicting evidence (38), answerer ignored present evidence
(10), count aggregation failure (5), and judge/format ambiguity (2). Treat this
as rehearsal evidence only, not a publication-grade single full-500 win.

Before another full retrieval batch, fix only generic capability families:
blank-answer transport handling, multi-session current-state/count retrieval,
stale/future/out-of-scope evidence suppression, answer-context packing, and
Search/vector score-details audit for missing-evidence cases. Do not add
question-id rules, gold-answer shortcuts, scorer edits, prompt edits, or
competitor-harness changes beyond transport headers.

Predict-only LongMemEval runs do not need an LLM call. Use a harmless local
placeholder for OpenAI compatibility and point the harness at the Memongo
compat server:

```bash
OPENAI_API_KEY=unused .venv/bin/python -m benchmarks.longmemeval.run \
  --project-name memongo-compat-smoke \
  --run-id memongo-compat-smoke \
  --dataset-path /Users/rom.iluz/.memongo/workspace/benchmarks/longmemeval_s_cleaned.json \
  --per-type 1 \
  --top-k 50 \
  --top-k-cutoffs 10,50 \
  --predict-only \
  --mem0-host http://localhost:8898 \
  --max-workers 1 \
  --output-dir /Users/rom.iluz/Dev/memongo-world-class-replay/artifacts/ecosystem-smokes/<run-id>
```

The exact previously failing `single-session-assistant` case `e3fc4d6e` is
selected by `--question-types single-session-assistant --seed 26 --per-type 1`.
Use it only as a regression smoke for generic evidence packaging. Do not add
case-specific retrieval or answer rules.

MongoDB Search highlighting guidance is the product rationale for the Mem0
compat adapter's query-passage packaging: returned memory text should preserve
the query-relevant passage, not blindly clip the head of a long retrieved
memory. This makes downstream judged-answer harnesses see the evidence that
MongoDB already retrieved.

For count/action questions, the Mem0 compat adapter may prepend a derived
action checklist built only from retrieved memories. This is answer-context
packaging, not new retrieval evidence: each checklist bullet must be traceable
to returned memory text, and the row must disclose this as Memongo answer
context behavior. The feature exists because the official answerer can collapse
two distinct obligations in the same exchange, such as `return X` and
`pick up Y`, into one phrase unless the retrieved evidence is structured as
separate action candidates. Keep this generic: normalize evidence categories
such as `dry cleaning for jacket` into the clothing item being retrieved, but
never add an action that is not present in returned memory text.

For count evidence, keep the generated context compact and source-backed:
dedupe repeated candidates by stable item/event identity, cap the evidence
block, preserve the source date, and instruct the answerer to verify the exact
action while ignoring plans or advice. This follows the same MongoDB Search
principle as query-passage packaging: expose the relevant evidence passage that
was already retrieved instead of flooding the answerer with duplicate snippets.
For arithmetic-total questions, sum only source-backed numeric facts from the
retrieved memories for the requested unit family, such as views, comments,
pages, meals, pounds, hours, or dollars. Do not use date numbers, ranks,
duration-window text, unrelated totals, or the number of retrieved sessions as
the answer.
For current/latest questions, prefer the latest source-dated user fact and keep
older conflicting facts visible as superseded context. Do not delete stale
evidence to win a judged answer; label it so the answerer can distinguish the
current answer from prior states.
If a retrieved unit exposes a timestamp from ingestion/projection time rather
than the source conversation/session, treat that lane as not publishable until
the provenance is fixed or the run discloses and filters the affected evidence.
Do not fix count-answer failures by matching a single gold answer when the
retrieved evidence is semantically plausible but the benchmark annotation is
ambiguous; escalate to a broader rehearsal and a generic count policy review.
Do not use the number of retrieved answer sessions as a shortcut for count
answers. In the LongMemEval-S corpus snapshot used for Mem0 compatibility work,
196 questions match count-style wording, and only 12 have a numeric answer equal
to `answer_session_ids.length`; most count answers are quantities such as days,
hours, money, inventory counts, or repeated actions.
For the broader quantitative audit, run
`bun run benchmark:count-policy-audit -- --dataset=<longmemeval.json> --artifact=<memory-benchmarks-result.json> --cutoff=top_50`.
The current audit includes `how much` money/percentage questions as explicit
non-item-count cases: 225 quantitative questions, 212 numeric gold answers, only
21 where `answer_session_ids.length` equals the gold number, and 191 where it
differs. Treat any adapter change that makes session count the answer as a
benchmark shortcut, not a product fix.

The full 2026-06-10 miss ledger shows the current generic fix priority:

- 117 cutoff misses: top_50 58, top_200 59.
- Categories: retrieval-missing-evidence 49, stale-or-conflicting-evidence 47,
  count-aggregation-failure 10, answerer-ignored-present-evidence 8,
  judge-or-answer-format-ambiguity 3.
- Question types: multi-session 70, temporal-reasoning 20,
  single-session-assistant 17, knowledge-update 8, single-session-user 2,
  single-session-preference 0.
- One empty retrieval, `c6853660`, makes both answerer artifact checks fail.
  The answerer status guard now reports `emptyRetrievals`,
  `emptyRetrievalQuestionIds`, `blankGeneratedAnswers`, and
  `nonAbstentionEvaluations` so this cannot be hidden inside a score summary.

Convert every full Mem0 failure into a product capability gate before rerunning
the official harness:

```bash
bun run benchmark:memory-capabilities -- \
  <longmemeval_results.json> \
  --miss-analysis=<answerer-miss-analysis.json> \
  --out-dir=<artifact-dir>
```

For the full 500 attempt, this produced
`artifacts/ecosystem-runs/mem0-memory-benchmarks-longmemeval-full500-predict-local-lmeprofile-20260609a/memory-capability-report.md`.
The report marked publication status `blocked`, with +11 top-50 and +27 top-200
correct answers needed to beat Mem0's committed platform rows. The later
domainfix rehearsal improved to 89.6% top-50 and 90.4% top-200 with zero empty
retrievals, but it is still blocked: at least +5 top-50 and +16 top-200 correct
answers are needed to beat the committed rows, and top-50 still has one blank
non-abstention generated answer. The remaining blockers are multi-session
current-state memory, retrieval coverage, stale/future evidence suppression,
temporal ordering, assistant-side recall, count/current-state aggregation, and
answer-context packing.

The capability report now links each blocker to a product fixture, MongoDB
capability family, and stop condition. Regenerate the generic fixture manifest
beside the report, then execute the generic product gates before any full rerun:

```bash
bun run benchmark:memory-fixtures -- --out-dir=<artifact-dir>
bun run benchmark:memory-fixture-gates -- --out-dir=<artifact-dir> --fail-on-error
```

Therefore the next full Mem0 rerun is blocked on product-generic improvements to
multi-session retrieval/context packaging and count/current-state evidence. Do
not patch the empty retrieval or high-miss questions by id.

Small judged-QA smokes with Grove/Kimi can be unstable because structured
output, content-filter retries, and ambiguous answer counting can change the
pass/fail decision over the same saved retrieval artifacts. Treat six-case
judged runs as diagnostics only. A publishable Mem0 row needs repeatability
criteria, fixed answerer/judge metadata, full artifact hashes, and a larger
rehearsal before any full benchmark.

For Mem0 LongMemEval, prefer `gpt-5` through the Grove wrapper when possible
because the official committed platform artifacts record `gpt-5` as both
generation and judge model. A quick model smoke should use enough completion
budget; too-small `max_completion_tokens` can return an empty response with
`finish_reason=length` even when the model is available.

Atlas Local Preview 72-question predict-only rehearsal `20260603a` completed
72/72 with no hidden fallback or rerank mentions, then cleaned the exact prefix.
It logged vector convergence waits and transient `java.net.ConnectException`
entries during readiness probing. Root cause: the Mem0 adapter writes all
official harness users under the shared `mem0-compat` agent while scoping each
user as `scope=user`, `scopeRef=user:<id>`, and `sessionId=<id>`. The readiness
probe was filtering only by `agentId`, so later questions waited on unrelated
users' documents. The fix narrows benchmark convergence probes with the same
`scope`/`scopeRef`/`sessionId` filters used by the actual search request.

Scoped Local Preview 18-question predict-only smoke `20260603a` completed
18/18 outputs and 18/18 ingestion ledgers after that fix. It had 26 bounded
vector convergence waits, but zero hidden fallback, zero rerank, zero request
failures, zero `java.net.ConnectException`, and exact-prefix cleanup removed 30
benchmark collections. This validates the readiness fix but does not yet make a
publishable Mem0 row. It unlocked scoped 36/72 rehearsals that record vector
wait counts and latency.

The first scoped 36-question Local Preview rehearsal `20260603b` aborted at
14/36 after scoped events vector readiness stalled at `indexedCount=0/529` and
the `memongo-benchmark-preview` container was OOM-killed. Exact-prefix cleanup
succeeded after restarting Local Preview only for cleanup. MongoDB Vector Search
benchmark guidance says the HNSW/vector index must fit in memory and recommends
monitoring Search memory, index size, page faults, and CPU warmup. Therefore,
do not rerun larger Mem0 Local Preview rehearsals on a reused/full-product local
deployment. For the next Local Preview attempt:

```bash
export MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE=longmemeval
```

Set it before `bun run mongodb:prepare` and before `bun run benchmark:mem0-compat`.
Run on a fresh benchmark-only Atlas Local Preview deployment or clean volume
with no dogfood prefix. If that still OOMs or shows repeated vector probe
timeouts, move the Mem0 LongMemEval full rows to managed Atlas with explicit
infrastructure disclosure.

The fresh benchmark-only Local Preview rerun `20260603f` used that
`longmemeval` Search/Vector profile and completed 36/36 official harness
predictions with 36/36 ingestion ledgers. It created and waited for 8/8
Search/Vector indexes, recorded zero hidden fallback, zero rerank, zero request
failures, no OOM, no empty retrievals, and exact-prefix cleanup of 30 benchmark
collections. It still recorded 16 bounded vector convergence waits, two vector
probe timeouts, and one EOF probe error, so it unlocks a scoped 72-case
rehearsal but does not yet prove a publishable Mem0 full row.

Before a full Mem0 LongMemEval row, require:

- prediction artifacts from a strict Memongo compat run with exact-prefix
  cleanup proof,
- a memory capability report for the latest failed or rehearsal artifact, with
  no critical blockers and no empty retrieval red flags,
- two repeated retrieval-judge evaluations over copied saved predictions with
  the official judge model,
- one six-type answerer-mode rehearsal with the same answerer and judge model as
  the competitor row,
- one larger answerer-mode rehearsal after any answer-context packaging change,
- post-run validation that fails the artifact if any non-abstention answerer
  result has an empty `generated_answer` or empty retrieval; run
  `bun run benchmark:mem0-answerer-status -- <artifact> --cutoff=top_50`,
- count-policy audit saved for the larger rehearsal artifact; count-context
  changes must be justified by broad audit flags, not one question ID,
- explicit separation between retrieval-judge diagnostics and judged answer
  accuracy claims.

## Stop Conditions

Stop the run, preserve artifacts, and do not publish the row if any condition is
true:

- The prefix is not isolated.
- A previous `memongo_bench_` collection exists before the run.
- Search or Vector Search indexes are not queryable.
- Strict mode reports fallback, auth failure, rerank failure, queue timeout, or
  empty results.
- The competitor scorer cannot be reproduced from repo-backed files.
- The row changes dataset, scorer, retrieval unit, top-k, case filter, LLM use,
  or reranker without an explicit label.
- A fix would require question IDs or benchmark-specific patterns.

## Benchmark Order

Run rows in this order:

1. Strict 6-case smoke.
2. Strict 48-case canary, twice.
3. MemPalace P0 replay on the fresh Atlas cluster.
4. MemPalace LLM/rerank lane, separately labeled.
5. Mem0 `memory-benchmarks` adapter lanes.
6. Supermemory `memorybench` provider lanes.
7. Zep LoCoMo/LongMemEval harnesses.
8. Mastra, Hindsight, OpenViking, and Letta only after each official competitor
   scorer is reproducible.

## Publication Gate

A row can move into public README language only when:

- Memongo and competitor scores are recomputed from artifacts.
- Artifact hashes and dataset hashes are recorded.
- The metric type is not mixed with another metric type.
- Warning/degradation state is zero or explicitly disclosed.
- Exact-prefix cleanup proof exists.
- Secret scan is clean.

The phrase "best memory framework in the world" remains locked until every
repo-backed P0/P1/P2 competitor benchmark claim is beaten or explicitly scoped
out as non-reproducible.
