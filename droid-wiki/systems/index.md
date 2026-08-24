# Systems

The systems lens covers the memory-engine's major subsystems in depth, one concern per page. Start with [Architecture](../overview/architecture.md) for how these fit together end to end, and [Glossary](../overview/glossary.md) for shared vocabulary.

- [Retrieval and search](retrieval-and-search.md) — hybrid vector/text search, fusion methods, reranking, and recall profiles.
- [Consolidation and novelty](consolidation-and-novelty.md) — the offline "Dreamer" pipeline that merges, promotes, or invalidates memories, and surprisal-based novelty detection.
- [Graph, episodes, and entities](graph-episodes-and-entities.md) — entity/relation extraction, graph traversal, and episode summarization from conversation events.
- [Temporal and bitemporal](temporal-and-bitemporal.md) — valid-time vs. transaction-time tracking and point-in-time queries.
- [Structured memory and procedures](structured-memory-and-procedures.md) — typed facts and stored playbooks, their stable-handle addressing and active/invalidated/conflicted lifecycle.
- [Schema, migrations, and indexes](schema-migrations-and-indexes.md) — collection setup, Atlas Search/Vector Search index management, schema validators, capability detection, and data migrations.
- [Embeddings and providers](embeddings-and-providers.md) — embedding generation, provider integrations, and automated vs. client-side embedding modes.
- [Provenance and evidence](provenance-and-evidence.md) — tracing search results back to source events and trust/confidence scoring.
- [Jobs, telemetry, and sync](jobs-telemetry-and-sync.md) — the background job queue, change-stream sync, and operational telemetry.

See also `packages/memory-engine/index.md` for the package's public surface, and `security.md` for security-specific concerns such as the injection classifier.
