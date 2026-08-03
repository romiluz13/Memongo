# How to contribute

Memongo is a focused memory product. The contribution rules exist to keep the supported surface clean: everything in this section traces to `CONTRIBUTING.md` and `docs/agents/`.

## Picking up work

Issues live in GitHub Issues on `romiluz13/memongo`, driven with the `gh` CLI (`docs/agents/issue-tracker.md`):

```bash
gh issue list --state open --label ready-for-agent
gh issue view <number> --comments
```

Work is triaged with five canonical labels (`docs/agents/triage-labels.md`):

| Label | Meaning |
|-------|---------|
| `needs-triage` | Maintainer needs to evaluate |
| `needs-info` | Waiting on reporter |
| `ready-for-agent` | Fully specified; ready for an AFK agent |
| `ready-for-human` | Requires human implementation |
| `wontfix` | Will not be actioned |

## The supported surface

Actively shaped as the product (`CONTRIBUTING.md`):

- `apps/api`, `apps/mcp`, `apps/web`, `apps/docs`
- `packages/memory-engine`, `packages/memory-bridge`, `packages/memongo-memory`, `packages/client`, `packages/tools`

`packages/lib` is internal runtime support — published only because public packages depend on it. Historical/experimental material should not expand into product scope without an ownership decision.

## PR process

1. Fork and clone; branch from `main` (`git checkout -b my-fix`).
2. Follow the [local workflow](development-workflow.md) — all gates must pass *before* opening the PR.
3. Commit with a short, action-oriented message (e.g. `engine: fix graph edge dedup`).
4. Open the PR against `romiluz13/memongo:main` and fill in the PR template.
5. **One logical change per PR** — it keeps review fast.

## Review expectations

- A maintainer reviews; address feedback with **new commits, not force-pushes** (`CONTRIBUTING.md`).
- PRs that break tests or type-checking will not be merged — the CI quality job (typecheck → lint → build → publishability → test) and the e2e tier-A gate must both pass (`.github/workflows/ci.yml`).
- Documentation changes follow the docs split: public story in `README.md`, `apps/docs`, `docs/platform`; research under `docs/research`; never teach deprecated aliases as the primary API shape.

## In this section

- [Development workflow](development-workflow.md) — branch → code → test → PR → merge, Turborepo tasks
- [Testing](testing.md) — Vitest setup, e2e tiers, test helpers, mock patterns
- [Debugging](debugging.md) — logs, health/readiness, probes, common errors
- [Tooling](tooling.md) — Turborepo, Biome, type checking, CI, benchmarks
- [Patterns and conventions](patterns-and-conventions.md) — coding style and quality gates
