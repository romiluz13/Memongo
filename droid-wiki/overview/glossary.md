# Glossary

| Term | Definition |
|------|------------|
| **Agent** | An AI application or coding agent that reads and writes memories. Identified by `agentId`. |
| **AgentId** | Tenant discriminator. Every memory document carries one. Used for logical partitioning in shared-collection mode. |
| **Active slate** | A curated set of currently-relevant memories (persona, user profile, current work) assembled into blocks for prompt injection. |
| **Bitemporal** | A time model where each memory has both a validity interval (`validFrom`/`validTo`) and a system time (when it was recorded). Enables point-in-time queries. |
| **Block** | A labeled section of the active slate (e.g., `persona`, `user-profile`, `current-work`). Each has a token budget. |
| **Bundle** | A context bundle: the assembled prompt-ready memory output from a retrieval request. Includes sections, items, and metadata. |
| **Chunk** | A segment of a knowledge-base document, embedded for vector search. |
| **Consolidation** | The "Dreamer" pipeline that runs offline to detect novelty, extract patterns, reason with LLM, and merge near-duplicate memories. |
| **Context bundle** | See Bundle. |
| **Episode** | A summarized conversation window with trigger conditions. Represents a coherent narrative segment. |
| **Entity** | A graph node representing a person, place, concept, or thing mentioned in memories. |
| **Extraction** | The process of pulling entities, relations, and structured facts from raw conversation events. |
| **Hybrid search** | Combining vector search (semantic) with full-text search (lexical) using rank fusion or score fusion. |
| **Job** | A durable background task with a lease, heartbeat, retries, and dead-letter handling. Types include extraction, consolidation, and sync. |
| **Knowledge base** | A collection of ingested documents, chunked and embedded for retrieval. Separate from conversation-derived memories. |
| **Lane** | A retrieval path in the 8-lane planner. Each lane targets a specific memory type or search strategy (e.g., vector, lexical, graph, episodic). |
| **Mongot** | The Atlas Search/Vector Search process that runs alongside mongod. Required for `$search` and `$vectorSearch`. |
| **Novelty** | A score indicating how new or different a memory is compared to existing ones. Used in consolidation to decide whether to store or merge. |
| **Projection** | The process of transforming raw events into structured memories, entities, and relations. |
| **Recall trace** | A recorded audit of a search request showing which lanes ran, what scores were computed, and which results were selected. |
| **Relation** | A typed edge between two graph entities. Eight relation types: `related_to`, `part_of`, `works_at`, `located_in`, `member_of`, `created_by`, `used_by`, `depends_on`. |
| **Reranker** | A cross-encoder model (Voyage) that re-scores search results for relevance. Runs after initial retrieval. |
| **RRF** | Reciprocal Rank Fusion. A method for combining ranked result lists by inverting ranks. Score formula: `1/(60 + rank)`. |
| **ScoreFusion** | MongoDB 8.3+ aggregation stage that combines raw scores with optional normalization (minMaxScaler, sigmoid). |
| **Scope** | A memory visibility level: `agent`, `session`, `reference`, `structured`, or `procedural`. Controls which memories a search can see. |
| **ScopeRef** | A reference identifier within a scope (e.g., a session ID for session scope). |
| **Structured memory** | A typed fact with lifecycle state (active, superseded, invalidated), revision history, and trust metadata. 14 structured types. |
| **Trust score** | A 7-dimension assessment: exactness, contradiction, scopeMatch, freshness, provenance, confidence, sourceDiversity. |
| **ValidFrom / ValidTo** | Bitemporal validity interval. A memory is "valid" at time T if `validFrom <= T < validTo` and `invalidAt` is null. |
