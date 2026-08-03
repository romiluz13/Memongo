# Installability & Production-Readiness — Deep Review Findings

Question: can a real user install and run Memongo in production today, end to end, without the author?

## Findings

- [SEV: critical] MCP server is not installable by any end user
  - Where: `apps/mcp/package.json:1-20` (`"private": true`, no `bin`, no `files`), `apps/mcp/package.json:8` (`"start": "node --import tsx src/server.ts"`), `apps/mcp/src/server.ts:2090-2096` (entry guard exists but is never exposed as a bin)
  - What: The MCP server — the primary agent-connectivity surface — is private, unpublished, has no `bin` entry, and its only run mode is `tsx` over raw TypeScript source.
  - Why it matters: An agent user cannot `npx @memongo/mcp` or add it to an MCP client config. The only path is clone the monorepo, `bun install`, build/run from source. This breaks the "agent-agnostic, easy to connect" priority for every non-author user.
  - Recommendation: Publish `@memongo/mcp` with a `bin` entry (`"memongo-mcp": "./dist/server.js"`), a `#!/usr/bin/env node` shebang, `files: ["dist"]`, drop the tsx runtime dependency for production, and document a one-line MCP client config (`npx -y @memongo/mcp`).

- [SEV: critical] `apps/api` has two contradictory deploy targets; the Workers target cannot run
  - Where: `apps/api/wrangler.jsonc:1-10` (`"main": "src/server.ts"`, `nodejs_compat`) vs `apps/api/src/server.ts:1-28` (uses `@hono/node-server` `serve()`, `process` signal handlers, 15s shutdown timer) and `apps/api/Dockerfile:69` (`CMD ["node", "apps/api/dist/server.js"]`)
  - What: wrangler.jsonc declares a Cloudflare Workers deployment whose entry point starts a Node HTTP server, registers SIGTERM handlers, and holds a long-lived MongoClient — none of which work on Workers.
  - Why it matters: Anyone following the wrangler config gets a broken deploy; anyone following the Dockerfile gets the real one. Ambiguity at the exact point of production deployment.
  - Recommendation: Delete `apps/api/wrangler.jsonc` (and the wrangler devDep in `apps/web` is fine, but the API is Node-only) or provide a genuine Workers entry point.

- [SEV: critical] Dev-stack "minimal" path gives a MongoDB that cannot run the product's core feature
  - Where: `docker/docker-compose.minimal.yml:4-9` (`image: mongo:7`, no mongot, no replica set) vs engine requirement for `$vectorSearch`/Atlas Search (`packages/memory-engine/src/mongodb-schema.ts` `ensureSearchIndexes`, `mongotHost` in `docker/mongodb/mongod.conf:8-11`)
  - What: The minimal compose starts a plain standalone mongo:7. Vector search and Atlas Search indexes cannot be created or queried there; semantic retrieval silently degrades or errors.
  - Why it matters: The cheapest documented on-ramp produces a system whose headline feature (semantic memory search) does not work. Only `docker/docker-compose.yml` / `docker-compose.preview.yml` (mongodb-atlas-local:preview) or the fullstack mongod+mongot stack actually work.
  - Recommendation: Remove or rename `docker-compose.minimal.yml`, or gate it with a loud health probe (`/v1/probes/vector` exists — wire it into the API healthcheck).

- [SEV: high] Shipped default credential `local-dev-secret` in code and compose
  - Where: `packages/pi-extension/extensions/index.ts:28` (`MEMONGO_API_KEY ?? "local-dev-secret"`), `docker/docker-compose.full.yml:31` (`MEMONGO_API_KEY=${MEMONGO_API_KEY:-local-dev-secret}`), `.env.example:9`, `apps/api/Dockerfile:13` (example run command)
  - What: A published npm package hardcodes a fallback bearer token, and the full compose defaults to the same token.
  - Why it matters: Any deployment that forgets MEMONGO_API_KEY is reachable with a publicly-known credential; the pi-extension will silently authenticate with the dev secret. Combined with `MEMONGO_ALLOW_INSECURE_NO_AUTH` escape hatch, the auth story fails open by default in exactly the configs a first-time user copy-pastes.
  - Recommendation: Never default a secret. pi-extension should omit the header when no key is set; compose should require the variable (`${MEMONGO_API_KEY:?set MEMONGO_API_KEY}`).

- [SEV: high] No readiness signal: `/health` is liveness-only and Mongo config is validated lazily
  - Where: `apps/api/src/app.ts` (`app.get("/health", (c) => c.json({ ok: true ... }))`, no DB probe), `packages/memory-bridge/src/memory-config.ts:44-75` (config built on demand), `packages/memory-engine/src/backend-config.ts` (throws "MongoDB URI required" only when the engine is first used)
  - What: The container healthcheck and Docker HEALTHCHECK hit `/health`, which returns ok even with no `MEMONGO_MONGODB_URI`, an unreachable cluster, or missing search indexes. The URI error surfaces on the first `/v1/*` request, not at boot.
  - Why it matters: Orchestrators (compose `depends_on: service_healthy`, k8s) will route traffic to a pod that cannot serve; users discover misconfiguration as runtime 500s instead of a clear boot failure.
  - Recommendation: Validate `MEMONGO_MONGODB_URI` at boot in `apps/api/src/server.ts` (fail fast with the existing backend-config error message), and add `/ready` that pings Mongo (`db.adminCommand('ping')`) plus optionally vector-index readiness; point HEALTHCHECK at `/ready`.

- [SEV: high] Web console first-run is broken cross-origin by default
  - Where: `apps/web/app/console/page.tsx` (`NEXT_PUBLIC_MEMONGO_API_URL ?? "http://127.0.0.1:3847"`), `apps/api/src/app.ts:417-419` (CORS middleware only applied when `MEMONGO_CORS_ORIGINS` is non-empty)
  - What: The browser console calls the API directly from origin :3040, but the API sends no CORS headers unless the operator sets MEMONGO_CORS_ORIGINS explicitly.
  - Why it matters: Out of the box, every console request fails in the browser with a CORS error; nothing in the boot output tells the operator why.
  - Recommendation: Default-dev CORS for `http://127.0.0.1:3040`/`localhost:3040`, or have the console proxy through the Next server; log the active CORS policy at boot.

- [SEV: high] No version-skew guard between client, MCP, pi-extension, and API
  - Where: `packages/client/src/client.ts` (`resolveBaseUrl`/`resolveApiKey`; no client version header sent), `apps/api/src/openapi-spec.ts` (`version: "1.0.0"` while packages are 2.x), `packages/pi-extension/package.json:36` (`@memongo/client: "2.0.0"` exact pin)
  - What: Nothing identifies client protocol version to the server; exact pins mean a pi-extension install forces client 2.0.0 regardless of API version deployed.
  - Why it matters: Silent behavior drift between a 2.x client and an older/newer self-hosted API; debugging "it works on my machine" across the four moving pieces (engine, API, MCP, pi-extension) has no telemetry hook.
  - Recommendation: Send `x-memongo-client-version` from the client; log/echo a server version in `/health` and `/v1/status`; document the compatibility matrix.

- [SEV: medium] Engine auto-creates collections, indexes, and search indexes at startup with no migration tooling or version gating
  - Where: `packages/memory-engine/src/mongodb-manager.ts` (init calls `ensureCollections`, `ensureStandardIndexes`, `ensureSearchIndexes`), `packages/memory-engine/src/mongodb-schema.ts` (`ensure*` family)
  - What: First engine start mutates the cluster: creates ~30 collections, standard indexes, Atlas Search/vector indexes. There is no schema-version record consulted for migrations (a `metaCollection` exists but no migration runner), no dry-run, and no lock — two API replicas starting concurrently both run ensure* (idempotent by name, but search-index updates can race).
  - Why it matters: Upgrades that change index shapes rely on ensure-logic being perfectly idempotent forever; there is no way to evolve or roll back schema deliberately in production.
  - Recommendation: Write a schema version to the meta collection, gate ensure* on it, and ship an explicit `memongo migrate` (or document that ensure* is the migration path and make it concurrency-safe).

- [SEV: medium] Dependency hygiene issues on published packages
  - Where: `packages/memory-engine/package.json:46` (`"mongodb": "7.2.0"` exact pin), `packages/memory-engine/package.json:49-51` (`optionalDependencies: node-llama-cpp >=3.0.0`), none of the published packages declare `engines` (only root `package.json:6-8`)
  - What: Consumers are forced to exactly mongodb 7.2.0 (no patch float; conflicts with apps pinning 7.x elsewhere), and every install attempts a heavy native module (node-llama-cpp) that will fail-build on many platforms (tolerated, but slow and noisy). No `engines` floor on any published package.
  - Recommendation: `"mongodb": "^7.2.0"` (or peer range), move node-llama-cpp behind an opt-in install documented separately, add `"engines": {"node": ">=20.19.0"}` to all publishable packages.

- [SEV: medium] Publish pipeline has no build-on-publish guard; version drift already present
  - Where: `.github/workflows/publish.yml:39-78` (builds in CI, ok), but no `prepublishOnly`/`prepack` in any `packages/*/package.json`; `packages/pi-extension/package.json:3` is `2.1.1` while everything else is `2.0.0`
  - What: A manual `npm publish` from a maintainer laptop ships whatever stale `dist/` is on disk. `scripts/check-publishability.ts` verifies dist exists but not that it is fresh. Versions are already drifting per-package with no changesets/lerna tooling.
  - Recommendation: Add `"prepublishOnly": "bun run build"` to each publishable package; adopt a versioning tool or a single release doc.

- [SEV: medium] check-publishability gaps
  - Where: `scripts/check-publishability.ts` (whole file)
  - What it enforces: metadata fields, dist entrypoints exist, tarball contains README + entrypoints, no src/tests/tsconfig leak, no `workspace:` or private deps in packed manifest, install-smoke import of each tarball. Good baseline.
  - What it misses: no `bin`/shebang validation (would not catch the MCP problem even if mcp were listed), no `engines`/`publishConfig.access` check, no `.d.ts` resolution check (publint/attw), no version-consistency check across packages, no check that optional native deps install cleanly, install smoke uses `npm install --ignore-scripts` so native postinstall failures are invisible.
  - Recommendation: Add publint + `@arethetypeswrong/cli` per tarball; assert `engines`; run the smoke install without `--ignore-scripts` for memory-engine.

- [SEV: medium] Env contract is scattered; secrets defaulted in compose
  - Where: ~60 distinct `MEMONGO_*` reads across `apps/api/src`, `apps/mcp/src`, `packages/memory-engine/src`, `packages/memory-bridge/src` (grep evidence); canonical resolution exists only for Mongo URI (`packages/memory-bridge/src/memory-config.ts`), API hardening vars are parsed inline in `apps/api/src/app.ts:18-68`; `docker/mongodb/docker-compose.mongodb.yml:26-27` defaults `MONGOT_PASSWORD:-mongotPassword`, `ADMIN_PASSWORD:-admin`
  - What: There is no single config schema/module; `.env.example` documents only a subset (no MEMONGO_CORS_ORIGINS, MEMONGO_API_SCOPED_KEYS documented but empty default, no MEMONGO_TRUST_PROXY, no rate-limit vars). Fullstack mongo compose ships hardcoded default passwords with `authorization: enabled` (`docker/mongodb/mongod.conf:14-16`).
  - Recommendation: One `config.ts` per app validating all env at boot with clear errors (zod or hand-rolled like app.ts parsers); fail-fast compose on unset passwords.

- [SEV: low] Docker runner image copies all of `packages/` including src/tests
  - Where: `apps/api/Dockerfile:58` (`COPY --from=installer ... /app/packages ./packages`)
  - What: The production image ships full monorepo sources (~143k LOC + tests), not just dist + production node_modules. Image bloat and larger attack surface; also `USER node` appears twice (Dockerfile:54, 63).
  - Recommendation: Copy only `packages/*/dist` + `packages/*/package.json`, or use `bun install --production` in a pruned workspace.

- [SEV: low] Version pins in dev stack
  - Where: `docker/docker-compose.minimal.yml:5` (`mongo:7` — major-only floating tag), `docker/mongodb/docker-compose.mongodb.yml` (`mongodb/mongodb-community-server:latest`), `docker/docker-compose.yml:21` (`mongodb/mongodb-atlas-local:preview`)
  - What: Floating tags mean the dev DB can change under users; `mongo:7` also predates `$rankFusion` (8.0) / `$scoreFusion` (8.2) which the engine's hybrid search may use per SHARED-CONTEXT criteria.
  - Recommendation: Pin digests/minor versions; keep atlas-local preview as the canonical dev stack.

- [SEV: low] pi-extension ships raw TypeScript loaded via jiti
  - Where: `packages/pi-extension/package.json:14-18` (`files: ["extensions"]`), `packages/pi-extension/extensions/index.ts`
  - What: Works only because Pi loads extensions through jiti; any change in Pi's loader breaks it. Also zero tests for the single 447-LOC file (per repo map).
  - Recommendation: Acceptable for the Pi ecosystem, but add at least a smoke test and pin a supported Pi version range instead of `"*"` peer ranges.

## Top 5

1. **MCP server is unreachable for end users** — `apps/mcp/package.json` is private, has no `bin`, runs only via tsx from source; the flagship agent surface requires a monorepo clone.
2. **Contradictory API deploy targets** — `apps/api/wrangler.jsonc` points Workers at a Node `serve()` entry (`apps/api/src/server.ts:8`) that cannot run there; Dockerfile is the real path.
3. **Minimal dev stack cannot serve semantic search** — `docker/docker-compose.minimal.yml:5` is plain `mongo:7`, no mongot/vector search, while the engine requires `$vectorSearch`.
4. **Default credential `local-dev-secret` shipped in published code** — `packages/pi-extension/extensions/index.ts:28` and `docker/docker-compose.full.yml:31`; auth fails open for copy-paste deploys.
5. **No readiness/boot validation** — `/health` (`apps/api/src/app.ts`) is liveness-only; missing/invalid `MEMONGO_MONGODB_URI` surfaces as per-request 500s instead of a boot failure (`packages/memory-engine/src/backend-config.ts`).

## Harmony note

The pieces are individually careful — the API has excellent auth/rate-limit hardening (`apps/api/src/app.ts`), the bridge has graceful shutdown, the publishability script is genuinely thorough — but they do not form one installable organism. The published packages (engine/bridge/client/tools) form a coherent library story; the *application* story (API + MCP + web + pi-extension) is where harmony breaks: the MCP server and web console are private monorepo citizens that assume you cloned everything, the API carries two incompatible deployment identities (Node Dockerfile vs Workers wrangler), the pi-extension bypasses the config contract by baking its own default credential, and each surface reads its own slice of the ~60-var env space with no shared schema. The seam that most needs alignment: a single "how a user connects" contract — one published MCP bin, one canonical env/config module validated at boot, one deploy target per app, and readiness semantics that reflect the engine's actual dependencies (Mongo + mongot). Until then, the system works end-to-end only in the exact shape the author runs it.

## Out-of-scope sightings

- `apps/api/src/openapi-spec.ts` declares `version: "1.0.0"` while packages ship 2.x — API/docs versioning inconsistency (docs/API-surface reviewer should confirm).
- `packages/memory-engine/src/mongodb-manager.ts` init auto-creates search indexes with no concurrency lock; multi-replica API deploys may race index updates (MongoDB-usage reviewer should confirm idempotency).
- `apps/web` has zero tests and `gsap` as a runtime dep for a console app (possible bloat for the leanness reviewer).
