# Competitor Benchmark Publication Plan

Status: draft execution plan, not a public claim.
Date: 2026-05-25.

## Goal

Produce artifact-backed Memongo benchmark claims against the latest local
competitor repositories under `/Users/rom.iluz/Dev/memongo-competitors`.
Every claim must be lane-specific, reproducible, and explicit about metric,
dataset, retrieval unit, LLM use, embedding model, reranker, latency, storage,
and artifact path.

## Fresh Competitor Snapshot

Pulled with `git pull --ff-only` on 2026-05-25.

| Repo | Branch | Head | Dirty | Role |
| --- | --- | --- | --- | --- |
| Membench | main | f66d8d1 | no | MemBench source dataset |
| OpenViking | main | 1ca433b4 | no | LoCoMo/task-completion competitor evidence |
| hindsight | main | 878ef957 | no | BEAM and memory benchmark competitor evidence |
| letta | main | 11315357 | no | agent-memory architecture comparison |
| locomo | main | 3eb6f2c | no | LoCoMo source dataset |
| mastra | main | 9bbadfc9eb | no | observational-memory/eval competitor evidence |
| mem0 | main | 0da3359a | no | LoCoMo, LongMemEval, BEAM competitor evidence |
| mempalace | develop | d0d011e | no | primary apples-to-apples target |
| supermemory | main | f646f1a | no | MemoryBench/MemScore competitor evidence |
| zep | main | faf2ace | no | LoCoMo/LongMemEval/Zep eval harness evidence |

## Non-Negotiable Claim Rules

- Do not claim "best memory framework in the world" from one benchmark.
- Do not compare retrieval recall to answer/judge accuracy without labeling the
  metric difference.
- Do not compare no-LLM lanes to LLM/rerank lanes as if they are the same lane.
- Do not publish any row without an artifact pack and reproducible command.
- Do not use question IDs, gold evidence, or target labels before retrieval.
- Do not reuse polluted MongoDB collections; every serious run uses an isolated
  prefix that is dropped after artifact capture.
- Disclose MongoDB autoEmbed `voyage-4-large` whenever MemPalace uses
  ChromaDB/MiniLM, and add exact-model parity only as a separate lane.

## MemPalace Latest Public Claims To Cover

Source: latest `mempalace` develop docs at `README.md`,
`benchmarks/README.md`, `benchmarks/BENCHMARKS.md`, and committed
`benchmarks/results_*` files.

| Priority | Competitor lane | Their claimed score | Required Memongo lane | Current Memongo status |
| --- | --- | --- | --- | --- |
| P0 | LongMemEval raw session, top-5, no LLM | 96.6% R@5, 500q | raw session, no LLM/rerank/background derivations | already covered previously; must re-audit latest artifact before README |
| P0 | LongMemEval hybrid v4 held-out 450, no LLM | 98.4% R@5 | held-out 450, same split, no LLM, generic hybrid controls | not publishable until latest split/scorer artifact is rerun |
| P0 | LoCoMo session top-10, no rerank | 60.3% R@10, 1,986 rows | raw session top-10, no LLM/rerank | Memongo artifact exists, but scorer/case-count reconciliation is required |
| P0 | LoCoMo hybrid v5 top-10, no rerank | 88.9% R@10 | hybrid session top-10, no LLM/rerank | not yet run |
| P0 | ConvoMem all categories, 50/category, top-10 | 92.9% avg recall, 250 items | raw message/evidence top-10, no LLM/rerank | Memongo artifact exists and currently looks strongest |
| P0 | MemBench hybrid all movie/roles/events top-5 | 80.3% R@5, 8,500 items | turn top-5, same hybrid re-score semantics | only 100-item Memongo slice exists; full run required |
| P1 | LongMemEval hybrid v4 + LLM rerank | README says >=99%; BENCHMARKS discusses 100% but flags contamination | same retrieval + LLM rerank, separately labeled | only after clean no-LLM lanes are complete |
| P1 | LoCoMo rerank/top-50 claims | 100%, but their docs say structurally weak because top-k exceeds sessions | only reproduce as caveated demonstration, not a victory headline | optional; not a primary win condition |
| P2 | MemPalace model_eval multilingual tasks | new latest benchmark tooling | separate extraction/classification adapter if relevant | inventory first; not memory retrieval recall |
| P2 | MemPalace mining throughput | drawers/sec, storage throughput | MongoDB write/index throughput lane | optional product-performance comparison |

## Other Competitor Claims To Track

| Competitor | Claimed/evaluable benchmark | Metric type | Plan |
| --- | --- | --- | --- |
| Mem0 | LoCoMo, LongMemEval, BEAM via memory-benchmarks | answer/judge accuracy plus token budget | run their public harness or build a Memongo adapter; never compare directly to retrieval recall |
| Hindsight | BEAM 100K/500K/1M/10M published tiers | answer/judge accuracy at large token scale | treat BEAM as the scale benchmark; implement Memongo BEAM adapter before any claim |
| Supermemory | MemoryBench/MemScore | quality / latency / context tokens | use their MemScore format for Memongo product lane |
| Zep | LoCoMo and LongMemEval harnesses | context completeness / answer accuracy | run Zep harness format with Memongo adapter where possible |
| OpenViking | LoCoMo10 task completion, token cost | task completion and token savings | separate task-completion benchmark, not retrieval recall |
| Mastra | observational-memory evaluation | answer accuracy | only compare through their documented harness or a shared judge suite |
| Letta | architecture/eval harness references | agent behavior, DMR-style evals | keep as qualitative until a reproducible benchmark lane is identified |

## Execution Plan

### Phase 1: Freeze Evidence Inputs

1. Save a competitor snapshot JSON with repo, branch, commit, dirty status, and
   exact benchmark docs inspected.
2. Save SHA256 for every competitor committed result file used as a baseline.
3. Save SHA256 for every dataset file used by Memongo and competitor runners.
4. Record exact commands in artifacts, not in README prose only.

### Phase 2: Finish MemPalace P0 Lanes

1. Re-audit latest LongMemEval raw artifact and Memongo raw-session full artifact.
2. Re-run Memongo held-out 450 with the exact `lme_split_50_450.json` split.
3. Reconcile LoCoMo case counts:
   - Determine whether MemPalace includes abstention/category-5 rows.
   - Either score Memongo on exactly the same 1,986 rows or filter MemPalace to
     the exact same 1,540 non-abstention rows and label it clearly.
4. Run Memongo LoCoMo hybrid top-10 no-rerank.
5. Treat ConvoMem as provisionally strong, but add competitor result hash and
   exact effective category list to the artifact.
6. Run full MemBench 8,500-case lane under monitor before any MemBench claim.

### Phase 3: Add External Harness Adapters

1. Add BEAM adapter for Memongo before comparing to Mem0 or Hindsight.
2. Add MemoryBench/MemScore output for Memongo before comparing to Supermemory.
3. Add Zep LoCoMo/LongMemEval-style answer/context lane only if we can match
   their judge prompt and output schema.
4. Add OpenViking-style task-completion lane only as a separate product metric.

### Phase 4: Publication Gates

Each public comparison row must have:

- competitor repo commit and command
- Memongo commit and command
- dataset SHA
- result artifact SHA
- metric definition
- retrieval unit
- top-k
- LLM use
- embedding model
- reranker
- latency
- storage footprint
- warning/degradation ledger
- MongoDB prefix used and cleanup status

### Phase 5: README And Release

Only after P0 gates pass:

1. Update README with a conservative benchmark table.
2. Put caveats in the table, not buried in prose.
3. Link every row to an artifact pack.
4. Run `bun run check-types`, `bun run build`, focused tests, and secret scan.
5. Commit clean slices.
6. Push branch and open a draft PR.
7. Publish only after the PR includes artifacts or links to immutable artifacts.

## Current Truth

Memongo has promising evidence, but not enough for a world-best claim.

- ConvoMem looks publication-close.
- LoCoMo needs case-count/scorer reconciliation.
- MemBench full run is still missing.
- LongMemEval held-out 450 must be rerun against latest MemPalace split and
  latest Memongo code before it can be in a public table.
- BEAM/MemoryBench/MemScore are required before claiming broader ecosystem
  superiority beyond MemPalace.
