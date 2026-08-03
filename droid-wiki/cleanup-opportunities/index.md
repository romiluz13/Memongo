# Cleanup opportunities

Known maintenance opportunities, each verified against the current tree. These are observations, not assigned work — pick them up through the normal [contribution flow](../how-to-contribute/index.md).

## The god module: `mongodb-manager.ts`

`packages/memory-engine/src/mongodb-manager.ts` is **12,449 LOC** — roughly 25× the repo's own ~500 LOC guideline (`AGENTS.md`: "Keep files under ~500 LOC"). The manager owns connection lifecycle, search orchestration, writes, jobs, and shutdown in one class, which makes it the bottleneck for review, merge conflicts, and safe refactoring.

Natural seams (already separate concepts elsewhere in the engine): connection/capability detection, search fan-out, write paths, job scheduling, and shutdown orchestration could each become a focused module the manager composes.

## Dead code: the `batch-*` cluster

Fifteen `batch-*.ts` files in `packages/memory-engine/src/` (~790 LOC of source plus ~550 LOC of tests) form a self-contained cluster with **no inbound references**:

| File | LOC |
|------|-----|
| `batch-voyage.ts` | 354 |
| `batch-status.ts` | 80 |
| `batch-runner.ts` | 69 |
| `batch-output.ts` | 60 |
| `batch-http.ts` | 58 |
| `batch-upload.ts` | 53 |
| `batch-utils.ts` | 41 |
| `batch-error-utils.ts` | 39 |
| `batch-embedding-common.ts` | 25 |
| `batch-provider-common.ts` | 12 |

A grep for imports of these modules from any non-`batch-*` source file returns nothing, and none are re-exported from `packages/memory-engine/src/index.ts`. They still compile into the published `dist` (the package ships `files: ["dist"]`), so deleting them shrinks the npm artifact too. Before removal, confirm no external consumer deep-imports the paths.

## Benchmark/eval code in the published package

`@memongo/memory-engine` publishes `files: ["dist", "README.md"]` (`packages/memory-engine/package.json`), and `dist` contains the full compiled benchmark harness:

- `mongodb-benchmark-runner.js`, `mongodb-benchmark-harness.js`, `mongodb-benchmark-dataset.js`
- `benchmark-failure-taxonomy.js`, `benchmark-parity-envelope.js`, `benchmark-quality-contracts.js`
- Eval suites: `fact-extraction-eval.js`, `mongodb-e2e-qa.js` (both also have unit *and* e2e test twins in `src`)

Two of these are re-exported from the package entry (`packages/memory-engine/src/index.ts:225-231`), so they are part of the public surface whether intended or not. Options: move benchmark/eval code to the top-level `benchmarks/` directory (which already holds datasets), or split it into a private package so the published engine artifact only ships runtime code.

## Test-to-source ratio

- Source (excluding tests): **78,840 LOC**
- Tests (`*.test.ts` incl. e2e): **82,459 LOC**

A ~1.05:1 test-to-source ratio is unusually test-heavy. Some of that is deliberate (the e2e tier-A gate is the release contract), but there is visible duplication to prune — e.g. the triplicate `mongodb-e2e-qa.ts` / `.test.ts` / `.e2e.test.ts` files in `packages/memory-engine/src/`, and large fixture blocks that could move under `test-helpers/`.

## Related pages

- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md) — the 500 LOC guideline these violate
- [Background](../background/index.md) — the design ideals the cleanup should preserve
