# Brainstorm: ClawMongo Memory Layer -> Memongo Parity

**Date:** 2026-03-28
**Goal:** 100% feature parity between ClawMongo's `src/memory/` and Memongo's `packages/memory-engine/`

---

## 1. Current Memongo State

### Architecture (already built)

Memongo is a **Bun + Turbo monorepo** with a clean layered architecture:

```
apps/api          Hono HTTP API (/v1/* routes, OpenAPI)
apps/mcp          MCP server (stdio, calls HTTP API)
apps/web          Next.js operator console
apps/docs         Mintlify documentation sources
packages/memory-engine    Core MongoDB memory (the ClawMongo extraction)
packages/memory-bridge    Stable facade for engine (config resolution)
packages/memongo-memory   Published re-export package
packages/client           TypeScript HTTP client SDK
packages/tools            AI SDK tool helpers (Vercel AI SDK)
packages/lib              Shared types + utilities (logger, auth, ssrf, env, etc.)
packages/hooks            React hooks for memory operations
packages/ui               Shared UI components
packages/validation       Validation/proof scripts
packages/ai-sdk           AI SDK integration
packages/memory-graph     Graph visualization component
```

### What already exists in `packages/lib` (dependency shims)

The extraction work already **rewired all imports** from ClawMongo's scattered dependencies into `@memongo/lib`. This is the critical foundation -- all `../logging/subsystem.js`, `../config/types.memory.js`, `../infra/*`, `../agents/*`, and `../utils/*` imports have been replaced:

| ClawMongo import | Memongo lib shim |
|-----------------|-----------------|
| `../logging/subsystem.js` -> `createSubsystemLogger` | `@memongo/lib` -> `createSubsystemLogger` |
| `../config/types.memory.js` -> `MemoryScope`, etc. | `@memongo/lib` or `@memongo/lib/types/memory` |
| `../config/config.js` -> `OpenClawConfig` | `@memongo/lib` -> `MemongoConfig` |
| `../infra/net/ssrf.js` -> `SsrFPolicy` | `@memongo/lib` -> `SsrFPolicy` |
| `../infra/errors.js` -> `formatErrorMessage` | `@memongo/lib` -> `formatErrorMessage` |
| `../infra/env.js` -> `isTruthyEnvValue` | `@memongo/lib` -> `isTruthyEnvValue` |
| `../infra/retry.js` -> `retryAsync` | `@memongo/lib` -> `retryAsync` |
| `../agents/model-auth.js` -> `resolveApiKeyForProvider`, etc. | `@memongo/lib` -> `requireApiKey`, etc. |
| `../agents/agent-scope.js` -> `resolveAgentWorkspaceDir` | `@memongo/lib` -> `resolveUserPath` + inline |
| `../logging/redact.js` -> `redactSensitiveText` | `@memongo/lib` -> `redactSecrets` |
| `../media/mime.js` -> `detectMime` | `@memongo/lib` -> `detectMime` |
| `../utils/run-with-concurrency.js` | `@memongo/lib` -> `runTasksWithConcurrency` |
| `../config/types.secrets.js` -> `SecretInput` | `@memongo/lib` -> `SecretInput` |
| `../utils/normalize-secret-input.js` | `@memongo/lib` -> `normalizeOptionalSecretInput` |

### What already exists in `packages/memory-engine`

The engine already contains **most** of the ClawMongo memory files (100+ files including tests), all with imports rewritten to `@memongo/lib`. The file diff shows exact parity on the majority of modules.

### What the bridge and API already expose

The bridge (`memongo-bridge.ts`) wraps the engine manager with agent-ID resolution and exposes:
- `memongoBridgeSearch`, `memongoBridgeSearchKB`, `memongoBridgeReadFile`
- `memongoBridgeAdd`, `memongoBridgeWriteConversationEvent`
- `memongoBridgeWriteStructuredMemory`, `memongoBridgeWriteProcedure`
- `memongoBridgeProfile`, `memongoBridgeStatus`, `memongoBridgeStats`
- `memongoBridgeSync`, `memongoBridgeProbeEmbedding`, `memongoBridgeProbeVector`
- `memongoBridgeRelevanceExplain`, `memongoBridgeRelevanceBenchmark`, `memongoBridgeRelevanceReport`

The API exposes all of these as `/v1/*` Hono routes.

---

## 2. ClawMongo Memory Dependency Graph

### Internal dependencies (within `src/memory/`)

The memory layer is ~120 files. The core dependency tree:

```
mongodb-manager.ts (3739 LOC, the central orchestrator)
  ├── mongodb-schema.ts (1965 LOC, collections + indexes)
  ├── mongodb-search-executor.ts (852 LOC, CRAG/MMR/constraint relaxation) *** MISSING ***
  ├── search-utils.ts (21 LOC, sortObject) *** MISSING ***
  ├── mongodb-context-expansion.ts *** MISSING ***
  ├── mongodb-contiguous-merge.ts *** MISSING ***
  ├── mongodb-conversation-windows.ts *** MISSING ***
  ├── mongodb-tiered-summary.ts *** MISSING ***
  ├── mongodb-hybrid.ts (fusion scoring)
  ├── mongodb-search.ts (search execution)
  ├── mongodb-events.ts (event sourcing)
  ├── mongodb-graph.ts (entity/relation CRUD)
  ├── mongodb-episodes.ts (episode materialization)
  ├── mongodb-procedures.ts (procedural memory)
  ├── mongodb-profile.ts (profile synthesis)
  ├── mongodb-query-cache.ts (semantic cache)
  ├── mongodb-query-rewriter.ts (query rewriting)
  ├── mongodb-reranker.ts (cross-encoder rerank)
  ├── mongodb-relevance.ts (relevance telemetry)
  ├── mongodb-telemetry.ts (operational telemetry)
  ├── mongodb-mutations.ts (mutation tracking)
  ├── mongodb-analytics.ts (memory stats)
  ├── mongodb-change-stream.ts (change stream watcher)
  ├── mongodb-derived-memory.ts (derived projections)
  ├── mongodb-entity-extractor.ts (regex + LLM extraction)
  ├── mongodb-kb.ts + mongodb-kb-search.ts (knowledge base)
  ├── mongodb-sync.ts (sync orchestration)
  ├── mongodb-topology.ts (connection topology)
  ├── mongodb-ops.ts (operational runs tracking)
  ├── mongodb-migration.ts (v1->v2 backfill)
  ├── mongodb-scope.ts (scope resolution)
  ├── mongodb-retrieval-planner.ts (retrieval path planning)
  ├── embeddings.ts + embeddings-*.ts (embedding providers)
  ├── batch-*.ts (batch embedding pipeline)
  ├── backend-config.ts (config resolution)
  ├── search-manager.ts (manager lifecycle)
  └── types.ts (core interfaces)
```

### External dependencies (outside `src/memory/`)

These are what required shims in `@memongo/lib`:

1. **Logging**: `createSubsystemLogger` (used by ~30 files)
2. **Config types**: `OpenClawConfig` -> `MemongoConfig`, `MemoryScope`, `MemoryMongoDBEmbeddingMode`, `MemoryCitationsMode`
3. **Auth/Keys**: `resolveApiKeyForProvider`, `requireApiKey`, `resolveEnvApiKey`, `parseGeminiAuth`, `ApiKeyRotation`
4. **Infra**: `SsrFPolicy`, `formatErrorMessage`, `isTruthyEnvValue`, `retryAsync`
5. **Paths**: `resolveUserPath`, `resolveAgentWorkspaceDir`
6. **Secrets**: `SecretInput`, `normalizeOptionalSecretInput`
7. **Other**: `runTasksWithConcurrency`, `detectMime`, `redactSensitiveText`

### NPM dependencies

- `mongodb` ^6.13.0 (MongoDB driver)
- `chokidar` (file watching for workspace sync)
- `node-llama-cpp` (optional, local embeddings)

---

## 3. File-Level Gap Analysis

### Files MISSING from Memongo engine (present in ClawMongo)

| File | LOC | Feature | Priority |
|------|-----|---------|----------|
| `search-utils.ts` | 21 | `sortObject` shared utility | P0 |
| `mongodb-search-executor.ts` | 852 | Full search orchestration: CRAG corrective retrieval, constraint relaxation, MMR diversity, multi-pass execution | P0 |
| `mongodb-search-executor.test.ts` | ~500 | Tests for above | P0 |
| `mongodb-context-expansion.ts` | ~200 | Expand search context around hits | P1 |
| `mongodb-context-expansion.test.ts` | ~300 | Tests for above | P1 |
| `mongodb-contiguous-merge.ts` | ~150 | Merge contiguous chunks from same session | P1 |
| `mongodb-contiguous-merge.test.ts` | ~200 | Tests for above | P1 |
| `mongodb-conversation-windows.ts` | ~200 | Build + project conversation windows | P1 |
| `mongodb-conversation-windows.test.ts` | ~300 | Tests for above | P1 |
| `mongodb-tiered-summary.ts` | ~150 | Tiered summary prompts + parsing | P2 |
| `mongodb-tiered-summary.test.ts` | ~200 | Tests for above | P2 |

### Type gaps in `types.ts`

ClawMongo's `types.ts` (211 lines) vs Memongo's `types.ts` (103 lines). Missing:

| Type | Description |
|------|-------------|
| `MemorySearchMode` | "auto" / "direct" / "agentic" |
| `MemorySearchSourcePreference` | Source + path preferences |
| `MemorySearchClassification` | Query classification enum |
| `EvidenceCoverage` | "direct" / "partial" / "indirect" / "none" |
| `MemorySearchTimeRangePreset` | Time range presets |
| `MemorySearchTimeRange` | Time range filter |
| `MemoryConversationScope` | Conversation scope filter |
| `MemoryStructuredScope` | Structured memory scope filter |
| `MemoryReferenceScope` | Reference scope filter |
| `MemoryProceduralScope` | Procedural scope filter |
| `MemorySearchRequest` | Full search request type |
| `RejectedResultSummary` | Rejected result details |
| `MemorySearchPass` | Per-pass metadata |
| `MemorySearchMetadata` | Full search metadata |
| `MemorySearchResponse` | Search response with metadata |
| `MemorySearchResult.canonicalId` | Field missing |
| `MemorySearchResult.sessionId` | Field missing |
| `MemorySearchResult.timestamp` | Field missing |
| `MemorySearchManager.searchDetailed?` | Method missing |

### Index.ts barrel gaps

ClawMongo exports 158 lines of symbols. Memongo exports 138 lines. Missing exports:

- `renderEventChunkText` (from mongodb-events)
- `mergeContiguousChunks` (from mongodb-contiguous-merge) -- file missing
- `expandSearchContext` (from mongodb-context-expansion) -- file missing
- `buildConversationWindows`, `projectConversationWindows`, `ConversationWindow` (from mongodb-conversation-windows) -- file missing
- `buildTieredSummaryPrompt`, `parseTieredSummaryResponse`, `withTieredSummaries` (from mongodb-tiered-summary) -- file missing

### Manager integration gaps

ClawMongo's `mongodb-manager.ts` imports and uses the missing modules:
- Line 14: `expandSearchContext` from `./mongodb-context-expansion.js`
- Line 15: `mergeContiguousChunks` from `./mongodb-contiguous-merge.js`
- Line 16: `projectConversationWindows` from `./mongodb-conversation-windows.js`
- Line 85-88: `executeMongoSearchPlan` etc. from `./mongodb-search-executor.js`
- These are called at lines 942, 2485, 3389, 3421

The Memongo manager likely has these features stripped or stubbed. A careful diff of the two manager files is needed.

---

## 4. Extraction Strategy

### Category 1: Direct Copy (import rewrite only)

These files have **zero** external dependencies beyond `@memongo/lib` and sibling memory files:

| File | Action |
|------|--------|
| `search-utils.ts` | Copy verbatim (zero imports, pure function) |
| `mongodb-search-executor.ts` | Copy, rewrite `./types.js` and `./mongodb-retrieval-planner.js` imports (already local) |
| `mongodb-search-executor.test.ts` | Copy verbatim |
| `mongodb-contiguous-merge.ts` | Copy, verify imports |
| `mongodb-contiguous-merge.test.ts` | Copy |
| `mongodb-tiered-summary.ts` | Copy, rewrite `createSubsystemLogger` to `@memongo/lib` |
| `mongodb-tiered-summary.test.ts` | Copy |

### Category 2: Copy + Adapt imports

These need `../logging/subsystem.js` -> `@memongo/lib` and `../config/types.memory.js` -> `@memongo/lib`:

| File | Adaptations |
|------|-------------|
| `mongodb-context-expansion.ts` | `createSubsystemLogger` -> `@memongo/lib` |
| `mongodb-context-expansion.test.ts` | Same |
| `mongodb-conversation-windows.ts` | `MemoryScope` + `createSubsystemLogger` -> `@memongo/lib` |
| `mongodb-conversation-windows.test.ts` | Same |

### Category 3: Patch existing files

| File | Changes needed |
|------|---------------|
| `types.ts` | Add 15+ missing types (search request, metadata, scopes, etc.) |
| `index.ts` | Add missing exports for new files + `renderEventChunkText` |
| `mongodb-manager.ts` | Add imports for new modules, integrate `executeMongoSearchPlan`, `expandSearchContext`, `mergeContiguousChunks`, `projectConversationWindows` |

### Category 4: No action needed

All other ~100 files are already present and have rewritten imports.

---

## 5. Implementation Phases

### Phase 1: Foundation (30 min)

**Add pure-function files with zero external deps:**

1. Copy `search-utils.ts` to `packages/memory-engine/src/search-utils.ts`
2. Copy `mongodb-search-executor.ts` to `packages/memory-engine/src/mongodb-search-executor.ts`
   - No import changes needed (only imports from `./types.js`, `./mongodb-retrieval-planner.js`, `./search-utils.js`)
3. Copy `mongodb-search-executor.test.ts`
4. Verify: `bun run check-types` in `packages/memory-engine`

**Key features unlocked:**
- `sortObject` shared utility
- `analyzeCorrectionNeeded` (CRAG corrective retrieval)
- `identifyRelaxableConstraint` (constraint relaxation)
- `applyMMRReranking` (MMR diversity scoring)
- `executeMongoSearchPlan` (full search orchestration)
- `buildMemorySearchRequestSignature`, `normalizeMemorySearchRequest`
- `resolveExecutorTimeRange`, `classifyExecutorSearch`
- `buildExecutorPasses`, `computeEvidenceCoverage`
- `applyHardConstraintRejections`, `mergeMetadata`

### Phase 2: Search Enhancement Modules (30 min)

**Add context and merge modules:**

1. Copy `mongodb-context-expansion.ts` -> rewrite `createSubsystemLogger` import to `@memongo/lib`
2. Copy `mongodb-context-expansion.test.ts` -> same
3. Copy `mongodb-contiguous-merge.ts` -> verify imports (likely pure, may use only local types)
4. Copy `mongodb-contiguous-merge.test.ts`
5. Copy `mongodb-conversation-windows.ts` -> rewrite `MemoryScope` + `createSubsystemLogger` to `@memongo/lib`
6. Copy `mongodb-conversation-windows.test.ts`
7. Copy `mongodb-tiered-summary.ts` -> rewrite `createSubsystemLogger` to `@memongo/lib`
8. Copy `mongodb-tiered-summary.test.ts`

### Phase 3: Type Parity (20 min)

**Update `types.ts` to match ClawMongo:**

1. Add all missing types: `MemorySearchMode`, `MemorySearchSourcePreference`, `MemorySearchClassification`, `EvidenceCoverage`, `MemorySearchTimeRangePreset`, `MemorySearchTimeRange`, `MemoryConversationScope`, `MemoryStructuredScope`, `MemoryReferenceScope`, `MemoryProceduralScope`, `MemorySearchRequest`, `RejectedResultSummary`, `MemorySearchPass`, `MemorySearchMetadata`, `MemorySearchResponse`
2. Add missing fields to `MemorySearchResult`: `canonicalId`, `sessionId`, `timestamp`
3. Add `searchDetailed?` method to `MemorySearchManager` interface

### Phase 4: Barrel + Manager Integration (1-2 hours)

**Update index.ts:**

1. Add new exports for Phase 1-2 files
2. Add `renderEventChunkText` export from `mongodb-events.ts`
3. Add type re-exports from `types.ts`

**Patch mongodb-manager.ts:**

This is the hardest part. The ClawMongo manager is 3739 LOC and the Memongo manager needs the following integrations:
1. Import `expandSearchContext`, `mergeContiguousChunks`, `projectConversationWindows`
2. Import `executeMongoSearchPlan` and related types from `mongodb-search-executor`
3. Wire `executeMongoSearchPlan` into the `searchDetailed` method (replaces inline multi-pass logic)
4. Wire `expandSearchContext` into post-search pipeline
5. Wire `mergeContiguousChunks` into post-search dedup
6. Wire `projectConversationWindows` into conversation retrieval path

This requires a careful diff of the two manager files (ClawMongo vs Memongo) to identify exactly which blocks are missing.

### Phase 5: Bridge + API Parity (30 min)

**Update bridge to expose `searchDetailed`:**
1. Add `memongoBridgeSearchDetailed` to bridge
2. Add `/v1/search-detailed` route to API (accepts full `MemorySearchRequest`, returns `MemorySearchResponse`)

### Phase 6: Tests + Verification (1 hour)

1. Run all copied tests
2. Run existing tests to confirm no regressions
3. Run `check-types` across all packages
4. Verify search-executor stress tests pass (Phase 17 tests from ClawMongo)

---

## 6. Latest Improvements Checklist (v2026.3.33)

These are the specific features shipped in ClawMongo v2026.3.33 that MUST be included:

| Feature | File(s) | Status in Memongo |
|---------|---------|-------------------|
| `sortObject` shared utility | `search-utils.ts` | MISSING -- Phase 1 |
| CRAG corrective retrieval (`analyzeCorrectionNeeded`) | `mongodb-search-executor.ts` L442-479 | MISSING -- Phase 1 |
| Constraint relaxation (`identifyRelaxableConstraint`) | `mongodb-search-executor.ts` L485-513 | MISSING -- Phase 1 |
| MMR diversity scoring (`applyMMRReranking`) | `mongodb-search-executor.ts` L519-593 | MISSING -- Phase 1 |
| Full search executor (`executeMongoSearchPlan`) | `mongodb-search-executor.ts` L595-852 | MISSING -- Phase 1 |
| Context expansion (`expandSearchContext`) | `mongodb-context-expansion.ts` | MISSING -- Phase 2 |
| Contiguous merge (`mergeContiguousChunks`) | `mongodb-contiguous-merge.ts` | MISSING -- Phase 2 |
| Conversation windows | `mongodb-conversation-windows.ts` | MISSING -- Phase 2 |
| Tiered summary | `mongodb-tiered-summary.ts` | MISSING -- Phase 2 |
| `renderEventChunkText` export | `index.ts` barrel | MISSING -- Phase 4 |
| Full `MemorySearchRequest` type family | `types.ts` | MISSING -- Phase 3 |
| `searchDetailed` on manager | `mongodb-manager.ts` | MISSING -- Phase 4 |
| Phase 17 stress tests | `mongodb-search-executor.test.ts` | MISSING -- Phase 1 |

---

## 7. Risk Areas

### Risk 1: Manager Divergence (HIGH)

The manager files have likely diverged. ClawMongo's is 3739 LOC; Memongo's may have different internal structure. A line-by-line diff is essential before patching.

**Mitigation:** Do a detailed side-by-side diff of both manager files first. Identify which methods exist in ClawMongo but not Memongo. Copy missing methods rather than trying to patch.

### Risk 2: Test Infrastructure Differences (MEDIUM)

ClawMongo tests import from `../config/config.js`, `../agents/*`, and other framework-specific modules. Memongo test files already have adaptations (e.g., using `@memongo/lib` types), but the new test files being copied may reference ClawMongo test helpers.

**Mitigation:** Check `mongodb-search-executor.test.ts` imports carefully. If it only uses local types + vitest, it should copy cleanly. If it uses ClawMongo test infrastructure, adapt.

### Risk 3: Search Executor Integration Depth (MEDIUM)

`executeMongoSearchPlan` is called from `mongodb-manager.ts` with a complex `executePass` callback that orchestrates the entire search pipeline. The Memongo manager may have a different internal search pipeline structure.

**Mitigation:** The search executor is designed as a pure orchestrator -- it takes `executePass` as a callback. The integration point is the manager's `searchDetailed` method. If the Memongo manager has a simpler search method, `searchDetailed` can be added as a new method wrapping `executeMongoSearchPlan` with the existing search paths.

### Risk 4: renderEventChunkText Already Exists Locally (LOW)

The function exists in Memongo's `mongodb-events.ts` (line 30) but is not exported from `index.ts`. This is just a barrel update.

**Mitigation:** Verify the function signature matches ClawMongo's, then add the export.

### Risk 5: Type System Drift (LOW)

The additional types in `types.ts` (`MemorySearchRequest`, `MemorySearchResponse`, etc.) are referenced by the search executor and manager. If Memongo's existing code references these types by different names or shapes, there could be conflicts.

**Mitigation:** The types are additive (new types, new fields on existing types). No existing type signatures change. The `MemorySearchResult` additions (`canonicalId`, `sessionId`, `timestamp`) are all optional fields, so existing code won't break.

---

## 8. Estimated Effort

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 1: Foundation | 30 min | Low |
| Phase 2: Search Enhancement Modules | 30 min | Low |
| Phase 3: Type Parity | 20 min | Low |
| Phase 4: Barrel + Manager Integration | 1-2 hours | Medium-High |
| Phase 5: Bridge + API Parity | 30 min | Low |
| Phase 6: Tests + Verification | 1 hour | Medium |
| **Total** | **3.5-4.5 hours** | |

Phase 4 (manager integration) is the only risky phase. Everything else is mechanical copy + import rewrite.

---

## 9. Recommended Approach

1. **Start with Phase 1** -- the pure-function search executor. This is highest value (CRAG + MMR + constraint relaxation) with lowest risk (zero integration needed, self-contained).

2. **Do Phase 3 before Phase 4** -- get types right first so the manager patch has correct types to reference.

3. **Phase 4 requires a dedicated diff session** -- open both manager files side by side, identify the 4-5 integration points, and surgically add the missing blocks.

4. **Phase 5 is optional for v1** -- the engine can have full parity even without the bridge/API exposing `searchDetailed`. The manager itself would support it; the HTTP layer can follow.

5. **Run tests after each phase** -- don't accumulate untested changes.

---

## 10. Files Reference

### ClawMongo source (authoritative)
- `src/memory/search-utils.ts` -- 21 LOC, pure function
- `src/memory/mongodb-search-executor.ts` -- 852 LOC, CRAG/MMR/constraint relaxation
- `src/memory/mongodb-context-expansion.ts` -- ~200 LOC, context expansion
- `src/memory/mongodb-contiguous-merge.ts` -- ~150 LOC, contiguous chunk merge
- `src/memory/mongodb-conversation-windows.ts` -- ~200 LOC, conversation windows
- `src/memory/mongodb-tiered-summary.ts` -- ~150 LOC, tiered summary
- `src/memory/types.ts` -- 211 LOC (vs Memongo's 103 LOC)
- `src/memory/index.ts` -- 158 LOC barrel (vs Memongo's 138 LOC)
- `src/memory/mongodb-manager.ts` -- 3739 LOC (the integration target)

### Memongo targets
- `packages/memory-engine/src/` -- all engine files
- `packages/memory-engine/src/types.ts` -- type additions
- `packages/memory-engine/src/index.ts` -- barrel additions
- `packages/memory-engine/src/mongodb-manager.ts` -- integration point
- `packages/memory-bridge/src/memongo-bridge.ts` -- bridge extensions
- `apps/api/src/routes/v1.ts` -- API route additions
- `packages/lib/src/` -- already complete, no changes expected
