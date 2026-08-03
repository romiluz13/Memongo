# SHARED ORCHESTRATOR BRIEF — Memongo Deep Review (2026-08-02)

You are one of 9 parallel review sub-agents. Read this file fully before doing anything else.

## ABSOLUTE RULE: code only, no prose

Do NOT read any informative/documentation file. This includes: all `.md` files (README, CLAUDE.md, AGENTS.md, CONTEXT.md, docs/, audit reports, changelogs), and any file whose content is prose, guidance, prompts, or instructions rather than executable logic. The ONLY exceptions are: this brief, and your own findings file.

If you open a file and the first lines show it is prose/docs, close it immediately and move on. You may peek at a few lines ONLY to classify the file.

ONLY read functional files: `.ts`, `.js`, `.mjs`, `.cjs`, functional `.json` (package.json, tsconfig.json, wrangler.jsonc, biome.json — NOT lock files), `.yml`/`.yaml` (compose, CI), `Dockerfile`, `.sh`, `.conf`, `.toml`, `.py` (competitors), `.env.example` if present.

## Ground rules for findings

- Every finding must cite repo-root-relative `path/file.ts:line`. For competitors, cite `memongo-competitors/<name>/<path>:line`.
- No speculation: every claim must be backed by code you actually read. Quote or paraphrase the exact code.
- Severity: `critical` (breaks production/data), `high` (real user impact), `medium` (quality/maintainability debt), `low` (polish).
- Do not fix code. Review only.
- Be concrete. "Consider improving X" is worthless. "X does Y at file:line, which causes Z; do W instead" is valuable.
- Write your full findings to your assigned file under `/Users/rom.iluz/Dev/memongo/.tmp-review/`.
- Return (as your final report) at most 50 lines: your TOP 5 findings with file:line, plus your harmony note.

## Findings file format

```
# <Area> — Deep Review Findings
## Findings
- [SEV: high] Short title
  - Where: `packages/.../file.ts:123`
  - What: what the code does
  - Why it matters: concrete consequence
  - Recommendation: specific change
## Top 5
## Harmony note
One paragraph: how does this area fit or fight the rest of the system? Where are the seams misaligned?
```

## Repo map (verified by orchestrator)

Monorepo (Turborepo + Bun). Total TS ~143k LOC.

- `packages/memory-engine/` — core. 229 src files, ~123k LOC, 115 test files. NOTABLE: `src/mongodb-manager.ts` is 11,265 LOC; `src/mongodb-schema.ts` 4,296 LOC; `src/mongodb-graph.ts` 1,954; `src/mongodb-search-executor.ts` 1,945; `src/mongodb-structured-memory.ts` 1,693; `src/types.ts` 1,645. Repo guideline says keep files under ~500 LOC.
- `packages/memory-bridge/` — facade over engine, 7 src files, 2,244 LOC, main file `src/memongo-bridge.ts` (1,301 LOC).
- `packages/client/` — HTTP client SDK, 3 files, 2,260 LOC, ZERO tests. `src/types.ts` 1,130 LOC, `src/client.ts` 1,049 LOC.
- `packages/tools/` — AI SDK tool helpers, 8 files, 1,564 LOC.
- `packages/lib/` — shared utils, 14 files, 1,173 LOC, ZERO tests.
- `packages/memongo-memory/` — 2-line re-export package (published alias).
- `packages/pi-extension/` — single 447-LOC file, ZERO tests.
- `apps/api/` — Hono HTTP API, 8 src files, 9,545 LOC (routes/v1.ts 2,221 LOC, openapi-spec.ts 2,803 LOC). Has Dockerfile + wrangler.jsonc.
- `apps/mcp/` — MCP stdio server, `src/server.ts` 2,095 LOC, 1 test file.
- `apps/web/` — Next.js console, 17 files, 695 LOC, ZERO tests.
- `docker/` — `docker-compose.minimal.yml`, `docker-compose.full.yml`, `docker/mongodb/` (mongod.conf, mongot.conf, init-mongo.sh, setup-generator.sh, start.sh, start-preview.sh, docker-compose.mongodb.yml, docker-compose.preview.yml).
- `scripts/` — publishability check, benchmark/eval harnesses, mongodb runtime parity/preflight scripts.
- Competitor code lives OUTSIDE the repo at `/Users/rom.iluz/Dev/memongo-competitors/`: mem0, zep, letta, supermemory, mastra, hindsight, mempalace, graphify, OpenViking (frameworks); Membench, locomo, memorybench, memory-benchmarks, openclaw-eval (benchmarks, lower priority).

## Review philosophy (the user's exact priorities)

1. MongoDB usage compared against official MongoDB guidance (criteria below).
2. Memory framework quality compared against competitors' actual code.
3. As lean as possible while staying as good as possible — perfect balance of quality and efficiency. Flag bloat AND flag harmful over-leaning (missing validation, missing tests).
4. HARMONY between all moving pieces — the user's most emphasized word. Packages, apps, contracts, naming, error shapes, lifecycle should feel like one organism.
5. Installability and "it actually works" — real production usability.
6. Agent-agnostic connectivity — from coding agents to any agent; as easy to connect as possible.

## MongoDB official criteria (distilled from MongoDB's own skills/docs)

### Indexing & queries
- ESR rule: compound index field order = Equality → Sort → Range.
- Every hot query shape needs a supporting index; no COLLSCAN on request paths.
- Redundant indexes: `{a:1,b:1}` makes `{a:1}` redundant; ≤ ~20 indexes/collection; index count costs write throughput.
- Covered queries (projection within index) on hottest paths; always project only needed fields.
- Aggregation: `$match`/`$limit` as early as possible; avoid `$where`, `$regex` scans, `$lookup` fan-out (excessive-lookups anti-pattern); `$lookup` only when embedding genuinely wrong.
- Updates: targeted `$set`/`$inc`/`$push` operators (oplog-efficient), never read-modify-write full-document replace when atomic operators suffice; use `findOneAndUpdate` for atomic claim patterns.
- Deep `skip` pagination is O(n); prefer range/keyset pagination.

### Vector / Atlas Search
- `$vectorSearch` must be the FIRST stage of its pipeline; index `numDimensions` must match embedding model exactly; `similarity` metric must match training (cosine/dot/euclidean).
- `numCandidates` must be ≥ `limit`, typically 10–20× limit for recall.
- Prefilters: `filter` fields must be indexed in the search index definition; filtering post-hoc kills recall.
- Hybrid search: `$rankFusion` requires MongoDB 8.0+, `$scoreFusion` requires 8.2+ — version gate or fallback needed.
- Lexical search: Atlas Search `$search`; NEVER `$regex` or legacy `$text` for search use cases.
- Embedding writes should batch; embedding dimension must be consistent across all writes.

### Schema design
- Core principle: "data accessed together is stored together." Embed 1:1 and bounded 1:few; reference unbounded 1:N and M:N.
- Unbounded arrays → 16MB document limit risk; use bucket/outlier/subset patterns.
- Don't split homogeneous data into many collections (unnecessary-collections anti-pattern); don't over-normalize (this is not SQL).
- `$jsonSchema` validation (start `moderate`/`warn`, tighten to `strict`/`error`) where data quality matters.
- Schema versioning pattern for evolving documents.

### Connections & lifecycle
- ONE MongoClient per process, created once, reused; never connect per operation; close only at shutdown.
- Pool: default maxPoolSize 100 is usually right; justify any override with concurrency math; each connection ≈ 1MB server RAM; formula: instances × (maxPoolSize+2) × replica members.
- Set timeouts deliberately: connectTimeoutMS, socketTimeoutMS, serverSelectionTimeoutMS, maxIdleTimeMS, waitQueueTimeoutMS.
- Serverless: client cached outside handler scope.
- Retryable reads/writes on by default; writeConcern `majority` for data that matters; readConcern appropriate to consistency needs.
- Graceful shutdown: stop accepting work, drain, close client.

## Cross-agent coordination

Other agents are reviewing other areas in parallel. Do not duplicate their entire scope; go deep on yours. If you notice something big outside your scope, add one line in a `## Out-of-scope sightings` section (file:line + one sentence) so the orchestrator can cross-reference.
