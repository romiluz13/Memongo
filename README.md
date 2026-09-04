# Memongo

<p align="center">
  <img src="./docs/assets/README-hero.png" alt="Memongo - MongoDB-native long-term AI memory" width="100%">
</p>

<p align="center">
  <strong>MongoDB-native Company Brain memory framework for AI apps, agents, and teams.</strong>
</p>

<p align="center">
  <a href="./apps/docs/quickstart.mdx">Quickstart</a> ·
  <a href="./apps/docs/concepts/framework.mdx">Framework</a> ·
  <a href="./apps/docs/concepts/architecture.mdx">Architecture</a> ·
  <a href="./apps/docs/api/overview.mdx">API</a> ·
  <a href="https://memongo.rom-88f.workers.dev">Live Site</a> ·
  <a href="./docs/benchmarks/BENCHMARKS.md">Benchmarks</a> ·
  <a href="./docs/platform/PRODUCTION-READY.md">Release Gate</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@memongo/memory"><img alt="@memongo/memory npm version" src="https://img.shields.io/npm/v/%40memongo%2Fmemory?label=%40memongo%2Fmemory"></a>
  <a href="https://www.npmjs.com/package/@memongo/client"><img alt="@memongo/client npm version" src="https://img.shields.io/npm/v/%40memongo%2Fclient?label=%40memongo%2Fclient"></a>
  <a href="https://www.npmjs.com/package/@memongo/tools"><img alt="@memongo/tools npm version" src="https://img.shields.io/npm/v/%40memongo%2Ftools?label=%40memongo%2Ftools"></a>
</p>

Memongo gives AI systems durable Company Brain memory on top of MongoDB. It
stores conversations, facts, procedures, knowledge-base chunks, episodes, and
graph relationships in one MongoDB-backed memory engine, then retrieves context
with vector search, full-text search, and hybrid ranking.

The public repo is intentionally focused: a runnable API, MCP server, TypeScript client, AI SDK tools, web console, docs, Docker MongoDB setup, and release checks.

## Quickstart

Prerequisites:

- Node.js 20+
- Bun 1.2+
- Docker (for the local MongoDB path — uses MongoDB Atlas Local Preview with mongot for Atlas Search)

```bash
git clone https://github.com/romiluz13/memongo.git
cd memongo
bun install
```

Start MongoDB:

```bash
docker compose -f docker/docker-compose.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
export MEMONGO_API_KEY="local-dev-secret"
# Required for semantic search results below (Atlas Model API key, `al-...` prefix):
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
```

The default Docker file uses MongoDB Atlas Local Preview. Set `VOYAGE_API_KEY`
to a MongoDB Atlas Model API key with the `al-...` prefix when you want MongoDB
auto-embeddings. Without it, you can still use local development paths that do
not require auto-embed.

> [!WARNING]
> [MongoDB Automated Embedding](https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/)
> is an upstream Preview feature. MongoDB says not to use it in production.
> Memongo's current automated semantic-search lane is therefore for evaluation
> and controlled preview deployments, not production certification.

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
  -H "authorization: Bearer local-dev-secret" \
  -d '{"content":"The user prefers TypeScript and concise release notes.","sessionId":"demo-user"}'

curl -s http://127.0.0.1:3847/v1/search \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-dev-secret" \
  -d '{"query":"What does the user prefer?","sessionKey":"demo-user","maxResults":5}'
```

> Semantic search returns `{"results":[]}` until `VOYAGE_API_KEY` is set (see
> above) — embeddings are required to match stored memories by meaning.

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

## Memory Framework

Memongo's framework contract is:

- Memory taxonomy: episodic events, semantic facts, procedural playbooks,
  profile preferences, workspace knowledge, and provenance.
- Core operations: recall, context bundles, remember, update, forget, feedback,
  and trace.
- Scope model: `session`, `user`, `agent`, `workspace`, `tenant`, and `global`.
- Safety model: read by default; write only on explicit user, app, operator,
  test, or import intent.

See [Memory Framework](apps/docs/concepts/framework.mdx), [Memory Taxonomy](apps/docs/concepts/memory-taxonomy.mdx), and [Company Brain Guide](apps/docs/guides/company-brain.mdx).

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
| `MEMONGO_API_KEY` | Recommended bearer token for API requests |
| `MEMONGO_AGENT_ID` | Default memory isolation key |
| `MEMONGO_SHARED_CLIENT` | Set `0` (or `false`/`no`/`off`) to opt out of the default shared-client runtime and restore per-agent clients; default on |
| `MEMONGO_MANAGER_CACHE_MAX` | Manager cache LRU cap, default `50` |
| `MEMONGO_MANAGER_CACHE_IDLE_TTL_MS` | Idle managers evicted after this long, default `600000` (10 min) |
| `MEMONGO_JOB_SWEEP_MS` | Standing memory-job sweep interval, default `30000` (writes still drain immediately) |
| `MEMONGO_MONGODB_RECALL_PROFILE` | `latency`, `balanced`, or `proof`; default `balanced` |
| `MEMONGO_MONGODB_FUSION_METHOD` | `scoreFusion`, `rankFusion`, or `js-merge`; default `scoreFusion` with capability fallback |
| `MEMONGO_QUERY_EMBEDDING_MODEL` | Compatible Voyage 4 query model; default `voyage-4-large` |
| `VOYAGE_API_KEY` | Atlas Model API key for MongoDB auto-embed lanes |
| `MEMONGO_ENRICHMENT_BASE_URL` | Optional OpenAI-compatible or Anthropic endpoint for LLM enrichment |
| `MEMONGO_ENRICHMENT_API_KEY` | API key for the enrichment endpoint |
| `MEMONGO_ENRICHMENT_MODEL` | Model used by enrichment when enabled |

Deployment-safe defaults: all memory managers for the same MongoDB URI share
one client (and therefore one bounded connection pool, `maxPoolSize` 10) and
the manager cache is LRU-capped with idle eviction in every mode, so agent
count no longer multiplies connections — connections are fixed per URI, and
standing poll traffic is capped by the bounded manager cache (<=50 sweeps
per 30 s). Per-agent clients
return with `MEMONGO_SHARED_CLIENT=0`; note that in that mode an idle agent
re-bootstraps its manager (and reconnects) after the idle TTL, and per-agent
pool settings apply per manager again.

OpenAI-compatible enrichment defaults to `Authorization: Bearer`. Gateways that
require provider-specific headers can set
`MEMONGO_ENRICHMENT_AUTH_STYLE=api-key` or `x-api-key`; gateways that require
newer completion token naming can set
`MEMONGO_ENRICHMENT_TOKEN_PARAM=max_completion_tokens`.

For managed Atlas and Atlas Local Preview notes, see [Configuration](apps/docs/guides/memory-config.mdx) and [Self-hosting](docs/platform/self-host.md).

## Benchmarks

In a complete 500-question LongMemEval retrieval run, Memongo returned every
scenario successfully and achieved:

| Metric | Result |
|---|---:|
| Official session RecallAny@10 | **98.57%** |
| Official session RecallAll@10 | **94.75%** |
| Internal R@5 | **93.15%** |
| Internal R@10 | **97.16%** |
| Internal hit rate | **98.94%** |

The run used MongoDB-native `$scoreFusion`, Voyage 4 Large query embeddings,
Voyage `rerank-2.5`, and no generative LLM enrichment. These are retrieval
metrics, not generated-answer accuracy. The registered release contract still
classifies the run as **not publishable** because its 1,244 ms p95 exceeded the
1,000 ms gate and build, cost, and native-operation evidence was incomplete.

Competitor headline numbers use different evaluators and units. Mem0 and Zep
publish generated-answer accuracy, Supermemory publishes a differently
aggregated Recall@15 result, and Letta's public 74.0% result is on LoCoMo. None
is an apples-to-apples comparison with Memongo's retrieval-only result.

Read the methodology, competitor context, and failed gates before quoting any
number: [Benchmark Evidence](docs/benchmarks/BENCHMARKS.md).

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
npm install @memongo/memory
npm install @memongo/client
npm install @memongo/tools
```

Package READMEs:

- [@memongo/client](packages/client/README.md)
- [@memongo/tools](packages/tools/README.md)
- [@memongo/memory](packages/memongo-memory/README.md)
- [@memongo/memory-bridge](packages/memory-bridge/README.md)
- [@memongo/memory-engine](packages/memory-engine/README.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
