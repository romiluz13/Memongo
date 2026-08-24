# Data models

Canonical catalog of the shared TypeScript types that flow between the memory engine, bridge, API, and client. Other wiki pages link here instead of restating type shapes. Types live in `packages/memory-engine/src/types.ts` (engine-internal, richer) and `packages/lib/src/types.ts` / `packages/lib/src/types.memory.ts` / `packages/lib/src/contract.ts` (shared contract, engine-agnostic).

## Scope and identity types

| Type | File | Description |
|---|---|---|
| `MemoryScopeValue` / `MEMORY_SCOPE_VALUES` | `packages/lib/src/contract.ts` | The one canonical scope enum (`session`, `user`, `agent`, `workspace`, `tenant`, `global`); every other scope type derives from this array so validation cannot drift across layers. |
| `MemoryScope` | `packages/lib/src/types.memory.ts` | Alias of `MemoryScopeValue`, used throughout the engine. |
| `MemongoConfig` | `packages/lib/src/types.ts` | Top-level config shape (`memory`, `models`, `agents`) read from env/`~/.memongo/memongo.json`; see [Configuration](configuration.md). |
| `SecretInput` | `packages/lib/src/types.ts` | A secret that is either a plain string or a `{ secretRef }` pointer, for provider API keys. |
| `MemorySource` | `packages/memory-engine/src/types.ts` | `"reference" \| "conversation" \| "structured"` — the three current-generation memory sources. |
| `LegacyMemorySource` / `InternalMemoryStoredSource` | `packages/memory-engine/src/types.ts` | Legacy on-disk/collection source labels (`memory`, `sessions`, `kb`, `structured`) still used internally for stored-document compatibility. |

## Search request/response/result types

| Type | File | Description |
|---|---|---|
| `MemorySearchRequest` | `packages/memory-engine/src/types.ts` | Query plus scope, source-preference, time-range, and per-source scope filters (`conversationScope`, `structuredScope`, `referenceScope`, `proceduralScope`) and an optional `searchConfig`. |
| `SearchConfig` / `ResolvedSearchConfig` | `packages/memory-engine/src/types.ts` | Tunable knobs (`recipe`, `recallProfile`, `fusionMethod`, `hybridMode`, `numCandidates`, `lexicalPrefilter`, etc.); `ResolvedSearchConfig` is the fully-defaulted version actually executed. |
| `SearchRecipe` | `packages/memory-engine/src/types.ts` | `"fast" \| "hybrid" \| "deep" \| "temporal" \| "chain-of-thought"` — named presets over the lower-level `SearchConfig` fields. |
| `MemorySearchResponse` | `packages/memory-engine/src/types.ts` | `{ results: MemorySearchResult[]; metadata: MemorySearchMetadata }` — the top-level search return shape. |
| `MemorySearchResult` | `packages/memory-engine/src/types.ts` | One retrieved memory: path, score, snippet, `source`, scope/scopeRef, temporal validity (`validFrom`/`validTo`), `trust`, and optional `scoreDetails`. |
| `MemorySearchScoreDetails` / `MemorySearchScoreDetailEntry` | `packages/memory-engine/src/types.ts` | Per-pipeline `$rankFusion` contribution breakdown (RRF weight/rank/value), populated only when `scoreDetails: true` was requested. |
| `MemorySearchMetadata` | `packages/memory-engine/src/types.ts` | Diagnostics for a search call: `passes`, `pathsExecuted`, `resultsRejected`, `evidenceCoverage`, `trustSummary`, and the optional retrieval `plan`. |
| `MemorySearchPass` | `packages/memory-engine/src/types.ts` | One multi-pass retrieval attempt (query, paths executed, result count, whether it was reranked/rewritten). |
| `RejectedResultSummary` | `packages/memory-engine/src/types.ts` | A candidate result dropped from the final set, with a `reason`. |
| `MemoryReadResult` | `packages/memory-engine/src/types.ts` | Direct-read-by-locator result: text, path, source, optional `error`/`disabled` flags. |
| `MemoryContextBundleRequest` / `MemoryContextBundle` | `packages/memory-engine/src/types.ts` | Request for and result of a composed context bundle (active slate, query evidence, recent events, discovery projection) rendered as a token-budgeted string for prompt injection. `mode: "wake-up"` returns a compact ~250-token variant. |
| `MemoryDiscoveryProjectionRequest` / `MemoryDiscoveryProjection` | `packages/memory-engine/src/types.ts` | Structured "what changed" / entity-brief / contradiction-report projections built from cross-source evidence. |
| `MemoryActiveSlate` / `MemoryActiveSlateItem` | `packages/memory-engine/src/types.ts` | The curated "what matters right now" item list (active facts, procedures, decisions) surfaced independent of a query. |
| `MemoryBlock` / `MemoryBlocks` | `packages/memory-engine/src/types.ts` | Letta-style labeled core-memory blocks (`persona`, `user-profile`, `current-work`, etc.), each with its own token budget. |

## Trust types

| Type | File | Description |
|---|---|---|
| `MemoryResultTrust` | `packages/memory-engine/src/types.ts` | Per-result trust signal: `score`, `confidence`, `exactness`, `freshness`, `contradiction`, `scopeMatch`, `provenance`, `sourceDiversity`, and human-readable `factors`. |
| `MemorySearchTrustConfidence` | `packages/memory-engine/src/types.ts` | `"high" \| "medium" \| "low"`. |
| `MemorySearchTrustFreshness` | `packages/memory-engine/src/types.ts` | `"fresh" \| "aging" \| "stale" \| "timeless" \| "unknown"`. |
| `MemorySearchTrustExactness` | `packages/memory-engine/src/types.ts` | `"exact-id" \| "exact-locator" \| "approximate"`. |
| `MemorySearchTrustContradiction` | `packages/memory-engine/src/types.ts` | `"none" \| "conflicted" \| "invalidated"`. |
| `MemorySearchTrustScopeMatch` | `packages/memory-engine/src/types.ts` | `"exact" \| "partial" \| "unknown" \| "mismatch"`. |
| `MemorySearchTrustProvenance` | `packages/memory-engine/src/types.ts` | `"dense" \| "partial" \| "sparse" \| "none"`. |
| `MemorySearchTrustSummary` | `packages/memory-engine/src/types.ts` | Aggregate trust stats across a result set: top/average score, confidence distribution, contradiction/stale/exact counts. |

## Lifecycle and stable-handle types

| Type | File | Description |
|---|---|---|
| `MemoryLifecycleFamily` | `packages/memory-engine/src/types.ts` | `"structured" \| "procedure"` — the two revisioned memory families. |
| `MemoryLifecycleState` | `packages/memory-engine/src/types.ts` | `"active" \| "invalidated" \| "conflicted"`. |
| `MemoryStableHandleBase` / `MemoryStableHandle` | `packages/memory-engine/src/types.ts` | Identity that survives revisions: `family`, `id`, `agentId`, `scope`, `scopeRef`, `revision`, `state`, validity window. `MemoryStableHandle` is the discriminated union of `MemoryStructuredStableHandle` and `MemoryProcedureStableHandle`. |
| `MemoryLifecycleStructuredData` | `packages/memory-engine/src/types.ts` | Payload for a structured-fact revision (`type`, `key`, `value`, `confidence`, provenance fields). |
| `MemoryLifecycleProcedureData` | `packages/memory-engine/src/types.ts` | Payload for a procedure revision (`steps`, `triggerQueries`, `successCount`/`failCount`, `lastSuccessAt`/`lastFailureAt`). |
| `MemoryLifecycleItem` | `packages/memory-engine/src/types.ts` | Discriminated union pairing a stable handle with its current data, for either family. |
| `MemoryLifecycleHistoryEntry` | `packages/memory-engine/src/types.ts` | A `MemoryLifecycleItem` plus `historyKind` (`"revision" \| "current"`) and `supersededAt`, for revision history queries. |

## Error envelope

| Type | File | Description |
|---|---|---|
| `ApiErrorBody` | `packages/lib/src/contract.ts` | The one error shape every API route returns: `{ error: { code: string; message: string } }`. |
| `API_ERROR_OPENAPI_SCHEMA` / `API_ERROR_OPENAPI_REF` | `packages/lib/src/contract.ts` | OpenAPI schema and `$ref` for `ApiErrorBody`, shared by the generated OpenAPI document so no route defines its own error shape. |
| `apiErrorOpenApiResponse(description)` | `packages/lib/src/contract.ts` | Helper that wraps `API_ERROR_OPENAPI_REF` into an OpenAPI response fragment for a given status description. |
| `BEARER_SECURITY_SCHEME` / `BEARER_SECURITY_SCHEME_NAME` | `packages/lib/src/contract.ts` | The one bearer-auth security scheme declared for the whole API (`bearerAuth`). |

`packages/lib/src/contract.ts` also re-exports `MEMONGO_API_ROUTES` (from `packages/lib/src/contract-routes.ts`) and `MEMONGO_MCP_TOOL_FIELDS` (from `packages/lib/src/contract-mcp.ts`) as the canonical per-route and per-MCP-tool field tables; a conformance test (`apps/api/src/contract-conformance.test.ts`) fails on drift between these tables and the actual routes/schemas.

Related pages: [Memory engine](../packages/memory-engine/index.md) for how these types are produced, [Architecture](../overview/architecture.md) for where they sit in the request pipeline.
