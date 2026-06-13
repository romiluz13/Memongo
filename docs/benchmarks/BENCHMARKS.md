# Memongo Benchmark Results

Status: publication evidence pack for the MemPalace P0 release scope.

Last evidence refresh: 2026-06-13.

This document follows one rule: a benchmark row is public only when the run proves
the product path being claimed. Every public row must include artifact paths,
dataset identity, scorer, retrieval unit, LLM/rerank disclosure, warnings,
degradations, and competitor evidence. The old `98.1%` README claim is excluded:
it has no committed artifact pack and remains unproven.

For the refreshed cross-competitor queue, see
[Competitor Benchmark Inventory](./COMPETITOR-BENCHMARK-INVENTORY.md).
For the fresh Atlas execution procedure, see
[Ecosystem Benchmark Runbook](./ECOSYSTEM-BENCHMARK-RUNBOOK.md).
For the end-to-end state, road already traveled, and remaining gates, see
[Memongo Benchmark Full Picture Roadmap](./FULL-PICTURE-ROADMAP.md).

## Claim Policy

Allowed:

- "Memongo beats MemPalace on this benchmark lane under this scorer."
- "Memongo native MongoDB lane uses Atlas Search/Vector Search with autoEmbed
  `voyage-4-large`; competing stacks and models are disclosed."

Not allowed yet:

- "Best memory framework in the world."
- Comparing retrieval recall to answer/judge accuracy as one leaderboard.
- Reusing the old `98.1%` number without a reproducible artifact.
- Publishing a row whose command, dataset, scorer, retrieval unit, warnings, or
  competitor artifact are missing.

## Current Evidence Summary

These rows are artifact-backed and beat the matching MemPalace retrieval row.
They are valid for scoped README language after release checks, secret scans, and
reviewed commits pass. The 2026-06-03 competitor refresh moved MemPalace to
`02b8753d9759`; benchmark docs and committed result artifacts were unchanged, so
the P0 rows remain valid unless a later artifact-shape audit finds a gap.

| Status | Benchmark lane | Memongo | MemPalace | Verdict |
| --- | --- | ---: | ---: | --- |
| PROVED | LongMemEval raw session full 500, session RecallAny@5 | 99.15% | 96.60% | Memongo wins |
| PROVED | LongMemEval held-out 450 hybrid no-LLM, session RecallAny@5 | 99.11% | 98.44% | Memongo wins |
| COMPLETE | LongMemEval full 500 hybrid no-LLM, session RecallAny@5 | 99.20% | 96.60% raw / 99.20% Haiku rerank | Beats raw; ties rerank with different lane |
| PROVED | LoCoMo raw session top-10, 1,986 rows avg recall | 91.71% | 60.29% | Memongo wins |
| PROVED | LoCoMo hybrid session top-10, 1,986 rows avg recall | 93.30% | 88.91% | Memongo wins |
| PROVED | ConvoMem raw message top-10, 250 items avg recall | 100.00% | 92.87% | Memongo wins |
| PROVED | MemBench hybrid turn top-5, 8,500 rows hit@5 | 88.75% | 80.33% | Memongo wins |

Rows below are promising but not publishable claims.

| Status | Benchmark lane | Current evidence | Blocker |
| --- | --- | --- | --- |
| PROMISING | LongMemEval held-out 450 raw session | Memongo session RecallAny@5 99.06%, internal R@5 97.14% | Do not compare directly to MemPalace held-out hybrid without lane wording |
| INCOMPLETE | LLM/rerank rows | No Memongo full rerank lane artifact | Run and disclose Grove/model/reranker separately |
| INCOMPLETE | Mem0 official `memory-benchmarks` rows | Latest full 500 Atlas Local Preview sharded rehearsal completed 20/20 shards, 500/500 predictions, 500/500 ingestion ledgers, zero empty retrievals, and exact-prefix cleanup. Saved-artifact GPT-5/Grove judging scored top-50 89.6% and top-200 90.4%, still below Mem0 committed 90.4%/93.4% rows; top-50 answerer validation failed on one blank non-abstention generated answer. | Fix generic blank-answer handling, multi-session current-state/count retrieval, stale/future evidence suppression, and answer-context packing; then rerun saved-artifact evaluation and only run another full retrieval batch after focused gates pass |
| BLOCKED | Supermemory/Zep/Letta/Mastra/OpenViking ecosystem rows | Repos exist locally | Competitor command first, then Memongo adapter and same-scorer run |

## LongMemEval

Metric: labelled session appears in the retrieved top-k set. MemPalace publishes
this as R@5; Memongo artifacts report official session RecallAny@k and internal
R@k. The public comparison must use the same retrieval-unit language.

### Raw Session Full 500

| Field | Memongo | MemPalace |
| --- | --- | --- |
| Status | PROVED | Baseline competitor artifact |
| Cases | 500/500 | 500/500 |
| Retrieval unit | Session | Session |
| Top-k | 5 | 5 |
| LLM | None | None |
| Reranker | None | None |
| Embedding | MongoDB autoEmbed `voyage-4-large` | ChromaDB default MiniLM-L6-v2 |
| Scorer | LongMemEval session RecallAny@5 plus internal R@5 gate | MemPalace JSONL session `recall_any@5` |
| Memongo score | session RecallAny@5 99.15%; internal R@5 97.29% | - |
| Competitor score | - | session R@5 96.60% |
| Empty rate | 0.00% | Not reported in committed file |
| Warnings/degradations | 0/0 | Not reported |
| Memongo artifact | `artifacts/benchmark-runs/memongo-raw-session-full500-20260520-atlas-b/benchmark-response.json` | - |
| Memongo artifact SHA256 | `06b0b4c5a4d219bc74fa9d9f781e8dfc9844dca01e2d93a3e0efca7a90832a98` | - |
| Competitor artifact | - | `../memongo-competitors/mempalace/benchmarks/results_mempal_raw_session_20260414_1629.jsonl` |
| Competitor artifact SHA256 | - | `2b71b5e514279c28443736561e2ac453045520b0f8832ff092e8a6143965e5d1` |
| Dataset SHA256 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` | Not recorded in competitor artifact |
| Command | `bun scripts/launch-official-longmemeval-benchmark.ts` | Not captured in committed result file |

### Held-Out 450

MemPalace's honest generalizable hybrid row is held-out 450 hybrid v4 no-LLM at
98.44% R@5. Memongo has a current post-fix held-out 450 hybrid no-LLM artifact at
99.11% session RecallAny@5. This row is a MemPalace P0 win.

| Field | Memongo hybrid no-LLM | MemPalace hybrid held-out |
| --- | ---: | ---: |
| Cases | 450/450 | 450/450 |
| Session RecallAny@1 | 88.67% | 89.11% |
| Session RecallAny@5 | 99.11% | 98.44% |
| Session RecallAny@10 | 99.56% | 99.78% |
| Empty rate | 0.00% | Not reported |
| Warnings/degradations | 0/0 | Not reported |
| Artifact SHA256 | `d173405a11d55750726722623de9bfe4726d1d3788d11038588ae0987c578343` | `5f5849e8facdbdec673967dfbd9dd288323983ae824ca787ffa89110dd1b588d` |

Completed hybrid no-LLM run:

| Field | Value |
| --- | --- |
| Status | PROVED; `benchmark:status` PASS |
| Run ID | `memongo-lme-heldout450-hybrid-rrf-20260528-a` |
| Artifact | `artifacts/benchmark-runs/memongo-lme-heldout450-hybrid-rrf-20260528-a/benchmark-response.json` |
| Artifact SHA256 | `d173405a11d55750726722623de9bfe4726d1d3788d11038588ae0987c578343` |
| Scored cases | 450/450 |
| Internal/session R@5 | 99.11% |
| Empty rate | 0.00% |
| Main remaining miss pattern | single-session-preference, one multi-session, one temporal |
| Generic fix used | Atlas Search key-phrase token facets plus independent subsearch rank fusion; no question-id rules |
| Prefix cleanup | Exact prefix dropped and verified empty |

Previous failed hybrid no-LLM attempt:

| Field | Value |
| --- | --- |
| Status | Stopped early; not publishable |
| Run ID | `memongo-lme-heldout450-hybrid-nollm-20260526-atlas-a` |
| Artifact | `artifacts/benchmark-runs/memongo-lme-heldout450-hybrid-nollm-20260526-atlas-a/partial-response.json` |
| Artifact SHA256 | `3d114ec40ffcef79ac1acb41b492c161bc7681cd1a7acabb5dcff7e93e5a063d` |
| Scored cases | 227/450 |
| Running R@5 at stop | 96.92% |
| Reason stopped | 7 misses by 227 cases made a strict win over MemPalace 98.44% mathematically impossible |
| Main miss pattern | single-session-assistant first, then temporal-reasoning and single-session-preference |

### Hybrid No-LLM Full 500

This is a completed Memongo native hybrid retrieval row on the full LongMemEval-S
500-case dataset. It is not the same lane as MemPalace raw and not the same lane
as MemPalace Haiku rerank; use this row with explicit lane disclosure.

| Field | Memongo hybrid no-LLM |
| --- | ---: |
| Cases | 500/500 |
| Session RecallAny@1 | 89.80% |
| Session RecallAny@5 | 99.20% |
| Session RecallAny@10 | 99.60% |
| Empty rate | 0.00% |
| Warnings/degradations | 0/0 |
| Artifact SHA256 | `c3611431927fac69a3e64dced860d2a52ef1279d0b9eaa8625d77320d4e2f1ca` |

| Field | Value |
| --- | --- |
| Status | COMPLETE; `benchmark:status` PASS |
| Run ID | `memongo-lme-full500-hybrid-rrf-20260528-a` |
| Artifact | `artifacts/benchmark-runs/memongo-lme-full500-hybrid-rrf-20260528-a/benchmark-response.json` |
| Scored cases | 500/500 |
| Internal/session R@5 | 99.20% |
| Main remaining miss pattern | single-session-preference and temporal-reasoning |
| Prefix cleanup | Exact prefix dropped and verified empty |

## LoCoMo

Metric: average recall over 1,986 QA rows, top-10 session retrieval. No LLM or
reranker is used in the Memongo raw/hybrid rows below.

| Lane | Memongo | MemPalace | Verdict |
| --- | ---: | ---: | --- |
| Raw session top-10 | 91.71% | 60.29% | Memongo wins |
| Hybrid session top-10 | 93.30% | 88.91% | Memongo wins |

Artifacts:

| Lane | Memongo artifact | Memongo SHA256 | Competitor artifact | Competitor SHA256 |
| --- | --- | --- | --- | --- |
| Raw top-10 | `artifacts/benchmark-runs/memongo-locomo-raw-session-top10-raw1986-20260525-atlas-a/benchmark-response.json` | `882b24d1c9b445346f060387006088c5f0fc4ee252bfb49f1cae316a8ac0be20` | `../memongo-competitors/mempalace/benchmarks/results_locomo_raw_session_top10_20260414_1634.json` | `b8bc53a7a0595786fdff470dedd28dc6819d414619acd432748f443c6c907041` |
| Hybrid top-10 | `artifacts/benchmark-runs/memongo-locomo-hybrid-session-top10-raw1986-20260525-atlas-a/benchmark-response.json` | `75fd152b9e11bf97b309ccce4fa69460882045f95062d607984691e267ef836a` | `../memongo-competitors/mempalace/benchmarks/results_locomo_hybrid_session_top10_20260414_1649.json` | `f7f11bad92cf7406a6e93aa776524bf97d0bc84032786e62585835a4582a1dcf` |

Dataset SHA256: `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.

Latency:

- Raw top-10: avg 723 ms, p95 834 ms.
- Hybrid top-10: avg 1,131 ms, p95 1,398 ms.

## ConvoMem

Metric: average recall over 250 effective items, top-10 message retrieval. No
LLM or reranker is used.

| Lane | Memongo | MemPalace | Verdict |
| --- | ---: | ---: | --- |
| Raw message top-10 | 100.00% | 92.87% | Memongo wins |

Per-category Memongo recall is 100.00% across user evidence, assistant facts,
preference evidence, implicit connections, and abstention evidence.

Artifacts:

| Field | Value |
| --- | --- |
| Memongo artifact | `artifacts/benchmark-runs/memongo-convomem-full-limit50-top10-20260525-atlas-a/benchmark-response.json` |
| Memongo artifact SHA256 | `36cdaeadc7fa7e5cae9d9f9ce874527bd23ef5186bfd99962ce6671b71e9d5d1` |
| Competitor artifact | `../memongo-competitors/mempalace/benchmarks/results_convomem_raw_top10_20260414_1649.json` |
| Competitor artifact SHA256 | `e3d778c3007113d8a78854004aac6c724b82c86b5349f3cf764ca42abf3a0100` |
| Dataset/cache SHA256 | `6dfe4e5b59fc627d20ebe660eb2e49da7ea2a35f1e660f9e41832eafce9acafe` |
| Latency | avg 587 ms, p95 657 ms |

## MemBench

Metric: hit@5 over 8,500 movie-topic rows from MemBench FirstAgent. MemPalace's
committed artifact is a full 8,500-case hybrid top-5 result at 6,828/8,500, or
80.33%. Memongo now has a full 8,500-case artifact at 7,544/8,500, or 88.75%.

| Field | Value |
| --- | --- |
| Status | PROVED |
| Memongo artifact | `artifacts/benchmark-runs/memongo-membench-full8500-hybrid-20260527-atlas-a/benchmark-response.json` |
| Memongo artifact SHA256 | `a87e6826f57282862126bb1a8c56672cbb7921679a0f8818fb2248576244deea` |
| Memongo score | 7,544/8,500 hit@5, 88.75% |
| Competitor full artifact | `../memongo-competitors/mempalace/benchmarks/results_membench_hybrid_all_movie_top5_20260414_1656.json` |
| Competitor full SHA256 | `6a500795e68e40b4723da86c623d930e0bd184949a8f04c89f185d9181f4b622` |
| Competitor score | 6,828/8,500 hit@5, 80.33% |
| Empty rate | 0.00% |
| Prefix cleanup | Exact prefix dropped and verified empty |

Per-category Memongo hit@5:

| Category | Cases | Hit@5 |
| --- | ---: | ---: |
| simple | 1,000 | 98.90% |
| highlevel | 500 | 100.00% |
| knowledge_update | 1,000 | 98.40% |
| comparative | 1,000 | 99.40% |
| conditional | 1,000 | 79.20% |
| noisy | 1,000 | 69.80% |
| aggregative | 1,000 | 100.00% |
| highlevel_rec | 500 | 62.60% |
| lowlevel_rec | 500 | 100.00% |
| post_processing | 1,000 | 77.40% |

## Publication Blockers

- Some adapter artifacts do not record exact command lines. Rerun or backfill
  command metadata before README use.
- Storage and cost fields are incomplete for non-LongMemEval adapter rows.
- LLM/rerank lanes are not run for Memongo.
- Ecosystem competitors beyond MemPalace need adapters and same-scorer runs.
- Secrets and credentials must be rotated and scanned before release.
- Full JSON artifacts are stored under ignored `artifacts/` paths. Upload them as
  release assets or attach them to a public evidence bundle before a launch post.

## Next Run Queue

1. Mem0 official `memory-benchmarks` scoped 72-case Local Preview rehearsal on a
   fresh benchmark-only deployment with `MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE=longmemeval`,
   plus managed Atlas disclosure if Local Preview probe warnings persist.
2. Mem0 LongMemEval top-50/top-200 full rows, followed by LoCoMo and BEAM rows
   under the official scorer/model posture.
3. Supermemory/MemoryBench provider adapter.
4. Zep, Mastra, Hindsight, and OpenViking adapters only after reproducing each
   competitor command.
5. Optional LongMemEval rerank lane with full model disclosure.

## Validation Commands

Use these before moving any row from this draft into README or release notes:

```bash
bun run check-types
bun run build
bun run benchmark:status -- artifacts/benchmark-runs/memongo-raw-session-full500-20260520-atlas-b/benchmark-response.json
bun run benchmark:status -- artifacts/benchmark-runs/memongo-heldout450-raw-session-20260524-atlas-a/benchmark-response.json
bun run benchmark:status -- artifacts/benchmark-runs/memongo-lme-heldout450-hybrid-surgical-20260527-atlas-a/benchmark-response.json
bun run benchmark:status -- artifacts/benchmark-runs/memongo-lme-full500-hybrid-surgical-20260527-atlas-a/benchmark-response.json
shasum -a 256 artifacts/benchmark-runs/memongo-raw-session-full500-20260520-atlas-b/benchmark-response.json
shasum -a 256 ../memongo-competitors/mempalace/benchmarks/results_mempal_raw_session_20260414_1629.jsonl
```
