# Changelog

All notable changes to Memongo will be documented in this file.

## 2.2.0 — 2026-10-02

Reliability fixes across the engine, HTTP API, SDK, MCP, and middleware. This
release incorporates 140 independently reviewed bounded repairs. That count
tracks accepted changes, not unique defects or benchmark gains.

- Fence lifecycle writes and background work against erasure and stale ownership.
- Bound queries and diagnostic processing; redact nested provider and database errors.
- Propagate middleware owner coordinates and enforce scoped request authority.
- Return specific conflict responses for fenced lifecycle operations and reject
  ambiguous legacy quarantine promotion before claiming work.
- Preserve canonical quarantine identity and restore session coordinates during promotion.
- Start the published MCP executable correctly through npm bin symlinks.
- Suspend automatic paid wiki generation and scheduled provider tests; manual
  workflows remain available.

Validation and release limits are recorded in `docs/platform/releases/2.2.0.md`.

### Detailed changes

### KB search scope resolution

- KB searches honor an explicit scope when deriving the partition reference.
  Explicit references win; omitted scope preserves the legacy agent partition.
  Trusted global/workspace calls now search those shared partitions, which normal
  file sync does not populate. Direct engine ingestion or an explicit reference
  is needed to access an existing non-agent corpus.
- HTTP KB search rejects invalid non-empty scope strings and missing required
  user/tenant references or session coordinates with 400. Scoped-key 403 guards
  are unchanged. HTTP sessionId wins over sessionKey; existing SDK/MCP session
  callers can pass an explicit reference. Wrongly typed scopes remain lenient.

### Additional read request retries

- `profile`, `hydrateActiveSlate` and `recallConversation` now use the existing
  bounded 429/503 retry loop before failing or returning a silent fallback.
  Request bodies stay identical across attempts. Retrieval work, coordination
  writes and telemetry can repeat; per-attempt timeouts and backoff can extend
  total latency. `readFile` and other unkeyed POST methods retain their current
  failure behavior.

### Quarantine list state

- Quarantine list filters and client row types include `promoting`, matching
  the leased state already stored by the engine. API and MCP requests for
  that state now retain the filter. Completed review receipts still report
  only `promoted` or `rejected`.

### Conversation recall limit

- `POST /v1/recall-conversation` honors `limit` up to the advertised 200;
  it previously capped requests at 100. Requests above 100 can now return
  larger responses and require more retrieval work. Other search limits
  remain 100, and omitted or non-finite recall limits keep the engine default.

### API JSON identity validation

- `/v1` requests with nonempty bodies must use `Content-Type: application/json`;
  parameters such as `charset` are allowed. Missing or other media types,
  including `+json` variants, return 415 `UNSUPPORTED_MEDIA_TYPE` instead of
  executing body operation fields with query/default identity. Empty bodies
  remain supported. Authentication and body-size checks still run first;
  malformed JSON with JSON media still returns 400 `INVALID_JSON`.
  `@memongo/client` already sends the required header.

### Conversation recall query bounds

- Direct conversation recall trims queries and applies the same 2,000 UTF-16
  code-unit ceiling as memory search. All lanes and `metadata.queryUsed`
  receive the bounded query. Literal matches and temporal phrases beyond the
  ceiling no longer participate, so over-length query results can differ.
  Truncation records one `search-query-clamped` event, including calls that
  return early for inverted dates. Slicing can split a surrogate pair.

### Middleware owner coordinates

- Both middlewares forward optional `scopeRef` on context reads and turn
  capture; Vercel also supports per-request refs. Explicit user scope with a
  nonblank `userId` derives `user:<trimmed id>`. A request supplying scope
  does not inherit the constructor's ref; neither does a request overriding
  `userId` under user scope. Blank user overrides remain API errors without
  an explicit ref. Implicit scope defaults are preserved.
- Refs qualify derived turn keys. Calls without refs retain legacy keys;
  adding a ref can duplicate a turn retried across the change. These fields
  are trusted-host coordinates, not end-user authentication or new API grants.

### Search execution query bounds

- Every `searchV2` entry, including shared-budget calls, and generated search
  rewrites now use the existing 2,000 UTF-16 code-unit ceiling. Configured
  rewrites exceeding it are truncated consistently for parent lanes and
  recursive fallback; planner, cache and rerank retain their original-query
  semantics. Standalone rewrite settings and shared admission/budgets are
  unchanged. Slicing can split a surrogate pair at the boundary.
- `search-query-clamped` telemetry also records generated rewrite truncation,
  with the length before truncation. Bounded recursive re-entry does not emit
  another clamp event.

### Recall lane failure diagnostics

- Hybrid and semantic conversation-recall fallback warnings now retain only
  the lane label, own finite numeric error code, query length and digest.
  They omit driver error text. The retry classifier, failure callbacks,
  fallback results and response metadata are unchanged.

### Recall timezone diagnostics

- Invalid conversation-recall timezone warnings omit the caller's timezone
  text. Validation and the existing UTC fallback behavior are unchanged.

### Exact-evidence full text

- Exact-evidence admission also checks available `text`, separately from the
  preview and locator fields. An anchor after the 700-character preview can
  now admit a result when it is in the retained text. Existing producers cap
  text at 16,000 characters; content beyond that is not fetched. Preview-only
  results and provenance, scope and time restrictions remain supported.

### Exact-evidence anchor edges

- Quoted anchors such as `c++`, `$100`, `.env` and non-ASCII text now match
  their literal text when a non-word edge meets whitespace or punctuation.
  ASCII word-character edges retain word-boundary matching. Non-word edges
  impose no neighbor constraint, so `c++` also matches within `c+++`.
  Anchor extraction, whitespace folding and the existing OR rule are unchanged.

### Lifecycle handle revision validation

- Lifecycle, feedback and procedure-outcome routes now reject handles with a
  missing, non-integer, non-finite or less-than-one `revision` with 400
  `VALIDATION_ERROR`, matching the published schema and MCP validation.
  Missing or malformed revisions previously bypassed the observed-revision
  check. Existing positive integer revisions remain accepted.

### Query failure diagnostics

- Planner, search outer-failure and lane-coverage logs now omit the `error` field
  and free-text error detail. They retain the operation label, finite numeric
  `code` when present, `queryLength` and `queryDigest`. Use the digest for
  correlation instead of the former `[query:…]` error text. Planner/search
  callers still receive the original error; coverage fallback is unchanged.

### MCP alias authorization

- Semantic aliases now inherit their canonical tool's admin requirement.
  `memongo_memory_*` and `memongo_import_conversation_history` require both
  `MEMONGO_MCP_ALIASES=1` and `MEMONGO_MCP_ADMIN=1`; authenticated HTTP callers
  also need the admin credential. `memongo_recall_messages` remains available
  with the aliases flag alone. This applies to both tool listing and calls.

### Explicit tenant erasure target

- `/v1/admin/erase` and `memongo_erase_agent` now require an explicit nonblank
  agent ID. API requests without a target return 400 `VALIDATION_ERROR`; MCP
  calls return a tool error. Erasure no longer falls back to `MEMONGO_AGENT_ID`
  or the default agent. API body/query/nested identity precedence is unchanged.
  The client type remains optional, so callers must supply a target at runtime.

### Memory admission and API bind guards

- Consolidation rejects `maxEvents` unless it is a positive safe integer,
  before provider, database or tracking-job work. Omitted values still default
  to 100; zero no longer selects an unlimited event scan. Invalid numeric
  values through `/v1/consolidate` currently return `CONSOLIDATE_FAILED` (500).
- Whitespace-only `MEMONGO_API_KEY` and `MEMONGO_API_SCOPED_KEYS` now count as
  absent when checking API bind safety. Routable binds refuse startup unless
  authentication is configured or both existing insecure override flags are
  explicitly enabled. Loopback development remains supported.

### API contract hardening (upgrade note)

- Previously silently-ignored request input now returns 400 `VALIDATION_ERROR`
  naming the offending field (**breaking** for callers that relied on lenient
  acceptance): `/v1/context-bundle` `mode` must be `full` or `wake-up` (any
  other value previously produced the default `full` bundle with a 200);
  `/v1/chain-trace` `collection` must be one of the five traversable
  collections (`structured_mem`, `entities`, `relations`, `procedures`,
  `entity_links` — other names previously returned a fabricated
  `chainComplete: true` empty chain); `/v1/search-detailed` nested objects
  (`searchMode`, `sourcePreference`, `timeRange`, `searchConfig`, scope
  objects) and the context-route `timeRange` presets are schema-validated,
  so unknown keys, operator-shaped keys, and typo'd presets are rejected
  instead of cast through to the engine.
- The accepted `mode` and chain-trace `collection` value sets are
  single-sourced from `@memongo/lib` and enforced to match across the API,
  the TypeScript client (compile-time via the workspace type-check), the MCP
  tool schemas, and the AI SDK tools package.
- The client's automatic retry loop now retries only inherently idempotent
  GETs, requests carrying an `Idempotency-Key`, and the per-item-keyed bulk
  write; unkeyed mutations fail fast on the first 5xx or 429 instead of
  risking a double apply.
- The server now reads `x-memongo-client-version` and logs one deduped
  warning per client/server version pair on mismatch (the header was
  previously sent by the client and never read).

### Query result cache removed (upgrade note)

- The query result cache is removed: public `search`/`searchDetailed` no
  longer read persisted `query_cache` rows and no longer join identical
  in-flight queries — every call runs its own retrieval. This removes
  persisted and in-flight result reuse only; how up-to-date the underlying
  sources are is unchanged by this removal (stored-source freshness is
  tracked separately).
- **Breaking** for consumers of the published root barrel
  (`@memongo/memory-engine@2.0.0`): nine exports are removed from both the
  root and the deprecated `./internal` subpath — `checkCache`, `writeCache`,
  `normalizeQuery`, `hashQuery`, `QueryCacheEntry`, `QueryCacheConfig`,
  `CacheCheckResult`, `DEFAULT_CACHE_CONFIG` (previously
  `mongodb-query-cache.js`), and `getCacheHitRate` (previously
  `mongodb-telemetry.js`). There is no in-package replacement: result caching
  no longer exists, and neither does hit-rate telemetry. Callers that built
  on these must drop them. The internal `queryCacheCollection` helper
  remains for legacy-row maintenance.
- Legacy `cache.*` config keys (`enabled`, `conversationTtlSec`, `kbTtlSec`,
  `similarityThreshold`) are still accepted but ignored: resolution forces
  `cache.enabled: false` and the types are `@deprecated`. They cannot
  re-enable serving; remove them from your config at your own pace.
- Rows already stored in `query_cache` are never served. They remain bounded
  by the existing cleanup paths — write-path invalidation
  (`invalidateQueryCache`), the retained TTL index, and tenant erasure —
  which now act purely as legacy-data cleanup. Rollback note: before
  reverting to a cache-serving release, delete all legacy query-cache rows
  from the configured prefixed `query_cache` collection first — surviving
  legacy rows become serveable again as soon as the old serving code
  runs.

### Deployment defaults (upgrade note)

- The shared-client runtime is now the default: all memory managers for the
  same MongoDB URI share one client and one bounded connection pool
  (`maxPoolSize` 10), the manager cache is LRU-capped with idle eviction in
  every mode, and the standing memory-job sweep is 30 s (writes still drain
  immediately). Connections are fixed per URI, and standing poll traffic is
  capped by the bounded manager cache (<=50 sweeps per 30 s); ~150 agents on
  an M10 node previously exhausted its 1,500-connection budget. Deployments
  that relied on per-manager client isolation must set
  `MEMONGO_SHARED_CLIENT=0` (or `false`/`no`/`off`).
  Migration notes: in opt-out mode an idle agent re-bootstraps its manager
  and reconnects after the idle TTL (10 min default), and in the default
  shared mode pool options resolve per URI — the first agent to connect
  fixes the pool options for that URI, and differing per-agent pool
  settings are ignored (a warning is logged).

### Runtime capability re-verification

- Capability checks are no longer boot-cached: `/ready` vector-lane and
  embedding-availability probes now answer from a live index-status round
  trip (`listSearchIndexes` + queryable/type checks) instead of the boot
  snapshot, so an index that becomes unqueryable mid-flight flips the
  ready report instead of staying green.
- The change-stream watcher is supervised: a dead stream re-opens
  immediately once, then with exponential backoff (1 s doubling to a 30 s
  ceiling, unbounded attempts), the gap signal fires immediately, a real
  change event resets the backoff budget, and a `liveness` surface
  (`active`, `state`, `reopenAttempts`, `nextReopenDelayMs`) is exposed on
  `getDetailedStatus()` and `/v2/status` (previously the watcher gave up
  permanently after three attempts).
- When a search lane fails, index readiness is re-polled (throttled to one
  in-flight probe) and the outcome surfaces in status as
  `searchLanes.vectorSearch` / `searchLanes.textSearch` with the failing
  path, error, and probe timestamp.
- The Pi coding-agent extension no longer caches a startup probe failure
  for the whole session: a background retry with capped exponential
  backoff (2 s doubling to 60 s, at most one probe per minute) heals
  availability as soon as the API answers, so starting Pi before
  `memongo serve` no longer leaves semantic memory silently dead until
  restart.

### Shared-prefix migration tooling

- `scripts/migrate-to-shared-prefix.ts` migrates per-agent collections
  (`<prefix><agent>_<base>`) into shared `<prefix><base>` collections with a
  dry-run manifest, a server-side `$merge` copy verified by SHA-256 digest
  multisets, and an optional `--drop` that removes a source only after its
  own copy verifies.
- `scripts/mongodb-ttl-retention-hold.mjs` holds TTL retention during the
  window: it inventories exact collection UUIDs and supported TTL policies,
  pauses with two-pass validation, marks verified source absence after the
  migration, and restores per namespace. It accepts the connection string
  only via the `MEMONGO_MONGODB_URI` environment variable and never echoes it
  into logs or the hold file.
- `scripts/prepare-mongodb-runtime.ts --schema-only` runs the configured
  schema preparation (`ensureCollections` + `ensureStandardIndexes` with the
  resolved retention values) and emits a `mongodb:prepare-schema PASS`
  receipt, without Search index creation, capability detection, or
  readiness polling.
- The operator procedure — session setup, backup gate, schema-only
  preparation, inventory and pause, human-reviewed dry-run and apply,
  live-state reconciliation, restore, and parity verification — is published
  as the "MongoDB shared-prefix migration" guide in the Operations section
  of the docs.

## 2.0.0 - 2026-07-31

Major release: security hardening, tenant isolation, and engine robustness.
All changes are validated against real MongoDB Atlas clusters (8.3+) in CI.

### Security (upgrade recommended)

- Enforced a hard tenant isolation floor on every read and write path:
  `scope`/`scopeRef` are now server-authoritative, closing a tenant-write
  identity bypass. Unauthorized cross-tenant requests now return 403
  (**breaking** for callers that relied on the previous permissive behavior).
- Closed the last unfiltered engine read: the `readFile` `kb:`/`reference:`
  locator now filters on the caller's full resolved identity
  (`agentId` + `scope` + `scopeRef`), so a knowledge-base path or title match
  can no longer return another tenant's document content from a shared
  collection. An explicit `?scope=`/`?scopeRef=` on the path (the
  structured-path convention) reaches a shared-corpus document the caller
  ingested; unknown values fail closed. The two coexisting KB read semantics
  (scopeRef-partitioned list/stat/remove/search vs identity-strict
  full-content reads) are now documented at the source.
- Pi extension auto-capture is now **off by default** (**breaking** for Pi
  users who relied on silent capture): `MEMONGO_PI_AUTO_CAPTURE=1` opts back
  in. At registration the extension prints one notice stating exactly what
  capture sends (the raw text of user and assistant turns, no redaction,
  plus session id and resolved scope), and the README documents the data
  boundary and the per-surface agentId defaults (`pi` here, `main` for the
  bridge and console).
- Unified agent identity resolution so route authorization and memory-manager
  selection can never disagree.
- Secured API defaults and stricter search-index readiness gating.

### Reliability and correctness

- Bi-temporal recall correctness: validity filtering no longer drops valid
  results under overfetch; temporal queries are exact.
- Durable memory jobs: claim/renew leases are stamped with server time
  (`$$NOW`), immune to client clock skew; completed jobs expire via TTL.
- Unique-index violations now fail loudly with actionable errors instead of
  being silently swallowed; duplicate-key races retry safely.
- Change-stream consumers survive invalidate events and resume-token loss.
- Transactions use `writeConcern: { w: "majority", wtimeoutMS: 5000 }`.
- Remote embedding calls gained timeouts, retries with backoff, and vector
  sanitization; batch HTTP paths retry transient failures.
- Knowledge-base writes enforce byte-accurate size limits (UTF-8, 15 MiB).

### Benchmark integrity

- The LongMemEval benchmark harness now verifies the official dataset
  byte-for-byte against a pinned digest, runs the shipped retrieval pipeline
  only (no benchmark-only lanes), and gates publication on release criteria
  including a live conversation-recall regression suite.
- Official retrieval metrics follow the LongMemEval evaluator exactly; nDCG
  credits each relevant item once.

### MongoDB 8.3+ features (opt-in, off by default)

- `MEMONGO_VECTOR_INDEXING_METHOD=flat` — flat vector indexes for
  many-small-tenant workloads.
- `MEMONGO_VECTOR_STORED_SOURCE=1` — stored source fields on search-lane
  vector indexes with `returnStoredSource` retrieval.

### Removed (**breaking**)

- Client-side embedding cache configuration (`embeddingCacheTtlDays`) and the
  `cachedEmbeddings` / `collectionSizes.embeddingCache` statistics: the engine
  embeds server-side end-to-end (Atlas autoEmbed), so a client-side embedding
  cache is structurally impossible. Consumers of those SDK types must drop
  the fields.

## 1.1.0 - 2026-06-24

- Prepared the public Apache-2.0 open-source release.
- Published the MongoDB-native memory engine, bridge, client, AI SDK tools, MCP
  server, API, web console, and docs as the supported launch surface.
- Added scoped benchmark evidence wording without claiming a Mem0 LongMemEval
  judged-answer win or broad ecosystem leadership.
- Added release gates for type checking, linting, build, tests, publishability,
  proof pack, and agent smoke validation.
