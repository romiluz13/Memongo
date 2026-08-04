# Getting started

## Prerequisites

- Node.js 20+
- Bun 1.2+ (package manager)
- Docker (for local MongoDB with Atlas Search / Vector Search)

## Install

```bash
git clone https://github.com/romiluz13/memongo.git
cd memongo
bun install
```

## Start MongoDB

The default Docker setup uses MongoDB Atlas Local Preview, which bundles mongod + mongot (Atlas Search) in a single container:

```bash
docker compose -f docker/docker-compose.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
export MEMONGO_API_KEY="local-dev-secret"
# Required for auto-embeddings (Atlas Model API key, al- prefix):
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
```

Without `VOYAGE_API_KEY`, you can still use local development paths that do not require auto-embed.

## Start the API

```bash
cd apps/api
bun run dev
```

The API listens on port 3847 by default.

## Quick test

```bash
# Health check
curl -s http://127.0.0.1:3847/health

# Add a memory
curl -s http://127.0.0.1:3847/v1/add \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-dev-secret" \
  -d '{"content":"The user prefers TypeScript.","sessionId":"demo"}'

# Search
curl -s http://127.0.0.1:3847/v1/search \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-dev-secret" \
  -d '{"query":"what does the user prefer?","sessionKey":"demo"}'
```

## Build

```bash
bun run build          # Turborepo builds all packages
```

## Test

```bash
bun run test           # Turborepo runs Vitest across all packages
bun run test:e2e       # End-to-end tests (requires MongoDB)
```

## Type-check and lint

```bash
bun run check-types    # TypeScript type checking
bun run lint           # Biome lint (errors only)
bun run format         # Biome format
```

## Start the MCP server

```bash
cd apps/mcp
bun run dev
```

The MCP server runs over stdio and calls the HTTP API via `MemongoClient`. It requires the API server to be running.

## Start the web console

```bash
cd apps/web
bun run dev
```

The web console runs on port 3000 by default.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMONGO_MONGODB_URI` | Yes | — | MongoDB connection string |
| `MEMONGO_API_KEY` | Yes (prod) | `local-dev-secret` (dev) | API authentication key |
| `VOYAGE_API_KEY` | For auto-embed | — | Atlas Model API key (al- prefix) |
| `MEMONGO_API_HOST` | No | `127.0.0.1` | API bind host |
| `MEMONGO_API_PORT` | No | `3847` | API port |
| `MEMONGO_AGENT_ID` | No | `main` | Default agent identity |
| `MEMONGO_MONGODB_COLLECTION_PREFIX` | No | `memongo_{agentId}_` | Collection prefix (shared mode: `memongo_`) |
| `MEMONGO_ALLOW_INSECURE_NO_AUTH` | No | `false` | Disable auth (dev only) |

## Docker deployment

```bash
# Full stack (API + local MongoDB)
MEMONGO_API_KEY="your-key" \
docker compose -f docker/compose.yaml -f docker/compose.override.yaml up -d

# API only (connect to Atlas)
MEMONGO_MONGODB_URI="mongodb+srv://..." \
MEMONGO_API_KEY="your-key" \
docker compose -f docker/compose.yaml up -d
```
