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
