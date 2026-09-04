# Changelog

All notable changes to Memongo will be documented in this file.

## Unreleased

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

## 2.0.0 - 2026-07-31

Major release: security hardening, tenant isolation, and engine robustness.
All changes are validated against real MongoDB Atlas clusters (8.3+) in CI.

### Security (upgrade recommended)

- Enforced a hard tenant isolation floor on every read and write path:
  `scope`/`scopeRef` are now server-authoritative, closing a tenant-write
  identity bypass. Unauthorized cross-tenant requests now return 403
  (**breaking** for callers that relied on the previous permissive behavior).
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
