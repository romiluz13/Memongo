# Knowledge base

Active contributors: Rom Iluz

The knowledge base (KB) is Memongo's ingestion and search surface for workspace knowledge — docs, repo notes, research, and other reference material — kept as a distinct memory type from conversation events, structured facts, or procedures (see [Memory taxonomy](memory-taxonomy.md)).

## Ingestion

`ingestToKB()` in `packages/memory-engine/src/mongodb-kb.ts` writes two collections per document: a parent `kb` document (title, content, source metadata, hash) and a set of `kbChunks` (markdown-chunked via `chunkMarkdown`, default 600 tokens with 100-token overlap). Every document and chunk is tagged with the caller's resolved `{ agentId, scope, scopeRef }` (`resolveKBScope()`), and `scopeRef` is the filter every read, write, and delete path applies — tenants sharing one physical collection cannot observe or mutate each other's KB (issue #27 in the code comments).

Ingestion is idempotent and self-healing:

- Dedup runs by `source.path` first, then by content hash, against documents already sharing the same `scopeRef`. A same-content, fully-persisted document is skipped.
- A parent document is born with `chunksComplete: false` and is only flipped to `true` once every chunk write for it lands. A parent whose chunk writes partially failed — or that predates the marker — is a candidate for repair on the next ingest rather than being skipped, so a crash mid-write can never leave a KB permanently missing chunks.
- Re-ingesting changed content (hash mismatch) deletes the old document and chunks and inserts the new ones inside a `withTransaction()` when the client supports replica-set transactions (`reIngestAtomically()`), falling back to sequential writes on standalone topology.
- Documents are capped at a configurable size (default 10 MB, hard ceiling 15 MB, measured in UTF-8 bytes) before chunking.

`ingestFilesToKB()` layers a filesystem walk on top (`.md`/`.txt` files, recursive by default, symlinks skipped) and builds `KBDocument` inputs from file contents. Management helpers (`listKBDocuments`, `removeKBDocument`, `getKBStats`) all filter and scope by the same resolved `scopeRef`; `removeKBDocument()` deletes the parent inside the tenant filter first and only deletes chunks if that delete actually matched, so a cross-tenant delete attempt touches nothing.

## Search

`searchKB()` in `packages/memory-engine/src/mongodb-kb-search.ts` runs the same fusion waterfall as general conversation search (`$scoreFusion` -> `$rankFusion` -> vector/lexical fallback -> `$text`), but scoped to the `kbChunks` collection and always filtered on `scopeRef` — `resolveKBChunkFilter()` treats `scopeRef` as a mandatory tenant-isolation predicate that is never optional, even when a caller passes an additional `tags`/`category`/`source` filter. KB fusion uses a fixed 0.7 (vector) / 0.3 (text) weight split (`KB_FUSION_VECTOR_WEIGHT`, `KB_FUSION_TEXT_WEIGHT`), the same split the general search path uses, so score normalization can't drift between the two lanes.

The `fusionMethod` param (`scoreFusion`, `rankFusion`, or `js-merge`) mirrors `MEMONGO_MONGODB_FUSION_METHOD` and lets the manager choose which MongoDB-native fusion operator to prefer before falling back client-side.

### How KB search differs from conversation search

- **`scopeRef` is required, not optional.** `apps/api/src/app.ts`'s `routePolicyError()` enforces this at the API layer for scoped keys: a scoped API key policy must define a concrete (non-wildcard) `scopeRefs` constraint to call `/v1/search-kb` at all, because an unscoped KB search could otherwise return chunks across the whole knowledge base regardless of the key's other restrictions. See [Multi-tenancy and scopes](multi-tenancy-and-scopes.md).
- **Results are chunk-shaped, not event-shaped.** `toKBSearchResult()` returns a `MemorySearchResult` with `source: "reference"` and a `kb:<path>` path prefix, distinct from the `conversation` or `structured` sources conversation search returns.
- **KB documents carry an optional secondary filter** (`tags`, `category`, `source`) resolved against the parent `kb` collection and translated into a `docId: { $in: [...] }` constraint on the chunk query — conversation search has no equivalent document-level filter.

## Integration points

- HTTP: `/v1/search-kb` (route policy discussed above), plus the ingest/list/remove/stats management endpoints in `apps/api/src/routes/v1.ts`.
- Engine: `ingestToKB`, `ingestFilesToKB`, `listKBDocuments`, `removeKBDocument`, `getKBStats` in `mongodb-kb.ts`; `searchKB` in `mongodb-kb-search.ts`.
- Query cache: successful ingests and deletes call `invalidateQueryCache()` for the affected `{ agentId, scope, scopeRef }` so stale search results don't survive a KB update.

## Key source files

| File | Role |
|---|---|
| `packages/memory-engine/src/mongodb-kb.ts` | Ingestion, dedup/repair logic, atomic re-ingestion, list/remove/stats management |
| `packages/memory-engine/src/mongodb-kb-search.ts` | `searchKB()` — fusion-based hybrid search over `kbChunks`, scoped by `scopeRef` |
| `apps/api/src/app.ts` | `routePolicyError()` — enforces a concrete `scopeRefs` constraint for scoped keys on `/v1/search-kb` |

See also [Memory taxonomy](memory-taxonomy.md), [Multi-tenancy and scopes](multi-tenancy-and-scopes.md), and [Retrieval and search](../systems/retrieval-and-search.md) for the shared fusion mechanics.
