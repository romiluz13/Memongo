# Memongo benchmark matrix

This matrix is the execution map for honest, apples-to-apples memory benchmarks.
It is not a leaderboard. A row becomes a public claim only after the row's gate
passes with raw artifacts and zero strict-mode fallback.

## Global benchmark rules

- Keep benchmark artifacts reproducible: dataset version, command, git SHA,
  MongoDB topology, embedding model, LLM model, and all Memongo feature flags.
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
