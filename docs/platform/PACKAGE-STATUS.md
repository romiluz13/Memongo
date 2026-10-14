# Package Status

Use this table to decide whether something belongs in the public product story.

## Supported public

| Surface | Status | Notes |
|---|---|---|
| `apps/api` | supported | Canonical HTTP API |
| `apps/mcp` | supported | stdio adapter over the API |
| `apps/web` | supported | Operator console |
| `apps/docs` | supported | Product docs sources |
| `packages/memory-engine` | supported | Core MongoDB memory runtime |
| `packages/memory-bridge` | supported | Stable facade |
| `packages/memongo-memory` | supported | Convenience barrel |
| `packages/client` | supported | TypeScript SDK |
| `packages/tools` | supported | AI SDK helpers |

## Runtime support

| Surface | Status | Notes |
|---|---|---|
| `packages/lib` | supported | Runtime utilities used by publishable packages |
| `docker/mongodb` | supported | Local MongoDB and Atlas Local Preview validation stacks |
| `scripts/proof-pack.ts` | supported | API contract and operator proof lane |
| `scripts/check-publishability.ts` | supported | npm/tarball/install validation |
| `scripts/check-mongodb-runtime-parity.ts` | supported | MongoDB runtime compatibility check |

### MongoDB target for prepare, preflight and parity

`mongodb:prepare`, `mongodb:cluster-preflight` and the active arm of
`mongodb:parity` resolve the same target as the benchmark runner and the
application: URI `MEMONGO_FORCE_MONGODB_URI` > `MEMONGO_MONGODB_URI` >
`memory.mongodb.uri`; database `MEMONGO_MONGODB_DATABASE` >
`memory.mongodb.database` > `memongo`; prefix
`MEMONGO_MONGODB_COLLECTION_PREFIX` > `memory.mongodb.collectionPrefix` >
`memongo_`. A missing URI or a malformed config file fails all three before
connecting.

- Preflight refuses a `--prefix` that differs from the configured prefix and a
  legacy `MEMONGO_DB_NAME` that differs from the configured database. Set
  `MEMONGO_MONGODB_COLLECTION_PREFIX` / `MEMONGO_MONGODB_DATABASE` instead; the
  prefix must still start with `memongo_bench_`.
- Parity's active arm (no `MEMONGO_CLOUD_MONGODB_URI` or
  `MEMONGO_LOCAL_MONGODB_URI`) now inspects the configured prefix (default
  `memongo_`, previously `memongo_default_`) and database. It refuses a
  `MEMONGO_PARITY_DATABASE` or `MEMONGO_PARITY_COLLECTION_PREFIX` that differs
  from them.
- Parity's explicit cloud/local arms compare deployments, not the run target:
  they keep `MEMONGO_PARITY_DATABASE` (default `memongo`) and
  `MEMONGO_PARITY_COLLECTION_PREFIX` (default `memongo_default_`), and
  `MEMONGO_FORCE_MONGODB_URI` does not apply to them.

## Not shipped

Historical research, raw artifacts, diagnostic runs, and planning notes are preserved
outside the public launch tree. They are not part of the supported product docs.

## Not part of the supported product core

These surfaces should stay out of the main product story unless they are explicitly reintroduced with ownership and tests.

| Surface | Status | Notes |
|---|---|---|
| `apps/browser-extension` | removed/deprecated | No longer part of the supported release |
| `apps/memory-graph-playground` | removed/deprecated | Experimental playground removed from core scope |
| `packages/ai-sdk` | removed/deprecated | Duplicate packaging surface |
| `packages/hooks` | removed/deprecated | Old convenience layer |
| `packages/memory-graph` | removed/deprecated | Experimental graph UI package |
| `packages/ui` | removed/deprecated | Shared UI scaffolding not in supported product |
| `packages/validation` | removed/deprecated | Old validation package story replaced by repo-owned scripts |
