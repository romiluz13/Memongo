# Memongo Benchmark Evidence

Status: scoped public evidence for selected MemPalace retrieval lanes.

Last reviewed: 2026-06-24.

Memongo benchmark claims are intentionally narrow. Retrieval recall and judged
answer quality are different metrics and must not be presented as one
leaderboard.

## Launch Claim Policy

Allowed:

- Memongo has scoped MemPalace P0 retrieval-lane evidence.
- A row may be quoted only with its metric, dataset, retrieval unit, top-k,
  scorer, LLM/rerank posture, and artifact hash.

Not claimed:

- No Mem0 LongMemEval judged-answer win is claimed.
- No broad ecosystem leadership claim is made.
- No old `98.1%` README number is used.
- No retrieval-recall row is compared to a competitor's judged-answer accuracy
  row as if they were the same measurement.

Raw benchmark artifacts and internal run logs are not checked into the public
source tree. The launch source tree keeps the concise evidence summary below;
release artifacts can attach the raw files separately when needed.

## Selected MemPalace Retrieval Evidence

These rows are retrieval-lane comparisons against MemPalace committed artifacts.
They are not Mem0 claims and not judged-answer claims.

| Lane | Metric | Retrieval unit | Memongo | MemPalace | Status |
|---|---|---|---:|---:|---|
| LongMemEval raw session full 500 | RecallAny@5 | session | 99.15% | 96.60% | Scoped retrieval win |
| LongMemEval held-out 450 hybrid no-LLM | RecallAny@5 | session | 99.11% | 98.44% | Scoped retrieval win |
| LoCoMo raw session top-10 | average recall | session | 91.71% | 60.29% | Scoped retrieval win |
| LoCoMo hybrid session top-10 | average recall | session | 93.30% | 88.91% | Scoped retrieval win |
| ConvoMem raw message top-10 | average recall | message | 100.00% | 92.87% | Scoped retrieval win |
| MemBench hybrid turn top-5 | hit@5 | turn | 88.75% | 80.33% | Scoped retrieval win |

The previous LongMemEval full-500 hybrid no-LLM row is excluded from the launch
summary because it mixed MemPalace raw and rerank lanes in one line. It can be
reintroduced only as a separately worded Memongo-native retrieval row.

## Evidence Metadata

| Lane | Memongo artifact hash | Competitor artifact hash | Notes |
|---|---|---|---|
| LongMemEval raw session full 500 | `06b0b4c5a4d219bc74fa9d9f781e8dfc9844dca01e2d93a3e0efca7a90832a98` | `2b71b5e514279c28443736561e2ac453045520b0f8832ff092e8a6143965e5d1` | No LLM, no rerank |
| LongMemEval held-out 450 hybrid no-LLM | `d173405a11d55750726722623de9bfe4726d1d3788d11038588ae0987c578343` | `5f5849e8facdbdec673967dfbd9dd288323983ae824ca787ffa89110dd1b588d` | No LLM, no rerank |
| LoCoMo raw session top-10 | `882b24d1c9b445346f060387006088c5f0fc4ee252bfb49f1cae316a8ac0be20` | `b8bc53a7a0595786fdff470dedd28dc6819d414619acd432748f443c6c907041` | No LLM, no rerank |
| LoCoMo hybrid session top-10 | `75fd152b9e11bf97b309ccce4fa69460882045f95062d607984691e267ef836a` | `f7f11bad92cf7406a6e93aa776524bf97d0bc84032786e62585835a4582a1dcf` | No LLM, no rerank |
| ConvoMem raw message top-10 | `36cdaeadc7fa7e5cae9d9f9ce874527bd23ef5186bfd99962ce6671b71e9d5d1` | `e3d778c3007113d8a78854004aac6c724b82c86b5349f3cf764ca42abf3a0100` | No LLM, no rerank |
| MemBench hybrid turn top-5 | `a87e6826f57282862126bb1a8c56672cbb7921679a0f8818fb2248576244deea` | MemPalace committed result at 6,828/8,500 | No judged QA claim |

## Mem0 Status

No Mem0 LongMemEval win is claimed.

The latest full judged rehearsal remained below Mem0's committed top-50/top-200
rows. That work is preserved privately as benchmark-lab history and should not
be used as launch marketing.

## Operating Rules

See [Benchmark Operating Contract](benchmark-operating-contract.md).
