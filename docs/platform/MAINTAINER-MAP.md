# Maintainer Map

This is the shortest path to understanding what Memongo is, what is supported, and what must be green before a release.

## Start here

1. `README.md`
2. `apps/docs/introduction.mdx`
3. `docs/platform/PLATFORM-README.md`
4. `docs/platform/PACKAGE-STATUS.md`
5. `docs/platform/PRODUCTION-READY.md`

## Runtime core

```text
apps/api
  -> packages/memory-bridge
  -> packages/memory-engine
  -> MongoDB Atlas Local preview
```

Supported adapters around that core:

- `packages/client`
- `packages/tools`
- `apps/mcp`
- `apps/web`
- `apps/docs`

## Release lanes

- `repo-foundation`
  `bun run lint`
  `bun run check-types`
  `bun run build`
  `bun run test`
- `api-contract`
  `bun run proof-pack`
- `package-publishability`
  `bun run check-publishability`
- `live-core`
  `packages/memory-engine/src/production-readiness.e2e.test.ts`
- `live-capability`
  `packages/memory-engine/src/real-e2e-v2.e2e.test.ts`
  `packages/memory-engine/src/mongodb-e2e.e2e.test.ts`

Canonical local stack:
- `docker/mongodb/docker-compose.preview.yml`
- `VOYAGE_API_KEY=al-...`
- `mongodb://127.0.0.1:27017/?directConnection=true`

## Docs ownership

- `apps/docs`
  Public product docs and quickstart
- `docs/platform`
  Maintainer and release docs
- `docs/benchmarks`
  Scoped public benchmark evidence and operating contract
- Not shipped
  Historical research, diagnostic runs, raw artifacts, and planning notes

## Source of truth

- Product shape: `README.md`
- Public docs: `apps/docs`
- Release truth: `docs/platform/PRODUCTION-READY.md`
- Package support status: `docs/platform/PACKAGE-STATUS.md`
