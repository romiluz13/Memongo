# Memongo benchmark matrix

This matrix is the execution map for honest, apples-to-apples memory benchmarks.
It is not a leaderboard. A row becomes a public claim only after the row's gate
passes with raw artifacts and zero strict-mode fallback.

## Global benchmark rules

- Keep benchmark artifacts reproducible: dataset version, command, git SHA,
  MongoDB topology, embedding model, LLM model, and all Memongo feature flags.
- Every Memongo benchmark run must use an isolated MongoDB collection prefix.
  The runners derive `memongo_bench_<run-id>_` when no explicit prefix is set,
  and artifacts must show `mongodb.collectionPrefix`.
- Do not reuse a benchmark prefix across serious runs. Drop only collections
  with that exact prefix after artifact capture; never drop unrelated dogfood,
  product, or competitor data.
- Run strict benchmark lanes with `MEMONGO_BENCHMARK_STRICT=1`.
- Run strict publish lanes with `MEMONGO_LLM_ENRICHMENT_STRICT=1`.
- Treat any LLM failure, malformed JSON, index-readiness failure, skipped scored
  case, or regex fallback as a failed publish gate.
- Keep resilience fallbacks available for normal product operation, but do not
  use fallback-backed runs as benchmark evidence.
- Separate retrieval-only metrics from answer-quality metrics. Do not compare a
  retrieval-only MemPalace result to an end-to-end Mem0/Zep-style result without
  labeling the comparison as non-equivalent.
- Save raw per-case outputs before writing summaries or positioning copy.

## Required lanes

| Lane | Dataset/version | Primary metric | Allowed modes | Required gate | Claim allowed |
| --- | --- | --- | --- | --- | --- |
| LongMemEval-S retrieval | `longmemeval_s_cleaned.json`, sha recorded | `recall_all`, `ndcg_any`, R@5/R@10, empty rate | raw, session evidence A/B, LLM-enriched, query decomposition on/off, rerank on/off | strict canary, full 500, zero fallback, all cases scored | Long-term conversational retrieval quality |
| LoCoMo retrieval | official LoCoMo split and MemPalace-compatible split | evidence hit, R@k/NDCG, latency | raw, LLM-enriched, session-unit matched to competitor | same top-k and retrieval unit across systems | Multi-session memory retrieval |
| ConvoMem retrieval | Salesforce ConvoMem version and sampling policy recorded | evidence hit, substring/evidence match, R@k | raw, LLM-enriched | sampled and full settings disclosed | Conversation evidence retrieval |
| MemBench retrieval | exact MemBench version and target-id policy recorded | target-id hit rate, R@k | raw, LLM-enriched | target-id mapping audited | Memory benchmark compatibility |
| End-to-end QA | LongMemEval/LoCoMo QA prompts with fixed answer model | exact match where valid, judge score, citation faithfulness | answer model fixed, retrieval context fixed | retrieval artifacts plus answer artifacts | Agent answer quality with memory |
| Operations | synthetic and real agent traces | p50/p95 write, p50/p95 recall, error rate, cost | raw, LLM-enriched | no degraded indexes, no hidden retries beyond policy | Production ergonomics and cost |
| Isolation | multi-profile, multi-workspace, global opt-in cases | cross-scope leakage rate, scoped recall rate | raw and LLM-enriched | zero cross-scope leakage | Safe scoped agent memory |

## MemPalace benchmark takeover map

MemPalace is the immediate comparison target because it publishes runnable scripts
and committed result files. A Memongo row may say "beats MemPalace" only after the
matching row below has a Memongo artifact and a MemPalace reproduction artifact.

| MemPalace row | Their current artifact / score | Memongo status | Publish gate |
| --- | --- | --- | --- |
| LongMemEval raw session, no LLM | latest `develop@1b94f4e`, reproduced locally: R@5 `0.9660`, R@10 `0.9820`, NDCG@10 `0.8888` | Memongo raw-session full-500 artifact `artifacts/benchmark-runs/memongo-raw-session-full500-20260520-atlas-b/benchmark-response.json`: R@5 `0.9729`, R@10 `0.9933`, NDCG@10 `0.9538`, `benchmark:status` PASS | Claim allowed with disclosure: same dataset/retrieval unit/no LLM/no rerank; embedding/backend differ. |
| LongMemEval held-out 450 hybrid v4, no LLM | reproduced locally on latest `develop@1b94f4e`: R@5 `0.9844`, R@10 `0.9978`, NDCG@10 `0.9379`; artifact `artifacts/competitors/mempalace/heldout-hybrid-v4-20260520-latest/results.jsonl` | Not run yet | Run Memongo on `mempalace/benchmarks/lme_split_50_450.json` without question-id tuning. |
| LongMemEval hybrid v4 + LLM rerank | committed full file: R@5 `0.9920`, R@10 `1.0000`; docs no longer headline "100%" because final fixes inspected known wrong answers | Not run yet | Run Memongo rerank lane with fixed reranker model, prompt hash, and no hidden fallback; report separately from no-LLM rows. |
| LoCoMo raw session top-10 | reproduced locally: avg recall `0.6029` over 1,986 QA pairs; artifact `artifacts/competitors/mempalace/locomo-full-20260520-latest/raw-session-top10.json` | No Memongo adapter yet | Implement LoCoMo adapter and match session/top-10/evidence-hit scorer. |
| LoCoMo hybrid session top-10 | committed file: avg recall `0.8891` over 1,986 QA pairs | No Memongo adapter yet | Implement generic hybrid lane; do not use top-k=50 as a publishable retrieval claim. |
| ConvoMem raw top-10 sample | reproduced locally: avg recall `0.9287` over 250 loaded items; artifact `artifacts/competitors/mempalace/convomem-full-20260520-latest/raw-all-limit50-top10.json` | No Memongo adapter yet | Implement ConvoMem adapter; disclose sampling/category policy. |
| MemBench hybrid movie top-5 | committed file: R@5 `0.8033` over 8,500 items; smoke reproduced 2/2; full reproduction attempt stopped after about 3h with no artifact because upstream script buffers progress and rebuilds Chroma per item | No Memongo adapter yet | Re-run MemBench full as a monitored detached job with unbuffered output, then implement MemBench adapter and audit target-id mapping before running. |

Current strongest claim:

> Memongo beats latest reproduced MemPalace raw LongMemEval session retrieval
> on the same dataset with no LLM and no rerank. This is not yet a claim that
> Memongo beats every MemPalace benchmark or is the best memory framework.

## MongoDB isolation contract

This is the path that keeps benchmark state from fighting itself:

1. Pick one benchmark row from this matrix.
2. Use the upstream GitHub benchmark script and dataset instructions for the
   competitor row. Save their raw output under `artifacts/competitors/...`.
3. For Memongo, run from the clean replay branch with a unique run id. The
   runner derives `MEMONGO_MONGODB_COLLECTION_PREFIX=memongo_bench_<run-id>_`
   unless a safe explicit `memongo_bench_*_` prefix is supplied.
4. Run the MongoDB preflight for that exact prefix: collections, classic indexes,
   Search indexes, Vector Search/autoEmbed indexes, and fusion capability.
5. Run the benchmark. Artifacts must contain the run id, dataset SHA, command,
   retrieval unit, embedding/rerank model, `mongodb.collectionPrefix`, warnings,
   degradations, and per-case output or miss ledger.
6. Verify with `bun run benchmark:status -- <artifact>` where applicable.
7. Drop only the exact `memongo_bench_<run-id>_` prefix after the artifact pack
   is complete and copied to the dated artifact path. Use
   `bun run mongodb:drop-benchmark-prefix -- --prefix=memongo_bench_<run-id>_`
   first as a dry-run, then add `--yes` only after the collection list matches
   the intended benchmark run.

If a run cannot prove which MongoDB prefix it used, it is not publishable.

## Publication ladder

The release story has to be one repository, one benchmark matrix, and one proof
pack. The order matters:

1. Land the raw-session infrastructure and artifact contract on the clean replay
   branch with passing `check-types`, build, lint, focused tests, and secret scan.
2. Re-run the raw LongMemEval win from a clean shell and preserve both Memongo and
   MemPalace artifacts under dated paths.
3. Run the MemPalace held-out 450 split with Memongo. This is the next decisive
   LongMemEval gate because MemPalace treats it as the honest hybrid number.
4. Add dataset adapters in this order: LoCoMo, ConvoMem, MemBench. Each adapter
   must produce raw per-case output plus a scorer summary before optimization.
5. Only after a raw adapter passes, add generic product improvements: lexical
   exactness, temporal anchors, session/preference evidence, provenance-preserving
   rerank, and lane caps. No question-id tuning.
6. Run optional LLM/rerank rows with Grove `Kimi-K2.6` only after a smoke test
   passes and the rerank prompt/model hash are recorded.
7. Run dogfood stress with full derived work enabled. This is a product-proof
   lane, not a substitute for benchmark parity.
8. Publish only rows that have artifacts, commands, dataset SHA, retrieval unit,
   embedding model, LLM/rerank disclosure, latency, storage, and warnings.

The phrase "best memory framework in the world" is only allowed after Memongo has:

- artifact-backed wins or clearly superior tradeoffs across the MemPalace matrix;
- MongoDB capability proof with no hidden fallback;
- dogfood stress proof for writes, updates, conflicts, graph, KB, procedures,
  change streams, deletion/retention, and strict failure paths;
- a clean public repo state with no secrets, no stale benchmark claims, and no
  orphan benchmark artifacts.

## Mode matrix

| Mode | What changes | Why it exists | Publish rule |
| --- | --- | --- | --- |
| Raw retrieval | no LLM enrichment, no synthetic QA evidence | baseline MongoDB-native retrieval | publishable only as raw mode |
| Session evidence A | session summaries in chunks collection | compare current best session evidence path | publishable if zero fallback and all cases scored |
| Session evidence B | session chunks collection | compare alternate session-unit design | publishable only when retrieval unit is disclosed |
| LLM facts-only | user facts from strict LLM extraction | test if extraction improves personal-fact recall | publishable only with strict JSON and zero failed sessions |
| LLM enriched | facts plus synthetic QA evidence | test EnrichIndex-style recall | publishable only with strict JSON and zero failed sessions |
| Query decomposition | multiple rewritten retrieval queries | test complex/multi-hop recall | publishable only when query count and model are recorded |
| Rerank | cross-encoder rerank after retrieval | test ordering quality | publishable only when rerank provider/model is recorded |

## Model lanes

| Lane | Provider | Model | Current status | Use when |
| --- | --- | --- | --- | --- |
| Sonnet strict | Grove Anthropic Messages | `claude-sonnet-4-6` | passed tiny strict JSON smoke | default LLM enrichment lane until it fails a strict canary |
| GPT strict | Grove OpenAI-compatible | `gpt-5.5` | passed tiny strict JSON smoke | fallback lane if Sonnet fails strict JSON, latency, or quality |
| Kimi rerank | Grove OpenAI-compatible | `Kimi-K2.6` | 2026-05-20 HTTP 200 smoke passed with `api-key` header and non-empty content at normal token budget | optional rerank/answer lane; record prompt hash and never mix with no-LLM rows |
| No LLM | none | none | baseline lane | raw retrieval and cost/latency floor |

## Canary ladder

Do not jump directly to full benchmark runs.

| Step | Command shape | Pass criteria | Next action |
| --- | --- | --- | --- |
| Dry canary | `MEMONGO_CANARY_DRY_RUN=1 MEMONGO_CANARY_CASES_PER_TYPE=1` | one case per question type selected, artifact written | run strict live canary |
| Strict single-case smoke | `MEMONGO_BENCHMARK_STRICT=1 MEMONGO_LLM_ENRICHMENT_STRICT=1 MEMONGO_CANARY_TOTAL_CASES=1 MEMONGO_ENRICHMENT_CONCURRENCY=3 MEMONGO_LLM_ENRICHMENT_MAX_TOKENS=2048` | one case scored, zero fallback logs, zero failed enrichment sessions, zero JSON parse failures, all benchmark-required search indexes queryable | run strict tiny live |
| Strict targeted replay | `MEMONGO_BENCHMARK_STRICT=1 MEMONGO_CANARY_QUESTION_IDS=<question_id>` | the named failure reproduces or passes with artifact evidence | fix or promote to single-case smoke |
| Strict tiny live | `MEMONGO_BENCHMARK_STRICT=1 MEMONGO_LLM_ENRICHMENT_STRICT=1 MEMONGO_CANARY_CASES_PER_TYPE=1 MEMONGO_ENRICHMENT_CONCURRENCY=3 MEMONGO_LLM_ENRICHMENT_MAX_TOKENS=2048` | one case per question type scored, zero fallback logs, zero failed enrichment sessions, zero JSON parse failures, all benchmark-required search indexes queryable | run 8-per-type canary |
| Strict 8-per-type | `MEMONGO_BENCHMARK_STRICT=1 MEMONGO_LLM_ENRICHMENT_STRICT=1 MEMONGO_CANARY_CASES_PER_TYPE=8` | all 48 cases scored, zero fallback, stable latency | run full LongMemEval-S |
| Full LongMemEval-S | official dataset path, strict mode, recorded build identity | all 500 cases scored, official metrics present, warnings reviewed | compare competitors |

## Competitor parity checklist

For every competitor run, record:

- repository/version/commit and install command
- dataset file and preprocessing script
- embedding model and dimensions
- top-k and retrieval unit: turn, message, session, memory item, or QA pair
- whether the competitor uses LLM extraction, graph construction, summaries, or
  synthetic QA pairs
- whether evaluation is retrieval-only or answer-generation
- raw JSONL outputs and exact scoring script
- latency, token usage, and storage footprint where available

## Claim boundaries

Allowed after strict gates:

- "Memongo outperformed X on LongMemEval-S retrieval under this configuration."
- "Memongo raw retrieval scored X with MongoDB automated embeddings."
- "Memongo LLM-enriched retrieval scored X with Sonnet 4.6 and zero fallback."

Not allowed:

- "Best memory framework" from a single dataset.
- "Beats Mem0/Zep/MemPalace" unless the retrieval unit, model budget, dataset
  version, and evaluation type are matched or explicitly caveated.
- "Production-ready benchmark" when any strict lane used fallback, skipped cases,
  degraded indexes, or missing build identity.
