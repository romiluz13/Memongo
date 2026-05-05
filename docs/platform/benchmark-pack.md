# Memongo benchmark pack

This document defines **honest** benchmarking: what to measure, how to run it, and how to avoid fake leaderboard scores.

For the release-gate rules, report envelope, publishable-claim criteria, and
query-governance policy, see
[benchmark-operating-contract.md](../benchmarks/benchmark-operating-contract.md).

## What to compare

| Dimension | What “good” means | Memongo lever |
|-----------|-------------------|---------------|
| **Retrieval quality** | Correct items in top-k for realistic agent queries | Hybrid vector + lexical fusion, reranking, relevance telemetry |
| **Write latency** | Stable p95 for `add` / `write-event` under concurrency | MongoDB indexing, batching, engine write paths |
| **Search latency** | Stable p95 for `search` with your index size | Query planner, cache, index health |
| **Operational cost** | Self-hosted MongoDB + API footprint vs hosted SaaS | Your cluster sizing, not ours |
| **Data ownership** | No mandatory third-party memory store | MongoDB-native design |

## Required baseline: validation + proof

Before benchmarking, run:

```bash
bun run check-types && bun run test && bun run build
```

With API + Mongo:

```bash
bun run proof-pack
```

## Retrieval benchmark (engine)

For deep relevance and admin APIs, use the engine’s **relevance benchmark** endpoints and tests (see [capability-matrix.md](capability-matrix.md) “Relevance benchmark” row):

- `POST /v1/admin/relevance/benchmark` (when exposed by your build)
- `packages/memory-engine` E2E: `production-readiness.e2e.test.ts`

Record: dataset description, MongoDB version, index definitions, embedding model, and **query set** (do not use toy one-word queries for serious claims).

## Load smoke (HTTP)

Use concurrent `search` and `add` traffic against **`apps/api`** with realistic payload sizes. Treat this as **regression detection**, not a substitute for retrieval correctness proofs.

Suggested env knobs (if you add a small script locally): concurrency, duration, mix of read/write.

## Anti-patterns

- **Cherry-picked queries** that only hit lexical or only vector paths.
- **Single-digit document corpora** that do not stress the planner.
- **Comparing to hosted products** without matching embedding models and privacy constraints.

## Artifacts to save per release

1. Git SHA and `bun --version`.
2. MongoDB topology (preview image vs replica set + mongot, etc.).
3. Embedding provider and model id.
4. Output of `bun run proof-pack` (PASS/FAIL summary JSON).
5. Optional: relevance benchmark summary from engine E2E.
