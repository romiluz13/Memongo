# Memongo Benchmark Evidence

Status: scoped retrieval evidence, including a transparent non-reportable
LongMemEval candidate run.

Last reviewed: 2026-08-16.

Memongo benchmark claims are intentionally narrow. Retrieval recall and judged
answer quality are different metrics and must not be presented as one
leaderboard.

## Launch Claim Policy

Allowed:

- Memongo has scoped MemPalace P0 retrieval-lane evidence.
- The August 14 full LongMemEval result may be described as non-reportable
  research evidence only when its metric unit and failed release gates are
  included.
- A row may be quoted only with its metric, dataset, retrieval unit, top-k,
  scorer, and LLM/rerank posture.

Not claimed:

- No Mem0 LongMemEval judged-answer win is claimed.
- No broad ecosystem leadership claim is made.
- No old `98.1%` README number is used.
- No retrieval-recall row is compared to a competitor's judged-answer accuracy
  row as if they were the same measurement.

The source tree includes an aggregate machine-readable summary and a sanitized
completion excerpt for the August 14 run. It does not include the 640,000-line
checkpoint, raw connection-bearing log, predictions, or a complete release
artifact bundle.

## August 14 LongMemEval Full Run

This was a complete 500-question retrieval run against the pinned
`LongMemEval_S` dataset. It used the canonical LongMemEval retrieval evaluator,
MongoDB-native `$scoreFusion`, Voyage 4 Large query embeddings, Voyage
`rerank-2.5`, parallel conversation evidence, and no generative LLM enrichment.

| Metric | Unit | Result |
|---|---|---:|
| Execution success | scenarios | 500/500 |
| Official RecallAny@10 | session | **98.57%** |
| Official RecallAll@10 | session | **94.75%** |
| Official nDCGAny@10 | session | **87.63%** |
| Official RecallAny@10 | turn | 46.30% |
| Internal hit rate | scored case | **98.94%** |
| Internal R@5 | scored case | **93.15%** |
| Internal R@10 | scored case | **97.16%** |
| Internal nDCG@10 | scored case | **89.38%** |
| p50 / p95 | scored query | 792 ms / 1,244 ms |

The session and turn rows are deliberately shown together. Memongo retrieved
the relevant session very reliably, but exact turn targeting remains much
weaker and is an open quality problem.

### Release-contract result

The run passed official retrieval, internal retrieval, execution completeness,
and conversation-recall regression gates. It is **not reportable under
`longmemeval-release@1`**:

1. p95 was 1,244 ms, above the registered 1,000 ms threshold.
2. Build commit identity, monetary cost, and MongoDB Automated Embedding/vector
   operation accounting were incomplete.

This status is retained even when latency is not a product priority. It is part
of the pre-registered evidence contract and cannot be silently removed after a
run.

### Evidence

- [Aggregate result](../../benchmarks/results/final-2026-08-14/longmemeval-score-fusion-voyage-large-summary.json)
- [Sanitized completion excerpt](../../benchmarks/results/final-2026-08-14/longmemeval-score-fusion-voyage-large-sanitized-summary.log)
- Dataset SHA-256:
  `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
- LongMemEval evaluator commit:
  `9e0b455f4ef0e2ab8f2e582289761153549043fc`

## Competitor Context

These public results answer different questions. A larger percentage does not
establish a win unless dataset, retrieval unit, top-k, answer model, judge, and
aggregation all match.

| System | Public result | Measurement | Directly comparable? |
|---|---:|---|---|
| Memongo | 98.57% | LongMemEval session RecallAny@10, retrieval only | Baseline |
| [Mem0](https://mem0.ai/research) | 94.4% | LongMemEval generated-answer accuracy | No, answer generation and judging |
| [Zep / Graphiti](https://www.getzep.com/research/) | 90.2% | LongMemEval answer accuracy | No, answer generation and judging |
| [Supermemory](https://supermemory.ai/research/longmembench/) | 95% | LongMemEval overall Recall@15 with aggregation | No, different top-k and aggregation |
| [Mastra Observational Memory](https://mastra.ai/research/observational-memory) | 95% | LongMemEval end-to-end result | No, answer pipeline rather than retrieval-only session recall |
| [Letta Filesystem](https://www.letta.com/blog/benchmarking-ai-agent-memory/) | 74.0% | LoCoMo answer quality | No, different dataset and evaluator |
| [LangMem](https://github.com/langchain-ai/langmem) | No first-party LongMemEval result found in the August 16 audit | Framework documentation | No result to compare |

Graphiti is the open-source graph framework behind Zep, so the Zep row is not
duplicated as a separate competitor score. Hindsight, Cognee, and Weaviate
Engram were also reviewed for public evidence, but no first-party result with a
matching Memongo retrieval protocol was found.

The defensible conclusion is narrow: **Memongo demonstrates excellent
session-level retrieval on this run.** The evidence does not establish that
Memongo is the world's best memory framework or that it beats generated-answer
systems.

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

Do not quote release-artifact hashes until raw predictions, scorer output, run
metadata, cost and operation accounting, build identity, and cleanup proof are
attached to a public GitHub Release.

## Operating Rules

See [Benchmark Operating Contract](benchmark-operating-contract.md).
