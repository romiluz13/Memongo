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

## Supported internal

| Surface | Status | Notes |
|---|---|---|
| `packages/lib` | supported internal | Runtime utilities used by publishable packages |
| `docker/mongodb` | supported internal | Atlas Local preview and advanced MongoDB validation stacks |
| `scripts/proof-pack.ts` | supported internal | API contract and operator proof lane |
| `scripts/check-publishability.ts` | supported internal | npm/tarball/install validation |

## Historical, migration, or internal analysis

| Surface | Status | Notes |
|---|---|---|
| `docs/migration` | historical | Compatibility and legacy notes |
| `docs/research` | internal | Research and audits |
| `docs/experiments` | internal | Experiments and analysis |
| `docs/plans` | internal | Planning material |

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
