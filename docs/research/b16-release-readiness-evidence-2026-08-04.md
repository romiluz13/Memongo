# B16 Release-Readiness Evidence

**Run date:** 2026-08-04

**Target:** MongoDB Atlas 8.3.8 with Atlas Search and automated embeddings

**Scope:** Builder-queue Batch 4 validation

## Live correctness suites

The restored, cohesive E2E suites ran against Atlas:

| Gate | Result |
| --- | --- |
| Evaluation E2E | 33/33 tests passed, 99.3/100 overall score |
| Production readiness | 96/96 tests passed |
| Real E2E v2 | Passed |
| MongoDB E2E | Passed |

The production-readiness run covered search score bounds, KB routing and
tenant filtering, cache behavior, reranking, telemetry, lifecycle history,
canonical import/recall, agentic search, and a 200-event scale stress path.

## Capability stress

Artifact:
`benchmarks/results/b16-2026-08-04/real-capability-stress/2026-08-04T14-26-28-792Z.json`

- Overall result: `ok: true`.
- Conversation, structured, procedural, graph, episodic, and KB retrieval
  lanes returned direct, high-confidence evidence.
- Health, OpenAPI, sync, writes, profile, status, telemetry, query cache,
  graph, episodes, KB lifecycle, and lane-coverage checks passed.
- Query-cache probe reported a 0.33 hit rate.
- The real-agent check was skipped because no `MEMONGO_LLM_*` provider was
  configured.

The Atlas vector index advertises `storedSource`, but the operational
`returnStoredSource` probe rejects it. Runtime capability detection therefore
disables stored-source reads rather than claiming unsupported behavior.

## Shipped-profile benchmark

Primary sample artifact:
`benchmarks/results/b16-2026-08-04/benchmark-sample-5-attempt8.log`

- Cases: 5/5 scored.
- Hit rate: 1.0000.
- Empty rate: 0.0000.
- Recall@5: 1.0000.
- nDCG@10: 0.9262.
- Conversation-recall regression gate: 6/6 tests passed.

This sample is explicitly non-publishable and does not replace the full
500-case release-contract run.

Attempt 8 exposed completion-validation warnings in the durable extraction
queue. Atlas rejected negative `durationMs` values when the server-stamped
claim time was slightly ahead of the worker clock. The worker now clamps
elapsed duration at zero on both completion and failure paths.

Clean verification artifact:
`benchmarks/results/b16-2026-08-04/benchmark-sample-1-attempt9.log`

- One shipped-profile scenario ingested 53 conversations and 550 turns.
- All 550 extraction jobs reached `completed`.
- Persisted duration range: 0–1111 ms.
- Completion-validation warnings: 0.
- Hit rate, Recall@5, and nDCG@10: 1.0000.
- Retained r9 scenario data was removed after verification; zero matching
  documents remained.

## Repository gates

After the implementation changes:

- Unit and integration tests: passed across all packages.
- Type-check: passed.
- Lint: passed.
- Build: passed.

## Publication boundary

This evidence closes the implemented Atlas correctness and shipped-profile
smoke gates. Publication still requires explicit user authorization. A full
500-case benchmark, the 10k-turn throughput run, stored-source parity on a
deployment where `returnStoredSource` is operational, fresh-machine compose
proof, and an LLM-backed real-agent run are not established by these artifacts.
