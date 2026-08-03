# Memongo Fix-Plan Implementation Review and Builder Handoff

**Date:** 2026-08-03  
**Review scope:** `65a2fac7cb...635cfce419`  
**Specification:** `docs/research/fix-plan-2026-08-03.md`  
**Commits reviewed:**

- `45d4ea4b7f` — P0-P2
- `6df2353dbf` — P3
- `635cfce419` — P4

The working tree was clean at the start of this review. This document is the
authoritative builder handoff for remaining work. It supersedes interim review
summaries produced before the P4 commit.

## Executive verdict

The implementation is broad and well tested, but the master plan is **not
complete**. Of 45 acceptance items:

- **21 complete**
- **23 partial**
- **1 not started**

The normal repository gates are green. The principal remaining risks are
contract drift, incomplete public TTL/config plumbing, write/read scope
asymmetry, unsafe release artifacts/versioning, and incomplete P4 cleanup.

Do not publish from this handoff without explicit release authorization.

## Current validation baseline

Run against clean `HEAD`:

| Gate | Result |
|---|---|
| `bun run lint` | Passed, 395 files |
| `bun run check-types` | Passed, 15/15 tasks |
| `bun run build` | Passed, 10/10 tasks |
| `bun run test` | Passed, 13/13 tasks |
| Engine tests | 2,053 passed |
| API tests | 174 passed |
| `bun run check-publishability` | Passed, but has false negatives documented below |
| `git diff --check 65a2fac7cb...HEAD` | Passed |

Real MongoDB/Voyage E2E, recall benchmarks, the 10k-turn import benchmark, and
actual package publication were not performed.

## Acceptance matrix

### P0 — Stop the bleeding

| Item | Verdict | Remaining work |
|---|---|---|
| P0.1 End-to-end idempotency | **Partial** | Core replay works, but the payload fingerprint omits timestamp, validity, metadata, and expiry. |
| P0.2 Consolidator lease | **Partial** | Lease/fencing works, but gate identity concatenates fields without separators. |
| P0.3 Sync partial-failure masking | **Complete** | Individual retries and metadata-hash protection are implemented. |
| P0.4 Episode set divergence | **Complete** | Materialization uses the preselected event set. |
| P0.5 Literal NUL source bytes | **Complete** | The two specified engine files are text-safe. A separate NUL remains in a moved script test. |
| P0.6 Default credential removal | **Complete** | Non-loopback use fails closed; local loopback remains usable. |
| P0.7 Import path confinement | **Complete** | Allowed-root validation is wired. |
| P0.8 Safe error envelope | **Complete** | Central sanitized error handling is present. |
| P0.9 Database-env release | **Partial** | Repo changes exist, but engine/bridge 2.0.1 are not on npm. |
| P0.10 KB fusion | **Complete** | Score/rank fusion and normalization are implemented. |

### P1 — Make it real

| Item | Verdict | Remaining work |
|---|---|---|
| P1.1 Publish MCP | **Partial** | Package is locally publishable, but npm has no `@memongo/mcp`. |
| P1.2 MCP surface diet | **Complete** | Core/admin/alias split, extraction, and envelopes are implemented. |
| P1.3 Client SDK contract | **Complete** | Scope forwarding, resilience, error parsing, and tests are implemented. |
| P1.4 Layered auto-trigger | **Partial** | Lifecycle behavior exists, but search-default scope is not applied to writes. |
| P1.5 Middleware cache isolation | **Partial** | Tenant identity is fixed; the claimed LRU is actually FIFO. |
| P1.6 Docker truth | **Partial** | Compose still probes `/health`; base/override dev-production separation is absent. |
| P1.7 Readiness/boot/CORS | **Complete** | `/ready`, boot checks, and CORS behavior are implemented. |
| P1.8 Remove API Workers target | **Complete** | API Wrangler target is removed. MCP still has a separate stale Wrangler config. |
| P1.9 Visible index failure | **Partial** | Runtime visibility works, but at least one E2E assertion remains false-green. |

### P2 — One organism

| Item | Verdict | Remaining work |
|---|---|---|
| P2.1 Shared runtime | **Partial** | Shared client/cache exists, but manager eviction can close an actively borrowed manager. |
| P2.2 One contract source | **Partial** | Route table only models required fields/statuses, not full request/response/tool shapes. |
| P2.3 Scope identity | **Partial** | Explicit/session rules are unified; env default still causes write/read asymmetry. |
| P2.4 Query cache | **Partial** | Code paths are implemented; required mixed-load hit-rate benchmark is absent. |
| P2.5 Concurrency hardening | **Complete** | CAS, lease checks, duplicate recovery, and shutdown ordering are covered. |
| P2.6 Forced URI precedence | **Complete** | One FORCE-wins rule is shared. |
| P2.7 Tenant-safe migration | **Complete** | Tenant filtering, batching, and tenant-aware IDs are implemented. |
| P2.8 Boundary validation | **Complete** | Route validation and limits are substantially implemented. MCP lifecycle handlers still use `any`. |

### P3 — Search cost and quality

| Item | Verdict | Remaining work |
|---|---|---|
| P3.1 Embedding amplification | **Partial** | Some lanes are collapsed, but no proof meets the specified ≤1-2 embeds/search target. |
| P3.2 Search storm budget | **Complete** | Budgeting and empty-is-not-error behavior are implemented. |
| P3.3 Stored source | **Partial** | Version gate exists; required real ≥8.3.7 parity/latency validation is absent. |
| P3.4 Quantization probe | **Complete** | Probe-adopt behavior is implemented. |
| P3.5 `errorAndLog` | **Complete** | Correctly version-gated. |
| P3.6 Capability registry | **Partial** | Probe outcomes are process-global by feature, not deployment/URI scoped. |
| P3.7 Post-CE boosts | **Complete** | Recency/access boosts and off-switch are implemented. |
| P3.8 Index hygiene | **Complete** | Index and request-path changes are implemented. |
| P3.9 Write batching | **Partial** | Bulk endpoint exists, but imports still invoke one write per turn and no 10k benchmark exists. |

### P4 — Lean and parity

| Item | Verdict | Remaining work |
|---|---|---|
| P4.1 Cut list | **Partial** | Benchmark/eval modules remain in engine `src` and are imported by the production manager. |
| P4.2 Test rebalance | **Complete** | Lib/client/MCP/Pi and stateful manager/consolidator tests exist. |
| P4.3 God-file split | **Partial** | Split improved structure, but many new modules remain 1,000-3,000 LOC. |
| P4.4.1 TTL | **Partial** | Engine indexes/writes mostly exist; public surfaces and one evidence read are incomplete. |
| P4.4.2 Contradictions | **Partial** | Engine path exists, but public manager/bridge/API configuration cannot disable it. |
| P4.4.3 LLM dedup | **Partial** | Engine path exists, but public configuration cannot enable it. |
| P4.4.4 Temporal proximity | **Partial** | Core scoring exists; reference-date forwarding and benchmark evidence are missing. |
| P4.4.5 UUID-to-int mapping | **Not started** | No implementation found. |
| P4.5 Release hygiene | **Partial** | Gate passes despite stale dist, compiled tests, version skew, and unpublished packages. |

## Builder queue

Tasks are ordered by dependency and release risk, not by original phase number.

### B1. Make TTL end-to-end and enforce expiry on every read

**Severity:** High  
**Plan items:** P4.4.1, P2.2, P4.5

Engine input supports `expiresAt`, but the bridge, API, client, MCP, and OpenAPI
do not expose it:

- `packages/memory-engine/src/mongodb-manager-write.ts:51`
- `packages/memory-bridge/src/memongo-bridge.ts:190`
- `apps/api/src/routes/v1.ts:1635`
- `packages/client/src/types.ts:14`
- `apps/mcp/src/tools/core.ts:107`
- `apps/api/src/openapi-spec.ts:2027`

`findSupportingEventIds` can also treat expired events as durable evidence:

- `packages/memory-engine/src/mongodb-derived-memory.ts:381`

**Implementation**

1. Add `expiresAt` to add/event/batch/structured input types where applicable.
2. Parse and validate it at the HTTP boundary.
3. Thread it through client → API → bridge → manager.
4. Add it to MCP schemas and dispatch.
5. Document it in OpenAPI, including date-time validation.
6. Add `buildUnexpiredClause()` to `findSupportingEventIds`.
7. Confirm every event/structured read path filters expired rows until MongoDB's
   background TTL sweep removes them.

**Acceptance**

- Explicit future `expiresAt` survives all public surfaces.
- Invalid/past expiry policy is deterministic and tested.
- Expired events cannot support derived-memory promotion.
- API, client, MCP, bridge, and engine contract tests cover the field.
- TTL index tests and real MongoDB TTL behavior remain green.

### B2. Replace the spot-check route table with a real contract source

**Severity:** High  
**Plan item:** P2.2

`ApiRouteContract` describes path, required field names, statuses, and tools,
but not complete request/response schemas:

- `packages/lib/src/contract.ts:114`
- `apps/api/src/contract-conformance.test.ts:101`

Consequently, the conformance test cannot detect omitted optional fields. The
current OpenAPI document still omits supported fields:

- `/v1/search-kb`: agent/scope/filter/fusion fields,
  `apps/api/src/openapi-spec.ts:1965`
- `/v1/add`: scope/scopeRef/metadata/customId,
  `apps/api/src/openapi-spec.ts:2012`
- `/v1/write-event`: customId, `Idempotency-Key`, expiresAt,
  `apps/api/src/openapi-spec.ts:2043`

MCP also drifts:

- `memongo_search` has no scope/scopeRef,
  `apps/mcp/src/tools/core.ts:12`
- `memongo_add` has no scope/scopeRef/metadata/customId/expiresAt,
  `apps/mcp/src/tools/core.ts:107`
- `memongo_write_event` has no metadata/customId/expiresAt,
  `apps/mcp/src/tools/core.ts:137`

**Implementation**

1. Define full runtime schemas once, preferably in `@memongo/lib` or a dedicated
   contract package.
2. Derive API validation, OpenAPI schemas, MCP schemas, and client input types
   from those definitions.
3. Include headers, optional fields, response bodies, errors, and aliases.
4. Remove the remaining bridge capability cast after fixing the interface:
   `packages/memory-bridge/src/memongo-bridge.ts:698`.
5. Replace the MCP lifecycle `as any` cluster with validated typed handles:
   `apps/mcp/src/server.ts:368`.

**Acceptance**

- Deleting any optional field from OpenAPI or MCP makes conformance tests fail.
- Route request and response shapes are checked, not only required names.
- `rg "as any" apps/mcp/src/server.ts` returns no boundary casts.
- OpenAPI, MCP, API, bridge, and client accept the same fields.

### B3. Resolve default-scope write/read asymmetry

**Severity:** High  
**Plan items:** P1.4, P2.3

Reads apply `MEMONGO_SEARCH_DEFAULT_SCOPE`, while writes explicitly do not:

- `packages/memory-engine/src/backend-config.ts:823`
- `packages/memory-engine/src/mongodb-manager-search.ts:89`
- `packages/memory-engine/src/mongodb-manager-write.ts:461`

With `MEMONGO_SEARCH_DEFAULT_SCOPE=global`, an unscoped MCP add writes to
`agent` while an unscoped MCP search reads `global`.

**Implementation**

Choose and document one rule:

- Preferred: rename/generalize the setting and apply the same fallback to
  writes and reads.
- Alternative: keep search-only behavior, but require explicit scope on all
  write/read agent surfaces and remove misleading "single-user default" claims.

Do not silently fan a read across all scopes.

**Acceptance**

- Unscoped add → unscoped search roundtrips under every configured default.
- Explicit scope still wins.
- Session identity still implies session scope.
- MCP add/search and Pi capture/search self-consistency tests cover the default.

### B4. Compare the complete idempotent write payload

**Severity:** High  
**Plan item:** P0.1

The write input contains timestamp, validAt, invalidAt, metadata, and expiresAt,
but replay comparison only includes role/body/session/scope:

- `packages/memory-engine/src/mongodb-manager-write.ts:51`
- `packages/memory-engine/src/mongodb-manager-write.ts:358`

A caller can reuse a key with changed temporal or metadata semantics and receive
the original receipt rather than a 422.

**Implementation**

Build one canonical fingerprint from every immutable persisted input. Normalize
dates to ISO timestamps, sort object keys recursively, and define whether
omitted/defaulted values are equivalent before comparing.

**Acceptance**

- Changing any immutable field under the same key returns 422.
- Equivalent normalized payloads replay successfully.
- Single and batch paths share the same fingerprint function.
- Tests cover metadata key order and date normalization.

### B5. Make release artifacts reproducible and version-safe

**Severity:** High  
**Plan items:** P0.9, P1.1, P4.5

Current npm versions:

| Package | Repository | npm |
|---|---:|---:|
| `@memongo/lib` | 2.0.0 | 2.0.0 |
| `@memongo/memory-engine` | 2.0.1 | 2.0.0 |
| `@memongo/memory-bridge` | 2.0.1 | 2.0.0 |
| `@memongo/memory` | 2.0.0 | 2.0.0 |
| `@memongo/client` | 2.0.0 | 2.0.0 |
| `@memongo/tools` | 2.0.0 | 2.0.0 |
| `@memongo/pi-extension` | 2.1.1 | 2.1.1 |
| `@memongo/mcp` | 0.1.0 | unpublished |

The publish workflow skips a package when its exact version already exists:

- `.github/workflows/publish.yml:59`

Therefore changed lib/client/tools/Pi code will not ship without coordinated
bumps. MCP package version `0.1.0` also disagrees with its reported server
version `2.0.1`.

Builds do not clean `dist`. Current local output contains:

- 16 orphan engine JavaScript files from deleted sources
- `packages/client/dist/client.test.js`

The test artifact is included by the client's `"files": ["dist"]` and causes
the client suite to run twice. `check-publishability` rejects `.test.ts`, not
compiled `.test.js`:

- `scripts/check-publishability.ts:88`

**Implementation**

1. Add package-local clean-before-build steps.
2. Exclude all tests from publish builds.
3. Make publishability fail on orphan output and compiled tests.
4. Validate all changed publishable packages have unpublished versions.
5. Align MCP package and reported server version, or formally document and
   enforce a separate versioning policy.
6. Coordinate dependency bumps, especially `@memongo/lib`.
7. Only after authorization, publish and verify registry dist-tags.

**Acceptance**

- A clean build and a dirty pre-existing dist produce identical tarballs.
- No `*.test.js`, deleted module, benchmark-only module, or source file ships.
- Publishability fails if a changed package version already exists on npm.
- `npm pack --dry-run` output is reviewed for all eight packages.
- `npx -y @memongo/mcp` completes a stdio handshake after publication.

### B6. Route conversation imports through the batch write path

**Severity:** Medium-high  
**Plan item:** P3.9

The new bulk endpoint and engine batch writer exist, but imports still invoke
one write per turn:

- `packages/memory-engine/src/mongodb-manager-benchmark.ts:1497`
- `packages/memory-engine/src/mongodb-manager-benchmark.ts:1522`

**Implementation**

Change the dataset importer callback contract to submit bounded batches through
`writeConversationEventsBatch`, while preserving per-item idempotency,
authorized scope forcing, ordering, and partial-error reporting.

**Acceptance**

- Import uses batch writes, not `writeConversationEvent` in a loop.
- 10k-turn benchmark demonstrates at least 10x throughput.
- Single-write latency remains unchanged.
- Partial batch failures identify the failing turn and do not cross tenants.

### B7. Fix consolidation gate identity encoding

**Severity:** Medium  
**Plan item:** P0.2

The comment promises NUL-separated identity, but the implementation directly
concatenates optional fields:

- `packages/memory-engine/src/mongodb-consolidator.ts:288`

This admits collisions between scoped/unscoped identities and can cause
unrelated runs to rate-limit or fence one another.

**Implementation**

Use an unambiguous tuple encoding, for example length-prefixed JSON or escaped
NUL separators. Reuse one identity-key helper rather than hand-building keys.

**Acceptance**

- Collision fixtures for boundary-shifted values produce different keys.
- Scoped and unscoped runs remain separate.
- Existing lease, crash recovery, and fencing tests stay green.

### B8. Expose P4.4 controls and implement UUID-to-int mapping

**Severity:** Medium  
**Plan items:** P4.4.2, P4.4.3, P4.4.5

`ConsolidationOptions` has `resolveContradictions` and `llmDedup`, but the
manager facade drops them:

- `packages/memory-engine/src/types.ts:1651`
- `packages/memory-engine/src/mongodb-manager-lifecycle.ts:573`
- `packages/memory-bridge/src/memongo-bridge.ts:914`
- `apps/api/src/routes/v1.ts:2451`

UUID-to-small-integer mapping for LLM self-edit/feedback flows is absent.

**Implementation**

1. Thread both consolidation controls through manager, bridge, API, MCP, client,
   and OpenAPI.
2. Add explicit defaults and off-proof tests.
3. In self-edit/feedback prompt rendering, build a per-request bidirectional
   map `{small integer ↔ UUID}`.
4. Resolve model responses back to UUIDs and reject unknown integers.

**Acceptance**

- Contradiction resolution can be disabled publicly.
- LLM dedup can be enabled publicly.
- Flags-off tests prove the old behavior.
- LLM-facing candidate lists contain `1..N`, not UUIDs.
- Integer selection resolves to the intended memory; unknown IDs fail cleanly.

### B9. Prevent manager eviction while a request is using it

**Severity:** Medium  
**Plan item:** P2.1

The cache returns raw managers without a lease/refcount, while LRU and idle
eviction immediately call `close()`:

- `packages/memory-engine/src/search-manager.ts:115`
- `packages/memory-engine/src/search-manager.ts:138`
- `packages/memory-engine/src/search-manager.ts:191`

A 51st agent initialization can close a manager still executing a write.

**Implementation**

Introduce borrower accounting or a request-scoped lease. Remove an evicted
manager from lookup immediately, but defer close until active borrowers reach
zero. Apply the same protection to idle eviction and shutdown.

**Acceptance**

- Concurrent in-flight write plus forced LRU eviction completes successfully.
- New lookups create/use the replacement manager.
- Evicted managers close exactly once after quiescence.
- Shared MongoClient reference counts remain correct.

### B10. Scope capability probe outcomes by deployment

**Severity:** Medium  
**Plan item:** P3.6

Probe results are held in a process-global map keyed only by feature:

- `packages/memory-engine/src/mongodb-capability-registry.ts:79`

A rejection from one MongoDB deployment disables the feature for managers
connected to another compatible deployment in the same process.

**Implementation**

Key mutable probe outcomes by deployment identity plus feature, or store them
on the manager's detected-capabilities object. Avoid putting credentials in
keys or logs.

**Acceptance**

- Two fake deployments can report opposite support concurrently.
- Reset and shutdown remove only the intended deployment state.
- No URI credentials appear in telemetry.

### B11. Finish the P4.1/P4.3 module cleanup

**Severity:** Medium  
**Plan items:** P4.1, P4.3

Benchmark/eval code remains under production engine source and is imported by
the production manager:

- `packages/memory-engine/src/mongodb-manager.ts:49`
- `packages/memory-engine/src/mongodb-manager-benchmark.ts`
- `packages/memory-engine/src/mongodb-benchmark-runner.ts`
- `packages/memory-engine/src/mongodb-benchmark-harness.ts`
- `packages/memory-engine/src/benchmark-parity-envelope.ts`
- `packages/memory-engine/src/benchmark-quality-contracts.ts`

The split also left many files far above the ~500 LOC guideline:

| File | LOC |
|---|---:|
| `apps/api/src/openapi-spec.ts` | 3,021 |
| `apps/api/src/routes/v1.ts` | 2,517 |
| `packages/memory-engine/src/mongodb-manager.ts` | 2,161 |
| `packages/memory-engine/src/mongodb-schema-search-indexes.ts` | 1,666 |
| `packages/memory-engine/src/mongodb-search-v2.ts` | 1,471 |
| `packages/memory-engine/src/mongodb-schema-validators.ts` | 1,340 |
| `packages/memory-engine/src/mongodb-manager-search.ts` | 1,275 |
| `packages/memory-engine/src/mongodb-manager-write.ts` | 1,211 |
| `packages/memory-engine/src/mongodb-schema-standard-indexes.ts` | 1,110 |
| `apps/mcp/src/server.ts` | 1,056 |

**Implementation**

1. Move benchmark/eval implementation to `scripts/` or a private dev package.
2. Keep production manager interfaces free of benchmark imports.
3. Split search/schema/API modules by stable domain seams.
4. Do not create shallow one-function wrappers solely to satisfy line counts.
5. Preserve the stable public barrel and `/internal` compatibility window.

**Acceptance**

- Published engine tarball contains no benchmark/eval implementation.
- Production manager has no benchmark imports.
- Hot source modules approach the documented size guideline.
- Full tests and benchmark scripts still work from their canonical home.

### B12. Complete Docker truth

**Severity:** Medium  
**Plan item:** P1.6

Full compose overrides the Dockerfile readiness probe:

- `docker/docker-compose.full.yml:50`

It requests `/health`, so the container can report healthy while MongoDB/search
is unavailable. The requested production-safe base plus development override
split is also absent.

**Implementation**

1. Point the compose healthcheck to `/ready`.
2. Establish `compose.yaml` as the production-safe base.
3. Put local ports and dev conveniences in `compose.override.yaml`.
4. Consolidate or clearly label the remaining minimal/full files.

**Acceptance**

- Killing MongoDB leaves `/health` at 200 but marks the API container unhealthy.
- Base compose exposes no unsafe development ports/defaults.
- Default development invocation remains documented and works.

### B13. Correct the middleware cache's LRU behavior

**Severity:** Low  
**Plan item:** P1.5

`cacheGet` does not refresh Map insertion order, so eviction removes the oldest
inserted entry rather than the least recently used:

- `packages/tools/src/cache-identity.ts:94`

Refresh recency on hit and replacement. Add a test where an old entry is read
before capacity eviction and therefore survives.

### B14. Forward the temporal reference clock

**Severity:** Low  
**Plan item:** P4.4.4

Raw-window scoring calls `extractTemporalWindow(query)` without the request or
benchmark reference date:

- `packages/memory-engine/src/mongodb-search-v2.ts:574`

Relative queries such as "last week" become nondeterministic for historical
`asOf`/benchmark cases. Thread the same reference clock used to derive the
retrieval range and add a fixed-clock ranking test.

### B15. Repository and runtime hygiene

**Severity:** Low  
**Plan items:** standards follow-up

1. Replace the literal NUL byte in `scripts/mongodb-e2e-qa.test.ts` with
   escaped `"\0"`.
2. Remove the committed runtime artifact
   `apps/api/wf-20260730T2213-a7f3c2d1.events.jsonl`.
3. Move or delete `.tmp-review/`; research material belongs under
   `docs/research/`.
4. Remove or document `apps/mcp/wrangler.jsonc`; it describes another
   Node/Mongo-incompatible Workers target.
5. Bound or reset `seenKeys` in
   `packages/pi-extension/extensions/lifecycle.ts:255`.
6. Split oversized test files opportunistically.

### B16. Close the missing validation evidence

**Severity:** Release gate  
**Plan items:** P2.4, P3.1, P3.3, P3.7, P3.9, all P4.4 items

Produce and retain:

- Mixed read/write query-cache hit-rate benchmark.
- Aggregation and embedding telemetry proving P3.1/P3.2 targets.
- Real MongoDB ≥8.3.7 storedSource field-parity and latency run.
- Recall/NDCG benchmark envelope for ranking and P4.4 changes.
- 10k-turn import throughput benchmark.
- Fresh-machine compose readiness proof.
- Package dry-run manifests and install smoke tests.

## Suggested execution order

1. **Correctness contracts:** B1 → B2 → B3 → B4.
2. **Concurrency/runtime:** B7 → B9 → B10.
3. **Feature completion:** B6 → B8 → B13 → B14.
4. **Architecture and deployment:** B11 → B12 → B15.
5. **Release:** B5 → B16 → authorized publication.

B2 should precede most public-surface additions so new TTL and consolidation
fields are defined once rather than copied into another four handwritten
schemas.

## Definition of done

The fix plan is complete only when:

1. Every matrix row is **Complete**.
2. Every builder task's acceptance tests pass.
3. Normal lint/type/build/test gates pass from a clean clone.
4. Required real MongoDB and benchmark gates have saved evidence.
5. Clean and dirty build directories yield identical package tarballs.
6. Live npm versions match the intended release set.
7. No package is silently skipped by the publish workflow.
8. The repository is clean after validation.
