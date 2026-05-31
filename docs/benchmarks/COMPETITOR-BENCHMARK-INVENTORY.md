# Competitor Benchmark Inventory

Last refresh: 2026-05-31.

This inventory tracks repo-backed benchmark claims only. A row can become a
Memongo victory claim only when Memongo runs the same dataset, scorer, retrieval
unit, top-k, and LLM/rerank posture, with artifacts and cleanup proof.

Execution rules for the fresh Atlas control lane live in
[Ecosystem Benchmark Runbook](./ECOSYSTEM-BENCHMARK-RUNBOOK.md).

## Refresh Snapshot

| Competitor repo | Latest local commit | Refresh result | Notes |
| --- | --- | --- | --- |
| MemPalace | `9b7cfc9940` | Fast-forwarded | P0 comparison source; benchmark result artifacts did not change in this refresh. |
| Mem0 | `a3154d59e5` | Fast-forwarded | README points to `mem0ai/memory-benchmarks` for reproducible numbers. |
| Memory Benchmarks | `4b61c5d31b` | Already current | Official Mem0 benchmark harness and committed results. |
| Supermemory | `4eb8399358` | Fast-forwarded | README claims #1 rows; MemoryBench is the reproducible harness. |
| MemoryBench | `118209a746` | Already current | Official provider-neutral benchmark framework. |
| Zep | `faf2acec4f` | Already current | LoCoMo CLI harness and LongMemEval notebooks. |
| Mastra | `bf8dd8b75a` | Fast-forwarded | LongMemEval answer-quality benchmark package. |
| Hindsight | `3e99a3f490` | Fast-forwarded | LoCoMo and LongMemEval benchmark scripts. |
| OpenViking | `9e99c8f7db` | Fast-forwarded | LoCoMo/openclaw-eval and RAG benchmark surfaces. |
| OpenClaw Eval | `75e07d696e` | Already current | External LoCoMo evaluation script referenced by OpenViking. |
| Letta | `1131535716` | Already current | No reproducible benchmark claim found yet. |
| LoCoMo | `3eb6f2c585` | Already current | Dataset/evaluator source. |
| MemBench dataset | `f66d8d1028` | Already current | Dataset source used by MemPalace and Memongo MemBench rows. |

Snapshot artifacts:

- Manifest: `artifacts/competitor-snapshots/20260531-a/manifest.json`
- Refresh report: `artifacts/competitor-snapshots/20260531-a/refresh-report.json`
- Bundles: `artifacts/competitor-snapshots/20260531-a/bundles/*.bundle`

## Active Adapter Smoke

Mem0's official `memory-benchmarks` harness is the first P1 ecosystem target.
Memongo now has a local Mem0 OSS-compatible adapter for the harness:
`bun run benchmark:mem0-compat`.

Smoke evidence from 2026-05-31:

- Harness: `memory-benchmarks` LongMemEval runner, predict-only.
- Dataset: `longmemeval_s_cleaned.json`.
- Filter: `single-session-user`, `per-type=1`, `top-k=10`.
- Result directory: `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-20260531/predicted_memongo-compat-smoke-20260531`.
- Output artifact SHA256: `505a0479aa4b9e76eceaaead5fb3a356fdf662843daa57930394627352c095f2`.
- Ingestion artifact SHA256: `0005f2d7fa7a33230a8c5d24b9925d7c39e0b125199e82ae8296f698ccd24890`.
- Atlas cleanup: exact prefix `memongo_bench_mem0_memorybenchmarks_smoke_20260531_b_` dry-run listed 30 collections; exact drop removed 30; prefix inventory returned 0 groups.

This is an adapter compatibility smoke, not a publishable benchmark score.
The first attempted smoke exposed workspace contamination from default local
workspace sync; the adapter now creates an isolated empty workspace unless
`MEMONGO_WORKSPACE_DIR` is explicitly set.

Follow-up smoke evidence from 2026-05-31:

- Root cause fixed: explicit `MEMONGO_BENCHMARK_DERIVED_WORK_MODE=disabled` now disables derived background work for non-standard official harness agent IDs such as `longmemeval_<run>`, not only Memongo's older `benchmark-*` and `canary-*` IDs.
- Harness: same official LongMemEval runner and one-question `single-session-user` smoke.
- Prefix `memongo_bench_mem0_memorybenchmarks_smoke_20260531_c_`: derived-work pollution removed; top results were raw event memories only. Search/vector still fell back after final writes.
- Prefix `memongo_bench_mem0_memorybenchmarks_smoke_20260531_d_`: added a 10s per-user post-write search settle guard. Result artifact SHA256 `b476bb7e863ebd2fbb09b8ddc0149a22e8e9e44f0421f03488a7ae44be2d8175`; ingestion artifact SHA256 `5d0e8be66940c1b689cfc0d296442be0fc6ebae95c66c4a2de795688240d9ae3`.
- Atlas cleanup: exact prefix `memongo_bench_mem0_memorybenchmarks_smoke_20260531_d_` dry-run listed 30 collections; exact drop removed 30; prefix inventory returned 0 groups.
- Prefix `memongo_bench_mem0_memorybenchmarks_smoke_20260531_f_`: strict Search V2 correctly failed instead of falling back. Root cause: the adapter mapped Mem0 `user_id` both to Memongo `agentId` and to `sessionKey`; writes were stored under agent scope while search narrowed to session scope. Result artifact SHA256 `1e7d2ff96a33e27dc7b81bfe108f3b60f34fd5d6ae5c27a4934a54a71086a374`; ingestion artifact SHA256 `81865300fe6fb44113f8053a9d3e5ba7d92e5bd6a84017743f536debb2d18960`.
- Prefix `memongo_bench_mem0_memorybenchmarks_smoke_20260531_g_`: fixed the adapter to search at the Mem0 user namespace level. Strict Search V2 returned 10 results; top-1 was the exact Netflix/documentaries/10-hours memory. Result artifact SHA256 `d44915722de59d5098343c861979a19939eb30f8497d273e1399dcacd3a31e72`; ingestion artifact SHA256 `a882eeee8eaee4b0d27cbfa6307cc1c91407c6a3c27df5d1662ed8fe7035f6ef`.
- Atlas cleanup: exact prefix `memongo_bench_mem0_memorybenchmarks_smoke_20260531_g_` dry-run listed 30 collections; exact drop removed 30; prefix inventory returned 0 groups.

Multi-type smoke evidence from 2026-05-31:

- Harness: official `memory-benchmarks` LongMemEval runner, predict-only.
- Filter: `per-type=1`, `top-k=50`, six questions across all LongMemEval-S types.
- Result directory: `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-20260531h/predicted_memongo-compat-smoke-20260531h`.
- Prefix: `memongo_bench_mem0_memorybenchmarks_smoke_20260531_h_`.
- Ingestion: 1,475 memory pairs processed, 0 failed.
- Retrieval: all 6 prediction artifacts returned 50/50 results; no empty retrieval files.
- Per-question result SHA256:
  - `0a995998.json`: `43c2a1446f9df6faf0379702deec2db92cefcf16c54dbc4bdcfe2ddf2dcde4d6`
  - `18bc8abd.json`: `ff106de1df343a1e93cb3e55466b1084b85de96654404d6c87c63ff99bff05ee`
  - `1c0ddc50.json`: `8ae3f9d29d43037a53fecdb0142e4d208036ab8fc2b3bd801f3625f91cc68c3c`
  - `6b168ec8.json`: `20c6303d8ca280afa354a942bcfffef94ee223f222b04884675cde91ce59fd9a`
  - `e3fc4d6e.json`: `130c19516bbde8fff737147cd7efdaa0a6ec30ad19d83bc58d2edc37ff8b5fde`
  - `gpt4_2655b836.json`: `f6872697123502622fd8ab33ec6e6b2016a99f79481cce181f26852a05f19bff`
- Per-question ingestion SHA256:
  - `_ingestion_0a995998.json`: `55fb0af87fff6ac49d9b301c49fd5afff700cbe2eb57674649f7f8f3b681375a`
  - `_ingestion_18bc8abd.json`: `faa19c2813192ff8b6aa84c2b4bc5a4920ba67524cd99d9dfef7b8f56c8f7d31`
  - `_ingestion_1c0ddc50.json`: `582448c1ce5dd8f6289cc6b9f1fa82fcf4d0321751081175e45e08114b18bfb0`
  - `_ingestion_6b168ec8.json`: `f0db4ad3a34048e6125d5aafe4de8e3d2485155e9d34357571108d7df37771de`
  - `_ingestion_e3fc4d6e.json`: `d1480712f6cfa34aa40ecb7c6610a5b50f5c3e6d262ee27653a83d3f1efb0d13`
  - `_ingestion_gpt4_2655b836.json`: `3a9af694dfe877356a8ed9a79c8e24d9f8c7e5135723a56750d189de020ba041`
- Runtime note: the official harness took about 36.5 minutes for six questions because each question ingests a large LongMemEval haystack through the Mem0 API shape.
- Atlas cleanup: exact prefix dry-run listed 30 collections; exact drop removed 30; prefix inventory returned 0 groups.

Current blocker before full Mem0 runs: the adapter is now strict-clean on a
six-type official LongMemEval smoke, but full judged Mem0 rows still require a
larger rehearsal and a fixed answerer/judge setup. Do not publish a Mem0 win
from the smoke.

## Repo-Backed Benchmark Rows

| Priority | Competitor | Benchmark | Claimed / committed score | Metric type | Dataset / cases | Retrieval unit | Top-k | LLM / rerank posture | Repo evidence | Memongo status |
| --- | --- | --- | ---: | --- | --- | --- | ---: | --- | --- | --- |
| P0 | MemPalace | LongMemEval raw session full 500 | 96.60% | Retrieval RecallAny@5 | LongMemEval-S, 500 | Session | 5 | No LLM, no rerank | `mempalace/benchmarks/results_mempal_raw_session_20260414_1629.jsonl`, SHA `2b71b5e514279c28443736561e2ac453045520b0f8832ff092e8a6143965e5d1` | PROVED: Memongo 99.15% session RecallAny@5 |
| P0 | MemPalace | LongMemEval held-out 450 hybrid v4 | 98.44% | Retrieval RecallAny@5 | MemPalace held-out split, 450 | Session | 5 | No LLM, no rerank | `mempalace/benchmarks/results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl`, SHA `5f5849e8facdbdec673967dfbd9dd288323983ae824ca787ffa89110dd1b588d` | PROVED: Memongo 99.11% session RecallAny@5 |
| P0 | MemPalace | LongMemEval hybrid v4 Haiku rerank full 500 | 99.20% committed artifact; docs still discuss 100% internal story | Retrieval RecallAny@5 | LongMemEval-S, 500 | Session | 5 | Haiku rerank | `mempalace/benchmarks/results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl`, SHA `8bc55a31d7cc260564f2607feae49f396d58dea6ba9de5141ce4abbec67ba624` | PARTIAL: Memongo hybrid no-LLM ties 99.20%; separate LLM/rerank lane still needed |
| P0 | MemPalace | LoCoMo raw session top-10 | 60.29% | Retrieval avg recall | LoCoMo, 1,986 rows | Session | 10 | No LLM, no rerank | `mempalace/benchmarks/results_locomo_raw_session_top10_20260414_1634.json`, SHA `b8bc53a7a0595786fdff470dedd28dc6819d414619acd432748f443c6c907041` | PROVED: Memongo 91.71% |
| P0 | MemPalace | LoCoMo hybrid session top-10 | 88.91% | Retrieval avg recall | LoCoMo, 1,986 rows | Session | 10 | No LLM, no rerank | `mempalace/benchmarks/results_locomo_hybrid_session_top10_20260414_1649.json`, SHA `f7f11bad92cf7406a6e93aa776524bf97d0bc84032786e62585835a4582a1dcf` | PROVED: Memongo 93.30% |
| P0 | MemPalace | ConvoMem raw message top-10 | 92.87% | Retrieval avg recall | ConvoMem, 250 effective items | Message | 10 | No LLM, no rerank | `mempalace/benchmarks/results_convomem_raw_top10_20260414_1649.json`, SHA `e3d778c3007113d8a78854004aac6c724b82c86b5349f3cf764ca42abf3a0100` | PROVED: Memongo 100.00% |
| P0 | MemPalace | MemBench movie hybrid top-5 | 80.33% | Retrieval hit@5 | MemBench FirstAgent movie, 8,500 | Turn | 5 | Hybrid, no Memongo LLM | `mempalace/benchmarks/results_membench_hybrid_all_movie_top5_20260414_1656.json`, SHA `6a500795e68e40b4723da86c623d930e0bd184949a8f04c89f185d9181f4b622` | PROVED: Memongo 88.75% |
| P1 | Mem0 | LongMemEval platform top-50 | 94.8% in README; committed platform result top-50 reports 90.4% answer accuracy, SHA `8bbf06e4205dce1df9c2dff9a9ddf99074865ca40019e1c5a10f0d3a37b4275c` | Judged answer accuracy | LongMemEval-S, 500 | Answer context | Top-50 search | GPT-5 answerer/judge in committed result metadata | `memory-benchmarks/results/platform/longmemeval_top50_results.json` | STRICT 6-TYPE SMOKE PASSED; next gate is larger rehearsal plus judged top-50 run |
| P1 | Mem0 | LongMemEval platform top-200 | 94.4% in README; committed platform result top-200 reports 93.4% pass rate, SHA `58bd6d8934a54d8cd568ef481bbd3e37270c2c74a5d59713b661d4c3ddb332a1` | Judged answer accuracy | LongMemEval-S, 500 | Answer context | Top-200 search | GPT-5 answerer/judge | `memory-benchmarks/results/platform/longmemeval_results.json` | TODO |
| P1 | Mem0 | LoCoMo platform top-50 | 91.8% in README; committed platform result reports 82.66% answer accuracy, SHA `b4bc12d41b9864aaac747a9b58d8609ba3a0d7780ea39857d5b87a83ef3dc45a` | Judged answer accuracy | LoCoMo, 1,540 rows | Answer context | Top-50 search | GPT-5 answerer/judge | `memory-benchmarks/results/platform/locomo_top50_results.json` | TODO: run same 1,540-row judged lane |
| P1 | Mem0 | LoCoMo platform top-200 | 92.5% in README; committed platform result reports 91.56% answer accuracy, SHA `36338fa6c1ca38bcf9e3fc33a5cbc3b6e53bdc4bafaeeaee0947cf13b5527911` | Judged answer accuracy | LoCoMo, 1,540 rows | Answer context | Top-200 search | GPT-5 answerer/judge | `memory-benchmarks/results/platform/locomo_results.json` | TODO |
| P1 | Mem0 | BEAM 1M top-200 | 70.1% pass rate, 0.641 avg score, SHA `60a4878fdbd0082164dbf48a440f62384ec5e16001eaea4152732b8dfc9f75da` | Judged answer quality | BEAM 1M, 700 questions | Answer context | Top-200 search | GPT-5 answerer/judge | `memory-benchmarks/results/platform/beam_1m_results.json` | TODO: build BEAM adapter |
| P1 | Mem0 | BEAM 10M top-200 | 50.5% pass rate, 0.486 avg score, SHA `e0a3578d501d29a0dec9e13218945611e61e2d859a8a4aca2d4beaf4a71d78f3` | Judged answer quality | BEAM 10M, 200 questions | Answer context | Top-200 search | GPT-5 answerer/judge | `memory-benchmarks/results/platform/beam_10m_results.json` | TODO |
| P1 | Supermemory / MemoryBench | LoCoMo / LongMemEval / ConvoMem provider comparison | Framework claim, no committed provider result row found yet | Judged answer accuracy plus MemScore | MemoryBench supports `locomo`, `longmemeval`, `convomem` | Answer context | Provider-defined | Configurable judge/model | `memorybench` CLI and docs | TODO: add Memongo provider and run `compare` lanes |
| P1 | Zep | LoCoMo harness | No committed score found in repo docs | Judged answer accuracy, latency, context analysis | LoCoMo10, configurable users | Graph context | Graph limits | OpenAI response and grader models | `zep/benchmarks/locomo` | TODO: run Zep harness and Memongo adapter under same config |
| P1 | Zep | LongMemEval notebooks | No committed score found in repo docs | Judged answer accuracy | LongMemEval | Context | Notebook-defined | OpenAI and Zep keys required | `zep/benchmarks/longmemeval` | TODO: convert notebook lane into reproducible command or mark blocked |
| P2 | Mastra | LongMemEval | README references full and quick commands; no committed result found | Judged answer accuracy | LongMemEval-S/M/oracle | Answer context | Config-defined | Model e.g. GPT-4o in README examples | `mastra/explorations/longmemeval` | TODO: run official package; compare judged QA only |
| P2 | Hindsight | LoCoMo / LongMemEval | README claims state of the art but no score table in benchmark README | Judged answer accuracy and latency | LoCoMo and LongMemEval | API recall/think context | Config-defined | Hindsight API, likely LLM-backed | `hindsight/hindsight-dev/benchmarks` | TODO: run scripts; capture score artifacts |
| P2 | OpenViking | LoCoMo10 / OpenClaw Eval | README says 1,540-case LoCoMo test; no committed score artifact found | Judged answer accuracy | LoCoMo10, 1,540 cases | Answer context | Config-defined | Judge script required | `OpenViking/benchmark/locomo`, `openclaw-eval` | TODO |
| P2 | Letta | Unknown | No repo-backed benchmark claim found | Unknown | Unknown | Unknown | Unknown | Unknown | No reproducible row found | WATCHLIST only |

## Must-Beat Queue

1. MemPalace LLM/rerank retrieval lane: reproduce committed Haiku/Sonnet rerank result, then run a Memongo rerank lane with identical split/scorer/top-k disclosure.
2. Mem0 Memory Benchmarks: promote the strict-clean Mem0 compatibility adapter from six-type smoke to a larger rehearsal, then full LongMemEval top-50/top-200, LoCoMo top-50/top-200, BEAM 1M, and BEAM 10M with the same answerer/judge settings.
3. Supermemory MemoryBench: implement a Memongo provider for `memorybench`; run `locomo`, `longmemeval`, and `convomem` with the same judge/model and report MemScore.
4. Zep LoCoMo and LongMemEval: run Zep's own harness first, then run Memongo through a matching adapter and compare only judged answer accuracy rows.
5. Mastra, Hindsight, and OpenViking: run their official benchmark commands first; only build Memongo lanes after the competitor artifact is reproducible.

## Non-Reproducible Watchlist

These are not victory targets until a repo-backed artifact or runnable command
is available:

- Supermemory README `#1` claims without committed result artifacts in the repo snapshot.
- Hindsight README image/table claims without a machine-readable result artifact.
- MemPalace prose about 100% rerank if it is not backed by the committed JSONL row being compared.
- Any website, blog, screenshot, or marketing table not tied to a public repo commit and scorer.
