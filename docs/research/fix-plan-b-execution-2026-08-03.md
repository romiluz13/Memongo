# Builder-Queue Execution Plan (B1–B16)

**Date:** 2026-08-03 (revised after plan review; C1–C4 + backlog added per handoff)
**Source-of-truth order:** `docs/handoff/2026-08-03-builder-handoff.md` → this plan → `docs/research/fix-plan-builder-review-2026-08-03.md` → `docs/research/fix-plan-2026-08-03.md`
**Base:** `635cfce419` (P4 checkpoint). The original 40-item plan (`fix-plan-2026-08-03.md`) is closed except as carried here.

This document is the executable plan for the review's builder queue. It records
the decisions that shape implementation, sequences work into five batches with
a commit each, and defines done.

## Recorded decisions

- **D1 — Unified default scope (B3), user-approved 2026-08-03.** One
  default-scope setting applied to BOTH reads and writes. Generalize
  `MEMONGO_SEARCH_DEFAULT_SCOPE` to `MEMONGO_DEFAULT_SCOPE`. Precedence:
  `MEMONGO_DEFAULT_SCOPE` wins; if the legacy name is also set with a
  DIFFERENT value, log a warning and still use the new name; the legacy name
  alone remains a read alias for one deprecation window. Unscoped add +
  unscoped search must roundtrip under every configured default. Explicit
  scope still wins; session identity still implies session scope. Never fan a
  read across all scopes.
- **D2 — Conformance-first contracts (B2), user-approved 2026-08-03.** Phase 1
  (this plan): extend `contract-conformance.test.ts` to verify FULL
  request/response field sets so any OpenAPI/MCP/client drift fails CI; define
  new fields (`expiresAt`, consolidation flags) once in `@memongo/lib`'s
  contract. **Explicitly deferred with user approval:** deriving API
  validation, OpenAPI, MCP schemas, and client types from one schema source
  (the letter of P2.2). Rationale: conformance-first delivers the safety
  property (drift cannot pass CI); derivation is a four-surface big-bang
  refactor better done after the new fields stabilize. Follow-up item: schema
  derivation refactor (unscheduled).
- **D3 — MCP version alignment (B5), user-approved 2026-08-03.** Bump
  `@memongo/mcp` to 2.0.1 so first publish matches the suite and the reported
  server version.
- **D4 — P4.4.5 descoped, user-approved 2026-08-03.** UUID-to-int mapping was
  surveyed (consolidation, self-edit, feedback, MCP, pi-extension prompt
  surfaces) and no UUID-list prompt flow exists to map. The approval was given
  explicitly in session and is recorded here so it survives outside chat.
  Trigger to reopen: if a prompt surface that renders raw UUID lists to an LLM
  is introduced, implement the bidirectional int↔UUID map at that surface
  (per-request map, resolve responses back to UUIDs, reject unknown integers).

## Working principles (from the P-phase retro)

1. One item per pass. Run the item's narrow gates after each item; run FULL
   repo gates (build, check-types, test, lint) before each batch commit.
2. Never trust an agent report without running gates independently.
3. Background tasks for heavy work; verify trees after interrupts.
4. Stage commits by explicit paths, never `git add -A`.
5. TDD: failing test first for every defect fix.
6. Turbo `lib#test` has a cold-run flake; re-run before investigating.

## Batch 0 — hygiene (commit 1)

| Item | Scope |
|---|---|
| B15.1 | Replace the literal NUL in `scripts/mongodb-e2e-qa.test.ts` with escaped `"\0"` (git currently classifies the file as binary). |
| B15.2/15.3 | Untrack `apps/api/wf-20260730T2213-a7f3c2d1.events.jsonl` and `.tmp-review/`, add `.gitignore` entries. (Amend or follow-up commit depending on whether the user already ran the cleanup.) |
| B15.4 | Delete or document `apps/mcp/wrangler.jsonc` (stale Workers target). |
| B15.5 | Bound `seenKeys` in `packages/pi-extension/extensions/lifecycle.ts:255`. |

Gate: lint + pi-extension tests. Full gates before commit.

## Batch 1 — correctness (commit 2)

TDD each, in this order, all in-line:

1. **B13 LRU** (`packages/tools/src/cache-identity.ts:94`): refresh recency on
   hit (delete + re-set). Test: an old entry read before capacity eviction
   survives while unread newer-inserted entries evict.
2. **B14 reference clock** (`mongodb-search-v2.ts:574`): thread the retrieval
   reference date into `extractTemporalWindow(query, referenceDate)`. Source
   the clock from the same place the planner's timeRange derivation uses
   (asOf/benchmark context). Test: fixed-clock ranking is deterministic.
3. **B7 gate identity** (`mongodb-consolidator.ts:288`): unambiguous tuple
   encoding (length-prefixed JSON). Test: boundary-shifted fixtures
   (`("ab","c")` vs `("a","bc")`, scoped vs unscoped) produce distinct keys;
   existing lease/fencing/recovery tests stay green.
4. **B4 idempotency fingerprint** (`mongodb-manager-write.ts:51,358`): one
   canonical fingerprint over every immutable persisted input (role, body,
   session, scope, timestamp, validAt, invalidAt, metadata, expiresAt). ISO
   dates, recursively sorted keys, defined omitted-vs-default equivalence;
   single + batch paths share it. Tests: any changed immutable field → 422;
   metadata key order / date normalization equivalence → replay.
5. **B9 eviction lease** (`search-manager.ts:115,138,191`): borrower refcount;
   evicted managers leave lookup immediately but close at quiescence; same for
   idle eviction and shutdown; shared MongoClient refcounts intact. Test:
   in-flight write + forced LRU eviction completes; evicted manager closes
   exactly once.
6. **B3 unified default scope (D1)** (`backend-config.ts:823`,
   `mongodb-manager-search.ts:89`, `mongodb-manager-write.ts:461`): resolve one
   `defaultScope` with the D1 precedence rule, apply on read AND write
   fallback paths. Tests: unscoped add→search roundtrip per default; explicit
   scope wins; session identity implies session scope; MCP add/search and Pi
   capture/search consistency; both-env-var conflict warns and uses the new
   name.
7. **P1.9 false-green E2E** (`production-readiness.e2e.test.ts:921`): repair
   the residual false-green KB branch so the assertion fails when index
   visibility regresses. Tests: prove the assertion can go red.
8. **C1 V2 single-lane BM25 normalization** (handoff, high): V2 stores lane
   results directly (`mongodb-search-v2.ts:1130`) and cross-lane RRF
   normalization only runs when multiple paths produced results
   (`mongodb-search-v2.ts:1246`), so a single lexical-fallback lane leaks raw
   BM25 scores. Reuse the method-aware normalizer (`mongodb-hybrid.ts:96,388`,
   already applied on the legacy path at `mongodb-manager-search.ts:426`) for
   the V2 single-lane lexical case; do NOT distort vector or server-fusion
   scores; preserve multi-lane RRF. Acceptance: single lexical fallback lane
   returns finite scores in [0,1], ordering monotonic with source BM25 order,
   vector/server-fusion/multi-lane regressions green, and a regression test
   that fails on the pre-fix implementation.
9. **C2 KB partial-chunk repair** (handoff, high): dedup skips on persisted
   parent hash (`mongodb-kb.ts:165`), but the parent is inserted before chunk
   writes (`mongodb-kb.ts:269`) and partial unordered chunk failures
   (`mongodb-kb.ts:278,281`) don't invalidate it — an identical retry skips
   permanently missing chunks. Invariant: a parent must not appear complete
   and deduplicable unless all expected chunks persisted; on partial failure
   retain enough state for an identical retry to repair (sync-path
   partial-failure behavior is the reference). Cover fresh ingestion and any
   standalone/non-transactional re-ingestion fallback. Preserve duplicate-key
   race handling and tenant/scope isolation. Acceptance: injected partial
   failure → first ingestion reports failure and is not complete; identical
   retry repairs chunks instead of incrementing `skipped`; final parent
   `chunkCount`/hash/chunk set agree; concurrent identical ingestion stays
   safely deduplicated.
10. **C3 typed-relation failure surfacing** (handoff, high): entity
    extraction propagates failure (`mongodb-manager-jobs.ts:276`), but
    typed-relation extraction catches+logs and lets the job complete
    (`mongodb-manager-jobs.ts:342,394,399`), silently losing relations and
    defeating retry. Route through the existing job failure/retry mechanism
    preserving lease fencing; record an observable failed relation projection
    where possible; retries idempotent for entity/derived/relation writes;
    no-provider and <2-entities behavior unchanged. Acceptance: provider
    failure marks the claimed job failed (metadata identifies the relation
    stage, no sensitive content), a later retry creates relations and
    completes, entity-failure behavior unchanged, tests prove the
    silent-success path cannot recur.

**C4 acceptance timing (handoff):** B3's MCP `memongo_search`/`memongo_add`
scope-field roundtrip cannot complete in Batch 1 because MCP gains those
fields only in B2a (Batch 2). Split acceptance: engine-level roundtrip + Pi
consistency tests pass in Batch 1; the MCP roundtrip assertion completes
after B2a and is a B2a completion requirement, not a Batch 1 failure.

Narrow gate per item (owning suite + check-types). Full repo gates before commit.

## Batch 2 — contract and public surfaces (commit 3)

Sequential where files overlap (openapi-spec.ts, routes/v1.ts, mcp/tools/core.ts).

1. **B2a conformance-first (D2)**: full request/response field sets in
   `packages/lib/src/contract.ts:114` + conformance test assertions; close the
   known drift (search-kb agent/scope/filter/fusion; /v1/add
   scope/scopeRef/metadata/customId; /v1/write-event customId,
   `Idempotency-Key`; MCP memongo_search scope, memongo_add/memongo_write_event
   field gaps at `apps/mcp/src/tools/core.ts:12,107,137`). Remove the bridge
   capability cast (`memongo-bridge.ts:698`) and the MCP lifecycle `as any`
   cluster (`apps/mcp/src/server.ts:368`) with typed handles.
   Acceptance: deleting any optional field from OpenAPI or MCP fails tests.
2. **B1 TTL end-to-end — events AND structured memory**: `expiresAt` through
   client types (`packages/client/src/types.ts:14`) → API parse/validate
   (`routes/v1.ts:1635` and the structured write route) → bridge
   (`memongo-bridge.ts:190` + structured write surface) → manager inputs
   (`mongodb-manager-write.ts:51` + `writeStructured`) → MCP schemas/dispatch
   (`core.ts:107` + structured tools) → OpenAPI (`openapi-spec.ts:2027` +
   structured schemas). Add `buildUnexpiredClause()` to
   `findSupportingEventIds` (`mongodb-derived-memory.ts:381`) and audit EVERY
   structured read path for the same filter. Deterministic policy for
   invalid/past expiry, tested. Contract tests cover the field on every
   surface, event and structured alike.
3. **B8 plumbing**: thread `resolveContradictions` + `llmDedup` through manager
   facade (`types.ts:1651`, `mongodb-manager-lifecycle.ts:573`) → bridge
   (`memongo-bridge.ts:914`) → API (`routes/v1.ts:2451`) → MCP/client/OpenAPI.
   Validate both flags as booleans at API/MCP/client boundaries; unknown or
   malformed values fail cleanly with a 400-style error. Flags-off tests prove
   prior behavior; invalid-input tests cover each surface.
4. **B10 deployment-scoped capabilities**
   (`mongodb-capability-registry.ts:79`): key probe outcomes by deployment
   identity + feature (no credentials in keys/logs). Test: two fake deployments
   report opposite support concurrently; reset/shutdown removes only its own
   state.
5. **B6 importer batch routing** (`mongodb-manager-benchmark.ts:1497,1522`):
   dataset importer submits bounded batches via `writeConversationEventsBatch`,
   preserving per-item idempotency, authorized scope forcing, ordering,
   partial-error reporting. Throughput proof deferred to B16 (live stack).

Narrow gate per item (conformance + owning suites). Full repo gates before commit.

## Batch 3 — architecture and deploy (commit 4)

Parallel background agents (disjoint surfaces: engine vs api/mcp vs docker).

1. **B11a benchmark extraction**: move benchmark/eval implementation
   (`mongodb-benchmark-runner.ts`, `mongodb-benchmark-harness.ts`,
   `benchmark-parity-envelope.ts`, `benchmark-quality-contracts.ts`,
   `mongodb-manager-benchmark*.ts` impl) to `scripts/benchmark/` as a
   self-contained harness using the engine's internal API; remove benchmark
   imports from the production manager (`mongodb-manager.ts:49`) and its
   facade methods. Published tarball must not contain benchmark/eval code.
   Preserve the public barrel + `/internal` window.
2. **B11b named module splits (user-approved targets):**
   - `apps/api/src/openapi-spec.ts` (3,021) → route-group modules, each <800 LOC.
   - `apps/api/src/routes/v1.ts` (2,517) → domain route modules, each <800 LOC.
   - `mongodb-schema-search-indexes.ts` (1,666),
     `mongodb-schema-validators.ts` (1,340),
     `mongodb-schema-standard-indexes.ts` (1,110) → per-collection modules,
     each <700 LOC.
   - **Explicitly deferred (user-approved):** `mongodb-search-v2.ts` (1,471),
     `mongodb-manager.ts` (2,161), `mongodb-manager-search.ts` (1,275),
     `mongodb-manager-write.ts` (1,211), `apps/mcp/src/server.ts` (1,056).
     Rationale: recently split in P4.3 or high-churn orchestrators; further
     splitting now risks shallow wrappers. Revisit after Batch 2 stabilizes.
3. **B15.6 oversized test files:** split test files >1,500 LOC by
   describe-block domain (currently `mongodb-manager-search.test.ts` ~3,000;
   re-audit after B11b). Keep the shared test kit as the single fixture source.
4. **B12 Docker truth**: compose healthcheck → `/ready`
   (`docker-compose.full.yml:50`); production-safe `compose.yaml` base +
   `compose.override.yaml` dev conveniences; consolidate/label remaining files.
   Acceptance: killing MongoDB keeps `/health` 200 but marks the API container
   unhealthy; base exposes no dev ports.

Full repo gates + benchmark harness smoke-run (mocked) + compose config render
before commit.

## Batch 4 — release readiness (commit 5; publish is user-authorized only)

1. **B5 version + artifact safety**: bump every changed publishable package to
   an unpublished version — lib, client, tools, memongo-memory → 2.0.1;
   pi-extension → 2.1.2 (lifecycle code changed); mcp → 2.0.1 (D3);
   engine/bridge already 2.0.1. Align dependency ranges on bumped packages
   (e.g. dependents of `@memongo/lib` → `^2.0.1`). Package-local
   clean-before-build; exclude tests from publish builds; publishability fails
   on orphan dist output, compiled `*.test.js`, and on a changed package whose
   version already exists on npm; review `npm pack --dry-run` manifests for
   all eight packages. Verify the publish workflow end-to-end (dry-run the
   version-exists skip logic; no changed package may be silently skipped).
   After authorized publication: `npm view <pkg> version` + dist-tag checks
   for every package, recorded in the release notes.
   Acceptance: clean and dirty dist produce identical tarballs.
2. **B16 evidence (user-run, agent-assisted). Prerequisites:**
   - Stack: MongoDB ≥8.3.7 with mongot (the `docker/mongodb` atlas-local
     compose), fresh-machine clone.
   - Credentials: `VOYAGE_API_KEY` (embeddings + rerank), the configured
     consolidation LLM key, `MEMONGO_API_KEY` for the API.
   - Datasets: the benchmark datasets under `benchmarks/` referenced by
     `benchmark-parity-envelope` / `benchmark-quality-contracts`.
   - Commands: `bun scripts/mongodb-e2e-qa.ts`,
     `bun scripts/real-capability-stress.ts`, and the relocated harness under
     `scripts/benchmark/` (post-B11a).
   - Thresholds: ≤1–2 server-side embeds per search (P3.1); import throughput
     ≥10x single-write (B6); mixed-load query-cache hit rate at the P2.4
     target; storedSource field-parity + latency within the P3.3 envelope;
     recall/NDCG within the parity envelope for ranking + P4.4 changes.
   - Artifacts: `benchmarks/results/2026-08-<run>-<name>.json` plus an
     evidence note per gate in `docs/research/`. Owner: user provides the
     stack + keys; the agent runs, records, and commits artifacts.

## Commit strategy

Five commits, staged by explicit path:
1. `chore: builder-queue hygiene (B15)`
2. `fix: builder-queue correctness batch (B3,B4,B7,B9,B13,B14,P1.9,C1-C3)`
3. `feat: builder-queue contract and surface parity (B1,B2,B6,B8,B10)`
4. `chore: builder-queue architecture and deploy (B11,B12,B15.6)`
5. `chore: builder-queue release gates (B5)`

B16 evidence artifacts are committed separately as they are produced.

## Corrected separate backlog (out of scope — durable record per handoff)

These seven items do not block the builder queue but must not disappear:

1. **Embedding input enforcement:** `maxInputTokens` is populated by providers
   but not enforced; `splitTextToUtf8ByteLimit` has no runtime caller. (The
   previously reported `resolveEmbeddingMaxInputTokens` symbol does not exist.)
2. **Logger metadata redaction:** `packages/lib/src/logger.ts:63` serializes
   structured metadata without applying the existing sensitive-text redaction.
3. **Schema initialization latency:** the default agent is pre-warmed at boot,
   but boot/first use of other agents can still perform DDL and wait up to 60s
   for index readiness.
4. **RC4 scoring cleanup:** pre-cross-encoder scoring can be overwritten;
   camera/photography-specific keyword expansions remain; several weights are
   not externally configurable.
5. **TypeScript indexed-access strictness:** no tsconfig enables
   `noUncheckedIndexedAccess`; enabling it is a deliberate monorepo hardening
   project, not a one-line flag change.
6. **Quickstart embedding UX:** local/Ollama providers exist, so "no local
   fallback" is inaccurate; the real gap is the fresh automated quickstart
   still needs an Atlas Model API key for semantic results unless local models
   are manually provisioned.
7. **Retrieval injection integration coverage:** `@memongo/tools` already wraps
   retrieved memory in an untrusted-data quarantine envelope; the remaining
   proposal is defense-in-depth for direct API/engine consumers building their
   own context.

## Definition of done

1. Every review matrix row Complete, or formally recorded in this doc as
   deferred/descoped with user approval (D2 derivation, D4, B11b deferrals).
2. Every batch acceptance item green; full lint/type/build/test from clean clone.
3. Clean and dirty dist produce identical tarballs; no test/benchmark code in packages.
4. B16 evidence artifacts saved at the specified paths.
5. Publication happens only on explicit user authorization after B5/B16,
   followed by the recorded `npm view` verification.
