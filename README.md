# Memongo -- OpenClaw, but it remembers.

<p align="center">
  <img src="./README-memongo-header-v2.png" alt="Memongo" width="100%">
</p>

<p align="center">
  <a href="https://github.com/romiluz13/Memongo/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/romiluz13/Memongo/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/romiluz13/Memongo/releases"><img src="https://img.shields.io/github/v/release/romiluz13/Memongo?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

Same channels. Same plugins. Same voice. But your agent's memory lives in MongoDB -- not in files that corrupt, disappear, or overflow your context window.

Memongo is [OpenClaw](https://github.com/openclaw/openclaw) (329K+ stars, 22 messaging channels, native apps, 78 extensions) with its memory replaced by a production MongoDB backend. Where OpenClaw defaults to QMD (SQLite + Markdown files), Memongo uses MongoDB Community + mongot + Voyage AI for vector search, knowledge graphs, episode materialization, event-sourcing, and 8 retrieval paths -- all in one database. Nothing is ever lost.

[Website](https://memongo.site) |
[Getting Started](docs/start/memongo-getting-started.md) |
[MongoDB Capabilities](docs/reference/mongodb-capabilities.md) |
[vs Default Memory](docs/reference/memongo-vs-default-memory.md) |
[Upstream Docs](https://docs.openclaw.ai) |
[Discord](https://discord.gg/clawd)

---

## What Is Memongo?

The full OpenClaw personal AI assistant -- 22 messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Microsoft Teams, Matrix, and 14 more), 78 extensions (25+ LLM providers, tools, media, infra), companion apps for macOS/iOS/Android, voice wake, live canvas, and the entire skills platform -- with a MongoDB brain instead of files.

Memongo is **not** a memory library. It is a complete personal AI assistant with a real database behind it. The product is the assistant. MongoDB is what makes it production-ready.

**Who is this for:**

1. **OpenClaw users** whose agent forgot something important. Again. You want a real backend, not files.
2. **MongoDB developers** who want a personal AI assistant that stores everything in the database you already know and operate.
3. **Teams building Company OS** -- multi-agent systems that need shared memory, knowledge bases, audit trails, and enterprise-grade isolation. All in MongoDB.

---

## Why MongoDB for Agent Memory?

MongoDB is uniquely suited for agent memory because it combines document flexibility, vector search, full-text search, graph traversal, and operational guarantees in a single platform. No other database offers all of these without bolting on external services.

Memongo uses 26 MongoDB capabilities. Each one solves a specific agent memory problem:

| #   | Capability                      | Why It Matters                                                                 | How It Works                                                                                             |
| --- | ------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1   | **Automated Embeddings**        | No application-side embedding code, no batch jobs, no model version management | mongot calls Voyage AI API at index time and query time via `autoEmbed`                                  |
| 2   | **Vector Search**               | Semantic recall over conversation history and knowledge base                   | `$vectorSearch` with HNSW indexing on `voyage-4-large` (1024 dimensions)                                 |
| 3   | **Full-Text Search**            | Keyword recall when the user asks for exact terms                              | mongot text indexes with Lucene standard analyzer                                                        |
| 4   | **Hybrid Search**               | Neither vector nor keyword alone is sufficient for agent memory                | `$rankFusion` / `$scoreFusion` (MongoDB 8.0+/8.2+), with manual RRF fallback                             |
| 5   | **Knowledge Graph**             | Agents need to traverse relationships, not just match strings                  | `$graphLookup` with bi-directional expansion via `$facet`                                                |
| 6   | **Event-Sourcing**              | Every write must be auditable and replayable                                   | Canonical `events` collection with derived projections (chunks, entities, episodes)                      |
| 7   | **Schema Validation**           | Garbage in, garbage out -- agent memory must be structurally consistent        | JSON Schema (`$jsonSchema`) on all 18 validated collections                                              |
| 8   | **Change Streams**              | Multiple gateway instances must stay in sync                                   | Real-time cross-instance notification via MongoDB change streams                                         |
| 9   | **TTL Indexes**                 | Embedding caches and telemetry data should expire automatically                | `expireAfterSeconds` on `embedding_cache`, `relevance_runs`, `relevance_artifacts`                       |
| 10  | **Multi-Tenant Isolation**      | One database, many agents, zero data leakage                                   | Compound indexes with `agentId` prefix + `$graphLookup` `restrictSearchWithMatch`                        |
| 11  | **Idempotent Upserts**          | Network retries and replays must not corrupt memory                            | `$setOnInsert` for creation-time fields + `$set` for mutable fields on unique compound keys              |
| 12  | **Relevance Telemetry**         | You cannot improve retrieval quality without measuring it                      | `explain`-driven diagnostics across `relevance_runs`, `relevance_artifacts`, `relevance_regressions`     |
| 13  | **Semantic Query Cache**        | Identical or near-identical queries skip the full retrieval pipeline           | SHA-256 exact match + `$vectorSearch` cosine >= 0.95, per-document TTL, fire-and-forget writes           |
| 14  | **Time Series Telemetry**       | Operational visibility into every memory operation with automatic retention    | Time series collection with `granularity: "seconds"`, P50/P95/P99 latency, cache hit rates               |
| 15  | **Profile Synthesis**           | Dynamic agent profile from structured memory, entities, episodes, and events   | `$facet` + `$lookup` aggregation across 5 collections, ~5-50ms                                           |
| 16  | **Cross-Encoder Re-ranking**    | Voyage rerank-2.5 precision pass on search results with instruction-following  | Two-stage: `$vectorSearch` recall then rerank-2.5 precision, 8-11% accuracy boost with instructions      |
| 17  | **Query Rewriting**             | Synonym expansion for improved vector search recall on terse queries           | Deterministic abbreviation + synonym expansion before embedding, planner sees original query             |
| 18  | **Pluggable Entity Extraction** | Regex default with LLM upgrade path for richer knowledge graphs                | `EntityExtractor` interface, `RegexEntityExtractor` + `LLMEntityExtractor` with timeout + fallback       |
| 19  | **Mutation Audit Trail**        | Every memory write tracked with before/after snapshots                         | `memory_mutations` collection, fire-and-forget `recordMutation`, 90-day TTL auto-cleanup                 |
| 20  | **Status Lifecycle**            | Episodes and chunks have active/archived/deleted states                        | `status` field + `{ $ne: "deleted" }` filter on all query paths (backward compatible with existing data) |
| 21  | **Procedural Memory Evolution** | Procedures track version history, success/fail counts                          | Atomic `$inc` counters + `$push` with `$slice: -20` for bounded evolution history                        |
| 22  | **Conservative Graph Deletion** | Conflict detection prevents accidental data loss in knowledge graphs           | Relation count check before delete, `force` override, audit trail on every deletion                      |
| 23  | **Working Memory Bounds**       | Configurable session event capacity for context window management              | `$sort` + `$limit` optimization (MongoDB coalesces adjacent stages), default 50 events                   |
| 24  | **Temporal Grounding**          | Entity extraction captures dates and times as first-class concepts             | `DATE_REGEX` patterns + `extractedAt` timestamps on entities, dates stored as type "concept"             |
| 25  | **Role-Based Extraction**       | Separate extraction prompts for user vs assistant messages                     | `buildUserExtractionPrompt` / `buildAssistantExtractionPrompt` + `sourceRole` tracking on entities       |
| 26  | **Tiered Retrieval**            | IDs-only projection mode for 10x token reduction in large memory spaces        | `$project` after `$vectorSearch` returns lightweight results, full content fetched on demand             |

For the full technical deep-dive on each capability with code examples: [MongoDB Capabilities in Memongo](docs/reference/mongodb-capabilities.md)

---

## Memongo vs Default OpenClaw Memory

| Capability             | OpenClaw Default (QMD/SQLite)         | Memongo (MongoDB)                                                            |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| Storage backend        | SQLite file + Markdown files          | MongoDB Community (replica set)                                              |
| Vector search          | sqlite-vec or LanceDB                 | mongot + Voyage AI autoEmbed                                                 |
| Embedding management   | Application-side (multiple providers) | Automated via mongot (zero app code)                                         |
| Full-text search       | SQLite FTS5 / BM25                    | mongot text indexes (Lucene)                                                 |
| Hybrid search          | BM25 + vector with MMR                | `$rankFusion` / `$scoreFusion` + RRF                                         |
| Knowledge graph        | None                                  | `$graphLookup` with entities + relations                                     |
| Episodes               | None                                  | Auto-materialized from event windows                                         |
| Event sourcing         | None (append-only Markdown)           | Canonical events collection                                                  |
| Structured memory      | Basic key-value                       | Salience, temporal validity, state, provenance                               |
| Procedures             | None                                  | Versioned workflow artifacts                                                 |
| Retrieval paths        | 1 (search)                            | 8 paths with planner-driven selection                                        |
| Schema validation      | None                                  | JSON Schema on all collections                                               |
| Multi-tenant isolation | Filesystem separation                 | Compound indexes with agentId prefix                                         |
| Operational visibility | Limited                               | Ingest runs, projection runs, relevance telemetry, time series observability |
| Query caching          | None                                  | Two-tier semantic cache (SHA-256 exact + cosine similarity)                  |
| Data model             | Flat files + SQLite rows              | 23 collections, 66 indexes + 9 search indexes                                |

**Decision rule:** If your workload is one user with small memory files, OpenClaw's default memory is fine. If you need retrieval quality SLOs, operational visibility, knowledge graphs, or team-scale agent memory, Memongo is the practical path.

Full comparison with migration guidance: [Memongo vs Default Memory](docs/reference/memongo-vs-default-memory.md)

---

## MongoDB Memory Architecture

Memongo uses a canonical-truth-first architecture where **events are the single source of truth**. Everything else -- chunks, entities, relations, episodes, procedures -- is derived.

```text
Write Path:
  Message / tool output -> writeEventAndProject()
                           +-> events       (canonical, append-only)
                           +-> chunks       (projected, searchable)
                           +-> ingest_runs  (operational audit)
                           +-> extractAndUpsertEntities(role)
                                +-> entities   (@mentions, #tags, URLs, dates, quoted names)
                                +-> relations  (links between entities, weighted)
                                +-> memory_mutations (before/after snapshots, 90-day TTL)
                           +-> checkAutoEpisodeTriggers()
                                +-> episodes   (materialized, status lifecycle)

Retrieval Path:
  Query -> checkCache() -> HIT? return cached results
                        -> MISS -> planRetrieval() -> score 8 paths by keyword heuristics
           +-> active-critical  (high-salience recent)
           +-> structured       (facts, preferences)
           +-> episodic         (summarized threads, status-filtered)
           +-> graph            ($graphLookup, conservative delete)
           +-> kb               (knowledge base docs)
           +-> hybrid           ($rankFusion vector+text)
           +-> raw-window       (bounded working memory, $sort+$limit)
           +-> procedural       (versioned workflows, success tracking)
           -> crossEncoderRerank() -> deduplicate -> writeCache() -> return to agent

Observability:
  All paths emit to memory_telemetry (time series, fire-and-forget, 7-day TTL)
```

### 23 Collections

| Group               | Collections                                                      |
| ------------------- | ---------------------------------------------------------------- |
| Conversation memory | `chunks`, `files`, `embedding_cache`, `meta`                     |
| Knowledge base      | `knowledge_base`, `kb_chunks`                                    |
| Structured memory   | `structured_mem`, `structured_mem_revisions`                     |
| Procedures          | `procedures`, `procedure_revisions`                              |
| Relevance telemetry | `relevance_runs`, `relevance_artifacts`, `relevance_regressions` |
| v2 event system     | `events`, `entities`, `relations`, `entity_links`, `episodes`    |
| Operational         | `ingest_runs`, `projection_runs`                                 |
| Query cache         | `query_cache`                                                    |
| Audit trail         | `memory_mutations` (90-day TTL)                                  |
| Observability       | `memory_telemetry` (time series)                                 |

All backed by **66 standard indexes** and **up to 9 MongoDB Search indexes** (4 text + 5 vector autoEmbed). Reranking via Voyage rerank-2.5 enabled by default (2s timeout, graceful fallback).

### 8 Retrieval Paths

The retrieval planner (`planRetrieval`) scores paths based on query analysis:

| Path              | When It Scores High                                            |
| ----------------- | -------------------------------------------------------------- |
| `active-critical` | Current-state, crisis, blocker, or "what matters now" queries  |
| `procedural`      | Workflow, runbook, process, or exact learned procedure lookups |
| `structured`      | Fact, preference, or current-truth lookups                     |
| `raw-window`      | Recent context ("what did I just say")                         |
| `graph`           | Entity names detected in query                                 |
| `episodic`        | Time-range or summary queries                                  |
| `kb`              | Reference material queries                                     |
| `hybrid`          | Broad lexical + vector fallback                                |

After retrieval, `crossEncoderRerank` (Voyage rerank-2.5, on by default) applies cross-encoder precision scoring with a 2-second timeout and graceful fallback, followed by `rerankResults` for source diversity, episode boost, deduplication, and backstop execution.

### Test Coverage

- ~300 v2 memory unit tests
- 1000+ total memory tests across 59 test files
- 82 live e2e tests against real MongoDB 8.2 + Voyage AI (production-readiness suite)

---

## Quick Start

**Prerequisites:** Node.js 22+ (24 recommended), Docker (for `mongodb-atlas-local:preview`), Voyage AI API key, an LLM API key (Anthropic Claude recommended).

```bash
# Start MongoDB (atlas-local:preview -- bundles mongod + mongot + search)
./docker/mongodb/start-preview.sh

npm install -g @romiluz/memongo@latest

memongo onboard --install-daemon
```

For Docker-based MongoDB setup, detailed configuration, and verification steps: [Getting Started with Memongo](docs/start/memongo-getting-started.md)

`openclaw` is shipped as an alias to `memongo` for compatibility.

### Memongo platform (SDK, HTTP API, MCP, web)

The [`memongo-platform/`](memongo-platform/) workspace ships a **self-hosted** product layer modeled after common open-source memory deployments: npm SDK (`@romiluz/memongo-platform`), versioned HTTP API (`apps/api`, `GET /openapi.json`), MCP, and a Next.js console. There is **no vendor email registration**—you bring **MongoDB** (for example [`mongodb/mongodb-atlas-local:preview`](https://hub.docker.com/r/mongodb/mongodb-atlas-local)) and set **environment variables** (`OPENCLAW_MONGODB_URI` or `MEMONGO_FORCE_MONGODB_URI`, `VOYAGE_API_KEY`, optional `MEMONGO_API_KEY` for Bearer protection on `/v1/*`).

| Step                                           | What to run                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Build engine (includes `memongo-bridge` chunk) | From repo root: `pnpm install` && `pnpm build`                                                                                  |
| Install platform workspace                     | `cd memongo-platform && pnpm install`                                                                                           |
| Run HTTP API                                   | `cd memongo-platform/apps/api && pnpm start` (set env vars first; see [memongo-platform/README.md](memongo-platform/README.md)) |
| Publish to npm                                 | [memongo-platform/docs/publish.md](memongo-platform/docs/publish.md)                                                            |
| Pre-release checklist                          | [memongo-platform/docs/PRODUCTION-READY.md](memongo-platform/docs/PRODUCTION-READY.md)                                          |

---

## For Agents: Install Memongo

If you are an AI agent (Claude, GPT, Cursor, Windsurf, etc.) helping a user set up Memongo, follow these steps exactly:

### Prerequisites Check

```bash
node --version        # Must be 22+ (24 recommended)
docker --version      # Docker Desktop must be installed and running
```

### Step 1: Start MongoDB (atlas-local:preview)

```bash
# Set Voyage AI API key (required for automated embeddings)
export VOYAGE_API_KEY="pa-..."

# Start the single-container MongoDB stack
# This bundles mongod + mongot + Atlas Search + Vector Search + auto-embeddings
./docker/mongodb/start-preview.sh

# Verify it's healthy
docker inspect --format='{{.State.Health.Status}}' memongo-preview
# Expected: "healthy"
```

> **Critical:** Use the `:preview` tag only. The `:latest`, `:8.0`, and `:8.2` tags do NOT include the community mongot with Voyage AI auto-embeddings.

### Step 2: Install Memongo

```bash
npm install -g @romiluz/memongo@latest
memongo --version
```

### Step 3: Run Onboarding

```bash
memongo onboard --install-daemon
```

The wizard will:

1. Prompt for Voyage AI API key (if not already set)
2. Auto-detect the atlas-local Docker container
3. Verify MongoDB topology (mongod + mongot)
4. Bootstrap 23 collections + 66 indexes + 9 search indexes
5. Configure LLM provider (Anthropic Claude recommended)
6. Optionally import knowledge base documents

### Step 4: Verify

```bash
memongo doctor                    # Check MongoDB + mongot + Voyage AI
memongo channels status --probe   # Check channel connectivity
memongo agent --message "Hello, remember my name is Alice" --thinking low
memongo agent --message "What is my name?" --thinking low
```

### Step 5: Connect a Channel (Optional)

```bash
# Telegram (quickest)
memongo config set channels.telegram.botToken "YOUR_BOT_TOKEN"
memongo gateway restart
```

### Troubleshooting

| Symptom                            | Fix                                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| `Connection refused` on port 27017 | Run `./docker/mongodb/start-preview.sh`                           |
| `mongot not detected`              | Ensure you're using `mongodb-atlas-local:preview` (not `:latest`) |
| `VOYAGE_API_KEY not set`           | `export VOYAGE_API_KEY=pa-...` then restart the Docker container  |
| Vector search returns empty        | Wait 30s for auto-embedding indexing to complete                  |

### Configuration Reference

Minimal `~/.openclaw/openclaw.json`:

```json
{
  "agent": { "model": "anthropic/claude-opus-4-6" },
  "memory": {
    "mongodb": {
      "uri": "mongodb://localhost:27017/openclaw?directConnection=true",
      "embeddingMode": "automated"
    }
  }
}
```

---

## The Full OpenClaw Platform

Memongo inherits the entire OpenClaw platform. Everything below works identically.

### 22 Messaging Channels

WhatsApp (Baileys), Telegram (grammY), Slack (Bolt), Discord (discord.js), Google Chat, Signal, BlueBubbles (iMessage), iMessage (legacy), IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, WebChat.

Full channel setup guides: [OpenClaw Docs -- Channels](https://docs.openclaw.ai/channels)

### 78 Extensions

- **22 messaging channels + 2 transport plugins** (voice call, device pairing)
- **25+ LLM provider plugins** (OpenAI, Anthropic, Google, Bedrock, Mistral, Ollama, OpenRouter, and more)
- **Tool plugins** (Brave search, Firecrawl, Tavily, browser control)
- **Media plugins** (ElevenLabs speech, Microsoft speech)
- **Infrastructure plugins** (OpenTelemetry, sandbox backends, MCP bridge)

### Companion Apps

- **macOS** -- menu bar control, Voice Wake, push-to-talk, Canvas, WebChat
- **iOS** -- Canvas, Voice Wake, Talk Mode, camera, screen recording, Bonjour pairing
- **Android** -- chat sessions, voice tab, Canvas, camera, SMS/contacts/calendar access

### Tools and Automation

- [Browser control](https://docs.openclaw.ai/tools/browser) -- dedicated Chrome/Chromium with CDP
- [Live Canvas + A2UI](https://docs.openclaw.ai/platforms/mac/canvas) -- agent-driven visual workspace
- [Voice Wake + Talk Mode](https://docs.openclaw.ai/nodes/voicewake) -- macOS/iOS/Android
- [Cron jobs](https://docs.openclaw.ai/automation/cron-jobs), [Webhooks](https://docs.openclaw.ai/automation/webhook), [Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub)
- [Skills platform](https://docs.openclaw.ai/tools/skills) -- bundled, managed, workspace skills

All links above point to the upstream [OpenClaw docs](https://docs.openclaw.ai). Memongo inherits this functionality unchanged.

---

## Development and Ops

### Install from Source

```bash
git clone https://github.com/romiluz13/Memongo.git
cd Memongo

pnpm install
pnpm ui:build
pnpm build

pnpm memongo onboard --install-daemon
pnpm gateway:watch  # dev loop with auto-reload
```

### Keep in Sync with Upstream

```bash
pnpm upstream:steady          # routine check -- exits clean if at 0 behind
pnpm upstream:report           # divergence + conflict hotspots before a merge wave
bash scripts/sync-upstream.sh --merge  # merge upstream when ready
```

Detailed workflow: [docs/reference/upstream-sync.md](docs/reference/upstream-sync.md)

### Development Channels

- **stable**: tagged releases (`vYYYY.M.D`), npm dist-tag `latest`
- **beta**: prerelease tags (`vYYYY.M.D-beta.N`), npm dist-tag `beta`
- **dev**: moving head of `main`, npm dist-tag `dev`

Switch: `memongo update --channel stable|beta|dev`

### Security Defaults (DM Access)

Memongo connects to real messaging surfaces. Treat inbound DMs as untrusted input.

Default behavior: **DM pairing** -- unknown senders receive a pairing code. Approve with `memongo pairing approve <channel> <code>`. Public inbound DMs require explicit opt-in (`dmPolicy="open"`).

Full security guide: [OpenClaw Docs -- Security](https://docs.openclaw.ai/gateway/security)

---

## Built on OpenClaw

Memongo is a fork of [OpenClaw](https://github.com/openclaw/openclaw), which is supported by these sponsors:

| OpenAI                                                            | Vercel                                                            | Blacksmith                                                                   | Convex                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Vercel](docs/assets/sponsors/vercel.svg)](https://vercel.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) | [![Convex](docs/assets/sponsors/convex.svg)](https://www.convex.dev/) |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=romiluz13/Memongo&type=date&legend=top-left)](https://www.star-history.com/#romiluz13/Memongo&type=date&legend=top-left)

## Community and Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, maintainers, and how to submit PRs.

Memongo is built on [OpenClaw](https://github.com/openclaw/openclaw) by Peter Steinberger and the community. MIT licensed.

- [memongo.site](https://memongo.site) | [Upstream Docs](https://docs.openclaw.ai) | [Discord](https://discord.gg/clawd)
