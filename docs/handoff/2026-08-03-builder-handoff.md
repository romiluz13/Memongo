# Builder Handoff: Complete the Fix-Plan Queue

**Date:** 2026-08-03
**Repository:** `romiluz13/memongo`
**Branch:** `main`
**Implementation base:** `635cfce419`
**Primary execution plan:** `docs/research/fix-plan-b-execution-2026-08-03.md`

## Mission

Execute the remaining Memongo fix-plan work to completion in five reviewable
batches. Preserve the approved decisions below, use test-first fixes, run the
specified gates, and do not publish without explicit user authorization.

Batch 0 may start immediately. Before Batch 1 is declared complete, incorporate
the three additional confirmed correctness items in this handoff. The primary
execution plan does not yet contain those items.

## Source-of-truth order

When documents differ, use this order:

1. This handoff's **Required queue additions and correction**
2. `docs/research/fix-plan-b-execution-2026-08-03.md`
3. `docs/research/fix-plan-builder-review-2026-08-03.md`
4. `docs/research/fix-plan-2026-08-03.md`

The execution plan supersedes the older builder review where the user has
approved a recorded deferral, descoping decision, or narrower module-split
target.

## Repository state at handoff

- `main` is three commits ahead of `origin/main`.
- The implementation base consists of:
  - `45d4ea4b7f` — P0-P2
  - `6df2353dbf` — P3
  - `635cfce419` — P4
- Existing untracked user work:
  - `docs/research/fix-plan-b-execution-2026-08-03.md`
  - `docs/research/fix-plan-builder-review-2026-08-03.md`
- Treat all existing tracked and untracked changes as user work. Do not delete,
  replace, clean, or revert them.
- The review baseline was green for lint, type checking, build, tests, and
  publishability. Publishability has known false negatives that B5 must close.
- Real MongoDB/Voyage E2E, recall benchmarks, the 10k-turn import benchmark,
  and actual publication have not been completed.

## Active constraints

1. Follow `AGENTS.md` and `CLAUDE.md`.
2. Use TDD for every defect: demonstrate a failing test, implement the smallest
   complete fix, then run the owning suite and type checks.
3. Run full `bun run lint`, `bun run check-types`, `bun run build`, and
   `bun run test` before each batch commit.
4. Stage explicit paths only. Never use `git add -A`.
5. Preserve public compatibility unless the execution plan explicitly changes
   it.
6. Do not expose secrets in code, logs, tests, fixtures, or evidence artifacts.
7. Do not publish packages or perform another outward-facing release action
   without explicit user authorization.
8. Keep one logical batch per commit using the five-commit strategy in the
   execution plan.
9. A cold `lib#test` failure may be the documented Turbo flake. Re-run once
   before diagnosing it as a product regression.

## Approved decisions

Do not reopen these decisions unless implementation evidence makes them
impossible:

- **D1:** `MEMONGO_DEFAULT_SCOPE` is the unified read/write default.
  It wins over the legacy variable; conflicting values warn; the legacy
  variable remains a read alias for one deprecation window.
- **D2:** This plan delivers full-field conformance tests and shared definitions
  for new fields. Deriving every API/OpenAPI/MCP/client schema from one runtime
  schema is explicitly deferred.
- **D3:** Publish `@memongo/mcp` as `2.0.1`.
- **D4:** UUID-to-integer prompt mapping is descoped because no UUID-list LLM
  prompt surface exists. Reopen only if such a surface is introduced.
- **B11b:** Split only the named API and schema modules now. The listed
  high-churn orchestrators are explicitly deferred.

## Required queue additions and correction

These requirements were independently verified against `635cfce419`. They are
part of the builder queue, not merely backlog notes.

### C1. Normalize V2 single-lane lexical fallback scores

**Placement:** Batch 1, correctness
**Severity:** High

V2 stores lane results directly:

- `packages/memory-engine/src/mongodb-search-v2.ts:1130`

Cross-lane RRF normalization runs only when more than one path produced
results:

- `packages/memory-engine/src/mongodb-search-v2.ts:1246`

The existing method-aware normalizer maps BM25 text scores onto `[0,1]`:

- `packages/memory-engine/src/mongodb-hybrid.ts:96`
- `packages/memory-engine/src/mongodb-hybrid.ts:388`

The legacy manager path already applies it:

- `packages/memory-engine/src/mongodb-manager-search.ts:426`

**Implementation requirements**

1. Normalize raw lexical/BM25 fallback output in the V2 single-lane path.
2. Reuse the existing method-aware normalization behavior rather than blindly
   clamping raw BM25 scores.
3. Do not distort vector or already-normalized server-fusion scores.
4. Preserve multi-lane RRF behavior.

**Acceptance**

- A V2 search with one lexical fallback lane returns finite scores in `[0,1]`.
- Ordering remains monotonic with the source BM25 ordering.
- Vector-only, server-fusion, and multi-lane RRF regression tests stay green.
- A regression test fails on the pre-fix implementation.

### C2. Make partial KB chunk ingestion retryable

**Placement:** Batch 1, correctness/data integrity
**Severity:** High

Dedup skips an existing document when its persisted hash matches:

- `packages/memory-engine/src/mongodb-kb.ts:165`

Fresh ingestion currently inserts the parent document before chunk writes:

- `packages/memory-engine/src/mongodb-kb.ts:269`

Partial unordered chunk failures are recorded but do not invalidate or remove
the parent hash:

- `packages/memory-engine/src/mongodb-kb.ts:278`
- `packages/memory-engine/src/mongodb-kb.ts:281`

An identical retry can therefore skip permanently missing chunks.

**Implementation requirements**

1. A parent must not appear complete and deduplicable unless all expected
   chunks were persisted.
2. On partial chunk failure, retain enough state for an identical retry to
   repair the missing chunks. Use the existing sync-path partial-failure
   behavior as a consistency reference.
3. Cover fresh ingestion and any standalone/non-transactional re-ingestion
   fallback with the same invariant.
4. Preserve duplicate-key race handling and tenant/scope isolation.

**Acceptance**

- Inject a partial unordered chunk-write failure.
- The first ingestion reports the failure and is not treated as complete.
- Repeating the identical ingestion repairs the missing chunks rather than
  incrementing `skipped`.
- The final parent `chunkCount`, parent hash/completion state, and actual chunk
  set agree.
- Concurrent identical ingestion remains safely deduplicated.

### C3. Surface typed-relation extraction failures

**Placement:** Batch 1, correctness/data integrity
**Severity:** High

Entity extraction already propagates failure to the job-level failure handler:

- `packages/memory-engine/src/mongodb-manager-jobs.ts:276`

Typed-relation extraction catches and logs errors, then allows the extraction
job to complete successfully:

- `packages/memory-engine/src/mongodb-manager-jobs.ts:342`
- `packages/memory-engine/src/mongodb-manager-jobs.ts:394`
- `packages/memory-engine/src/mongodb-manager-jobs.ts:399`

This silently loses relations and prevents the job retry policy from repairing
them.

**Implementation requirements**

1. A typed-relation extraction failure must not produce a successfully
   completed extraction job.
2. Route the error through the existing job failure/retry mechanism while
   preserving lease fencing.
3. Record an observable failed relation projection where possible.
4. Keep retries idempotent for entity, derived-memory, and relation writes.
5. Do not change the existing behavior when no enrichment provider is
   configured or fewer than two entities exist.

**Acceptance**

- A relation-provider failure marks the claimed job failed, not completed.
- Failure metadata identifies the relation stage without exposing sensitive
  content.
- A later successful retry creates the relations and completes the job.
- Entity-extraction failure behavior remains unchanged.
- Projection/job tests prove the old silent-success path cannot recur.

### C4. Correct the B3 MCP acceptance timing

**Placement:** B3 acceptance note in Batch 1

Current MCP `memongo_search` and `memongo_add` do not accept `scope` or
`scopeRef`:

- `apps/mcp/src/tools/core.ts:12`
- `apps/mcp/src/tools/core.ts:107`

Those fields are added by B2a in Batch 2. Therefore B3 cannot complete the MCP
scope-field roundtrip during Batch 1.

Use this acceptance split:

> MCP scope-field roundtrip acceptance completes after B2a lands in Batch 2;
> engine-level roundtrip and Pi consistency tests pass in Batch 1.

Do not treat the deferred MCP assertion as a Batch 1 failure. Do not declare
B2a complete until the MCP roundtrip test passes.

## Corrected separate backlog

Record these seven items in a separate tracker or a clearly labeled
out-of-scope section. They do not block Batch 0 or the current builder queue,
but they must not disappear.

1. **Embedding input enforcement:** `maxInputTokens` is populated by providers
   but not enforced; `splitTextToUtf8ByteLimit` has no runtime caller. The
   previously reported `resolveEmbeddingMaxInputTokens` symbol does not exist.
2. **Logger metadata redaction:** `packages/lib/src/logger.ts:63` serializes
   structured metadata without applying the existing sensitive-text
   redaction.
3. **Schema initialization latency:** the default agent is pre-warmed at boot,
   but boot and first use of other agents can still perform DDL and wait up to
   60 seconds for index readiness.
4. **RC4 scoring cleanup:** pre-cross-encoder scoring can be overwritten;
   camera/photography-specific keyword expansions remain; several weights are
   not externally configurable.
5. **TypeScript indexed-access strictness:** no tsconfig enables
   `noUncheckedIndexedAccess`. Treat enabling it as a deliberate monorepo
   hardening project, not a one-line flag change.
6. **Quickstart embedding UX:** local and Ollama embedding providers already
   exist, so “no local fallback” is inaccurate. The actual gap is that the
   fresh automated quickstart still needs an Atlas Model API key for semantic
   results unless local models are manually provisioned.
7. **Retrieval injection integration coverage:** `@memongo/tools` already
   wraps retrieved memory in an untrusted-data quarantine envelope. The
   remaining proposal is defense-in-depth for direct API/engine consumers that
   build their own context.

The BM25, KB partial-ingestion, and typed-relation failures are deliberately not
in this backlog because C1-C3 promote them into the current builder queue.

## Execution order

### Batch 0: hygiene

Execute B15.1-B15.5 exactly as specified in the primary execution plan. Run the
narrow gates and full repository gates, then create commit 1.

### Batch 1: correctness

Execute the existing order, adding C1-C3 before the batch commit:

1. B13 LRU
2. B14 reference clock
3. B7 consolidation gate identity
4. B4 idempotency fingerprint
5. B9 manager eviction lease
6. B3 unified default scope, with C4's split acceptance timing
7. P1.9 false-green E2E
8. C1 V2 single-lane BM25 normalization
9. C2 KB partial chunk repair
10. C3 relation extraction failure surfacing

Run each owning suite plus `check-types` after its item. Run all full repository
gates before commit 2.

### Batch 2: contracts and public surfaces

Execute B2a, B1, B8, B10, and B6 sequentially as specified. After B2a adds MCP
scope fields, complete and pass C4's deferred B3 MCP roundtrip assertion.

### Batch 3: architecture and deployment

Execute only the approved B11a/B11b/B15.6/B12 targets. Avoid shallow wrappers
and preserve the public barrel plus `/internal` compatibility window.

### Batch 4: release readiness

Complete B5 artifact/version safety and B16 evidence. Building, packing, and
registry reads are allowed as validation. Publication requires a fresh,
explicit user authorization.

## Commit plan

Use the five primary commits from the execution plan, with commit 2 expanded
to include C1-C3:

1. `chore: builder-queue hygiene (B15)`
2. `fix: builder-queue correctness batch (B3,B4,B7,B9,B13,B14,P1.9,C1-C3)`
3. `feat: builder-queue contract and surface parity (B1,B2,B6,B8,B10)`
4. `chore: builder-queue architecture and deploy (B11,B12,B15.6)`
5. `chore: builder-queue release gates (B5)`

B16 evidence artifacts may be committed separately as they are produced.
Before committing, inspect status and the staged diff for unrelated user work.

## Completion and stop conditions

Do not declare the fix plan complete unless all of the following hold:

1. Every non-deferred execution-plan item and C1-C4 satisfies its acceptance
   criteria.
2. D2, D4, and B11b deferrals remain explicitly recorded.
3. The seven corrected backlog items have a durable separate tracker or
   out-of-scope record.
4. Full lint, type, build, and test gates pass from a clean clone.
5. Required live MongoDB and benchmark evidence is saved at the paths specified
   by B16.
6. Clean and dirty `dist` states produce identical package tarballs.
7. No compiled test or benchmark/eval implementation ships.
8. Every changed publishable package has an unpublished version and aligned
   dependency ranges.
9. Publication, if authorized later, is followed by recorded `npm view`
   version and dist-tag verification.
10. Repository status contains no unexplained files or modifications.

Stop and ask the user before:

- publishing or changing a remote repository;
- changing an approved decision or deferral;
- deleting or replacing existing user work;
- weakening an acceptance criterion because a test or environment is hard to
  satisfy;
- marking B16 complete without the required stack, keys, datasets, and saved
  evidence.

## Errors and blockers

- No unresolved command or test errors were present when this handoff was
  created.
- B16 remains environment-gated by the live MongoDB/mongot stack, Voyage and
  consolidation credentials, and benchmark datasets described in the primary
  execution plan.

## Builder's first actions

1. Read this handoff and the primary execution plan in full.
2. Run `git status --short --branch` and preserve the two existing untracked
   research documents.
3. Add C1-C4 and the corrected backlog record to the working execution
   checklist without reopening D1-D4.
4. Start Batch 0 with B15.1 and its failing/reproduction check.
5. After Batch 0, show the user the status, validation results, and proposed
   explicit-path commit before any action requiring confirmation.

## Copyable kickoff instruction

> Execute `docs/handoff/2026-08-03-builder-handoff.md`. Treat
> `docs/research/fix-plan-b-execution-2026-08-03.md` as the primary batch plan
> and the handoff's C1-C4 requirements as mandatory additions. Preserve D1-D4,
> use TDD and narrow gates per item, run full repository gates before each
> batch commit, preserve all existing user work, and do not publish without my
> explicit authorization. Start with Batch 0.
