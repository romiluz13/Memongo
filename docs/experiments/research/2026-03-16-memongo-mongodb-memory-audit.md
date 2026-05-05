# Memongo MongoDB Memory Audit

Date: 2026-03-16
Scope: Framework-level audit for Memongo as a general-purpose agent runtime, not a RomBot-specific review
Audience: Future AI/code-review sessions, maintainers, launch-readiness reviewers

## Executive Summary

Memongo is already strong in the right places:

- It has a clear MongoDB-only product contract.
- It models the official MongoDB Community Search stack correctly in Docker:
  - `mongod`
  - replica set
  - keyfile auth
  - `mongot`
  - `searchCoordinator` user
  - Search + Vector Search wiring
- It has a meaningful v2 architecture:
  - canonical events
  - derived chunks
  - graph projection
  - episodes
  - retrieval planning
- It has a large and mostly healthy test surface.

But it is not yet fully honest or fully closed as a runtime architecture:

- `mongo_v2` is still blocked by schema validation.
- the default runtime path still behaves mostly like the older sync/search pipeline
- session-memory/source policy is still partially implicit
- `searchV2()` is exported as if complete, but is only partially implemented
- the docs currently claim more runtime closure than the code actually delivers
- the official local `community-mongot` demo stack was not running on this machine during the audit

This means the core MongoDB-first direction is correct, but the framework still needs one more tightening pass before it can honestly claim that the new Mongo memory architecture is the live default experience.

## Audit Inputs

This audit used only:

- Memongo code and docs in this repository
- live local runtime checks on this machine
- official MongoDB docs on mongodb.com

This audit deliberately did not rely on third-party MongoDB skills, Mem0/Cognee docs, or RomBot-specific assumptions.

## Framework Goals This Audit Assumes

Memongo is intended to be:

- a general-purpose OpenClaw-compatible agent framework
- MongoDB-first and MongoDB-only for runtime memory
- suitable for:
  - single agents
  - multi-agent systems
  - team knowledge agents
  - coding agents
  - business-process agents
  - long-running production agents

The memory architecture should therefore be evaluated against these framework-level goals:

- one canonical runtime memory backend
- explicit source ownership
- no hidden fallback to legacy backends
- deterministic retrieval behavior
- clear degraded-mode behavior
- operational truthfulness

## What MongoDB Official Docs Support

The current Docker/Search topology is aligned with official MongoDB docs:

- MongoDB Search in Community requires a replica set deployment with keyfile authentication and `mongot`.
- `mongod` must be configured with:
  - `mongotHost`
  - `searchIndexManagementHostAndPort`
  - `useGrpcForSearch`
- the Search connection requires a user with the `searchCoordinator` role.
- transactions require a replica set or sharded cluster.
- change streams require a replica set or sharded cluster.
- graph traversal can be implemented with `$graphLookup`.

Official MongoDB docs referenced during this audit:

- https://www.mongodb.com/docs/manual/core/search-in-community/deploy-rs-keyfile-mongot/
- https://www.mongodb.com/docs/manual/core/search-in-community/connect-to-search/
- https://www.mongodb.com/docs/manual/reference/configuration-options/index.html
- https://www.mongodb.com/docs/manual/core/transactions/
- https://www.mongodb.com/docs/manual/changestreams/
- https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphlookup/
- https://www.mongodb.com/docs/atlas/atlas-vector-search/crud-embeddings/create-embeddings-automatic/

## What Is Already Architecturally Right

### 1. The Docker/Search topology is directionally correct

The static local stack matches the official MongoDB Community Search shape:

- replica set name in `docker/mongodb/mongod.conf`
- `mongotHost`, `searchIndexManagementHostAndPort`, `useGrpcForSearch`
- keyfile auth enabled
- `mongotUser` with `searchCoordinator` role
- separate `mongod` and `mongot` services
- generated `mongot` config with explicit embedding keys and provider endpoint

Relevant files:

- `docker/mongodb/mongod.conf`
- `docker/mongodb/init-mongo.sh`
- `docker/mongodb/docker-compose.mongodb.yml`
- `docker/mongodb/.runtime/mongot.generated.yml`

### 2. The framework contract is clearer than old OpenClaw memory

The repo now correctly frames Memongo as:

- MongoDB-only for runtime memory
- Community + `mongot` as the official path
- no QMD / SQLite / side-backend story as a normal runtime path

This is a strong product direction and should remain.

### 3. The v2 memory model is the right long-term design

The conceptual architecture is strong:

- canonical events
- derived chunks
- structured memory
- graph projection
- episodes
- retrieval planning

That is the right MongoDB-native direction for a general-purpose agent framework.

### 4. The test surface is substantial

Non-live tests are broad and mostly healthy. The framework is not hand-wavy; it has real coverage.

## What The Audit Verified Locally

### Code-path truth

The following are currently true in runtime code:

- tool-layer memory recall goes through `manager.search(...)`
- manager sync still goes through `syncToMongoDB(...)`
- `syncToMongoDB(...)` still ingests:
  - workspace memory files
  - session transcript files
- `searchV2()` exists but is not the default search path

### Local runtime truth

During this audit:

- `localhost:27017` refused connections
- the local Docker context was `desktop-linux`
- the repo’s official local fullstack connection string was not actually reachable
- a separate Atlas/CloudMongo URI still exists in `~/.codex/config.toml`, but its host resolved to `NXDOMAIN`

So there was no reachable live Memongo MongoDB instance on this machine to validate end-to-end behavior against.

That matters because Memongo is positioning MongoDB as the runtime substrate; the local official fullstack path needs to be reliably bootable and verifiable.

## Main Findings

### Finding 1: `mongo_v2` is still blocked by config validation

Severity: High

The backend config resolver accepts `mongo_v2`, but schema validation still rejects anything except `mongo_canonical`.

Evidence:

- `src/memory/backend-config.ts` accepts both `mongo_canonical` and `mongo_v2`
- `src/config/zod-schema.ts` still rejects `mongo_v2`

Why it matters:

- the new architecture cannot be honestly presented as supported if normal config validation blocks it
- this is a contract break between docs/tests and the real config surface

### Finding 2: v2 architecture is not the default runtime path yet

Severity: High

The docs/README present canonical events as the primary write target, but the actual live search path still runs through the older sync/search pipeline:

- memory tools call `manager.search(...)`
- `manager.search(...)` searches conversation chunks, KB chunks, and structured memory
- `manager.sync()` still calls `syncToMongoDB(...)`
- `syncToMongoDB(...)` still indexes workspace markdown and session transcripts

Why it matters:

- the runtime is still closer to "Mongo-backed indexed sync of files/transcripts" than "event-first canonical runtime"
- this is not wrong as an intermediate state, but it is not the same thing as the v2 architecture promised in docs

### Finding 3: session/source policy is still partially implicit

Severity: High

The framework still auto-enables session memory and defaults Mongo memory search to `["memory", "sessions"]` in the resolver layer when explicit sources are absent.

Why it matters:

- in a general-purpose framework, source policy must be explicit and deterministic
- session transcripts are not just another neutral data source; they change privacy, recall shape, and retention semantics
- the resolved per-agent config should be the single truth, and the manager should consume exactly that

### Finding 4: `searchV2()` is exported before it is complete

Severity: Medium

`searchV2()` is public enough to look real, but several retrieval paths are still stubs or delegated placeholders:

- `structured`
- `hybrid`
- `kb`

Why it matters:

- future AI sessions and future developers may assume the v2 retrieval planner is already fully wired
- exported-but-incomplete APIs create false confidence and architectural confusion

### Finding 5: KB search has a naming-contract regression

Severity: Medium

The broader non-live memory suite found 2 failing tests in `src/memory/mongodb-kb-search.test.ts`.

The failure is straightforward:

- tests expect `results[0].source === "kb"`
- implementation currently returns `source: "reference"`

The implementation is in `src/memory/mongodb-kb-search.ts`:

- `toKBSearchResult()` returns:
  - `source: "reference"`
  - `sourceType: "reference"`

This is likely a naming-contract regression rather than a deep architectural failure, but it proves the memory surface still has inconsistent taxonomy.

### Finding 6: docs overstate the automated embedding story

Severity: Medium

The docs say Memongo does not require an external embedding provider for its official path.

That wording is too broad.

The generated `mongot` config clearly depends on:

- `queryKeyFile`
- `indexingKeyFile`
- `providerEndpoint`

This is still MongoDB-managed embedding behavior from the application’s perspective, but it is not "no external provider exists" in the operational sense.

The cleaner truth is:

- Memongo does not run its own embedding pipeline in app code
- MongoDB Search / `mongot` handles embedding generation
- but self-managed automated embedding still depends on provider-backed config and preview-sensitive MongoDB features

## Generalized Lessons From RomBot, Reframed For Memongo

These are the RomBot lessons that do apply to a general-purpose framework.

### 1. Canonical truth and derived views must be separated

Never let a derived artifact quietly become a shadow source of truth.

For Memongo this means:

- canonical: MongoDB collections that own runtime memory
- derived:
  - chunks
  - graph projection
  - episodes
  - exports
  - analytics

### 2. Health must be split into layers

Do not collapse everything into a single "memory healthy" bit.

Framework-level health should report separately:

- Mongo canonical availability
- Search availability (`mongot`)
- projection lag
- change-stream/watcher health
- backup/recovery posture
- source-policy configuration

### 3. Feature flags must change behavior, not only metadata

If `runtimeMode` exists, it must actually switch codepaths in runtime behavior.

If it only changes resolved config fields and tests, but not writes/reads, it is not a real runtime mode.

### 4. Framework docs must never outrun runtime truth

This is especially important if Memongo is meant to showcase MongoDB.

The story needs to be precise:

- what is supported
- what is preview-sensitive
- what is default
- what is partial
- what is still transitional

### 5. Source policy must be explicit

A general-purpose agent framework cannot let memory ownership drift implicitly across:

- files
- session transcripts
- KB docs
- structured memory
- events
- graph/episodes

It must be possible to reason about exactly what the agent can search and why.

## Tests Run During This Audit

### Passed

Targeted config/memory tests:

- `pnpm exec vitest run src/config/config.schema-regressions.test.ts src/memory/backend-config.test.ts src/memory/search-manager.test.ts`

Result:

- 56 tests passed

Broader non-live memory sweep:

- non-E2E tests in `src/memory`
- memory-tool tests
- selected config schema tests

Result:

- 48 test files passed
- 639 tests passed
- 2 tests failed

### Failed

Only one file failed:

- `src/memory/mongodb-kb-search.test.ts`

Both failures are the same taxonomy mismatch:

- expected `source: "kb"`
- received `source: "reference"`

### Not Run / Not Verified

These remain unresolved in this audit:

- live MongoDB fullstack E2E against a reachable local `community-mongot` stack
- real search index creation/query verification on a running local demo
- end-to-end validation of the "official local showcase" from `docker/mongodb`
- runtime behavior of `mongo_v2` in a fully booted application session

## Improvement Plan For Future AI Sessions

### Release-critical

1. Make config truth match product truth.
   - `mongo_v2` must either be fully supported or fully removed from public surfaces.

2. Make runtime truth match docs.
   - If v2 is supported, the default runtime write/read path must actually switch under `runtimeMode`.

3. Make source policy deterministic.
   - Stop auto-enabling session recall as an implicit Mongo default.
   - Drive runtime behavior from resolved config, not defaults-only reads.

4. Fix the local official fullstack verification path.
   - A maintainer or AI should be able to boot local `community-mongot` and validate:
     - ping
     - Search
     - Vector Search
     - index readiness
     - one real memory ingest/read cycle

### Important but not launch-blocking

5. Decide the public taxonomy for KB results.
   - `kb` vs `reference`
   - then align tests, docs, and tool output

6. Either complete `searchV2()` or stop presenting it as a complete public runtime path.

7. Tighten docs around automated embeddings.
   - precise wording
   - preview-aware wording
   - honest self-managed operational requirements

### Strategic next step

8. Convert the framework memory model into one explicit contract table:

- canonical writes
- derived writes
- searchable stores
- human-authored docs
- operational metadata

The contract should be understandable without reading the whole codebase.

## Suggested Handoff Prompt For Future AI

Use this exact framing:

1. Treat Memongo as a general-purpose OpenClaw-compatible framework.
2. Do not optimize for RomBot or any single channel/use case.
3. Assume MongoDB is the only intended runtime memory backend.
4. Use only official MongoDB docs for database/search behavior.
5. Verify runtime truth, not just docs or tests.
6. Keep canonical truth vs derived views separate.
7. Audit:
   - config truth
   - runtime truth
   - source-policy truth
   - local fullstack verifiability
   - doc truth
8. Do not claim v2 is done unless:
   - config accepts it
   - runtime writes/reads use it
   - local fullstack passes a real E2E cycle

## Bottom Line

Memongo is close to a strong MongoDB-native agent-memory architecture, but it is still in a transitional state between:

- a Mongo-backed v1 sync/search framework
- and a true event-first Mongo-native v2 runtime

The architecture is promising.
The MongoDB direction is correct.
The Docker/Search shape is mostly right.
The codebase has real substance.

But the framework still needs one more pass to make its runtime, its config, and its docs tell the same story.
