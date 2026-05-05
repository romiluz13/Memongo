# Memongo Parity And Ship Audit

Date: 2026-03-25

## Executive Summary
- Ship recommendation: `no-go`
- ClawMongo core-memory parity: `partial`
- Supermemory public-surface parity: `not achieved`
- Production readiness: `not achieved`

Memongo already contains most of the ClawMongo memory primitives in the active engine and bridge, and the standalone API is live enough to answer `GET /health`, serve `GET /openapi.json`, and report a MongoDB-backed status surface. The project is not ready to ship as a production standalone product because the verification gates are red, first-party public surfaces disagree on request contracts, and several user-facing docs still describe an older `memongo-platform` / `@romiluz/*` / OpenClaw-oriented packaging model that no longer matches the active repo.

## Scope And Method
This audit executed the attached plan against three targets:
- Memongo itself in this repo
- ClawMongo core memory behavior only
- Supermemory public product surface only

Evidence came from:
- Active code and docs in this repo
- Read-only comparison against `ClawMongo-v2` and `supermemory`
- Runtime smoke probes against the local API already running on `127.0.0.1:3847`
- Local verification commands:
  - `bun run check-types`
  - `bun run test`
  - `bun run build`
  - `bun run lint`
  - targeted package checks and tests in `packages/lib`, `packages/memory-bridge`, `packages/memory-engine`, `apps/api`, `apps/mcp`, and `apps/web`

## 1. Frozen Product Inventory
### What Memongo currently ships

| Surface | Active paths | Notes |
|---|---|---|
| Core engine | `packages/memory-engine` | MongoDB-native memory engine with events, graph, episodes, KB, relevance, telemetry, cache, migration |
| Stable facade | `packages/memory-bridge`, `packages/memongo-memory` | Product-facing facade over the engine |
| HTTP API | `apps/api` | Hono server on `127.0.0.1:3847` by default |
| MCP server | `apps/mcp` | stdio MCP wrapper over the HTTP API |
| TS SDK | `packages/client` | `MemongoClient` |
| AI tools | `packages/tools` | `createMemongoTools(client)` |
| Web console | `apps/web` | Minimal Next.js console |
| Docs app | `apps/docs` | Mintlify docs app |
| Extra workspace apps | `apps/browser-extension`, `apps/memory-graph-playground` | Part of workspace build surface even though they are not central in the root README |
| Published React component | `packages/memory-graph` | Additional public surface not reflected in the core product story |

### Actual public entrypoints
- Runtime HTTP endpoints observed from `GET /openapi.json`:
  - `/health`
  - `/openapi.json`
  - `/v1/add`
  - `/v1/admin/relevance/benchmark`
  - `/v1/admin/relevance/explain`
  - `/v1/admin/relevance/report`
  - `/v1/admin/relevance/sample-rate`
  - `/v1/probes/embedding`
  - `/v1/probes/vector`
  - `/v1/profile`
  - `/v1/read-file`
  - `/v1/search`
  - `/v1/search-kb`
  - `/v1/stats`
  - `/v1/status`
  - `/v1/status/detailed`
  - `/v1/sync`
  - `/v1/write-event`
  - `/v1/write-procedure`
  - `/v1/write-structured`
- SDK methods in `packages/client/src/client.ts`:
  - `add()`, `search()`, `searchKB()`, `readFile()`, `writeEvent()`, `writeStructured()`, `writeProcedure()`, `profile()`, `status()`, `getDetailedStatus()`, `stats()`, `sync()`, `probeEmbedding()`, `probeVector()`, `relevanceExplain()`, `relevanceBenchmark()`, `relevanceReport()`, `relevanceSampleRate()`
- MCP tools in `apps/mcp/src/server.ts`:
  - `memongo_search`
  - `memongo_search_kb`
  - `memongo_read_file`
  - `memongo_add`
  - `memongo_write_event`
  - `memongo_profile`
  - `memongo_status`
- Web console tabs in `apps/web/app/page.tsx`:
  - `search`
  - `kb`
  - `status`
  - `profile`
  - `health`

### Inventory conclusion
The active repo is broader than the root README suggests. The product story is framed as engine + API + MCP + web, but the workspace also includes a docs app, browser extension, playground, and memory graph package. Those extra surfaces matter for ship readiness because Turbo includes them in workspace operations.

## 2. Track A: ClawMongo Core-Memory Parity
### Capability matrix

| Capability | Status | Memongo evidence | Notes |
|---|---|---|---|
| Event-sourced writes and chunk projection | `present` | `packages/memory-engine/src/index.ts`, `packages/memory-engine/src/mongodb-events.ts`, `packages/memory-bridge/src/memongo-bridge.ts` | Matches the ClawMongo event + projection model at the API layer through `write-event` and `add` |
| Hybrid retrieval and fusion | `present` | `packages/memory-engine/src/mongodb-manager.ts`, `packages/memory-engine/src/mongodb-hybrid.ts`, `packages/memory-engine/src/mongodb-search.ts` | Includes fusion, hybrid backstop, and score normalization |
| Retrieval planner with 8 paths | `present` | `packages/memory-engine/src/mongodb-retrieval-planner.ts` | Active paths are `active-critical`, `structured`, `raw-window`, `graph`, `hybrid`, `kb`, `episodic`, `procedural` |
| Structured memory | `present` | `packages/memory-engine/src/mongodb-structured-memory.ts` | Includes salience, validity windows, provenance, supersession, and revisions |
| Procedures | `present` | `packages/memory-engine/src/mongodb-procedures.ts` | Includes versioning, intent tags, outcomes, and evolution |
| Profile synthesis | `present` | `packages/memory-engine/src/mongodb-profile.ts`, `packages/memory-bridge/src/memongo-bridge.ts` | Reads across structured memory, entities, episodes, and events |
| Knowledge base ingest and search | `present` | `packages/memory-engine/src/mongodb-kb.ts`, `packages/memory-engine/src/mongodb-kb-search.ts`, `apps/api/src/routes/v1.ts` | Dedicated KB ingest and query surfaces exist |
| Graph entities and traversal | `present` | `packages/memory-engine/src/mongodb-graph.ts` | Includes entity upserts, relations, and bounded `$graphLookup` expansion |
| Episodes | `present` | `packages/memory-engine/src/mongodb-episodes.ts` | Includes daily, weekly, thread, topic, and decision episode types |
| Query cache | `present` | `packages/memory-engine/src/mongodb-query-cache.ts`, `packages/memory-engine/src/mongodb-manager.ts` | Cache participates in search execution |
| Reranking | `present` | `packages/memory-engine/src/mongodb-reranker.ts`, `packages/memory-engine/src/mongodb-manager.ts` | Heuristic rerank plus cross-encoder path |
| Relevance, telemetry, mutations, ops | `present` | `packages/memory-engine/src/mongodb-relevance.ts`, `packages/memory-engine/src/mongodb-telemetry.ts`, `packages/memory-engine/src/mongodb-mutations.ts`, `packages/memory-engine/src/mongodb-ops.ts` | Core observability surface is present |
| Migration | `present` | `packages/memory-engine/src/mongodb-migration.ts` | Backfill path exists |
| Sync and config semantics | `partial` | `packages/memory-engine/src/mongodb-sync.ts`, `packages/memory-engine/src/backend-config.ts`, `packages/memory-bridge/src/memory-config.ts` | Sync, source toggles, change streams, TTL, and standalone config exist, but Memongo intentionally narrows the deployment contract to MongoDB-only, `community-mongot`, and `automated` embeddings |

### Track A assessment
At the design and code-surface level, Memongo preserves nearly all in-scope ClawMongo memory capabilities. The gap is not missing memory subsystems; the gap is verification and confidence:
- `packages/memory-engine` tests currently fail heavily in this workspace: 63 failed, 729 passed, 271 skipped.
- `packages/memory-bridge` tests are stale and fail against removed symbols.
- `bun run check-types` does not pass, so parity cannot be certified as production-ready even though the feature surface is largely present.

### Track A verdict
`partial`

Reason:
- Feature coverage is high enough to say the standalone product is built from the ClawMongo memory model.
- Production verification is red, so 100 percent parity cannot be claimed yet.

## 3. Track B: Supermemory Public-Surface Parity
### Surface matrix

| Surface | Status | Evidence | Gap |
|---|---|---|---|
| Product positioning and top-level quickstart | `partial` | `README.md`, `apps/docs/introduction.mdx`, `apps/docs/quickstart.mdx` | Good high-level positioning, but the top-level product story does not fully cover SDK, MCP config, docs entry, or dashboard flow the way Supermemory does |
| API discoverability and OpenAPI | `partial` | `apps/api/src/openapi-spec.ts`, runtime `GET /openapi.json` | Runtime OpenAPI exists and is reachable, but root docs do not reflect the full surface and docs examples use the wrong request fields |
| SDK install and usage story | `partial` | `packages/client/src/client.ts`, `packages/client/src/types.ts`, `apps/docs/quickstart.mdx` | SDK exists, but docs examples call `client.search({ q: ... })` instead of `query` |
| MCP product story | `partial` | `apps/mcp/src/server.ts`, `apps/docs/guides/cli-memory.mdx` | MCP server exists, but user-facing docs do not explain real tool names or client config clearly |
| Docs and onboarding | `fail` | `apps/docs/*.mdx`, `docs/platform/*.md`, `docs/start/memongo-getting-started.md` | Multiple docs still describe old package names, old repo layout, OpenClaw/gateway flows, and broken examples |
| Web console and dashboard feel | `partial` | `apps/web/app/page.tsx`, `apps/web/app/layout.tsx` | There is a working console concept, but it is closer to an API tester than a polished dashboard or onboarding surface |
| Terminology consistency | `fail` | `README.md`, `apps/docs/introduction.mdx`, `docs/platform/PLATFORM-README.md`, `docs/platform/publish.md`, `docs/platform/PRODUCTION-READY.md` | Active repo mixes `@memongo/*`, `@romiluz/*`, `memongo-platform`, `packages/bridge`, `packages/engine`, and OpenClaw wording |
| First-party surface contract alignment | `fail` | `apps/browser-extension/utils/api.ts`, `apps/memory-graph-playground/src/app/api/graph/route.ts`, `apps/api/src/routes/v1.ts` | Some first-party clients still send legacy `q` / `containerTag` payloads that the standalone API does not accept |

### Track B assessment
Memongo has the pieces of a Supermemory-shaped standalone product:
- standalone API
- standalone SDK
- MCP server
- docs app
- web console

The public packaging is not yet coherent enough to claim parity. A new user following the current docs can easily hit broken examples, wrong package names, or wrong request fields before they succeed.

### Track B verdict
`not achieved`

## 4. Runtime And Configuration Reality
### Runtime smoke checks
- `GET http://127.0.0.1:3847/health` returned `{"ok":true,"service":"memongo-api"}`
- `GET http://127.0.0.1:3847/openapi.json` returned the full endpoint surface listed above
- `GET http://127.0.0.1:3847/v1/status?agentId=stress-test` returned:
  - backend: `mongodb`
  - sources: `conversation`, `reference`, `structured`

### Confirmed contract mismatches
- `README.md` documents only a subset of the actual API and omits `/v1/read-file` and all `/v1/admin/relevance/*` routes.
- `apps/docs/quickstart.mdx` uses `q` and `containerTag` in both TypeScript and HTTP examples, but the actual API route requires `query` and `sessionKey`, and the SDK requires `query`.
- `apps/docs/api/overview.mdx` repeats the same broken search example.
- `apps/docs/guides/cli-memory.mdx` lists MCP tools as `search`, `add`, `write_event`, `write_structured`, `profile`, and `status`, but the actual tool names are `memongo_search`, `memongo_add`, `memongo_write_event`, `memongo_profile`, and `memongo_status`.
- `apps/browser-extension/utils/api.ts` posts `{ content, containerTag }` to `/v1/add` and `{ q, containerTag }` to `/v1/search`. The route implementation in `apps/api/src/routes/v1.ts` reads `sessionId` for add and `query` / `sessionKey` for search, so the browser extension does not match the standalone contract.
- `apps/memory-graph-playground/src/app/api/graph/route.ts` also posts `{ q, containerTag }` to `/v1/search`, and if search fails it returns an empty graph instead of surfacing the upstream error.
- `apps/docs/guides/memory-config.mdx` documents `MEMONGO_DATABASE`, but that variable is not implemented anywhere in the active code.
- `apps/docs/guides/memory-config.mdx` also says Atlas is supported, while `packages/memory-engine/src/backend-config.ts` explicitly rejects `.mongodb.net` URIs.

### Configuration reality assessment
The runtime surface is more internally consistent than the docs surface. The code says one thing and several docs and first-party clients still say another. That makes the standalone product easy to misuse even though the core API itself is live.

## 5. Quality Gates Before Ship
### Command results

| Command | Result | Key evidence |
|---|---|---|
| `bun run check-types` | `fail` | stopped at `packages/lib/src/ssrf.ts`: `LookupAddress` is not exported from `node:dns/promises` |
| `bun run test` | `fail` | `apps/api` exits 1 because it defines `vitest run` with no test files |
| `bun run build` | `fail` | `@memongo/web#build` cannot resolve `apps/web/node_modules/next/dist/bin/next` |
| `bun run lint` | `fail` | Biome reported 15,177 errors, 5,503 warnings, 985 infos in 14,172 files |
| `packages/memory-bridge: bun run test` | `fail` | `memory-config.test.ts` imports and exercises removed symbols |
| `packages/memory-engine: bun run test` | `fail` | 63 failed, 729 passed, 271 skipped |

### High-signal quality findings
- `packages/lib/src/ssrf.ts` blocks typecheck immediately with a Node types mismatch.
- `tsconfig.base.json` targets `ES2022`, but active engine code uses `toSorted()` and `toReversed()`, generating type errors in multiple files during `check-types`.
- `packages/memory-bridge/src/memory-config.test.ts` still imports `buildStandaloneOpenClawConfig` and `shouldUseMemongoStandaloneConfig`, but `packages/memory-bridge/src/memory-config.ts` exports neither symbol.
- `apps/api/package.json` defines `"test": "vitest run"` with no tests in `apps/api`, which makes the workspace test gate fail by construction.
- `packages/memory-engine` has broad test drift across search, watcher, analytics, events, multimodal internals, and embeddings.
- `.github/workflows/ci.yml` only typechecks a subset of packages and does not include `apps/api`, `apps/mcp`, `apps/web`, `apps/browser-extension`, or `apps/memory-graph-playground`.
- `.github/workflows/publish.yml` publishes with `--no-git-checks` and swallows publish failures with `|| true`, which can hide broken release attempts.
- `apps/web/package.json` advertises Cloudflare preview and deploy scripts, but no `wrangler` config file is checked into `apps/web`.

### Quality-gate verdict
`fail`

There is no honest way to call the current repo production-ready while the workspace fails typecheck, test, build, and lint in the observed environment.

## 6. Prioritized Gap List
### P0
- Fix the standalone API contract drift across first-party surfaces:
  - align `apps/browser-extension/utils/api.ts`
  - align `apps/memory-graph-playground/src/app/api/graph/route.ts`
  - either accept `containerTag` aliases in `apps/api/src/routes/v1.ts` or make every first-party caller use `sessionId` and `sessionKey`
- Make the workspace verification gates pass:
  - root `check-types`
  - root `test`
  - root `build`
  - root `lint`

### P1
- Rewrite the public docs so the active product story is consistent:
  - remove old `memongo-platform` / `@romiluz/*` / OpenClaw package instructions
  - correct broken quickstart and API examples
  - correct MCP tool names and setup examples
  - correct unsupported config variables and Atlas claims
- Expand CI coverage to include the shipped app surfaces, not only a subset of packages.
- Remove `|| true` and `--no-git-checks` from the publish workflow unless there is a documented and justified exception.

### P2
- Upgrade the web console from an internal API console to a real standalone product dashboard.
- Decide whether `apps/browser-extension`, `apps/memory-graph-playground`, and `packages/memory-graph` are part of the public standalone release, then document and gate them accordingly.

## 7. Risk Register

| Risk | Probability | Impact | Evidence | Mitigation |
|---|---|---|---|---|
| First-party clients send wrong request fields | high | high | `apps/browser-extension/utils/api.ts`, `apps/memory-graph-playground/src/app/api/graph/route.ts`, `apps/api/src/routes/v1.ts` | unify request contracts and add contract tests |
| Users follow broken docs and hit immediate failures | high | high | `apps/docs/quickstart.mdx`, `apps/docs/api/overview.mdx`, `apps/docs/guides/cli-memory.mdx`, `docs/platform/*.md`, `docs/start/memongo-getting-started.md` | docs rewrite and doc tests |
| Production verification stays red | high | high | failing root commands and targeted package tests | repair typecheck, tests, build, lint before release |
| CI misses regressions in shipped app surfaces | high | medium | `.github/workflows/ci.yml` filtered typecheck | widen CI scope |
| Publish workflow hides broken releases | medium | high | `.github/workflows/publish.yml` | fail hard on publish and restore checks |
| Web deployment path is incomplete | medium | medium | `apps/web/package.json` deploy scripts with no checked-in wrangler config | either finish or remove deploy story |

## 8. Final Recommendation
Current state: `no-go`

Memongo is close to the right product shape, but it is not safe to ship as a polished standalone memory product yet.

What is already true:
- The core ClawMongo memory model is mostly present in the active engine.
- The standalone HTTP API is real and reachable.
- The SDK, MCP server, docs app, and web console all exist.

What blocks ship:
- workspace verification is red
- docs and first-party clients disagree with the actual standalone API contract
- public packaging still mixes active Memongo names with old `memongo-platform` and `@romiluz/*` instructions

Conditions to move from `no-go` to `conditional go`:
1. Green `bun run check-types`, `bun run test`, `bun run build`, and `bun run lint`.
2. Correct request-contract alignment across API, SDK, browser extension, memory graph playground, and docs examples.
3. Replace stale platform docs with one coherent standalone Memongo install and usage story.
4. Expand CI so the app surfaces that users actually touch are gated before release.

Until those conditions are met, claiming 100 percent parity or production readiness would overstate the current state of the repo.
