# Ecosystem Benchmark Runbook

Status: operational runbook for fresh Atlas benchmark batches.

This runbook is the execution layer for
[BENCHMARKS.md](./BENCHMARKS.md) and
[COMPETITOR-BENCHMARK-INVENTORY.md](./COMPETITOR-BENCHMARK-INVENTORY.md).
It exists to prevent benchmark chaos: no reused MongoDB state, no hidden
fallback, no mixed metrics, no untracked claims.

## Core Rules

- Use `codex/benchmark-ecosystem-evidence` for ecosystem benchmark work.
- Use the managed Atlas publication cluster as the control lane.
- Do not migrate old benchmark data into the publication cluster.
- Use one exact prefix per run:
  `memongo_bench_<competitor>_<benchmark>_<lane>_<date>_<suffix>_`.
- Never drop an entire database during benchmark work.
- Run exact-prefix dry-run cleanup before and after every benchmark.
- Keep retrieval recall, hit@k, and judged answer accuracy in separate tables.
- Do not publish any row without a Memongo artifact, competitor artifact or
  scorer output, dataset SHA, command, metric definition, warning/degradation
  state, and cleanup proof.

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
2. Run `bun run check-types`, `bun run build`, and `bun run test`.
3. Run `benchmark:cluster-preflight`.
4. Run `mongodb:prepare` for the exact prefix.
5. Run a smoke or canary before expensive full runs.
6. Run the benchmark command with build identity env set.
7. Save `benchmark-response.json`, status, logs, command, dataset SHA, artifact
   SHA, latency, storage/cost, warnings, degradations, and miss ledger.
8. Run the scorer/status checker for that lane.
9. Dry-run exact-prefix cleanup:

   ```bash
   bun run mongodb:drop-benchmark-prefix -- \
     --prefix=memongo_bench_mempalace_lme_raw_20260527_a_
   ```

10. Drop only the exact prefix after artifact capture:

    ```bash
    bun run mongodb:drop-benchmark-prefix -- \
      --prefix=memongo_bench_mempalace_lme_raw_20260527_a_ \
      --yes
    ```

11. Verify inventory is clean:

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

## Mem0 Memory-Benchmarks Notes

Run official `memory-benchmarks` commands from the competitor repo root:

```bash
cd /Users/rom.iluz/Dev/memongo-competitors/memory-benchmarks
```

Running the module from another working directory can fail with
`ModuleNotFoundError: No module named 'benchmarks'`.

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

Before a full Mem0 LongMemEval row, require:

- prediction artifacts from a strict Memongo compat run with exact-prefix
  cleanup proof,
- two repeated retrieval-judge evaluations over copied saved predictions with
  the official judge model,
- one six-type answerer-mode rehearsal with the same answerer and judge model as
  the competitor row,
- one larger answerer-mode rehearsal after any answer-context packaging change,
- post-run validation that fails the artifact if any non-abstention answerer
  result has an empty `generated_answer`; run
  `bun run benchmark:mem0-answerer-status -- <artifact> --cutoff=top_50`,
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
