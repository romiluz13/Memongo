# Development workflow

The branch → code → test → PR → merge cycle, with the Turborepo task graph underneath.

## Setup

```bash
git clone https://github.com/romiluz13/memongo.git
cd memongo
bun install          # Bun 1.2+, Node 20+
```

Start the local database before doing anything engine-facing:

```bash
docker compose -f docker/docker-compose.yml up -d   # or ./docker/mongodb/start-preview.sh
export MEMONGO_MONGODB_URI="mongodb://localhost:27017/?directConnection=true"
```

## The local gate sequence

`CONTRIBUTING.md` defines the pre-PR workflow — run it in this order and confirm every step passes:

```bash
bun run lint                  # Biome, errors only
bun run check-types           # TypeScript strict, whole monorepo
bun run build                 # Turborepo build
bun run test                  # Vitest unit tests
bun run check-publishability  # npm publish readiness
```

For API and live-memory verification, the release docs add `docs/platform/PRODUCTION-READY.md`, `docs/platform/validation-pack.md`, and `docs/platform/publish.md`.

## Turborepo task graph

Tasks are declared in `turbo.json` and orchestrated with the TUI (`"ui": "tui"`):

| Task | Depends on | Notes |
|------|-----------|-------|
| `build` | `^build` | Outputs `dist/**`, `.next/**` |
| `test` | `^build` | Unit tests per package |
| `test:e2e` | `^build` | Never cached; env: `MONGODB_TEST_URI`, `MEMONGO_TEST_MONGODB_URI`, `VOYAGE_API_KEY`, `MEMONGO_E2E_TIER` |
| `lint` | `^lint` | |
| `check-types` | `^build`, `^check-types` | |
| `dev` | — | Persistent, uncached |

`^build` means dependencies build first — e.g. `apps/api` builds only after `@memongo/memory-bridge`, `@memongo/memory-engine`, and `@memongo/lib`. Root scripts (`package.json:17-18`) are thin: `"test": "turbo run test"`, `"test:e2e": "turbo run test:e2e"`.

To work on one package, filter: `bun run turbo build --filter=@memongo/memory-engine...` (the same pattern the Dockerfile uses).

## Branch and commit cycle

1. Branch from `main`: `git checkout -b engine-fix-graph-dedup`.
2. Make the change with tests colocated (`*.test.ts` next to source).
3. Run the gate sequence above.
4. Commit with a concise, action-oriented message, prefixed by area: `engine: …`, `api: …`, `mcp: …`, `client: …`, `docker: …` (see `git log` for the pattern, e.g. `fix: land fix-plan phases P0-P2 across engine, api, mcp, client, docker`).
5. Group related changes; never bundle unrelated refactors into one PR.
6. Push, open the PR, iterate with **new commits** (no force-pushes during review).

## Merging

Merge happens after maintainer review with green CI (quality job + e2e tier A, `.github/workflows/ci.yml`). Releases are separate: `publish.yml` handles npm publishing, gated by `bun run check-publishability` and the rules in `docs/platform/publish.md`.

## Related pages

- [Testing](testing.md)
- [Tooling](tooling.md)
- [Patterns and conventions](patterns-and-conventions.md)
- [Debugging](debugging.md)
