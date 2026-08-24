# Development workflow

## The cycle

1. **Branch** from `main`: `git checkout -b my-fix`.
2. **Code** the change, staying inside one package or app where possible (see [How to contribute](index.md#supported-surface) for the boundary) and following [Patterns and conventions](patterns-and-conventions.md).
3. **Test locally** — run the workflow below before pushing. Don't rely on CI to catch a broken build; the feedback loop is slower and ties up the shared e2e MongoDB service container.
4. **Commit** with a short, action-oriented, scoped message (see [Patterns and conventions](patterns-and-conventions.md#commit-style)).
5. **Open a PR** against `main`. See [How to contribute](index.md#the-pr-process) for the full checklist.
6. **Address review** with new commits; a maintainer merges once the checklist is green and the change is scoped correctly.

## Local workflow

From `CONTRIBUTING.md` (also documented with setup steps in [Getting started](../overview/getting-started.md)):

```bash
bun install
bun run lint
bun run check-types
bun run build
bun run test
bun run check-publishability
```

Every one of these is a Turborepo task (`turbo run <task>`, defined in `turbo.json`) except `check-publishability`, which is a standalone script (`scripts/check-publishability.ts`, see [Tooling](tooling.md)).

## How Turborepo orders work across the monorepo

`turbo.json` declares four cacheable tasks with dependency edges:

```json
{
	"build":       { "dependsOn": ["^build"] },
	"test":        { "dependsOn": ["^build"] },
	"check-types": { "dependsOn": ["^build", "^check-types"] },
	"lint":        { "dependsOn": ["^lint"] }
}
```

The `^` prefix means "this task's dependencies in other workspace packages, not this package's own task." In practice:

- Running `bun run build` at the root builds every package's *dependencies* before the package itself. If `packages/memory-bridge` depends on `packages/memory-engine`, Turborepo builds `memory-engine` first, then `memory-bridge`, in whatever order the dependency graph requires — you never have to sequence this by hand.
- `test` depends on `^build`, not `^test` — a package's tests run against its dependencies' **built** output, not against their test results. This is why `bun run test` alone (without `bun run build` first) still works: Turborepo builds the dependency chain implicitly before running tests.
- `check-types` depends on both `^build` and `^check-types` in upstream packages, since type declarations often come from a package's build output (`.d.ts` files in `dist/`), not just its source.
- `lint` only depends on `^lint`, not `^build` — Biome lints source text and doesn't need built artifacts from other packages.

`dev` is marked `"cache": false, "persistent": true` — it's a long-running process (e.g. `apps/api`'s dev server), not a batch task, so Turborepo never tries to cache or short-circuit it.

Turborepo caches task outputs (see each task's `outputs` array in `turbo.json`, e.g. `dist/**` for `build`) keyed by a hash of inputs. A second `bun run build` with no source changes replays cached output instead of rebuilding — this is why CI and local iteration both stay fast even though the monorepo has 15+ workspace packages.

## What CI gates a PR

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, as two jobs:

| Job | What it runs | Needs |
|---|---|---|
| `quality` | `bun run check-types`, `bun run lint`, `bun run build`, `bun run check-publishability`, `bun run test` | Nothing beyond `bun install --frozen-lockfile` |
| `e2e` (tier A) | `bun run --filter @memongo/memory-engine test:e2e:tier-a` | A `mongodb/mongodb-atlas-local:preview` service container, no API keys |

Tier A e2e covers the paths that only need a live MongoDB — transactions, indexes, tenant isolation, background jobs — so it can gate every PR without needing secrets in a fork's CI run. Tiers needing a Voyage/LLM key run in `.github/workflows/e2e-nightly.yml` on a schedule, not per-PR — see [Testing](testing.md) for the tier breakdown and [Deployment](../deployment.md) for the full CI/CD and release-publishing picture (the `publish.yml` workflow, versioning, and npm publication are out of scope for a day-to-day contribution and covered there instead).

A PR only needs the `quality` and `e2e` (tier A) jobs green to be mergeable — matching exactly the local workflow above plus tier A e2e, so there should be no surprises between "passes locally" and "passes in CI."
