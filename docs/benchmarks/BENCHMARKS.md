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
  scorer, and LLM/rerank posture.

Not claimed:

- No Mem0 LongMemEval judged-answer win is claimed.
- No broad ecosystem leadership claim is made.
- No old `98.1%` README number is used.
- No retrieval-recall row is compared to a competitor's judged-answer accuracy
  row as if they were the same measurement.

Raw benchmark artifacts and run logs are not checked into the public source
tree. The launch source tree keeps the concise evidence summary below; public
artifact bundles can be attached to a GitHub Release before quoting hashes.

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

## Evidence Artifacts

The public source tree intentionally omits raw benchmark artifacts. Do not quote
artifact hashes until the corresponding raw predictions, scorer output, run
metadata, and cleanup proof are attached to a public GitHub Release.

## Mem0 Status

No Mem0 LongMemEval win is claimed.

The latest full judged rehearsal remained below Mem0's committed top-50/top-200
rows. That work is preserved privately as benchmark-lab history and should not
be used as launch marketing.

## Operating Rules

See [Benchmark Operating Contract](benchmark-operating-contract.md).
