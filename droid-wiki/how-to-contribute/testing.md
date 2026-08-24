# Testing

## Unit tests

Colocated `*.test.ts` files next to the source they cover, run with Vitest and V8 coverage — see [Patterns and conventions](patterns-and-conventions.md) for the file-organization convention this follows. `bun run test` runs `turbo run test`, which fans out to every package's own `test` script.

Typical unit test shape: mock the layer below with `vi.mock` / `vi.hoisted` and assert on the boundary's behavior. `apps/api/src/app.test.ts` mocks the entire `@memongo/memory-bridge` surface (every `memongoBridge*` function) so route-level tests exercise HTTP wiring, validation, and error mapping without a real MongoDB connection. Shared request/response payloads for these tests live in fixture modules such as `apps/api/src/__fixtures__/contract-fixtures.ts`, which enumerates the full set of API route paths and alias cases used across the contract-conformance and app-level tests — reuse an existing fixture module before inventing a new payload literal in a test file.

### Property-based testing with fast-check

`fast-check` is a root devDependency (`package.json`). Most usage is plain example-based Vitest, but `packages/memory-engine/src/mongodb-bitemporal.test.ts` uses it for real property tests: `fc.assert(fc.property(...), { seed, numRuns })` generates hundreds of randomized memory/query-time combinations and checks an invariant holds for all of them (e.g. "no retrieval returns a memory where `invalidAt <= queryTime`"), rather than hand-picking example dates. When adding a test for an invariant that should hold across a range of inputs (not just a handful of examples), consider `fc.property` over enumerating cases by hand, and pin a `seed` so a failing run reproduces deterministically. `packages/memory-engine/src/fast-check-smoke.test.ts` is a minimal smoke test confirming the library imports and runs, not a template for real property tests.

## Contract-conformance tests

A specific pattern worth knowing before touching an API route or MCP tool: `apps/api/src/contract-conformance.test.ts` and `apps/mcp/src/mcp-contract-conformance.test.ts` assert that HTTP routes, the OpenAPI document, and MCP tool schemas all agree with the single source of truth in `packages/lib/src/contract.ts`. These tests exist to catch drift, not to test business logic — see [Patterns and conventions](patterns-and-conventions.md#single-source-of-contract-truth) for why this module exists and what changing a contract field requires.

## End-to-end tests

Files named `*.e2e.test.ts` need a real MongoDB connection — they are excluded from the plain `test` task and run through a separate `test:e2e` / `test:e2e:tier-a` script per package. In `packages/memory-engine/package.json`:

```json
"test:e2e": "vitest run --no-file-parallelism e2e.test.ts",
"test:e2e:tier-a": "vitest run --no-file-parallelism src/mongodb-kb-reingest.e2e.test.ts src/mongodb-kb-isolation.e2e.test.ts ..."
```

`--no-file-parallelism` is deliberate: e2e suites share one MongoDB deployment and mutate real collections, so running files in parallel would race against each other.

### Tiers

| Tier | Runs | Trigger | Needs |
|---|---|---|---|
| Tier A | A fixed list of `*.e2e.test.ts` files covering transactions, indexes, tenant isolation, background jobs (`packages/memory-engine/package.json`'s `test:e2e:tier-a` script) | Every PR, via `.github/workflows/ci.yml`'s `e2e` job | Only a MongoDB service container — no API keys, so it runs safely on forked PRs |
| Full / nightly | The complete `test:e2e` suite, including paths needing Voyage auto-embeddings and LLM enrichment | Nightly cron + manual `workflow_dispatch`, via `.github/workflows/e2e-nightly.yml` | `VOYAGE_API_KEY` and `MEMONGO_ENRICHMENT_MODEL` secrets, injected into the MongoDB container itself (not just the test process) because `mongot` proxies auto-embedding calls |

Relevant env vars, declared in `turbo.json`'s `test:e2e` task so Turborepo passes them through: `MONGODB_TEST_URI`, `MEMONGO_TEST_MONGODB_URI`, `VOYAGE_API_KEY`, `MEMONGO_E2E_TIER`.

## Running tests locally

```bash
bun run test                                          # unit tests, all packages
bun run --filter @memongo/memory-engine test:e2e:tier-a   # tier A e2e, needs local MongoDB only
bun run --filter @memongo/memory-engine test:e2e          # full e2e, needs VOYAGE_API_KEY too
```

Start a local MongoDB per [Getting started](../overview/getting-started.md#start-mongodb) first, then export `MONGODB_TEST_URI` (and `VOYAGE_API_KEY` for the full suite) before running the e2e commands above.

See [Debugging](debugging.md) for diagnosing a failing test or a flaky e2e run.
