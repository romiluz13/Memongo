# Security — Deep Review Findings

## Findings

- [SEV: medium] Raw internal error messages returned to API clients on every route
  - Where: `apps/api/src/routes/v1.ts:840-842` (and the identical `err instanceof Error ? err.message : String(err)` → `jsonError(c, 500, ...)` pattern repeated at ~30 sites: v1.ts:873, 916, 947, 974, 1013, 1053, 1093, 1140, 1222, 1341, 1361, 1402, 1489, 1525, 1710, 1723, 1735, 1745, 1761, ...)
  - What: every catch block forwards the raw exception message (MongoDB driver errors, file-system errors, parse errors with byte offsets, internal paths like `/app/packages/...`) into the HTTP response body.
  - Why it matters: leaks server internals (collection names, driver error details, absolute paths, dataset parse internals) to any authenticated caller; aids reconnaissance and, combined with finding below, leaks partial file-content metadata.
  - Recommendation: map known error classes to safe codes/messages; return a generic "internal error" plus a server-side log with a request id.

- [SEV: medium] `/v1/import/conversations` (and admin ingest) accept an absolute server-side file path with no `allowedRoots` wired
  - Where: `apps/api/src/routes/v1.ts:923-949` (`datasetPath` from body passed straight to `memongoBridgeImportConversations`); engine resolver `packages/memory-engine/src/mongodb-benchmark-dataset.ts:23-44` supports `allowedRoots` but the API route never sets it; only guards are extension `.json`/`.jsonl` and `..` rejection for relative paths (mongodb-benchmark-dataset.ts:32,42).
  - What: any holder of the master `MEMONGO_API_KEY` (scoped keys are blocked via `ADMIN_ONLY_V1_PATHS`, app.ts:599) can make the server read and parse any absolute `.json`/`.jsonl` path (`/app/config.json`, `package.json`, `tsconfig.json`, etc.); parse errors come back in the 500 message.
  - Why it matters: arbitrary read of JSON files on the API host; secrets are commonly stored in `.json` config files.
  - Recommendation: require `allowedRoots` (e.g. a `MEMONGO_DATASET_ROOT` env) and reject absolute paths outside it at the route layer.

- [SEV: medium] Multi-tenant isolation rests entirely on the master key being secret; no per-request tenancy verification below the engine filter
  - Where: master-token branch `apps/api/src/app.ts:560-563` (any bearer matching `MEMONGO_API_KEY` passes with zero scope checks); tenant filtering is only in engine queries, e.g. `packages/memory-engine/src/mongodb-manager.ts:1387-1398` (`{agentId, scope, scopeRef}` in vector/text filters) and `packages/memory-engine/src/mongodb-kb-search.ts:66-68` ("scopeRef is ALWAYS applied").
  - What: a master-key caller selects any tenant by passing `agentId`/`scopeRef`; the engine filters are the only enforcement and are correct, but there is no defense-in-depth (no per-manager assertion that returned docs match the requested agentId).
  - Why it matters: one leaked master key = full cross-tenant read/write of every agent's memories; any future code path that forgets a filter silently crosses tenants.
  - Recommendation: document master key as admin-only; consider a post-query assertion (dev mode) that result docs' agentId/scopeRef match the request namespace; encourage scoped keys (`MEMONGO_API_SCOPED_KEYS`) as default.

- [SEV: low] `search-kb` filter is cast, not validated — non-string values produce 500s
  - Where: `apps/api/src/routes/v1.ts:853-858` (`body.filter as {tags?...}` cast); `packages/memory-engine/src/mongodb-kb-search.ts:46-50` calls `.trim()` on `category`/`source` and `tag.trim()` on each tag with no `typeof` check.
  - What: `{"filter":{"category":{"$gt":""}}}` throws a TypeError (no operator injection — values land in exact-match positions only, mongodb-kb-search.ts:82-88), but every malformed request returns a 500 and the error message leaks internals (finding 1).
  - Recommendation: runtime-validate `tags: string[]`, `category: string`, `source: string` at the route (zod or typeof guards) and 400 on mismatch.

- [SEV: low] Request bodies are hand-validated; `metadata` and other nested objects pass through unvalidated
  - Where: `apps/api/src/routes/v1.ts:1494-1528` (`/add` passes `body.metadata` onward with only `typeof` checks elsewhere); no schema library used anywhere in apps/api despite `zod` being a dependency of packages/tools.
  - Why it matters: `$`-prefixed/dotted keys in client-supplied metadata are stored verbatim into Mongo documents, creating future query-shape corruption risk; validation drift across 40+ routes.
  - Recommendation: shared zod schemas per route family; reject keys starting with `$` or containing `.` in free-form metadata.

- [SEV: low] Docker dev stack ships default credentials and no-auth exposures
  - Where: `docker/mongodb/docker-compose.mongodb.yml:60-63` (`MONGODB_INITDB_ROOT_PASSWORD: ${ADMIN_PASSWORD:-admin}`, `MONGOT_PASSWORD:-mongotPassword`); `docker/mongodb/setup-generator.sh:10-11`; `docker/mongodb/start.sh:44,66` echoes the connection string including the live password to the terminal; `docker/docker-compose.minimal.yml:5-11` runs `mongo:7` with port `27017` published and no auth configured at all.
  - Why it matters: fine for local dev, but the minimal compose has zero authentication on a published port, and start.sh leaks the configured password into shell history/logs.
  - Recommendation: print the connection string with a password placeholder; add a loud warning on default credentials; bind published ports to 127.0.0.1.

- [SEV: low] Next.js pinned to an old 15.1.x line
  - Where: `apps/web/package.json` (`"next": "^15.1.0"`).
  - What: 15.1.x predates several Next security fixes (e.g. middleware authorization bypass CVE-2025-29927, fixed in 15.2.3). apps/web has no `middleware.ts` today (verified by glob), so current impact is limited, but the console proxies API data.
  - Recommendation: bump to latest 15.x (or 16.x) and pin.

- [SEV: low] Weak example API key in committed env template
  - Where: `.env.example:11` (`MEMONGO_API_KEY="local-dev-secret"`).
  - Why it matters: users routinely copy `.env.example` to production; a guessable documented default key defeats the otherwise strong auth layer.
  - Recommendation: use an obviously-fake placeholder (`"change-me-generate-a-long-random-token"`).

- [SEV: low] `/openapi.json` served unauthenticated
  - Where: `apps/api/src/app.ts:632` (outside the `/v1/*` auth middleware).
  - Why it matters: discloses the full route surface and parameter names to unauthenticated callers; minor recon aid. Likely intentional.

## Positives verified (no finding)

- Bearer comparison is timing-safe (SHA-256 pre-hash + `timingSafeEqual` + length check, `apps/api/src/app.ts:158-166`).
- Auth middleware is global on `/v1/*` (`app.ts:557`); all 40+ routes (enumerated v1.ts:819-2175) sit behind it — no per-route gap found. No-auth mode requires explicit `MEMONGO_ALLOW_INSECURE_NO_AUTH` and warns once (`app.ts:611-620`); fail-closed 401 when nothing configured (`app.ts:621-629`).
- Scoped-key policy validation fails closed (wildcard canonicalization, invalid scope rejection, admin/agent-global route denial) — `app.ts:264-320, 576-608`.
- Rate limiter: fixed-window, per-credential buckets keyed by hashed token, 100k bucket cap fails closed, X-Forwarded-For only honored behind `MEMONGO_TRUST_PROXY` (`app.ts:96-155`); body cap 1MB before JSON parse (`app.ts:532-553`); wildcard CORS rejected (`app.ts:56-59`).
- No `$where`, `eval`, `new Function`, or string-built Mongo queries in runtime code; all `$search`/`$vectorSearch` pipelines are object-built with query text as a value (mongodb-manager.ts:1268-1315, 1405-1430; mongodb-kb-search.ts:160-179). No operator passthrough found (KB filter lands in exact-match positions only).
- No `child_process` in runtime packages; only dev scripts (`scripts/real-capability-stress.ts:239`, `scripts/validate-mintlify-build.mjs:4`, `packages/memory-engine/src/test-helpers/preview-env.ts:1`) using fixed-arg `spawn`/`execFileSync` — no injection surface. No `curl|bash` anywhere.
- Tenant filters are present and consistent in engine queries (`{agentId, scope, scopeRef}` — mongodb-manager.ts:1256-1258, 1387-1390; mongodb-kb-search.ts:66-68; background jobs re-check scope mongodb-manager.ts:8421-8428).
- No hardcoded secrets in code; `.env.example` uses placeholders/empties; no code logs URIs or keys (grep for console.* near uri/apiKey/password/token: zero hits). MCP stdio server never writes to stdout outside the protocol (`apps/mcp/src/server.ts` — no `console.log`/`process.stdout`; key only used for the Authorization header via `packages/client/src/client.ts:100`).
- API Dockerfile runs as non-root `node` user, frozen lockfile, no secrets baked (`apps/api/Dockerfile`).
- Lockfile discipline: `bun.lock` at root, `bun install --frozen-lockfile` in Docker.

## Top 5

1. Raw `err.message` (Mongo/fs/parse internals) returned to clients on ~30 routes — `apps/api/src/routes/v1.ts:840-842` et al.
2. `/v1/import/conversations` reads arbitrary absolute `.json` paths on the server; `allowedRoots` supported but never wired — `apps/api/src/routes/v1.ts:923-949`, `packages/memory-engine/src/mongodb-benchmark-dataset.ts:23-44`.
3. Tenancy enforced only by engine query filters; master key crosses all tenants with no defense-in-depth — `apps/api/src/app.ts:560-563`, `packages/memory-engine/src/mongodb-manager.ts:1387-1398`.
4. `search-kb` filter and other bodies cast without runtime validation → 500s / metadata key smuggling — `apps/api/src/routes/v1.ts:853-858`, `packages/memory-engine/src/mongodb-kb-search.ts:46-50`.
5. Dev Docker stack: no-auth published Mongo port, default `admin:admin`, and start.sh echoes the live password — `docker/docker-compose.minimal.yml:5-11`, `docker/mongodb/start.sh:44,66`.

## Harmony note

Security posture is unusually coherent with the rest of the system: the auth layer, rate limiter, and body cap all live in one place (`apps/api/src/app.ts`) and apply uniformly, and the scoped-key policy engine deliberately shares its scope vocabulary with the route layer via `scope-identity.ts` so auth and execution cannot diverge (issue #57 fix) — that is the harmony ideal this repo espouses. The seams misalign at the edges: the route layer trusts the engine for tenancy (master key = global admin with no second check), the engine supports `allowedRoots` path confinement that the API never wires in, and validation philosophy is inconsistent (rigorous env/config validation in app.ts, cast-and-pray for request bodies in v1.ts) — the polish of the perimeter is not matched by polish at the handler boundary.

## Out-of-scope sightings

- `packages/memory-engine/src/mongodb-manager.ts:10881` — search result snippets can be blanked (`snippet: ""`) under some condition; possible silent data-shaping bug worth the engine reviewer checking.
- `apps/web/package.json` — `gsap` animation dependency in a console app feels like bloat (web/lean reviewer).
