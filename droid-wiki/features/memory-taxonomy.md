# Memory taxonomy

Active contributors: Rom Iluz

Memongo's public framework contract (`README.md`, "Memory Framework" section, paraphrased from `apps/docs/concepts/framework.mdx` and `apps/docs/concepts/memory-taxonomy.mdx`) defines a taxonomy of six memory types, a fixed set of core operations, and a safety model that governs when memory changes at all. This page maps that product contract onto the code that implements it.

## The six memory types

| Type | What it captures | Engine home | Deep-dive |
|---|---|---|---|
| Episodic events | Conversation and workflow events, summarized into episodes | `packages/memory-engine/src/mongodb-events.ts`, `packages/memory-engine/src/mongodb-episodes.ts` | [Graph, episodes, and entities](../systems/graph-episodes-and-entities.md) |
| Semantic facts | Typed `type + key` structured facts with a lifecycle (active/invalidated/conflicted) and revision history | `packages/memory-engine/src/mongodb-structured-memory.ts` | [Structured memory and procedures](../systems/structured-memory-and-procedures.md) |
| Procedural playbooks | Reusable multi-step action patterns with their own lifecycle | `packages/memory-engine/src/mongodb-procedures.ts` | [Structured memory and procedures](../systems/structured-memory-and-procedures.md) |
| Profile preferences | A synthesized summary over structured memory, entities, episodes, and events | `packages/memory-engine/src/mongodb-profile.ts` (`ProfileSynthesis`) | [Context bundles and state](context-bundles-and-state.md) |
| Workspace knowledge | Ingested document chunks distinct from conversational memory | `packages/memory-engine/src/mongodb-kb.ts`, `mongodb-kb-search.ts` | [Knowledge base](knowledge-base.md) |
| Provenance | Source event IDs, citations, and trace metadata attached to writes and results | `sourceEventIds`, `provenance`, `trust` fields on `MemorySearchResult` (`packages/memory-engine/src/types.ts:60-97`) | [Provenance and evidence](../systems/provenance-and-evidence.md) |

`MemorySource` (`packages/memory-engine/src/types.ts:5`) is the runtime tag on a search result — `"reference" | "conversation" | "structured"` — while `LegacyMemorySource` (`"memory" | "sessions" | "kb" | "structured"`) is the on-disk source label still emitted by older write paths; `InternalMemoryStoredSource` unions the two so read paths can handle both without a migration gate.

## Core operations

| Intent | Operation | API / manager surface |
|---|---|---|
| Find relevant context | Recall | `/v1/search`, `/v1/search-detailed`, `MongoDBMemoryManager.search` |
| Start an answer or agent turn | Context bundle | `/v1/context-bundle`, `buildContextBundle()` in `packages/memory-engine/src/mongodb-context-bundle.ts` — see [Context bundles and state](context-bundles-and-state.md) |
| Save a new event | Remember (event) | `/v1/write-event`, `writeEvent()` in `mongodb-events.ts` |
| Save a stable fact | Remember (fact) | `/v1/write-structured`, `writeStructured()` in `mongodb-structured-memory.ts` |
| Save a playbook | Remember (procedure) | `/v1/write-procedure`, `writeProcedure()` in `mongodb-procedures.ts` |
| Correct memory | Update / feedback | Lifecycle update endpoints, `applyMemoryFeedback` |
| Remove stale memory | Forget | Lifecycle delete or invalidation endpoints |
| Explain why memory appeared | Trace | `/v1/chain-trace`, `packages/memory-engine/src/mongodb-reasoning-chain.ts` |

These map onto the six-scope isolation model described in [Multi-tenancy and scopes](multi-tenancy-and-scopes.md) — every operation above resolves an `{ agentId, scope, scopeRef }` identity before it touches a collection.

## Safety model: read by default, write on explicit intent

The framework contract commits to two rules:

- Phase-1 integrations read by default — they can search and build context bundles without changing memory.
- Writes require explicit intent: a user says "remember this," an app calls a write endpoint as part of a documented workflow, an operator updates or invalidates a memory, or a test/benchmark fixture intentionally writes data. There is no background writeback, hooks, auto-consolidation, or silent client-side capture in the framework slice.

This is enforced structurally rather than by a single flag: read operations (`search`, `context-bundle`, discovery projections) never call a write path internally, and every write operation (`writeEvent`, `writeStructured`, `writeProcedure`, KB ingest) is its own explicit endpoint/manager method that a caller must invoke deliberately. The one documented exception is `@memongo/tools`' middleware helpers, which inject context and then write user/assistant events by design — apps that want read-first behavior use the explicit tools or the TypeScript client directly instead of the middleware.

## Key source files

| File | Role |
|---|---|
| `packages/memory-engine/src/types.ts` | `MemorySource`, `LegacyMemorySource`, `InternalMemoryStoredSource`, and the `MemorySearchResult` provenance fields |
| `packages/memory-engine/src/index.ts` | `MemoryStateFamily` — the profile/blocks/bundle grouping used by context bundles |
| `README.md` | Public statement of the memory framework contract (taxonomy, operations, scope, safety) |
| `apps/docs/concepts/memory-taxonomy.mdx` | Product-facing taxonomy doc with the memory-type-to-storage table and scope mapping |
| `apps/docs/concepts/framework.mdx` | Product-facing framework contract doc with the operation table and safety baseline |

See also [Multi-tenancy and scopes](multi-tenancy-and-scopes.md), [Knowledge base](knowledge-base.md), [Context bundles and state](context-bundles-and-state.md), and [Overview: architecture](../overview/architecture.md).
