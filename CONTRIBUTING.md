# Contributing to Memongo

Memongo is a focused memory product. The fastest way to keep it clean is to preserve the supported surface and quarantine everything else.

## How to contribute (external contributors)

1. Fork the repo on GitHub and clone your fork.
2. Create a branch from `main`: `git checkout -b my-fix`.
3. Follow the [local workflow](#local-workflow) to make and verify your change.
4. Commit with a short, action-oriented message (e.g. `engine: fix graph edge dedup`).
5. Push your branch and open a pull request against `romiluz13/memongo:main`.
6. Fill in the PR template. One logical change per PR keeps review fast.
7. A maintainer will review; address feedback with new commits, not force-pushes.

**Before opening a PR:** run the full local workflow below and confirm all steps pass. PRs that break tests or type-checking will not be merged.

## Supported surface

These are the packages and apps we actively shape as the product:

- `apps/api`
- `apps/mcp`
- `apps/web`
- `apps/docs`
- `packages/memory-engine`
- `packages/memory-bridge`
- `packages/memongo-memory`
- `packages/client`
- `packages/tools`

`packages/lib` is an internal runtime support package. It is published only because the public packages depend on it.

Historical, experimental, or comparison material should not be expanded into first-class product scope unless there is a clear ownership decision first.

## Local workflow

```bash
bun install
bun run lint
bun run check-types
bun run build
bun run test
bun run check-publishability
```

For API and live-memory verification, use the release docs:

- `docs/platform/PRODUCTION-READY.md`
- `docs/platform/validation-pack.md`
- `docs/platform/publish.md`

## Documentation rules

- Keep the public product story in `README.md`, `apps/docs`, and `docs/platform`.
- Put migration and historical material under `docs/migration`.
- Put research or brainstorm material under `docs/research`, `docs/experiments`, or `docs/plans`.
- Do not teach deprecated aliases as the primary API shape.

## Release rules

- Do not claim production readiness unless every release-blocking lane is green.
- Do not publish from a dirty working tree.
- Do not add public package dependencies on private workspace-only packages.
- Prefer deleting dead surfaces over carrying them as implied product commitments.

## Maintainer map

For the current repo map, package status, and release lanes, start here:

- `docs/platform/MAINTAINER-MAP.md`
- `docs/platform/PACKAGE-STATUS.md`
