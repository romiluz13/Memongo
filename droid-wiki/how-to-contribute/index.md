# How to contribute

Memongo is maintained by one person (`romiluz13`). There is no review queue with multiple maintainers rotating through it, no on-call, and no SLA on issue responses — read `CONTRIBUTING.md`'s "Maintainer map" pointers (`docs/platform/MAINTAINER-MAP.md`, `docs/platform/PACKAGE-STATUS.md`) for the current state of things before assuming a feature has a dedicated owner. External pull requests are still explicitly welcome per `CONTRIBUTING.md` — the solo-maintainer fact just means turnaround time depends on one person's availability, and PRs that don't follow the checklist below take longer to land because they need back-and-forth instead of a quick merge.

## Picking up work

There is no formal "good first issue" triage process. If you want to contribute:

1. Check open issues in `romiluz13/memongo` on GitHub for something matching your interest.
2. For anything nontrivial, open an issue first describing the change before writing code — this avoids wasted work if the maintainer has a different direction in mind for that area.
3. Stay inside the [supported surface](#supported-surface) below unless you've discussed expanding it.

## The PR process

From `CONTRIBUTING.md`:

1. Fork the repo and clone your fork.
2. Branch from `main`: `git checkout -b my-fix`.
3. Make your change and run the full local workflow (see [Development workflow](development-workflow.md)) before opening a PR.
4. Commit with a short, action-oriented message scoped to a package or area, e.g. `engine: fix graph edge dedup` (see [Patterns and conventions](patterns-and-conventions.md#commit-style) for the full commit convention).
5. Push and open a PR against `romiluz13/memongo:main`.
6. Fill in the PR template. **One logical change per PR** — bundling an unrelated refactor with a fix slows review down and makes it harder to revert independently.
7. A maintainer reviews and either merges or asks for changes. Address feedback with **new commits, not force-pushes** — this keeps the review thread's diff history intact so earlier comments still point at the right lines.

## Review expectations

Because there is a single reviewer, expect review turnaround to vary. A PR that fails CI (see [Development workflow](development-workflow.md)) will not be looked at until it's green — fix build, lint, or test failures before requesting review, not after.

## Definition of done

`CONTRIBUTING.md` states plainly: **PRs that break tests or type-checking will not be merged.** Before opening a PR, run:

```bash
bun install
bun run lint
bun run check-types
bun run build
bun run test
bun run check-publishability
```

All five must pass locally — this is the same sequence CI runs (see [Development workflow](development-workflow.md)). `bun run check-publishability` (`scripts/check-publishability.ts`) is not optional busywork: it validates package metadata, reproducible builds, tarball contents, and version consistency across every publishable package, and a change that breaks packaging invisibly to `bun run build` will still fail here.

Changes touching the live API or memory behavior should additionally be checked against the release docs referenced from `CONTRIBUTING.md`:

- `docs/platform/PRODUCTION-READY.md`
- `docs/platform/validation-pack.md`
- `docs/platform/publish.md`

## Supported surface

`CONTRIBUTING.md` draws a hard line around what counts as the product. These are actively shaped and reviewed as first-class:

| Path | Role |
|---|---|
| `apps/api` | HTTP API server |
| `apps/mcp` | MCP server |
| `apps/web` | Web console |
| `apps/docs` | Public documentation site |
| `packages/memory-engine` | Core MongoDB memory engine |
| `packages/memory-bridge` | Stable facade over the engine |
| `packages/memongo-memory` | Published re-export package (`@memongo/memory`) |
| `packages/client` | HTTP client SDK |
| `packages/tools` | AI SDK tool helpers |

`packages/lib` is different: it is **internal-only but still published**, because the packages above depend on it at runtime. Treat it as implementation detail, not a public API to design around — see `scripts/check-publishability.ts`'s `supportedSurface: false` marker on it.

Anything outside this list — historical, experimental, or comparison material under `docs/migration`, `docs/research`, `docs/experiments`, or `docs/plans` — is explicitly out of scope for "product" changes. Per `CONTRIBUTING.md`, this material should not be expanded into first-class product scope without a prior ownership decision, and prefer deleting dead surfaces over carrying them as implied commitments.

## Related pages

- [Development workflow](development-workflow.md) — the branch/build/test/CI cycle in detail.
- [Testing](testing.md) — unit, e2e, and contract-conformance conventions.
- [Tooling](tooling.md) — the build system and `scripts/` directory.
- [Patterns and conventions](patterns-and-conventions.md) — error handling, retries, logging, and commit style.
- [Debugging](debugging.md) — diagnosing failures locally.
