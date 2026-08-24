# Schema, migrations, and indexes

Active contributors: Rom Iluz

Memongo runs against MongoDB deployments that differ in what they support — Atlas Local Preview, Atlas managed clusters, and self-hosted community-mongot all expose different combinations of Atlas Search, Atlas Vector Search, `$rankFusion`/`$scoreFusion`, and index-management features. This system is the layer that sets up collections and indexes, detects what a given deployment actually supports, and migrates older data forward, so the rest of the engine (see [Architecture](../overview/architecture.md)) can write straight-line code against a stable capability contract instead of branching on deployment everywhere.

## Key source files

| File | Role |
|---|---|
| `packages/memory-engine/src/mongodb-schema.ts` | Orchestrator: re-exports the public schema API from the domain modules below; the stable `./mongodb-schema.js` import surface every other file depends on |
| `packages/memory-engine/src/mongodb-schema-types.ts` | Shared types: `DetectedCapabilities`, `MongoIndexBudgetCheck` |
| `packages/memory-engine/src/mongodb-schema-collections.ts` | One accessor function per collection (`chunksCollection`, `eventsCollection`, `structuredMemCollection`, ...) |
| `packages/memory-engine/src/mongodb-schema-budget.ts` | `assertIndexBudget` — per-deployment-profile search-index count ceiling |
| `packages/memory-engine/src/mongodb-schema-capabilities.ts` | `detectCapabilities` / `waitForSearchCapabilities` — probes the connected server |
| `packages/memory-engine/src/mongodb-schema-integrity.ts` | `checkKBOrphans` — data-integrity check for the knowledge base |
| `packages/memory-engine/src/mongodb-schema-search-definitions.ts` | Builds Atlas Search/Vector Search index definitions (autoEmbed fields, stored-source, autocomplete) |
| `packages/memory-engine/src/mongodb-schema-search-indexes.ts` | `ensureSearchIndexes` — creates/updates search indexes against a live deployment |
| `packages/memory-engine/src/mongodb-schema-search-readiness.ts` | Polls index status (`READY`/`ACTIVE`/`FAILED`), queryability checks |
| `packages/memory-engine/src/mongodb-schema-standard-index-types.ts` | `StandardIndexOptions` type shared by the standard-index modules |
| `packages/memory-engine/src/mongodb-schema-standard-indexes.ts` | Coordinator: calls the core/graph/operations standard-index modules |
| `packages/memory-engine/src/mongodb-schema-standard-indexes-core.ts` | Standard (non-search) indexes for events, structured memory, procedures, KB |
| `packages/memory-engine/src/mongodb-schema-standard-indexes-graph.ts` | Standard indexes for entities, relations, entity links |
| `packages/memory-engine/src/mongodb-schema-standard-indexes-operations.ts` | Standard indexes for jobs, telemetry, mutations, query cache, and other operational collections |
| `packages/memory-engine/src/mongodb-schema-index-utils.ts` | `handleUniqueIndexCreationError` — shared conflict handling for index creation |
| `packages/memory-engine/src/mongodb-schema-validators.ts` | `ensureCollections` / `ensureSchemaValidation` — applies `$jsonSchema` validators per collection |
| `packages/memory-engine/src/mongodb-schema-validator-knowledge.ts` | `$jsonSchema` definitions for KB, structured memory, and procedure collections |
| `packages/memory-engine/src/mongodb-schema-validator-memory.ts` | `$jsonSchema` definitions for events, entities, relations, episodes |
| `packages/memory-engine/src/mongodb-schema-validator-operations.ts` | `$jsonSchema` definitions for jobs, mutations, query cache, evidence, and other operational collections |
| `packages/memory-engine/src/mongodb-schema-validator-relevance.ts` | `$jsonSchema` definitions for relevance-eval collections |
| `packages/memory-engine/src/mongodb-migration.ts` | `backfillEventsFromChunks` — one-time data migration from legacy chunk records to canonical events |
| `packages/memory-engine/src/mongodb-capability-registry.ts` | The capability re-enable registry: declares every version-gated or probe-gated feature in one place |

## Why the split

`mongodb-schema.ts` itself is an 80-line orchestrator: a comment at the top of the file states the rule directly — implementations live in per-domain `mongodb-schema-<domain>.ts` modules, and the orchestrator's only job is to re-export them under the original `./mongodb-schema.js` import path so every existing importer and both package barrels keep resolving unchanged. New exports go in the domain module, not the orchestrator.

The ~20 files divide along four concerns that change for different reasons and at different rates:

- **Collections** (`mongodb-schema-collections.ts`) — one thin accessor function per collection name/prefix pair. Changes only when a new collection is added.
- **Standard indexes** (`mongodb-schema-standard-index*.ts`) — ordinary MongoDB indexes (unique keys, TTL, compound lookups), split further into core/graph/operations because each group serves a different subsystem ([structured memory](structured-memory-and-procedures.md) vs. [graph](graph-episodes-and-entities.md) vs. jobs/telemetry — see [Jobs, telemetry, and sync](jobs-telemetry-and-sync.md)) and is maintained by whoever owns that subsystem.
- **Search indexes** (`mongodb-schema-search-*.ts`) — Atlas Search/Vector Search index definitions, creation, and readiness polling. This is the most volatile area: it tracks MongoDB server version gates, Atlas-only features, and autoEmbed configuration, so it is isolated from the standard-index code that never touches `$search`/`$vectorSearch` at all.
- **Validators** (`mongodb-schema-validator-*.ts`) — `$jsonSchema` document shape definitions, split by domain (knowledge, memory, operations, relevance) purely to keep each file under the repo's ~500 LOC guideline; `mongodb-schema-validators.ts` assembles them into one `VALIDATED_COLLECTIONS` map and applies `ensureCollections`/`ensureSchemaValidation`.
- **Capability detection** (`mongodb-schema-capabilities.ts`, `mongodb-capability-registry.ts`) — probes what the connected server actually supports, independent of collection or index shape.

## Schema ensure and migration flow

`ensureCollections` and `ensureSchemaValidation` (`packages/memory-engine/src/mongodb-schema-validators.ts`) create every collection in `VALIDATED_COLLECTIONS` if missing and attach its `$jsonSchema` validator with `validationAction: "errorAndLog"` (MongoDB 8.1+, `"error"` otherwise, gated by `serverVersionAtLeast`), so structurally invalid documents are rejected at write time rather than corrupting a collection silently. `ensureStandardIndexes` (`packages/memory-engine/src/mongodb-schema-standard-indexes.ts`) then delegates to the core/graph/operations modules and sums the index counts they create. Search index setup is separate: `ensureSearchIndexes` (`packages/memory-engine/src/mongodb-schema-search-indexes.ts`) builds vector and text index definitions per collection, submits them, and `waitForSearchIndexesQueryable` / `waitForSearchCapabilities` poll until they report `READY`/`ACTIVE` before the engine treats hybrid search as usable.

`mongodb-migration.ts`'s `backfillEventsFromChunks` is a separate, explicitly one-time path: it reads a caller's legacy `chunks` documents (`source` in `conversation`/`memory`/`sessions`) and creates canonical `events` documents from them, using a deterministic `sha256(agentId:path:hash)` event ID so the migration is idempotent and safe to re-run. It streams via a cursor with bulk-write batching rather than loading everything into memory, and is strictly scoped to the caller's own `agentId` so a shared-prefix collection can never leak another tenant's chunks into the migration.

## Capability registry: adapting to what the deployment supports

`packages/memory-engine/src/mongodb-capability-registry.ts` is the single place every version-gated or probe-gated MongoDB feature declares itself: a `CapabilityGate` records an id, description, either a `minServerVersion` or a `blockedOn` external-fix note, a tracked TODO, and a `shouldEnable` predicate evaluated against the server's `buildInfo`. Current gates include `vector-stored-source` (returnStoredSource, MongoDB 8.3.7+), `autoembed-quantization` (probe-adopt — no version announces support, so a server rejection at index-creation time is recorded via `recordCapabilityProbe` and disables the feature for that deployment only), `rerank-stage` and `lexical-prefilters` (both gated off pending Atlas Search GA), and `flat-indexes` (opt-in exact vector indexing behind an env var, MongoDB 8.3.7+).

Probe outcomes are keyed by a credential-free deployment identity (`mongodbDeploymentIdentity`, derived from host+database+appName with no userinfo), so one deployment's rejection of a feature never disables it for a different deployment sharing the same process — relevant for multi-tenant or test scenarios that spin up several `MongoDBMemoryManager` instances.

`detectCapabilities` (`packages/memory-engine/src/mongodb-schema-capabilities.ts`) is the consumer: it reads `buildInfo.versionArray` to set `rankFusion` (MongoDB 8.1+) and `scoreFusion` (MongoDB 8.3+) — preferring version gating over stage probes because MongoDB documents fusion-stage availability by version — falling back to live `$rankFusion`/`$scoreFusion` probes only when `buildInfo` is unavailable. It separately checks whether the probe collection's actual search indexes are `READY`/`ACTIVE` and type-compatible before claiming `vectorSearch`/`textSearch` are usable, because index-management availability alone does not mean a concrete index is serving queries yet. This is exactly the detection that feeds the fusion-method fallback chain (`scoreFusion` -> `rankFusion` -> `js-merge`) described in [Architecture](../overview/architecture.md) and `docs/adr/0001-substrate-claim-and-score-claim-are-separate.md`, and covered in depth in [Retrieval and search](retrieval-and-search.md).

## Index budget

`assertIndexBudget` (`packages/memory-engine/src/mongodb-schema-budget.ts`) caps the number of search indexes for the `community-mongot` deployment profile at 17 (self-hosted mongot has finite heap per indexed collection), while `atlas-local-preview` and `atlas-managed` are `"unbounded"`. Exceeding the community-mongot budget is meant to degrade to a reduced, chunks-only index target list rather than fail outright, making the addition of a new search index on that profile a deliberate, budget-aware decision.
