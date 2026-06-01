# Competitor Benchmark Inventory

Last refresh: 2026-05-31.

This inventory tracks repo-backed benchmark claims only. A row can become a
Memongo victory claim only when Memongo runs the same dataset, scorer, retrieval
unit, top-k, and LLM/rerank posture, with artifacts and cleanup proof.

Execution rules for the fresh Atlas control lane live in
[Ecosystem Benchmark Runbook](./ECOSYSTEM-BENCHMARK-RUNBOOK.md).
The full branch/evidence/roadmap summary lives in
[Memongo Benchmark Full Picture Roadmap](./FULL-PICTURE-ROADMAP.md).

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
- Per-question result SHA256 after retrieval-judge rejudge:
  - `0a995998.json`: `3a2630975255c5f3c5b013926a0af471e9526fc1862a27a12bce315b6b349e05`
  - `18bc8abd.json`: `734c532b5de3f7a7563cd67f26af0dc40b8c315b84b88bf5838c8672a7742308`
  - `1c0ddc50.json`: `6c8906182f6d64a3a636e8ea9892061121c1e5ac49c5442a4409464246049eca`
  - `6b168ec8.json`: `55f1e90c0af8ae4abc0f0c52f8e41403d241990cd3211543e38aff38542bcaec`
  - `e3fc4d6e.json`: `63e46f1131e4893a6a7a13d1ce1efb538f86ff99e0d20b3fd40b1b16b5ced035`
  - `gpt4_2655b836.json`: `6866d7ef485257d4bfa11e9b6429a980033e492f5d27037ec36cdaea32f85882`
- Per-question ingestion SHA256:
  - `_ingestion_0a995998.json`: `55fb0af87fff6ac49d9b301c49fd5afff700cbe2eb57674649f7f8f3b681375a`
  - `_ingestion_18bc8abd.json`: `faa19c2813192ff8b6aa84c2b4bc5a4920ba67524cd99d9dfef7b8f56c8f7d31`
  - `_ingestion_1c0ddc50.json`: `582448c1ce5dd8f6289cc6b9f1fa82fcf4d0321751081175e45e08114b18bfb0`
  - `_ingestion_6b168ec8.json`: `f0db4ad3a34048e6125d5aafe4de8e3d2485155e9d34357571108d7df37771de`
  - `_ingestion_e3fc4d6e.json`: `d1480712f6cfa34aa40ecb7c6610a5b50f5c3e6d262ee27653a83d3f1efb0d13`
  - `_ingestion_gpt4_2655b836.json`: `3a9af694dfe877356a8ed9a79c8e24d9f8c7e5135723a56750d189de020ba041`
- Runtime note: the official harness took about 36.5 minutes for six questions because each question ingests a large LongMemEval haystack through the Mem0 API shape.
- Atlas cleanup: exact prefix dry-run listed 30 collections; exact drop removed 30; prefix inventory returned 0 groups.

Judged smoke evidence from 2026-05-31:

- Grove transport note: the official harness's vanilla OpenAI SDK path failed
  against Grove with missing subscription-key errors. A one-off wrapper added
  Grove's required `api-key` header only; official prompts, scorer code, and
  saved retrieval artifacts were otherwise unchanged.
- Answerer mode with `Kimi-K2.6`: `top_10` scored 5/6 (83.3%); `top_50`
  scored 4/6 (66.7%). Unified artifact SHA256:
  `6800ad53be7f10d9bc45d057a68dc1ee61c7f38d2e6fdd8a1e0df7251aa6fca5`.
- Answerer-mode root cause: retrieval was not empty; the multi-session miss
  returned relevant top-10 memories but the answerer produced a blank answer,
  and the preference top-50 miss included relevant evidence but produced
  reasoning/noise instead of a clean final answer.
- Retrieval-judge mode with `Kimi-K2.6`: `top_10` scored 6/6 (100.0%);
  `top_50` scored 6/6 (100.0%). Unified artifact SHA256:
  `4251d9ccf5f881bd549ede75c3901e688aa33502df5b0c4b17948fa98564abe5`.
- Interpretation: the six-type smoke now supports Memongo retrieval/context
  quality for the Mem0 harness shape, but not yet a publishable Mem0 judged-QA
  win. The next fix must improve answer-context generation/transport, not
  question-specific retrieval.

Current blocker before full Mem0 runs: the adapter is now strict-clean on a
six-type official LongMemEval smoke, but full judged Mem0 rows still require a
larger rehearsal and a fixed answerer/judge setup. Do not publish a Mem0 win
from the smoke.

Query-passage smoke evidence from 2026-05-31:

- MongoDB docs basis: Atlas Search highlighting is built around returning
  passages that contain query terms, and the docs note that examined-character
  and passage limits can hide relevant terms. The Mem0 adapter now applies the
  same product principle when packaging retrieved memories for judged answer
  harnesses: preserve a query-relevant passage instead of blindly head-clipping
  long memories.
- Code path: `scripts/run-mem0-compat-server.ts` now compacts each returned
  `memory` string around query terms and keeps date/source provenance. This is
  generic query/evidence behavior, not question-id tuning.
- Exact failing case rehearsal: `single-session-assistant`, seed `26`, QID
  `e3fc4d6e`, prefix
  `memongo_bench_mem0_memorybenchmarks_smoke_20260531_l_`.
- Result: the retrieved memory preserved the previously clipped answer passage
  containing `Dr. Arati Prabhakar`; retrieval judge scored `1/1` at both
  `top_10` and `top_50`.
- Result artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-20260531l/longmemeval_results_20260531_175917.json`,
  SHA256 `7c1d53bb1edc56d25d33b17392915f0263f65b54cd03f448d9af42b9184f9b8d`.
- Atlas cleanup: exact prefix dry-run listed 30 collections; exact drop removed
  30; prefix inventory returned 0 groups.

Six-type query-passage rehearsal from 2026-05-31:

- Harness: official `memory-benchmarks` LongMemEval runner, predict-only first,
  then retrieval-judge evaluation over the saved predictions.
- Filter: `per-type=1`, `top-k=50`, six LongMemEval-S question types.
- Prefix: `memongo_bench_mem0_memorybenchmarks_smoke_20260531_m_`.
- Ingestion: 1,475 memory pairs processed, 0 failed.
- Retrieval packaging: all 6 prediction artifacts returned 50/50 results; no
  empty retrieval files.
- Result directory:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-20260531m`.
- Retrieval judge run 1: `top_10` scored `6/6`; `top_50` scored `5/6`.
  The one `top_50` failure was QID `0a995998` with blank generated answer,
  blank reason, and blank core intent after structured-output timeout and
  connection retries. Unified artifact SHA256:
  `4d9b3c3ca09fc3bb1a7b182eb0aecb4f58c7a4441f2f0918a36096810115703b`.
- Retrieval judge run 2 over the same saved predictions: `top_10` scored
  `5/6`; `top_50` scored `6/6`. The same QID `0a995998` flipped behavior:
  top-50 passed with all three required errands, while top-10 failed after the
  judge counted only two of the three errands. Unified artifact SHA256:
  `e4b9c9f5ce274063b17999fe6ba0d46499db37b54857ddf418443350421b0c51`.
- Atlas cleanup: exact prefix dry-run listed 30 collections; exact drop removed
  30; prefix inventory returned 0 groups.
- Interpretation: the packaging fix is valid and retrieval is promising, but
  the Mem0 judged lane is still not publishable. The same retrieved artifacts
  produced inconsistent judged outcomes, so the next gate is repeatable
  judge/answerer configuration and larger rehearsal, not a benchmark claim.

Official-model retrieval judge repeatability from 2026-05-31:

- Grove availability check: `gpt-5` is callable through the Grove
  OpenAI-compatible path when the completion budget is large enough. This
  matches the model name recorded in Mem0's committed LongMemEval platform
  artifacts more closely than the earlier Kimi diagnostic lane.
- Method: copied the same six saved prediction artifacts into fresh result
  folders and ran official `memory-benchmarks` retrieval-judge mode with
  `--judge-model gpt-5`, `--provider openai`, `--top-k-cutoffs 10,50`, and
  `--rejudge`. No MongoDB writes or searches were performed during these
  repeatability checks.
- Run `20260531n`: `top_10` scored `6/6`; `top_50` scored `6/6`. Unified
  artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-20260531n/longmemeval_results_20260531_190435.json`,
  SHA256 `39f3ee4c551217653fdf77ad5a0a693c677a9cfccf795202bf9ba87b03bb9344`.
- Run `20260531o`: `top_10` scored `6/6`; `top_50` scored `6/6`. Unified
  artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-20260531o/longmemeval_results_20260531_190657.json`,
  SHA256 `5e5175e4351ef87beffd1529ede55ba564b823357442ec983aca016441a1cfa9`.
- Interpretation: retrieval-judge stability is now established on the six-type
  smoke under the official model posture. This still is not a Mem0 publishable
  row; the next gate is a larger `gpt-5` retrieval-judge rehearsal, followed by
  answerer-mode rehearsal because Mem0's public rows are judged answer accuracy,
  not pure retrieval-judge recall.

Mem0 answer-context root-cause work from 2026-05-31:

- Stable failing answerer-mode case: QID `0a995998`, question
  `How many items of clothing do I need to pick up or return from a store?`.
  The saved retrieval included the three needed obligations, but `gpt-5`
  answerer repeatedly collapsed the Zara return and Zara pickup into one
  `exchanged boots` item and answered `2`.
- Larger memory text windows alone did not fix the failure. Exact run
  `20260531u` preserved longer passages and still failed with answer `Two
  items`, artifact SHA256
  `5fc798a204edbf3712e5f660fb5cc6a50742edefc4675abad7ce8b1fa227f015`.
- Noisy individual atomic-action evidence passed once, but was rejected as too
  loose because it included generic advice/question text. Exact run
  `20260531v` passed, artifact SHA256
  `26e53d9e5d9d89b3b7337428ea8662916c05e409ea2340a89816fe17ef370d47`.
- Cleaner individual atomic-action evidence failed again because the answerer
  still merged the exchange into one item. Exact run `20260531w` failed,
  artifact SHA256
  `8ff5a4d7a5df50efec9e43700ea49ac025a6b24e129c1f8ad74acb421192c558`.
- Offline saved-retrieval evaluation with a derived action checklist passed:
  `20260531z`, artifact SHA256
  `51f257b75090f4171f9ee0a7be0fa5ff8062c247eb23f4507e7963d278f632d1`.
  This validates the next implementation gate, but it is not a publishable
  Mem0 row because it did not rerun ingestion/search under the final adapter
  code.
- Final adapter investigation intentionally kept failing attempts in the
  ledger. Exact run `20260531aa` failed because the derived checklist still
  let the answerer merge `new pair` and `boots to Zara`, artifact SHA256
  `8e1712e60ecd4868e853c9c87ca5f72c9970da5f413c4c1acb40b67a56824d24`.
  Exact run `20260531ab` fixed action separation but still failed because the
  answerer excluded `dry cleaning` from the clothing count, artifact SHA256
  `0eff5fe21e1fe060fbbf49bce0693999ccdae6d4985d327624998addb610043b`.
- Implemented final exact smoke `20260531ac` passed under real ingestion,
  MongoDB search, and `gpt-5` answerer/judge. It returned `3 items: return the
  too-small boots to Zara, pick up the exchanged boots at Zara, and pick up
  your navy blue blazer from the dry cleaner`, artifact SHA256
  `ed09a9ad239f6f25c91889b51e671ff91e177a6fdbec29a72c426b81da889d1d`.
  The Atlas prefix was dropped after artifact capture. This is still only an
  exact smoke, not a publishable Mem0 row; the next gate is a six-type
  answerer-mode rehearsal under the final adapter code.
- Six-type answerer-mode rehearsal `20260531a` passed under final adapter code:
  `top_50` scored `6/6` across one case from each LongMemEval type, including
  QID `0a995998`. Artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-six-answerer-20260531a/longmemeval_results_20260531_234716.json`,
  SHA256 `5315481be480c02037c5c4d39911d3c2306f253e9dde55c41cf111b6087589fb`.
  The exact Atlas prefix
  `memongo_bench_mem0_memorybenchmarks_six_answerer_20260531_a_` dry-run showed
  30 collections, then dropped 30 collections; prefix inventory returned zero
  benchmark groups. This proves the fix generalizes across the six-type smoke,
  but it remains a rehearsal gate, not a publishable Mem0 row.
- Larger 12-case answerer-mode rehearsal `20260601b` improved to `11/12`
  (`91.7%`) at `top_50`, including passes for the earlier Andy-wearing and
  jewelry-count failures. Artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-12-answerer-20260601b/longmemeval_results_20260601_023313.json`,
  SHA256 `91039a0ac236ce7ac68abb651e8c1955a30945be18012c4c6807fae587b2a7bc`.
  Rejudging the same saved retrieval artifact produced the same `11/12` result,
  SHA256 `d63b7f70e3a6872bf156aaf3564b72ed344844d3fb227d24557916599eee4db`.
  The remaining fail was QID `88432d0a`, where MongoDB retrieval returned
  relevant baking-count evidence but the answerer generated a blank response.
- Follow-up adapter hardening made count evidence shorter, deduped by canonical
  item/event key, and capped to eight source-backed candidates. This is generic
  answer-context packaging over retrieved evidence, not question-id tuning.
  A two-question multi-session smoke `20260601c` scored `2/2` at `top_50`.
  Artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-2multi-answerer-20260601c/longmemeval_results_20260601_030201.json`,
  SHA256 `9ca3b79af1cffcb91e5f528df0ee96e5d88d1c5c0f90ad1ecfc2c965b6ce7eeb`.
  The sampled questions were `0a995998` and `3c1045c8`, so this smoke did not
  rerun the exact old baking-count fail `88432d0a`. The exact Atlas prefix
  `memongo_bench_mem0_memorybenchmarks_2_multi_answerer_20260601_c_` dry-run
  showed 30 collections, then dropped 30 collections; prefix inventory returned
  zero benchmark groups. The next gate remains a rerun of the larger answerer
  rehearsal after the compact count-evidence change.
- Exact old baking-count miss rerun `20260601d` passed under real ingestion,
  MongoDB search, and `gpt-5` answerer/judge. The official sampler selected
  QID `88432d0a` with `--question-types multi-session --per-type 1 --seed 51`;
  `top_50` scored `1/1`, generated answer `4 times.`, and artifact SHA256 is
  `ac5882782db7af3e1b15c1c9412d7643145f526bee20aaba743a524132c6a518`.
  Artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-1baking-answerer-20260601d/longmemeval_results_20260601_031653.json`.
  The exact Atlas prefix
  `memongo_bench_mem0_memorybenchmarks_1_baking_answerer_20260601_d_` dry-run
  showed 30 collections, then dropped 30 collections; prefix inventory returned
  zero benchmark groups and MCP listed only `system.views`. This proves the
  old miss is resolved by generic count evidence, but it also exposed a
  separate provenance risk: some projected/chunk retrieval units can surface
  run-time timestamps instead of source session dates. Do not promote Mem0 rows
  until the larger rehearsal passes and timestamp provenance is audited.
- Core provenance fix `20260601e`: event chunk projection now stores the source
  event timestamp instead of forcing search result mapping to fall back to
  projection `updatedAt`. Focused unit coverage was added in
  `packages/memory-engine/src/mongodb-events.test.ts`. The exact rerun of
  QID `88432d0a` then failed with answer `5`, artifact SHA256
  `148657a11fd00026167120cadec3607b5155ad2b238482139e104a5daf1f3bf9`,
  because the now-correct source dates exposed five plausible source-backed
  baking candidates while the official gold answer is `4`. This is not a
  reason to add benchmark-specific count rules. Treat it as a dataset/semantic
  ambiguity requiring broader rehearsal and generic count-policy review before
  any Mem0 publication row.
- Larger 12-case answerer-mode rehearsal `20260601f` completed under the
  official `memory-benchmarks` harness with Memongo served only through the
  Mem0-compatible endpoint. It scored `11/12` (`91.7%`) at `top_50`, with five
  of six question types at `100%` and the only miss in `multi-session`.
  Artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-12-answerer-20260601f/longmemeval_results_20260601_105719.json`,
  SHA256 `310f8c43180cd374fd417fca99315dfc8d927b01b362423539ce29962913444f`.
  The exact Atlas prefix
  `memongo_bench_mem0_memorybenchmarks_12_answerer_20260601_f_` dry-run showed
  30 collections, then dropped 30 collections; prefix inventory returned zero
  benchmark groups. The miss was again QID `88432d0a`: retrieval returned the
  needed baking-count evidence as the top result plus supporting events, but the
  official answerer produced a blank generated answer. Do not promote this row
  or run full Mem0 LongMemEval yet; the next gate is an answerer artifact
  validator and a generic count-answer policy decision that preserves source
  truth instead of forcing the benchmark's ambiguous gold count.
- Saved-retrieval re-evaluation `20260601g` copied the same 12 retrieved-memory
  artifacts from `20260601f` and re-ran only the official answerer/judge phase
  (`--evaluate-only --rejudge`), so no MongoDB writes or searches occurred. It
  again scored `11/12` (`91.7%`) at `top_50`. Artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-12-answerer-reeval-20260601g/longmemeval_results_20260601_114456.json`,
  SHA256 `e6dfe77bcd1abe788ef77dab9b5b9e3767b26b27b69d63c44be49078a4a16f8a`.
  The new answerer-artifact validator passed this artifact because no generated
  answer was blank; the remaining miss answered `6` for QID `88432d0a`. This
  proves the blank-answer issue was transient, while the real blocker remains
  generic count-context ambiguity. Do not make a code change that maps this case
  to `4`; first define a source-faithful count policy that rejects duplicate
  mentions and plans/advice across all count-style queries.
- Count-policy audit `20260601g` ran over the LongMemEval-S dataset and the
  saved-retrieval re-evaluation artifact. Audit artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-12-answerer-reeval-20260601g/count-policy-audit.json`,
  SHA256 `8deb6249e84f2751f89ba2e331fdf76ff3bbe73bfabeac6a91233317657ff301`.
  It found 225 broad quantitative questions: `inventory=85`, `duration=77`,
  `money-or-percent=42`, `repeated-action=20`, `pending-action=1`. Of 212
  numeric gold answers, only 21 equal `answer_session_ids.length`; 191 differ.
  In the 12-case artifact, all four quantitative cases were flagged because the
  derived evidence count differs from either gold or generated answer. This
  confirms the next work must be a generic count-context policy, not MongoDB
  Search ranking and not a session-count shortcut.
- Materialized-evidence retrieval gate `20260601n` ran the official
  `memory-benchmarks` LongMemEval runner in predict-only mode after the Mem0
  compatibility adapter was changed to materialize canonical event text from
  returned Memongo file sources. This is a generic evidence-handoff fix: MongoDB
  search had already found the right source, but the previous adapter could hand
  the official downstream judge an over-clipped snippet. The run processed 12
  questions, two from each LongMemEval-S type, with 12 prediction files and 12
  ingestion ledgers. Exact Atlas prefix
  `memongo_bench_mem0_memorybenchmarks_12_predict_materialized_20260601_n_`
  dry-run listed 30 collections, exact drop removed 30 collections, and prefix
  inventory returned zero groups/indexes.
- First saved-retrieval rejudge over `20260601n` with Grove/Kimi scored
  `11/12` because QID `88432d0a` returned `{}` / empty generated evidence after
  a structured-output timeout, even though rank 1 contained the correct
  source-backed count evidence. Failed artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-12-predict-materialized-20260601n/longmemeval_results_20260601_215919.json`,
  SHA256 `83892580fd3f27e6fb80ba183e3b6c438c3130a38a111595d4d099c22ca4988d`.
  Preserve this artifact as judge-transport evidence.
- Second saved-retrieval rejudge over the exact same `20260601n` prediction
  files used stronger Grove transport bounds
  (`timeout=180s`, `max_retries=5`, `min_max_tokens=8192`) and scored
  `12/12` at both `top_10` and `top_50`. Passing artifact:
  `artifacts/ecosystem-smokes/mem0-memory-benchmarks-longmemeval-12-predict-materialized-20260601n/longmemeval_results_20260601_220929.json`,
  SHA256 `fcee7162f42509b9c9a19db6832d57158130c6d00af665909d1c4bbf01aa3042`.
  This supports the materialized evidence handoff and transport-bounds fix, but
  it is still a 12-case rehearsal, not a publishable Mem0 full row.

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
| P1 | Mem0 | LongMemEval platform top-50 | 94.8% in README; committed platform result top-50 reports 90.4% answer accuracy, SHA `8bbf06e4205dce1df9c2dff9a9ddf99074865ca40019e1c5a10f0d3a37b4275c` | Judged answer accuracy | LongMemEval-S, 500 | Answer context | Top-50 search | GPT-5 answerer/judge in committed result metadata | `memory-benchmarks/results/platform/longmemeval_top50_results.json` | Larger answerer rehearsal reached 11/12, but the remaining miss has source-backed ambiguity plus a blank answerer output; not publishable yet |
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
