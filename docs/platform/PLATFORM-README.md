# Memongo Platform

This repository is the Memongo product: a Turborepo/Bun monorepo that ships MongoDB-native long-term AI memory on MongoDB Atlas cloud and Atlas Local Preview.

## What ships here

| Surface | Location | Role |
|--------|----------|------|
| HTTP API | `apps/api` | Hono, `/v1/*`, `GET /openapi.json`, default `http://127.0.0.1:3847` |
| MCP | `apps/mcp` | stdio MCP that calls the HTTP API |
| Web console | `apps/web` | Next.js operator dashboard (default port **3040**) |
| SDK | `packages/client` | `MemongoClient` for the API |
| Engine | `packages/memory-engine` | MongoDB memory core |
| Bridge | `packages/memory-bridge` | Stable facade used by `apps/api` |
| Published re-export | `packages/memongo-memory` | `@memongo/memory` convenience barrel |
| AI SDK tools | `packages/tools` | `createMemongoTools` pattern |
| Docs (Mintlify) | `apps/docs` | Product documentation site sources |

Optional or historical surfaces such as `apps/browser-extension`, `apps/memory-graph-playground`, and `packages/memory-graph` are not part of the supported product core.

## Memory intelligence

Six advanced memory intelligence capabilities ship natively on MongoDB:

- **Reasoning chain traversal** -- provenance trace via `$lookup` on `sourceEventIds` (`POST /v1/chain-trace`)
- **Surprisal novelty detection** -- Atlas Vector Search centroid distance scoring (`POST /v1/novelty-scan`)
- **Access tracking** -- `AccessTracker` with batched writes for memory access frequency (engine-internal)
- **Importance decay** -- `computeImportanceDecay()` in `mongodb-trust.ts`; permanent/ongoing memories never decay (engine-internal)
- **Wiki source categorization** -- `wikiSource`, `vault`, `section` fields on KB collections (schema-level)
- **Consolidation agent (Dreamer)** -- offline pipeline with rule-based pattern matching (`POST /v1/consolidate`)

## Install and run

```bash
bun install
```

**MongoDB:** use either managed MongoDB Atlas cloud or Atlas Local Preview. Both lanes use MongoDB Search, Vector Search, and auto-embeddings with an Atlas Model API key.

Managed Atlas cloud:

```bash
export MEMONGO_MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=memongo"
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
```

Atlas Local Preview:

```bash
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
docker compose -f docker/mongodb/docker-compose.preview.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
```

Use cloud for serious benchmark/control runs and Atlas Local Preview for local reproducibility/parity.

**API:**

```bash
cd apps/api && bun run dev
```

**Web / MCP**:

```bash
cd apps/web && bun run dev

cd apps/mcp && MEMONGO_API_URL=http://127.0.0.1:3847 bun run start
```

## Configuration

Standalone mode uses environment variables and optional `~/.memongo/memongo.json`. See `apps/docs/guides/memory-config.mdx`.

## Documentation map

- [Capability matrix](capability-matrix.md)
- [Validation pack](validation-pack.md)
- [Benchmark pack](benchmark-pack.md)
- [Self-host runbook](self-host.md)
- [Publishing](publish.md)
- [Production-ready checklist](PRODUCTION-READY.md)
- [Production-ready checklist](PRODUCTION-READY.md)

## Tests

```bash
bun run check-types
bun run lint
bun run build
bun run test
bun run check-publishability
```

With API + Mongo running:

```bash
bun run proof-pack
bun run memory-eval
bun run capability-stress
```

For full release validation, follow [PRODUCTION-READY.md](PRODUCTION-READY.md). The preview stack validates Search/auto-embed lanes only when `VOYAGE_API_KEY` is an Atlas Model key with the `al-...` prefix.
