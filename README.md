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

Memongo is a focused memory platform for AI systems that want durable recall without adding a separate vector database. It works for coding agents, Hermes-style personal agents, support agents, research agents, multi-agent teams, apps, and operators. It ships a MongoDB-backed engine, a stable bridge, an HTTP API, a TypeScript client, MCP tools, AI SDK helpers, a Hermes memory provider, and an operator console. The supported runtime core is `apps/api` -> `packages/memory-bridge` -> `packages/memory-engine` -> MongoDB.

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
| Hermes provider | `integrations/hermes/memongo` | External Hermes Agent memory provider over the HTTP API |
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
- Hermes: `integrations/hermes/memongo` as a `memory.provider`

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

## Benchmarks

Memongo benchmark claims are artifact-backed and scoped by lane. The old unproven 98% README number has been removed because it did not have a reproducible artifact pack.

Current MemPalace P0 evidence:

| Benchmark lane | Memongo | MemPalace | Status |
|---|---:|---:|---|
| LongMemEval raw session full 500, RecallAny@5 | **99.15%** | 96.60% | Memongo wins |
| LongMemEval held-out 450 hybrid no-LLM, RecallAny@5 | **99.11%** | 98.44% | Memongo wins |
| LongMemEval full 500 hybrid no-LLM, RecallAny@5 | **99.20%** | 96.60% raw / 99.20% Haiku rerank | Beats raw; ties rerank with different lane |
| LoCoMo raw session top-10, avg recall | **91.71%** | 60.29% | Memongo wins |
| LoCoMo hybrid session top-10, avg recall | **93.30%** | 88.91% | Memongo wins |
| ConvoMem raw message top-10, avg recall | **100.00%** | 92.87% | Memongo wins |
| MemBench full 8,500 hybrid top-5, hit@5 | **88.75%** | 80.33% | Memongo wins |

These rows are described in [Benchmark Results](docs/benchmarks/BENCHMARKS.md) with artifact SHA256 hashes, dataset identity, scorer, retrieval unit, LLM/rerank disclosure, warnings, degradations, latency where available, and competitor evidence. Public language is intentionally narrow: Memongo beats MemPalace on these retrieval lanes. Broader ecosystem benchmarks are still in progress.

Benchmark rules:

- No question-ID tuning.
- No hidden fallback.
- No benchmark-only product claims.
- Retrieval recall and judged answer quality are reported separately.
- "Best memory framework in the world" is not claimed until ecosystem benchmarks are beaten or explicitly scoped out.

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
- [Hermes Memory Provider](docs/platform/hermes-provider.md)
- [Benchmark Operating Contract](docs/benchmarks/benchmark-operating-contract.md)
- [Self-host Runbook](docs/platform/self-host.md)
- [Publishing](docs/platform/publish.md)
- [Production-ready Checklist](docs/platform/PRODUCTION-READY.md)

## History And Migration

Historical and migration notes are kept under [docs/migration](docs/migration/) and internal research/planning folders. They are not part of the supported product surface.

## License

Memongo is source-available under the Business Source License 1.1. Commercial use, production hosted use, managed-service use, or substantially similar service use requires a commercial license from Rom Iluz / Memongo unless it is covered by the license's Additional Use Grant.

The current BSL parameters are:

- Licensor: Rom Iluz
- Licensed Work: Memongo repository, packages, apps, docs, benchmark adapters, and examples
- Additional Use Grant: non-production evaluation, research, personal use, internal testing, and local development
- Change License: Apache License 2.0
- Change Date: four years after each release date

This is not legal advice. The final commercial-launch license language should be reviewed by counsel.
