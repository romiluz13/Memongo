# API

Active contributors: Rom Iluz

`apps/api` is the Hono HTTP server that fronts Memongo's memory engine. In a standard deployment it is the only process that opens a MongoDB connection: everything else (the web console, the MCP server, the client SDK, AI SDK tools) talks to MongoDB indirectly by calling this app over HTTP. See [Architecture](../../overview/architecture.md) for how it fits into the four-layer system (surfaces -> facade -> engine -> MongoDB) and [Memory bridge](../../packages/memory-bridge.md) for the facade it calls into.

This page covers the app's internal shape: directory layout, the request pipeline, and where to make changes. For the wire contract (endpoints, request/response bodies) see [API](../../api/index.md). For auth, CORS, and rate-limiting design rationale, see [Security](../../security.md). For the scope/tenant model enforced by scoped API keys, see [Multi-tenancy and scopes](../../features/multi-tenancy-and-scopes.md). For how the app is containerized and deployed, see [Deployment](../../deployment.md).

Route registration, middleware detail, and the OpenAPI document assembly are covered in [Routes and middleware](routes-and-middleware.md).

## Directory layout

```
apps/api/
  src/
    app.ts                  Hono app factory: auth, CORS, rate limit, body limit, health/ready, graceful shutdown
    server.ts               process entry point: boot validation, capability probe, serve(), signal handlers
    scope-identity.ts        shared scope/agentId/scopeRef resolution (auth and routes read identity identically)
    version.ts               MEMONGO_API_VERSION, must match root package.json
    openapi-spec.ts           assembles the OpenAPI document from the path fragments below
    openapi-schemas.ts        shared OpenAPI schema fragments (scope enum, idempotency, TTL wording)
    openapi-paths-*.ts        one file per route family's OpenAPI path definitions
    routes/
      v1.ts                   router entry point: body pre-parse middleware, registers each route family
      v1-helpers.ts           shared request-body readers, validation-error mapping, limits
      v1-search-routes.ts      search, search-kb, recall-conversation, import, search-detailed
      v1-context-routes.ts     hydrate-active-slate, discovery-projection, context-bundle, read-file
      v1-write-routes.ts       add, write-event(s), extract, write-structured, write-procedure
      v1-lifecycle-routes.ts   lifecycle get/update/delete/history, procedure outcome, memory feedback
      v1-status-routes.ts      profile, state, status, stats, sync, embedding/vector probes
      v1-admin-routes.ts       relevance explain/report, access trends/summaries, traces, jobs
      v1-maintenance-routes.ts chain-trace, novelty-scan, consolidate, self-edit
    lib/
      boot-env.ts             fail-fast check that a MongoDB URI resolves before the port binds
      capabilities.ts          derives/logs which search lanes (vector/keyword/hybrid/text) are available at boot
      errors.ts                canonical `{ error: { code, message } }` envelope, dependency-unavailable -> 503 mapping
      readiness.ts             GET /ready lane checks: mongo ping, vector probe, embedding probe
      validation.ts            Zod schemas for write-family bodies, KB filters, and free-form metadata
  Dockerfile                 multi-stage production image (turbo prune + bun build + node runtime)
```

## Key abstractions

| Concern | File(s) |
|---|---|
| App factory, auth, CORS, rate limit, body limit | `apps/api/src/app.ts` |
| Process entry point, boot checks, graceful shutdown wiring | `apps/api/src/server.ts` |
| Shared scope/agentId/scopeRef resolution (auth <-> routes) | `apps/api/src/scope-identity.ts` |
| Route registration and body pre-parse | `apps/api/src/routes/v1.ts` |
| Route families (8 files) | `apps/api/src/routes/v1-*-routes.ts` |
| Shared route helpers (readers, limits, idempotency) | `apps/api/src/routes/v1-helpers.ts` |
| Boot-time MongoDB URI check | `apps/api/src/lib/boot-env.ts` |
| Search-lane capability detection and logging | `apps/api/src/lib/capabilities.ts` |
| Error envelope and 503 classification | `apps/api/src/lib/errors.ts` |
| Liveness/readiness checks | `apps/api/src/lib/readiness.ts` |
| Zod input validation | `apps/api/src/lib/validation.ts` |
| OpenAPI document assembly | `apps/api/src/openapi-spec.ts`, `apps/api/src/openapi-schemas.ts`, `apps/api/src/openapi-paths-*.ts` |
| Release version constant | `apps/api/src/version.ts` |
| Production container image | `apps/api/Dockerfile` |

## How it works: request path

Every `/v1/*` request passes through the same middleware chain before it reaches a route handler. Order matters: request-id assignment happens first so every later rejection can be correlated, rate limiting happens before body parsing so an attacker cannot spend CPU on JSON parsing before being throttled, and the body-size cap runs before any handler reads the body.

```mermaid
sequenceDiagram
    participant Caller
    participant App as apps/api/src/app.ts
    participant V1 as routes/v1.ts
    participant Route as route family handler
    participant Bridge as memory-bridge

    Caller->>App: HTTP request
    App->>App: secureHeaders(), CORS check
    App->>App: requestId() (on /v1/*)
    App->>App: rate limiter (per credential or trusted-proxy IP)
    App->>App: bodyLimit() (default 1 MB, before JSON parsing)
    App->>App: bearer auth: MEMONGO_API_KEY or a scoped API key policy
    App->>App: scoped-key checks: route policy, admin-only paths, agent-global paths
    App-->>Caller: 401/403/429/413 (short-circuit on any failure)
    App->>V1: next()
    V1->>V1: parseJsonRequestBody() once, stash on context
    V1->>Route: dispatch by path
    Route->>Route: scope-identity.ts resolves agentId/scope/scopeRef; lib/validation.ts validates body
    Route->>Bridge: memongoBridge*(params)
    Bridge-->>Route: typed result or thrown error
    Route-->>Caller: 200 {...} or a mapped error envelope
```

Two failure paths bypass this chain deliberately: a deliberate `HTTPException` thrown by Hono internals (e.g. the body-limit middleware) returns its own response via `app.onError`, and anything unexpected falls through to `lib/errors.ts`'s `internalError`, which logs the raw error server-side under the request id and returns a generic `INTERNAL` 500 (or `SERVICE_UNAVAILABLE` 503 for a recognized MongoDB network failure) — raw driver messages, hostnames, and stack traces never reach the client.

`GET /health` (liveness) and `GET /ready` (deep readiness: mongo ping + vector probe + embedding probe, from `apps/api/src/lib/readiness.ts`) sit outside the `/v1/*` auth chain because container orchestrators probe them without an API key. `GET /openapi.json` serves the assembled OpenAPI document unauthenticated as well.

## Integration points

- **Calls into `packages/memory-bridge`**: every route handler's terminal action is a `memongoBridge*` function call (for example `memongoBridgeSearch`, `memongoBridgeAdd`, `memongoBridgeWriteConversationEvent`). The app never imports `packages/memory-engine` directly.
- **Calls into `packages/lib`**: the canonical scope enum (`MEMORY_SCOPE_VALUES`), the `ApiError` envelope schema, the bearer security scheme, and the route table used for OpenAPI/route conformance checking all come from `packages/lib/src/contract.ts` and friends, re-exported through `apps/api/src/scope-identity.ts` and `apps/api/src/openapi-spec.ts`.
- **Consumed by**: `packages/client`'s `MemongoClient` (HTTP calls), `apps/mcp` (stdio MCP server that proxies tool calls to `/v1/*`), and `apps/web` (the console, via `MEMONGO_API_URL`). None of these call MongoDB directly — see [Architecture](../../overview/architecture.md).
- **Contract conformance**: `apps/api/src/contract-conformance.test.ts` fails CI if the hand-written OpenAPI paths and the live router disagree, keeping `apps/api/src/openapi-spec.ts` honest against `apps/api/src/routes/v1.ts`.

## Entry points for modification

- **Add a new `/v1` endpoint**: add the field/route definition to `packages/lib/src/contract.ts` first, then add the handler to the relevant `apps/api/src/routes/v1-*-routes.ts` file (or create a new route family file and register it in `apps/api/src/routes/v1.ts`), then add its OpenAPI path fragment to the matching `apps/api/src/openapi-paths-*.ts` file. The conformance test enforces that all three agree.
- **Change auth or rate-limit behavior**: `apps/api/src/app.ts` (scoped API key policy parsing, `AGENT_GLOBAL_V1_PATHS`, `ADMIN_ONLY_V1_PATHS`, rate limiter bucket logic).
- **Change how identity is resolved from a request**: `apps/api/src/scope-identity.ts` — edit here, not in individual routes, so auth and execution cannot diverge (see the issue #57 comments in that file).
- **Add input validation**: `apps/api/src/lib/validation.ts` (Zod schemas), consumed by the write and search route families.
- **Change boot behavior**: `apps/api/src/server.ts` and `apps/api/src/lib/boot-env.ts` / `apps/api/src/lib/capabilities.ts`.
- **Change the container image**: `apps/api/Dockerfile`.

## Key source files

| File | Role |
|---|---|
| `apps/api/src/app.ts` | Hono app factory, auth, CORS, rate limiting, body limit, health/ready, graceful shutdown |
| `apps/api/src/server.ts` | Process entry point: boot validation, capability probe, `serve()`, signal handlers |
| `apps/api/src/scope-identity.ts` | Shared scope/agentId/scopeRef resolution used by both auth and routes |
| `apps/api/src/routes/v1.ts` | Router entry point and body pre-parse middleware |
| `apps/api/src/lib/errors.ts` | Canonical error envelope and dependency-unavailable classification |
| `apps/api/src/lib/readiness.ts` | `/ready` lane checks (mongo, vector, embedding) |
| `apps/api/src/lib/validation.ts` | Zod schemas for write/search bodies and metadata |
| `apps/api/src/openapi-spec.ts` | Assembles the OpenAPI document and enforces contract conformance |
| `apps/api/src/version.ts` | `MEMONGO_API_VERSION` constant |
| `apps/api/Dockerfile` | Production multi-stage image |
