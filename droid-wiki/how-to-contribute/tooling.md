# Tooling

The build, lint, type-check, CI, and benchmark toolchain.

## Build system: Turborepo + Bun

- **Bun 1.2+** is the package manager; `bun.lock` pins everything and CI installs with `--frozen-lockfile`.
- **Turborepo** (`turbo.json`) orchestrates tasks across the workspace with the TUI enabled (`"ui": "tui"`). Task graph: `build` (→ `^build`, outputs `dist/**` / `.next/**`), `test` (→ `^build`), `test:e2e` (→ `^build`, never cached), `lint`, `check-types` (→ `^build`, `^check-types`), `dev` (persistent).
- Build outputs are plain JS from `tsc` for packages and the API/MCP apps (`tsconfig.build.json`); the web app builds through Next.js.
- **Docker builds reuse the same graph:** `apps/api/Dockerfile` runs `turbo prune --docker @memongo/api` to extract the minimal pruned workspace, then `turbo build --filter=@memongo/api...` inside the image.

## Lint and format: Biome

- Config: `biome.json` at the repo root. Style: **tabs, double quotes**, semicolons as needed.
- `bun run lint` runs Biome with `--diagnostic-level=error`, so warnings are suppressed in CI — only errors gate.
- `bun run lint:fix` / `bun run format` auto-fix.
- Keep files under ~500 LOC and use `.js` extensions on relative imports (NodeNext resolution); see [Patterns and conventions](patterns-and-conventions.md).

## Type checking

- `bun run check-types` — TypeScript 5.8 strict across the monorepo (per-package `tsc --noEmit`; the web app runs `next typegen` first).
- Strict typing, no `any`. Shared config in `tsconfig.base.json` at the repo root.

## CI: GitHub Actions

Three workflows in `.github/workflows/`:

| Workflow | Trigger | Jobs |
|----------|---------|------|
| `ci.yml` | PR + push to `main` | **quality**: typecheck → lint → build → check-publishability → test. **e2e**: tier-A e2e against a `mongodb/mongodb-atlas-local` service container (same pinned image as local Docker) |
| `e2e-nightly.yml` | schedule | Broader e2e set |
| `publish.yml` | release | npm publish of the public packages |

The e2e service container runs with the image's own healthcheck, so tests start only when mongod **and** mongot are up — matching local Docker behavior.

## Publish readiness

`bun run check-publishability` validates all eight coordinated packages (`@memongo/lib`, `memory-engine`, `memory-bridge`, `memory`, `client`, `tools`, `pi-extension`, and `mcp`) before `publish.yml` ships them. Release rules live in `docs/platform/publish.md`.

## Benchmark scripts

- `benchmarks/` holds benchmark data (`benchmarks/data`); the harness and release contracts live under `scripts/benchmark/` so benchmark-only implementation is not shipped in `@memongo/memory-engine`.
- Knobs are env-driven: `MEMONGO_BENCHMARK_*` (dataset root/SHA, measurement passes, fast-ingest batch size, settle timeouts, strict gate, retrieval lane selection) — full list in [Configuration](../reference/configuration.md).
- Release-gate contracts (`benchmark-quality-contracts.ts`, `benchmark-parity-envelope.ts`) turn benchmark results into pass/fail gates.
- Release evidence is saved under `benchmarks/results/` with its configuration and dataset identity.

## Docs tooling

`apps/docs` has no Mintlify build in CI; its `build` script runs `scripts/check-docs-integrity.mjs` (fails the monorepo build on broken docs) and `validate:mintlify` runs `scripts/validate-mintlify-build.mjs` (`apps/docs/package.json`).

## Related pages

- [Development workflow](development-workflow.md) — the daily loop on top of these tools
- [Testing](testing.md)
- [Dependencies](../reference/dependencies.md) — versions of everything above
