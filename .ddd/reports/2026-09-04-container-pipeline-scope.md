# Container pipeline scope — 2026-09-04

**Change:** Dockerfile, .dockerignore, .github/workflows/container-publish.yml
(API service image + GHCR publish pipeline).

**Routing:** ddd-scope (new external dependencies and services). The `ddd` CLI
is unavailable in this environment (`command not found`); this scope was
recorded manually against the book's artifact formats. No `scope-change`
envelope was generated; nothing below should be read as a machine verdict.

## Boundary statement

The change consists of Dockerfile, Docker ignore, and workflow YAML classes.
These are outside the experimental TypeScript/OpenAPI/JSON-Schema boundary, so
change-envelope confidence for this change is **lowered by construction**; no
CONFORMANT or SATISFIED verdict is claimed or derivable for it. The assurance
claim for this change is operational, not code-derived: gates and validation
listed below.

## Stack additions (recorded in stack.yaml)

- `node-container-base` 22-bookworm-slim (runtime stage)
- `bun-container-base` oven/bun:1.3.13 (install stage)
- `ghcr-container-registry` ghcr.io/romiluz13/memongo (publish target)
- `docker-buildkit` buildx v3 / build-push-action v6 (CI platform)

## Visible gaps (not completion)

1. **Base-image digests unpinned.** Both stages reference floating tags. Until
   digests are pinned (or a lockfile-style image pin is introduced), image
   provenance rests on registry tag integrity. Deferred: pin after first
   successful publish.
2. **Registry and base-image documentation not locked.** No evidence.lock
   entries exist for Docker Hub or GHCR behavior; stack entries carry empty
   evidence_refs. Blocking evidence lock requires the `ddd` CLI or manual
   capture; recorded as a gap rather than inferred.
3. **No assurance case.** This change has no ENV/CASE artifact. If the
   container pipeline becomes release-gating for a served contract, build an
   assurance case for it.

## Operational gates (what actually protects this change)

1. Local build validation: `docker build` must succeed and the container must
   boot and answer `GET /health` (recorded in this report when run).
2. Publish gating: the workflow refuses to push an image unless typecheck,
   the full test suite, and the skip-green guard all pass — the same gate
   discipline as npm publishing.
3. Runtime fail-fast: `validateBootEnv()` exits before port bind on missing
   MongoDB config, so a misconfigured image cannot boot "healthy".

## Validation record

Local validation, 2026-09-04 (Docker 29.7.2, build completed in 170.9s):

- `docker build` succeeded after two fixes: COPY sources must preserve
  workspace directory layout (a flattened copy breaks workspace resolution),
  and the API's workspace closure must be compiled (`turbo run build
  --filter '@memongo/api...'`) before the production prune, since workspace
  packages resolve through their `dist/` builds and the compiler is a
  devDependency.
- Prune requires wiping `node_modules` first: a filtered `bun install
  --production` over an existing full tree does not reconcile extraneous
  packages. Image went from 2.56GB to 565MB (node_modules 1.7GB/903 packages
  → 136MB/130 packages).
- Boot smoke (placeholder env, unreachable MongoDB at 192.0.2.1:27017):
  `GET /health` → 200 `{"ok":true,"service":"memongo-api"}`; `GET /ready`
  → 503 with per-lane degradation detail (mongo/vector/embedding all
  reported unavailable); container reports `healthy` via the image
  HEALTHCHECK; with `MEMONGO_API_HOST=0.0.0.0` the port is reachable from
  outside the container.
- Fail-fast note: `validateBootEnv()` exits before port bind when required
  env is missing (verified in source review, not re-run in this session).
