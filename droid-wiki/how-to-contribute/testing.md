# Testing

Vitest + V8 coverage, tests colocated with source as `*.test.ts`. The suite is deliberately large — test LOC (~82k) exceeds source LOC (~79k) — because the e2e tier is the release contract.

## Layout and commands

| Kind | Naming | Runs against | Command |
|------|--------|--------------|---------|
| Unit | `*.test.ts` | mocks / in-process | `bun run test` |
| E2E | `*.e2e.test.ts` | real MongoDB | `bun run test:e2e` |
| E2E tier A | curated subset | real MongoDB | `bun run test:e2e:tier-a` (in `packages/memory-engine`) |

The engine's unit script explicitly excludes e2e files (`vitest run --exclude=src/**/*.e2e.test.ts`), and e2e runs with `--no-file-parallelism` because all suites share one MongoDB deployment (`packages/memory-engine/package.json:35-37`). CI runs tier A on every PR; `e2e-nightly.yml` runs the broader set.

## E2E environment

- Target database: `MONGODB_TEST_URI` or `MEMONGO_TEST_MONGODB_URI`, defaulting to the local atlas-local container.
- **Timeout scaling:** `packages/memory-engine/vitest.config.ts` detects a remote Atlas cluster by the `mongodb+srv://` scheme and scales hook/test budgets up (900s/600s remote vs 240s/120s local). This exists because a blown *hook* budget makes Vitest **skip** the file's tests — a remote run once reported 190 skipped tests that read as "green with gaps." The budgets are give-up limits, not expected runtimes.
- Tier A currently covers: KB reingest, KB isolation, legacy-search isolation, vector index shape, rankFusion scoring, projection repair, temporal validity, and memory jobs (`packages/memory-engine/package.json:37`).

## Test helpers

`packages/memory-engine/src/test-helpers/`:

| Helper | Purpose |
|--------|---------|
| `fetch-mock.ts` | `FetchMock` type + `withFetchPreconnect` wrapper for mocking provider HTTP |
| `ssrf.ts` | `mockPublicPinnedHostname` — deterministic DNS answers for SSRF-guard tests |
| `model-auth-mock.ts` | `createModelAuthMockModule` — fake provider auth for `vi.mock("@memongo/lib")` |
| `preview-env.ts` | Atlas-local preview environment helpers |
| `memory-eval-fixtures.ts` | Eval fixtures |

## Mock patterns

The canonical unit-test mock, from `packages/memory-engine/src/embeddings-voyage.test.ts`:

```ts
// The SSRF guard resolves hostnames for real; unit tests must not depend on
// DNS, so pin a deterministic public address instead.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}))

vi.mock("@memongo/lib", async (importOriginal) => {
	const original = await importOriginal<typeof import("@memongo/lib")>()
	const { createModelAuthMockModule } = await import(
		"./test-helpers/model-auth-mock.js"
	)
	return { ...original, ...createModelAuthMockModule() }
})
```

Principles this encodes:

- **Mock at system boundaries** (DNS, `fetch`, auth), never the module under test.
- **`importOriginal` + spread** so partial mocks keep real behavior elsewhere.
- **Deterministic network answers** — a public IP, so the SSRF guard's private-IP check still runs for real.

## API tests

`apps/api/src/app.test.ts` (~4,752 LOC) builds the Hono app in-process and exercises routes, auth, rate limiting, and the error envelope without a server; `apps/api/src/contract-conformance.test.ts` keeps routes conformant with `MEMONGO_API_ROUTES` (`packages/lib/src/contract.ts:144`). Shutdown logic takes injected `process`/`exit` dependencies so tests drive it without exiting (`apps/api/src/app.ts:432`).

## Writing a new test

1. Colocate: `foo.ts` → `foo.test.ts`.
2. Unit-test pure logic with mocked boundaries; anything needing indexes, change streams, or `$vectorSearch` is an e2e test (`*.e2e.test.ts`) and must tolerate the shared deployment.
3. Never hardcode a hook/test timeout — set it once in the vitest config pattern, or your file re-breaks the tier-A gate.
4. American English, tabs, double quotes (Biome will enforce).

## Related pages

- [Development workflow](development-workflow.md)
- [Debugging](debugging.md) — probes and health endpoints for live verification
- [Tooling](tooling.md) — CI gates these tests feed
