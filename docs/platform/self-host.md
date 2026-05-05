# Self-host Memongo

Memongo is data-plane memory you run next to your agents. This runbook describes the supported Memongo deployment layout and the canonical local stack.

## Components

1. MongoDB via `mongodb/mongodb-atlas-local:preview`.
2. `apps/api` - stateless HTTP service.
3. Optional: `apps/web` and `apps/mcp`.

## Configuration

- `MEMONGO_MONGODB_URI` - required for standalone API processes.
- `MEMONGO_API_KEY` - set in any untrusted network.
- `MEMONGO_API_PORT` / `MEMONGO_API_HOST` - bind address for `apps/api`.
- `VOYAGE_API_KEY` - required for auto-embed and hybrid retrieval quality on the preview stack. Use an Atlas Model key with the `al-...` prefix.

Optional file config: `~/.memongo/memongo.json` or `MEMONGO_CONFIG_PATH`. See `apps/docs/guides/memory-config.mdx`.

## Canonical MongoDB stack

Reference deployment:

```bash
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
docker compose -f docker/mongodb/docker-compose.preview.yml up -d
```

Use this URI from local apps and validation:

```bash
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
```

## Running the API

```bash
cd /opt/memongo
bun install --frozen-lockfile
export MEMONGO_MONGODB_URI="mongodb://..."
export MEMONGO_API_HOST="0.0.0.0"
cd apps/api && bun run start
```

Put TLS termination and your preferred ingress in front of `apps/api` when exposing it outside localhost.

## Health checks

- Liveness: `GET /health`
- OpenAPI: `GET /openapi.json`
- Memory status: `GET /v1/status`
- Contract proof: `bun run proof-pack`

## MCP

MCP is stdio; the host process spawns `apps/mcp` and sets `MEMONGO_API_URL` to your API base URL.
