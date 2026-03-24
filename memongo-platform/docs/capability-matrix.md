# Memongo platform capability matrix

Maps **Memongo engine** capabilities to the standalone product surface. Engine code lives only in `@romiluz/memongo` (`src/memory/*`). The product layer exposes operations via [`src/memongo-bridge.ts`](../../src/memongo-bridge.ts) → HTTP `/v1/*` → [`MemongoClient`](../src/client.ts).

**Legend:** ✅ exposed · ⏳ planned in a later wave · — not exposed by design

| Agent / gateway parity              | Engine (`MongoDBMemoryManager`)          | Bridge export                         | HTTP                                  | SDK                             |
| ----------------------------------- | ---------------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------- |
| `memory_search`                     | `search()`                               | `memongoBridgeSearch`                 | `POST /v1/search`                     | `search()`                      |
| `kb_search`                         | `searchKB()`                             | `memongoBridgeSearchKB`               | `POST /v1/search-kb`                  | `searchKB()`                    |
| `memory_get`                        | `readFile()`                             | `memongoBridgeReadFile`               | `POST /v1/read-file`                  | `readFile()`                    |
| `memory_write` (structured)         | `writeStructuredMemory()`                | `memongoBridgeWriteStructuredMemory`  | `POST /v1/write-structured`           | `writeStructured()`             |
| Procedures                          | `writeProcedure()`                       | `memongoBridgeWriteProcedure`         | `POST /v1/write-procedure`            | `writeProcedure()`              |
| Conversation ingest                 | `writeConversationEvent()`               | `memongoBridgeWriteConversationEvent` | `POST /v1/write-event`                | `writeEvent()`                  |
| Legacy “add” string as user message | `writeConversationEvent({ role: user })` | `memongoBridgeAdd`                    | `POST /v1/add`                        | `add()`                         |
| Profile                             | `synthesizeProfile()`                    | `memongoBridgeProfile`                | `POST /v1/profile`                    | `profile()`                     |
| Status                              | `status()`                               | `memongoBridgeStatus`                 | `GET /v1/status`                      | `status()`                      |
| Detailed status                     | `getDetailedStatus()`                    | `memongoBridgeGetDetailedStatus`      | `GET /v1/status/detailed`             | `getDetailedStatus()`           |
| Stats                               | `stats()`                                | `memongoBridgeStats`                  | `GET /v1/stats`                       | `stats()`                       |
| Sync workspace → Mongo              | `sync()`                                 | `memongoBridgeSync`                   | `POST /v1/sync`                       | `sync()`                        |
| Embedding probe                     | `probeEmbeddingAvailability()`           | `memongoBridgeProbeEmbedding`         | `GET /v1/probes/embedding`            | `probeEmbedding()`              |
| Vector probe                        | `probeVectorAvailability()`              | `memongoBridgeProbeVector`            | `GET /v1/probes/vector`               | `probeVector()`                 |
| Relevance explain                   | `relevanceExplain()`                     | `memongoBridgeRelevanceExplain`       | `POST /v1/admin/relevance/explain`    | `relevanceExplain()`            |
| Relevance benchmark                 | `relevanceBenchmark()`                   | `memongoBridgeRelevanceBenchmark`     | `POST /v1/admin/relevance/benchmark`  | `relevanceBenchmark()`          |
| Relevance report                    | `relevanceReport()`                      | `memongoBridgeRelevanceReport`        | `GET /v1/admin/relevance/report`      | `relevanceReport()`             |
| Relevance sample rate               | `relevanceSampleRate()`                  | `memongoBridgeRelevanceSampleRate`    | `GET /v1/admin/relevance/sample-rate` | `relevanceSampleRate()`         |
| Close manager                       | `close()`                                | —                                     | —                                     | — (shared server; do not close) |

## Verification

Admin routes under `/v1/admin/*` use the same `MEMONGO_API_KEY` gate as other `/v1/*` routes when `MEMONGO_API_KEY` is set.

Contract checks: `memongo-platform/test/openapi.test.ts` (OpenAPI document shape). Run `pnpm test` in `memongo-platform/`.
