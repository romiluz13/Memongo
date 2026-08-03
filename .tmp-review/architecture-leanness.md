# Architecture Leanness — Deep Review Findings

Module graph (verified from every package.json + grep of all `@memongo/` imports):

```
@memongo/lib  ←  @memongo/memory-engine  ←  @memongo/memory-bridge  ←  apps/api
                                              ↑
@memongo/client (zero runtime deps)  ←  @memongo/tools, apps/mcp, apps/web, packages/pi-extension
@memongo/memory (= @memongo/memongo-memory) = 2-line re-export of engine+bridge (publish alias)
scripts/* import client / bridge / engine / lib directly (dev-only, fine)
```

The package DAG is acyclic and directionally correct: no app imports the engine directly, no
package imports sideways, no cycles. The layering violations and bloat are all *inside* the
layers, not between them.

## Findings

- [SEV: high] God files an order of magnitude past the repo's own ~500-LOC rule
  - Where: `packages/memory-engine/src/mongodb-manager.ts` (11,265 LOC), `packages/memory-engine/src/mongodb-schema.ts:1` (4,296 LOC), `packages/memory-engine/src/mongodb-graph.ts` (1,954), `packages/memory-engine/src/mongodb-search-executor.ts` (1,945), `packages/memory-engine/src/mongodb-structured-memory.ts` (1,693), `packages/memory-engine/src/types.ts:1` (1,645, 151 exported symbols)
  - What: `MongoDBMemoryManager` (`mongodb-manager.ts:2071`) holds ~50 public methods spanning search, sync, KB, lifecycle, benchmarks, traces, jobs, consolidation, novelty, self-edit, plus top-level helpers (`rerankResults`, `deduplicateSearchResults`, `mergeRankedResultSets`, `scorePreferenceGroundingSignalBoost`). It even imports the e2e QA runner (`mongodb-manager.ts:183` imports `runE2eQa`). `mongodb-schema.ts` is ~30 collection accessors + 99 `createIndex` call sites in one file.
  - Why it matters: every feature lands in one file → constant merge contention, impossible navigation, and it forces the downstream workarounds seen in the bridge (finding below). The manager's test file is 7,242 LOC — the god file breeds a god test.
  - Recommendation: split the manager by the subsystem boundaries that already exist as sibling modules (search orchestration, lifecycle/structured writes, benchmark/eval, admin/status) into collaborator classes the facade delegates to; split schema.ts into per-domain index modules. Do not add features to these files until split.

- [SEV: high] Dead production code shipped in the published engine package
  - Where: `packages/memory-engine/src/batch-voyage.ts:1` (zero non-test importers, verified static + dynamic), and the entire `batch-*` cluster it anchors — `batch-embedding-common.ts`, `batch-runner.ts`, `batch-http.ts`, `batch-upload.ts`, `batch-status.ts`, `batch-output.ts`, `batch-utils.ts`, `batch-provider-common.ts`, `batch-error-utils.ts` (~600 LOC + ~700 LOC of tests); `packages/memory-engine/src/embedding-model-limits.ts:1` (dead twin of the live `embedding-input-limits.ts`, which is what `internal.ts` actually imports); `packages/memory-engine/src/fact-extraction-eval.ts:1` and `packages/memory-engine/src/benchmark-failure-taxonomy.ts:1` (referenced only by their own test files)
  - What: the batch cluster's only entry point is `batch-voyage.ts`; nothing in production imports it (grep confirms no static or dynamic importer outside tests). `embedding-model-limits.ts` duplicates `embedding-input-limits.ts` naming and purpose, confusing which one is authoritative.
  - Why it matters: `packages/memory-engine/package.json` publishes `files: ["dist"]`, so all of this compiles into the npm artifact; dead code with live tests keeps accruing maintenance (its tests run every CI) while delivering nothing.
  - Recommendation: delete the batch cluster + the three orphan modules and their tests, or wire `batch-voyage` into `embeddings-voyage.ts` if Voyage batch embedding was the intent (currently `embeddings-voyage.ts` has no batch path at all).

- [SEV: high] Three overlapping benchmark/eval systems; test code outweighs product code
  - Where: shipped in src — `packages/memory-engine/src/mongodb-benchmark-runner.ts` (1,977 LOC), `mongodb-benchmark-dataset.ts` (702), `benchmark-parity-envelope.ts` (489), `mongodb-e2e-qa.ts` (331, imported by the production manager), `mongodb-benchmark-harness.ts`, `mongodb-benchmark-readiness.ts`, `benchmark-quality-contracts.ts`; scripts stack — `scripts/` has 6,186 LOC across `memory-eval-core.ts`, `real-memory-eval.ts`, `compare-memory-eval.ts`, `proof-pack.ts`, `proof-artifacts.ts`, `run-benchmark.ts`, `stress-test.ts`, `real-capability-stress.ts`, `real-agent-smoke.ts`; mega e2e suites — `production-readiness.e2e.test.ts` (3,670 LOC), `real-e2e-v2.e2e.test.ts` (2,551), `e2e-evaluation.e2e.test.ts` (2,335), `mongodb-e2e.e2e.test.ts` (1,900)
  - What: engine test files total 66,349 LOC vs 56,715 LOC of non-test source — the package is more test than product, and evaluation logic exists in three generations (engine-internal runner, scripts harness, e2e suites) with partially duplicated concepts (quality contracts, parity envelope, proof packs).
  - Why it matters: CI time, flake surface (vitest.config.ts carries 240s/900s hook budgets just to keep these alive), and every refactor pays the tax three times. The benchmark runner being *shipped in the runtime package* also forces the engine public API to export eval internals (`evaluateRankingCase`, `loadBenchmarkDataset`, …).
  - Recommendation: pick ONE eval home (scripts/ or a dev-only private package, not the shipped engine); move `mongodb-benchmark-*`/`benchmark-*`/`fact-extraction-eval`/`mongodb-e2e-qa` out of `src/`; consolidate the four mega e2e suites into one parameterized suite.

- [SEV: high] The wire contract is hand-maintained in four places and has already diverged
  - Where: `apps/api/src/routes/v1.ts:1` (2,221 LOC of hand-rolled body parsing/validation), `apps/api/src/openapi-spec.ts:4` (2,803 LOC hand-written spec with the comment "Keep this aligned with the supported route contract"), `apps/mcp/src/server.ts:139` (40 inline tool definitions), `packages/tools/src/index.ts:316` (28 zod-defined tools)
  - What: MCP defines 4 copy-pasted "semantic alias" pairs (`memongo_memory_get|update|delete|history` duplicating `memongo_lifecycle_*`, `apps/mcp/src/server.ts:402`) and several tools absent from `packages/tools` (`memongo_recall_messages`, `memongo_import_conversation_history`, `memongo_status_detailed`, `memongo_search_detailed`, `memongo_write_structured`, `memongo_write_procedure`). The OpenAPI tests (`apps/api/src/app.test.ts:453`) only assert that paths exist plus one benchmark schema — they cannot catch spec/route drift in request shapes.
  - Why it matters: four hand-synced copies of one contract guarantees drift; agents connecting via MCP vs AI-SDK tools vs raw HTTP see different tool sets and field descriptions. This is the project's #6 priority (agent-agnostic connectivity) undermined structurally.
  - Recommendation: make `packages/client` types (or a new `@memongo/contract` module) the single source: generate/derive the OpenAPI document, the MCP tool list, and the zod tools from one route/tool table. Drop the MCP alias pairs (or implement aliases as data, not copy-pasted schema blocks).

- [SEV: medium] memory-bridge is ~90% shallow pass-through, and its real work is compensating for a broken type seam
  - Where: `packages/memory-bridge/src/memongo-bridge.ts` (1,301 LOC, ~45 exported functions); CapableManager casts at `memongo-bridge.ts:187-320` (~250 LOC of intersection types); structural type re-declarations at `memongo-bridge.ts:53-186` (~190 LOC); root cause at `packages/memory-engine/src/types.ts:640` (`MemorySearchManager` marks nearly every method optional, e.g. `hydrateActiveSlate?`, `recallConversation?`) while the only implementation `MongoDBMemoryManager implements MemorySearchManager` (`mongodb-manager.ts:2071`) implements all of them
  - What: ~40 of ~45 bridge functions are `const m = await memongoBridgeGetManager(...); return m.method(params)`. The bridge's *genuine* value is tenant-isolation enforcement (forcing authorized agentId/scopeRef over caller-smuggled nested fields, `memongo-bridge.ts:432-470`, Issue #42 comments), config resolution, shutdown, and `memongoBridgeGetState` composition — maybe 15% of the file. The rest exists because the engine's public interface was left optional for a pluggable-backend abstraction that has exactly one backend.
  - Why it matters: the `if (!m.hydrateActiveSlate) throw` runtime checks are dead defensiveness in a same-repo, same-version world, and the three parallel descriptions of the manager API (optional interface, class, bridge casts) will drift — they already require `as` casts at the seam.
  - Recommendation: make `MemorySearchManager` methods non-optional (there is one backend; the interface can still exist for testing), delete the 18 CapableManager types, and re-export engine response types instead of re-declaring them. Keep the tenant-forcing logic — that is the bridge earning its layer.

- [SEV: medium] Engine public API is a 338-line flat barrel leaking internal plumbing
  - Where: `packages/memory-engine/src/index.ts:1`
  - What: ~250+ symbols exported, including collection accessors (`queryCacheCollection`, `telemetryCollection`, `mutationsCollection`, `laneCoverageCollection`, `sessionChunksCollection`, `ensureEntityAutocompleteIndex` — index.ts:212-222), executor internals (`buildExecutorPasses`, `applyMMRReranking`, `normalizeMemorySearchRequest`, `buildConstraintSummaries`), and `sortObject`. Verified none of these have non-test internal consumers that require them to be public.
  - Why it matters: every export is a SemVer commitment for consumers of `@memongo/memory-engine`; leaking plumbing freezes internal refactors (like splitting the god files).
  - Recommendation: cut the barrel to the manager class + config + the request/response types apps actually use; move the rest behind an explicit `@memongo/memory-engine/internal` subpath (or unexported).

- [SEV: medium] Type triplication across the seam
  - Where: `packages/client/src/types.ts:28` (`SearchConfig` with recipe/recallProfile/fusionMethod unions), `packages/memory-engine/src/types.ts:297-308` (same unions), and a third inline copy inside `memongoBridgeSearchDetailed` (`packages/memory-bridge/src/memongo-bridge.ts:877-1010`) including `as` casts of caller input to the re-declared unions
  - What: the client's zero-dependency stance justifies one wire-type copy; the bridge's third inline re-declaration is pure duplication of the engine types it already imports.
  - Recommendation: bridge should import `SearchConfig`/`MemorySearchRequest` types from the engine and drop the inline unions; document client/types.ts as the wire contract (see contract finding).

- [SEV: low] Byte-identical duplicated compose file
  - Where: `docker/docker-compose.yml:1` and `docker/mongodb/docker-compose.preview.yml:1` — `diff` reports them identical; the former even carries a header comment naming the latter's path
  - Recommendation: keep one (the mongodb/ one), replace the other with a two-line `include:` or delete it.

- [SEV: high] Dangerous thinness: zero tests on the security/correctness-critical edges
  - Where: `packages/lib/src/ssrf.ts` (SSRF policy guarding every remote embedding fetch), `packages/lib/src/redact.ts` (secret redaction), `packages/lib/src/retry.ts`, `packages/lib/src/auth.ts` — packages/lib has ZERO test files while being the most-imported package by the engine's network paths. `packages/client/src/client.ts` (1,049-LOC public HTTP SDK) has ZERO tests. `apps/mcp/src/server.ts` (2,095 LOC, 40 tools) has one 355-LOC test file. `packages/pi-extension/extensions/index.ts` (447 LOC wiring a coding agent's lifecycle) has ZERO tests. `apps/web` (695 LOC) has ZERO tests (acceptable risk).
  - Why it matters: the repo spends 66k test LOC on engine e2e/benchmark theater while the SSRF guard, redaction, the published SDK's error/retry parsing, and the MCP tool surface — the things an external user or attacker actually touches first — are unverified. This is the inverse of "as lean as possible while staying as good as possible."
  - Recommendation: redirect a fraction of the eval-harness budget: unit-test lib's ssrf/redact/retry/auth (pure functions, cheap), contract-test client.ts against a mock Hono app (the fixtures already exist in `apps/api/src/__fixtures__/contract-fixtures.ts`), and add per-tool smoke tests for all 40 MCP tools.

- [SEV: medium] API edge swallows malformed JSON
  - Where: `apps/api/src/routes/v1.ts:69-80` — `readJsonBody` returns `{}` on any parse error (except BodyLimitError)
  - What: a syntactically invalid JSON body is treated as "all fields absent", so routes silently proceed with defaults (or fail later with a misleading missing-field error) instead of 400 malformed-request.
  - Recommendation: return a 400 with `INVALID_JSON` on parse failure; keep the empty-object fallback only for genuinely empty bodies.

## Verdict

### Cut list (delete or merge — with evidence)
1. `batch-voyage.ts` + entire `batch-*` cluster (~1,300 LOC incl. tests) — zero production importers.
2. `embedding-model-limits.ts`, `fact-extraction-eval.ts`, `benchmark-failure-taxonomy.ts` (+tests) — self-tested only.
3. `mongodb-benchmark-runner/dataset/harness/readiness`, `benchmark-parity-envelope`, `benchmark-quality-contracts`, `mongodb-e2e-qa` (~3,900 LOC) — move out of shipped `src/` into scripts/ or a dev package; `runE2eQa` must leave `mongodb-manager.ts:183`.
4. One of the three eval generations in `scripts/` (keep one canonical harness + `run-benchmark.ts` entry).
5. The 18 `*CapableManager` intersection types and `if (!m.x) throw` checks in `memongo-bridge.ts` — after making `MemorySearchManager` concrete.
6. Bridge's structural re-declarations (`MemongoBridgeActiveSlate`/`DiscoveryProjection`/`ContextBundle`, ~190 LOC) and the inline SearchConfig unions — import from engine.
7. MCP `memongo_memory_*` alias pairs (~120 LOC of copy-pasted schemas) — implement as data aliases or drop.
8. ~100+ leaked internal exports from `packages/memory-engine/src/index.ts` (collection accessors, executor internals).
9. `docker/docker-compose.yml` — byte-identical duplicate of `docker/mongodb/docker-compose.preview.yml`.
10. `mongodb-manager.test.ts` (7,242 LOC) — splits naturally once the manager does.

### Keep list (complexity that earns its place)
- `@memongo/lib` (14 files, 1,173 LOC): ssrf/retry/logger/redact used by ~30 engine modules; exactly what a shared package should be. (But: add tests.)
- `@memongo/client` zero-runtime-dep design: right call for an SDK meant to be embedded anywhere.
- `@memongo/memongo-memory` 2-line re-export: justified as the published `@memongo/memory` alias.
- Bridge's tenant-isolation forcing (agentId/scopeRef overrides, `memongo-bridge.ts:432-470`): real security value, the reason the layer exists.
- `apps/api/src/scope-identity.ts` + the Issue #57 merged-input validation in v1.ts: thoughtful, security-relevant, well-commented.
- The dual search stack (`mongodb-search.ts` legacy fusion + `mongodb-search-executor.ts` v2 planner-driven): genuinely different generations with the manager routing between them; consolidate only after v2 fully subsumes legacy.
- tsconfig setup: 12 files all thin `extends: tsconfig.base.json` — no sprawl. Single root biome.json. Wrangler configs are per-deploy-target, justified.

### Thicken list (too lean)
1. `packages/lib` — zero tests on ssrf/redact/retry/auth (security-critical, pure functions, cheap to test).
2. `packages/client` — zero tests on the 1,049-LOC public SDK (error mapping, retries, URL joining).
3. `apps/mcp` — 355 LOC of tests for a 40-tool, 2,095-LOC server; needs per-tool smoke tests.
4. `packages/pi-extension` — zero tests on agent lifecycle hooks (447 LOC).
5. `apps/api/src/routes/v1.ts:69` — malformed JSON silently becomes `{}`; no 400.
6. OpenAPI spec tests — only assert path existence; no request/response shape conformance between spec and routes.

## Top 5
1. God files: `mongodb-manager.ts` 11,265 LOC / ~50 methods; `mongodb-schema.ts` 4,296 LOC — repo rule is ~500.
2. Dead shipped code: `batch-*` cluster, `embedding-model-limits.ts`, `fact-extraction-eval.ts`, `benchmark-failure-taxonomy.ts` compile into the published package with zero production importers.
3. Eval over-engineering: 66k test LOC > 57k source LOC; three parallel eval systems; ~3,900 LOC of benchmark machinery shipped in the runtime package and reachable from the production manager.
4. Contract quadruplication: routes/v1.ts + openapi-spec.ts + mcp server.ts + tools/index.ts hand-maintain the same surface and have already diverged (MCP-only tools, alias pairs).
5. Inverted test investment: zero tests on `lib` (ssrf/redact), `client` (public SDK), most of `mcp`, and `pi-extension` — while mega e2e suites carry 10,456 LOC.

## Harmony note
At the package level this is one organism: a clean acyclic ladder (lib → engine → bridge → api; client → tools/mcp/web/pi) with consistent naming and a coherent tenant-isolation story (Issues #42/#57) threaded through bridge and API. But inside the layers it is a pile of parts accreted by generation: the god files, the dead batch cluster, the three eval generations, and the four hand-copied contract surfaces are each artifacts of a different era that were never reintegrated. The single most misaligned seam is engine↔bridge: an optional-methods interface built for a multi-backend future that never arrived, forcing 250 LOC of casts and 190 LOC of type re-declaration in the bridge — the codebase's own types don't agree about what the manager is. Leanness will come less from deleting code than from collapsing these parallel generations into one current truth per concern.

## Out-of-scope sightings
- `apps/api/src/app.ts:615` — `MEMONGO_ALLOW_INSECURE_NO_AUTH` warning-only mode leaves /v1 unauthenticated (security agent should assess).
- `packages/memory-engine/src/mongodb-schema.ts` — 99 createIndex call sites; per-collection index counts may breach MongoDB guidance (MongoDB agent should verify).
- `benchmarks/data/` is 267MB on disk but NOT git-tracked (only README is) — not repo bloat, noting so other agents don't double-report.
