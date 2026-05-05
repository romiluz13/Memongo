# Memongo

<p align="center">
  <img src="./docs/assets/README-hero.png" alt="Memongo - MongoDB-native long-term AI memory" width="100%">
</p>

<p align="center">
  <strong>MongoDB-native long-term AI memory</strong> for agents, apps, and operators.
</p>

<p align="center">
  <a href="./apps/docs/quickstart.mdx">Quickstart</a> ·
  <a href="./docs/platform/PLATFORM-README.md">Platform Docs</a> ·
  <a href="./docs/platform/PRODUCTION-READY.md">Release Gate</a> ·
  <a href="./docs/platform/PACKAGE-STATUS.md">Package Status</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

Memongo is a focused memory platform for AI systems that want durable recall without adding a separate vector database. It ships a MongoDB-backed engine, a stable bridge, an HTTP API, a TypeScript client, MCP tools, AI SDK helpers, and an operator console. The supported runtime core is `apps/api` -> `packages/memory-bridge` -> `packages/memory-engine` -> MongoDB.

## Supported Surface

| Layer | Location | Role |
|---|---|---|
| HTTP API | `apps/api` | Hono API with `/v1/*`, `/health`, and OpenAPI |
| MCP server | `apps/mcp` | stdio adapter over the HTTP API |
| Web console | `apps/web` | Operator UI for the supported API |
| Docs | `apps/docs` | Product docs for the supported core only |
| Engine | `packages/memory-engine` | MongoDB memory core |
| Bridge | `packages/memory-bridge` | Stable facade used by apps |
| Client SDK | `packages/client` | TypeScript HTTP client |
| AI tools | `packages/tools` | Vercel AI SDK tool helpers |
| Published barrel | `packages/memongo-memory` | `@memongo/memory` convenience import for engine + bridge |
| Shared internals | `packages/lib` | Internal types, config, and utilities |

Optional or historical surfaces such as the browser extension, graph playground, and graph component package are not part of the supported product core.

## Quick Start

```bash
git clone https://github.com/romiluz/memongo.git
cd memongo
bun install
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
docker compose -f docker/docker-compose.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
cd apps/api && bun run dev
```

Then verify the running stack:

```bash
curl http://127.0.0.1:3847/health
curl http://127.0.0.1:3847/v1/status
```

Run the real agent smoke lane after the API is up:

```bash
export GROVE_API_KEY="your-grove-key"
export GROVE_MODEL="gpt-5.4"
export MEMONGO_API_URL="http://127.0.0.1:3847"
bun run agent-smoke
```

This validates a live tool-calling agent loop against the supported Memongo HTTP API. The smoke harness persists conversation events, searches memory, and verifies exact recall through the real retrieval path.

For prompt-ready handoff and synthesis turns, use the context-bundle surface:
- HTTP: `POST /v1/context-bundle`
- SDK: `MemongoClient.buildContextBundle()`
- Tools/MCP: `memongo_build_context_bundle`

For a guided setup, demo flow, and SDK examples, use [apps/docs/quickstart.mdx](./apps/docs/quickstart.mdx) or the platform docs in `docs/platform/`.

## Architecture

```text
Client SDK / HTTP / MCP / tools
  -> apps/api
  -> packages/memory-bridge
  -> packages/memory-engine
  -> MongoDB
```

The engine handles hybrid retrieval, graph, episodes, structured memory, procedures, telemetry, sync, and relevance scoring. The bridge keeps app-facing behavior stable while the engine evolves.

## Release Gates

Use the release checklist before publishing packages, tagging a release, or making production-ready claims:

```bash
bun install
bun run check-types
bun run lint
bun run build
bun run test
bun run check-publishability
```

Live validation requires MongoDB and model-provider credentials. See [Production-ready Checklist](docs/platform/PRODUCTION-READY.md), [Validation Pack](docs/platform/validation-pack.md), and [Self-host Runbook](docs/platform/self-host.md).

## Retrieval Benchmark

Memongo is benchmarked against [LongMemEval-S](https://github.com/xiaowu0162/LongMemEval) (500 scenarios, 23,867 sessions, 246,750 turns) — the standard retrieval benchmark for long-term conversational AI memory.

**Full 500-case results (LLM-assisted pipeline):**

| Metric | Baseline | Current | Delta |
|--------|----------|---------|-------|
| **R@5** | 73.4% | **98.1%** | +24.7 pp |
| **R@10** | 77.0% | **98.9%** | +21.9 pp |
| **NDCG@10** | — | **0.889** | — |
| **Hit Rate** | — | **98.8%** | — |

The LLM-assisted pipeline uses a lightweight model (GPT-5.4-mini) at ingestion time for fact extraction and QA pair generation, and at query time for query decomposition. Retrieval and ranking remain MongoDB-native.

Per-category breakdown (500 cases):

| Category | R@5 | Cases |
|----------|-----|-------|
| single-session-assistant | 100.0% | 56 |
| single-session-user | 100.0% | 70 |
| knowledge-update | 96.8% | 78 |
| single-session-preference | 86.7% | 30 |
| multi-session | 85.6% | 133 |
| temporal-reasoning | 84.0% | 133 |

The reported run uses **MongoDB Atlas Local Preview (8.2.6)** with auto-embed vector search (Voyage 4 Large), Atlas Search, and `$rankFusion`. No external vector databases, no Redis, no Elasticsearch. Reproduction and operating rules live in [Benchmark Operating Contract](docs/benchmarks/benchmark-operating-contract.md); use the benchmark scripts only with the documented MongoDB preview stack and model credentials.

## Retrieval Architecture

Every retrieval capability runs natively on MongoDB. One database, one collection for all evidence types, one retrieval authority.

| Layer | MongoDB Feature | What It Does |
|-------|----------------|--------------|
| Semantic search | `$vectorSearch` + auto-embed (Voyage 4 Large) | Embedding similarity on conversation chunks, session evidence, and enriched facts |
| Full-text search | Atlas Search (`$search`) | Keyword matching for entity names, product terms, quoted phrases |
| Hybrid fusion | `$rankFusion` / `$scoreFusion` | Combines vector + text lanes with configurable per-pipeline weights |
| Polymorphic storage | `$jsonSchema` oneOf validator | Single `chunks` collection stores conversation turns, session evidence, userfact evidence, and QA evidence |
| Post-retrieval scoring | Aggregation pipeline | Keyword overlap (0.30), temporal proximity (0.40), entity name (0.40), quoted phrase (0.60) boosts |
| Exact nearest neighbor | `$vectorSearch` exact:true | Zero ANN approximation error for benchmark evaluation |
| Session evidence | Auto-embed on concatenated user turns | Session-level documents so queries about any topic in a session can match |
| LLM enrichment | Auto-embed on extracted facts + QA pairs | Vocabulary-bridging synthetic docs ("User grows cherry tomatoes" matches "dinner with homegrown ingredients") |
| Query decomposition | LLM sub-queries + RRF merge | Breaks generic queries into specific sub-queries that target stored evidence |
| Miss ledger | Benchmark runner traces | Per-case failure diagnostics with session/turn provenance for surgical optimization |

## Memory Intelligence

Memongo ships advanced memory intelligence capabilities natively on MongoDB:

| Capability | Engine | API / MCP / Client |
|---|---|---|
| Reasoning chain traversal | `mongodb-reasoning-chain.ts` | `POST /v1/chain-trace`, `memongo_chain_trace`, `.traceChain()` |
| Surprisal novelty detection | `mongodb-novelty.ts` | `POST /v1/novelty-scan`, `memongo_novelty_scan`, `.scanNovelty()` |
| Access tracking | `mongodb-access-tracker.ts` (`AccessTracker`, batched writes) | Engine-internal |
| Importance decay | `computeImportanceDecay()` in `mongodb-trust.ts` | Engine-internal (permanent/ongoing memories never decay) |
| Wiki source categorization | `wikiSource`, `vault`, `section` fields on KB collections | Schema-level |
| Consolidation agent (Dreamer) | `mongodb-consolidator.ts` | `POST /v1/consolidate`, `memongo_consolidate`, `.consolidate()` |
| Post-retrieval scoring | `mongodb-post-retrieval-scoring.ts` | Engine-internal (keyword, temporal, entity, quoted phrase) |
| Session evidence synthesis | `mongodb-session-evidence.ts` | Engine-internal (benchmark ingest path) |
| LLM fact + QA enrichment | `mongodb-llm-enrichment.ts` | Engine-internal (provider-agnostic, Grove/OpenAI/Anthropic) |
| Query decomposition | `mongodb-query-decomposition.ts` | Engine-internal (benchmark evaluation path) |

Current totals: 29 collections, 84 standard indexes, 14 search indexes, 48 MCP tools.

## Product Docs

- [Quickstart](apps/docs/quickstart.mdx)
- [Platform README](docs/platform/PLATFORM-README.md)
- [Maintainer Map](docs/platform/MAINTAINER-MAP.md)
- [Package Status](docs/platform/PACKAGE-STATUS.md)
- [Validation Pack](docs/platform/validation-pack.md)
- [Benchmark Operating Contract](docs/benchmarks/benchmark-operating-contract.md)
- [Self-host Runbook](docs/platform/self-host.md)
- [Publishing](docs/platform/publish.md)
- [Production-ready Checklist](docs/platform/PRODUCTION-READY.md)

## History And Migration

Historical and migration notes are kept under [docs/migration](docs/migration/) and internal research/planning folders. They are not part of the supported product surface.

## License

MIT
