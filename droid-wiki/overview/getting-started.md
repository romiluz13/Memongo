# Getting started

## Prerequisites

- Node.js 20.19+
- Bun 1.2+ (the package manager; pinned to `1.3.13` in `package.json`)
- Docker, for the local MongoDB path (uses MongoDB Atlas Local Preview with `mongot` for Atlas Search)

## Install

```bash
git clone https://github.com/romiluz13/memongo.git
cd memongo
bun install
```

This is a Bun workspace (`package.json` `workspaces: ["apps/*", "packages/*"]`) built with Turborepo (`turbo.json`).

## Start MongoDB

```bash
docker compose -f docker/docker-compose.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
export MEMONGO_API_KEY="local-dev-secret"
# Optional: required for semantic search results, an Atlas Model API key (al-... prefix)
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
```

`docker/docker-compose.yml` runs `mongodb/mongodb-atlas-local:preview`, a single container bundling `mongod` and `mongot` (MongoDB's community search engine) so Atlas Search, Atlas Vector Search, and Voyage AI auto-embeddings work locally without a cloud cluster. `VOYAGE_API_KEY` must be an **Atlas Model API key** (`al-...` prefix from `cloud.mongodb.com` → AI Models), not a direct Voyage key (`pa-...`) — `mongot` routes embedding calls through `ai.mongodb.com`.

> MongoDB Automated Embedding is an upstream Preview feature; MongoDB says not to use it in production. Treat Memongo's auto-embed lane as evaluation/preview-only.

## Start the API

```bash
cd apps/api
bun run dev
```

Default bind is `127.0.0.1:3847` (`MEMONGO_API_HOST` / `MEMONGO_API_PORT`). `MEMONGO_API_KEY` is required unless `MEMONGO_ALLOW_INSECURE_NO_AUTH=1` is set for trusted local development (`apps/api/src/app.ts`).

## Add and search memory

```bash
curl -s http://127.0.0.1:3847/health

curl -s http://127.0.0.1:3847/v1/add \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-dev-secret" \
  -d '{"content":"The user prefers TypeScript and concise release notes.","sessionId":"demo-user"}'

curl -s http://127.0.0.1:3847/v1/search \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-dev-secret" \
  -d '{"query":"What does the user prefer?","sessionKey":"demo-user","maxResults":5}'
```

Semantic search returns `{"results":[]}` until `VOYAGE_API_KEY` is set — embeddings are required to match stored memories by meaning. See [API reference](../api/index.md) for the full route list.

## Run the web console and MCP server

```bash
cd apps/web && bun run dev            # http://127.0.0.1:3040

cd apps/mcp && MEMONGO_API_URL=http://127.0.0.1:3847 bun run start
```

## Build, test, and check

```bash
bun run build            # turbo run build
bun run dev              # turbo run dev
bun run test             # turbo run test -> Vitest
bun run check-types      # turbo run check-types
bun run lint             # biome check . --diagnostic-level=error
bun run format           # biome format .
```

E2E tests against a real MongoDB instance run per package:

```bash
bun run --filter @memongo/memory-engine test:e2e:tier-a
```

Tier A covers paths that need only MongoDB (transactions, indexes, tenant isolation, background jobs) and gates every PR in CI (`.github/workflows/ci.yml`). Tiers needing a Voyage/LLM key run nightly (`.github/workflows/e2e-nightly.yml`). See [Testing](../how-to-contribute/testing.md).

## Release gate

Before publishing packages, tagging a release, or making production claims:

```bash
bun install --frozen-lockfile
bun run check-types
bun run lint
bun run build
bun run test
bun run check-publishability
```

Live validation (needs a running API and MongoDB):

```bash
bun run proof-pack
bun run agent-smoke
```

See `docs/platform/PRODUCTION-READY.md` and `docs/platform/validation-pack.md`.
