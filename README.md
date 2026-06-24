# Memongo

<p align="center">
  <img src="./docs/assets/README-hero.png" alt="Memongo - MongoDB-native long-term AI memory" width="100%">
</p>

<p align="center">
  <strong>MongoDB-native long-term memory for AI agents.</strong>
</p>

<p align="center">
  <a href="./apps/docs/quickstart.mdx">Quickstart</a> ·
  <a href="./apps/docs/concepts/architecture.mdx">Architecture</a> ·
  <a href="./apps/docs/api/overview.mdx">API</a> ·
  <a href="./docs/benchmarks/BENCHMARKS.md">Benchmarks</a> ·
  <a href="./docs/platform/PRODUCTION-READY.md">Release Gate</a>
</p>

Memongo gives AI systems durable memory on top of MongoDB. It stores conversations, facts, procedures, knowledge-base chunks, episodes, and graph relationships in one MongoDB-backed memory engine, then retrieves context with vector search, full-text search, and hybrid ranking.

The public repo is intentionally focused: a runnable API, MCP server, TypeScript client, AI SDK tools, web console, docs, Docker MongoDB setup, and release checks.

## Quickstart

Prerequisites:

- Node.js 20+
- Bun 1.2+
- Docker, for the local MongoDB path

```bash
git clone https://github.com/romiluz/memongo.git
cd memongo
bun install
```

Start MongoDB:

```bash
docker compose -f docker/docker-compose.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
```

Start the API:

```bash
cd apps/api
bun run dev
```

In another shell, add and search memory:

```bash
curl -s http://127.0.0.1:3847/health

curl -s http://127.0.0.1:3847/v1/add \
  -H "content-type: application/json" \
  -d '{"content":"The user prefers TypeScript and concise release notes.","sessionId":"demo-user"}'

curl -s http://127.0.0.1:3847/v1/search \
  -H "content-type: application/json" \
  -d '{"query":"What does the user prefer?","sessionKey":"demo-user","maxResults":5}'
```

For a guided setup, see [Quickstart](apps/docs/quickstart.mdx).

## What You Get

| Surface | Location | Purpose |
|---|---|---|
| HTTP API | `apps/api` | Hono server exposing `/v1/*`, `/health`, and OpenAPI |
| MCP server | `apps/mcp` | stdio adapter for MCP-compatible clients |
| Web console | `apps/web` | Operator UI for the API |
| Docs | `apps/docs` | Public docs |
| Engine | `packages/memory-engine` | MongoDB memory core |
| Bridge | `packages/memory-bridge` | Stable facade over the engine |
| Client SDK | `packages/client` | TypeScript HTTP client |
| AI tools | `packages/tools` | Vercel AI SDK tool helpers |
| Published barrel | `packages/memongo-memory` | `@memongo/memory` convenience package |

## How It Works

```text
App / Agent / MCP client
  -> Memongo HTTP API or TypeScript client
  -> Memory bridge
  -> MongoDB memory engine
  -> MongoDB Search, Vector Search, collections, indexes, and telemetry
```

Memongo keeps the product interface small while the engine handles:

- Conversation and event memory
- Structured facts and revisions
- Procedure memory
- Knowledge-base ingestion
- Episodes and graph relationships
- Hybrid retrieval across vector and lexical evidence
- Optional high-recall retrieval profiles for evaluation and audit work

## Configuration

Memongo reads environment variables and an optional config file at `~/.memongo/memongo.json`.

Common variables:

| Variable | Purpose |
|---|---|
| `MEMONGO_MONGODB_URI` | MongoDB connection string |
| `MEMONGO_API_HOST` | API bind host, default `127.0.0.1` |
| `MEMONGO_API_PORT` | API port, default `3847` |
| `MEMONGO_API_KEY` | Optional bearer token for API requests |
| `MEMONGO_AGENT_ID` | Default memory isolation key |
| `MEMONGO_MONGODB_RECALL_PROFILE` | `latency`, `balanced`, or `proof`; default `balanced` |

For managed Atlas and Atlas Local Preview notes, see [Configuration](apps/docs/guides/memory-config.mdx) and [Self-hosting](docs/platform/self-host.md).

## Benchmarks

Memongo benchmark evidence is scoped by lane. Current public evidence supports selected MemPalace P0 retrieval-lane comparisons only. Broader ecosystem benchmarks, including Mem0 LongMemEval judged-answer rows, are still under audit. No Mem0 LongMemEval win is claimed.

Read the evidence page before quoting any number: [Benchmark Evidence](docs/benchmarks/BENCHMARKS.md).

Benchmark rules:

- No question-ID tuning.
- No hidden fallback.
- Retrieval recall and judged answer quality are reported separately.
- No broad ecosystem leadership claim is made from one benchmark family.

## Release Gate

Run these checks before publishing packages, tagging a release, or making production claims:

```bash
bun install --frozen-lockfile
bun run check-types
bun run lint
bun run build
bun run test
bun run check-publishability
```

Live validation requires a running API and MongoDB:

```bash
bun run proof-pack
bun run agent-smoke
```

See [Production-ready Checklist](docs/platform/PRODUCTION-READY.md), [Validation Pack](docs/platform/validation-pack.md), and [Publishing](docs/platform/publish.md).

## Packages

```bash
bun add @memongo/client
bun add @memongo/tools
bun add @memongo/memory
```

Package READMEs:

- [@memongo/client](packages/client/README.md)
- [@memongo/tools](packages/tools/README.md)
- [@memongo/memory](packages/memongo-memory/README.md)
- [@memongo/memory-bridge](packages/memory-bridge/README.md)
- [@memongo/memory-engine](packages/memory-engine/README.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
