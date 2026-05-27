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
export VOYAGE_API_KEY="<atlas-model-api-key-with-al-prefix>"
export GROVE_API_KEY="..."
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
