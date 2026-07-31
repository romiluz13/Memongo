# Changelog

All notable changes to Memongo will be documented in this file.

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
