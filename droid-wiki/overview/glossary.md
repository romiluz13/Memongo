# Glossary

Memongo-specific vocabulary used throughout this wiki, the codebase, and `CONTEXT.md`.

## Claims and evidence (from `CONTEXT.md`)

| Term | Meaning |
|---|---|
| **Substrate claim** | The assertion that Memongo's architecture is better because MongoDB is its substrate. Proven only by self-facts, never by a benchmark score. |
| **Score claim** | The assertion that Memongo is the best memory framework, earned only by beating competitors on LongMemEval under identical methodology. Kept independent of the substrate claim. |
| **Self-fact** | A verifiable property of MongoDB or of Memongo's own code that stays true regardless of what competitors ship. The only evidence permitted for the substrate claim. |
| **Competitor-fact** | A property of another system. Provides context only, never load-bearing evidence, because it rots when a competitor ships a change. |
| **Lane** | One scoring path within a single search — vector, text, or graph. Lanes are fused, not chosen between (see [Retrieval and search](../systems/retrieval-and-search.md)). |

## Memory model

| Term | Meaning |
|---|---|
| **Agent** | The top-level memory owner, identified by `agentId` (`MEMONGO_AGENT_ID`, default `main`). Each agent gets its own `MongoDBMemoryManager` instance and, in shared-cluster deployments, its own collection namespace. |
| **Scope** | The isolation boundary for a memory: one of `session`, `user`, `agent`, `workspace`, `tenant`, or `global` (`packages/lib/src/contract.ts`). See [Multi-tenancy and scopes](../features/multi-tenancy-and-scopes.md). |
| **ScopeRef** | The concrete identifier within a scope, e.g. a workspace path or tenant id. |
| **Conversation event** | A single message or action recorded via `writeEvent` (`packages/memory-engine/src/mongodb-events.ts`); the canonical, append-only memory record. |
| **Episode** | A summarized group of related conversation events, produced by the episode summarizer (`packages/memory-engine/src/mongodb-episodes.ts`). |
| **Structured memory** | A typed `type + key` fact with a lifecycle (active / invalidated / conflicted) and revision history (`packages/memory-engine/src/mongodb-structured-memory.ts`). |
| **Procedure** | A stored playbook — a reusable multi-step action pattern — with its own lifecycle (`packages/memory-engine/src/mongodb-procedures.ts`). |
| **Stable handle** | An addressable pointer (`family`, `id`, `agentId`, `scope`, `scopeRef`, `revision`, `state`) to a structured memory or procedure, used for lifecycle get/update/delete/history calls. |
| **Active slate** | The always-loaded hot context for the current session, materialized from recent events (`packages/memory-engine/src/mongodb-active-slate.ts`). |
| **Context bundle** | A token-budgeted assembly of profile, blocks, and retrieved evidence for LLM consumption (`packages/memory-engine/src/mongodb-context-bundle.ts`). |
| **Memory blocks** | Always-loaded session context materialized from the active slate, one of the three "State Family" views. |
| **State Family** | The three coordinated views over memory: `profile` (synthesized summary), `blocks` (hot session context), `bundle` (token-budgeted assembly) — see `MemoryStateFamily` in `packages/memory-engine/src/index.ts`. |
| **Discovery projection** | A lightweight index-style projection of what memory exists for a scope, without full content (`packages/memory-engine/src/mongodb-discovery-projections.ts`). |

## Retrieval and ranking

| Term | Meaning |
|---|---|
| **Hybrid search** | Combining vector similarity and full-text lexical search results into one ranked list. |
| **Fusion method** | How lane results are combined: `scoreFusion` (MongoDB-native `$scoreFusion`, default), `rankFusion` (`$rankFusion`), or `js-merge` (client-side RRF fallback/diagnostic path). `MEMONGO_MONGODB_FUSION_METHOD`. |
| **Recall profile** | A retrieval preset trading latency for recall: `latency`, `balanced` (default), or `proof`. `MEMONGO_MONGODB_RECALL_PROFILE`. |
| **Reranker** | A cross-encoder pass (Voyage `rerank-2.5`) applied after fusion to reorder top candidates (`packages/memory-engine/src/mongodb-reranker.ts`). |
| **Trust score** | A composite confidence signal on a search result (`confidence`, `freshness`, `exactness`, `contradiction`, `scopeMatch`, `provenance`) computed in `packages/memory-engine/src/mongodb-trust.ts`. |
| **Novelty detection** | Surprisal scoring via Atlas Vector Search centroid distance, used to flag genuinely new information (`packages/memory-engine/src/mongodb-novelty.ts`). |
| **Consolidation ("Dreamer")** | An offline pipeline that merges, promotes, or invalidates memories using rule-based pattern matching (`packages/memory-engine/src/mongodb-consolidator.ts`). |
| **Reasoning chain** | Provenance traversal from a result back to its source events via `$lookup` on `sourceEventIds` (`packages/memory-engine/src/mongodb-reasoning-chain.ts`). |
| **Access tracker** | Batched write-behind counter of how often a memory is retrieved, used to boost frequently-accessed results (`packages/memory-engine/src/mongodb-access-tracker.ts`). |
| **Importance decay** | Time-based score decay for search results; permanent/ongoing memories never decay (`computeImportanceDecay()` in `mongodb-trust.ts`). |
| **Bitemporal** | Tracking both when a fact was true in the world and when Memongo learned it, enabling point-in-time queries (`packages/memory-engine/src/mongodb-bitemporal.ts`). |

## Infrastructure

| Term | Meaning |
|---|---|
| **mongot** | MongoDB's community search process bundled in `mongodb/mongodb-atlas-local`, providing Atlas Search and Atlas Vector Search locally. |
| **Atlas Local Preview** | The local, Docker-based MongoDB distribution used for development and CI that includes `mongot` and auto-embedding. |
| **Atlas Model API key** | A MongoDB-issued key (`al-...` prefix) that lets `mongot` call Voyage AI for auto-embeddings; distinct from a direct Voyage key (`pa-...`). |
| **Idempotency fingerprint** | A hash used to detect and reject duplicate writes (`packages/memory-engine/src/mongodb-idempotency-fingerprint.ts`). |
| **Job queue** | A MongoDB-backed queue for background enrichment work (extraction, consolidation) with claim/lease/retry semantics (`packages/memory-engine/src/mongodb-memory-jobs.ts`). |
| **Change stream watcher** | A MongoDB change-stream subscriber used for cache invalidation and sync (`packages/memory-engine/src/mongodb-change-stream.ts`). |

See also [Memory taxonomy](../features/memory-taxonomy.md) for how these pieces combine into the product's memory framework contract.
