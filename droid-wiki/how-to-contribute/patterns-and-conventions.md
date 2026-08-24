# Patterns and conventions

## Language and formatting

- TypeScript everywhere, ESM modules, strict typing (`any` is avoided).
- Biome (`biome.json`) enforces formatting (tabs, double quotes, semicolons as needed) and lints with `noUnusedVariables`, `noUnusedImports`, `noNonNullAssertion` as warnings and `useAsConstAssertion`, `useSelfClosingElements` as errors.
- Files stay under roughly 500 lines; large modules are split by concern (see "One module, one job" below). A handful of files exceed this deliberately — see [Complexity hotspots](../cleanup-opportunities.md).
- Tests are colocated as `*.test.ts` next to the source they cover, run with Vitest and V8 coverage. End-to-end tests use a `*.e2e.test.ts` suffix and need a real MongoDB connection.

## One module, one job

`packages/memory-engine/src` has 130+ files, almost all prefixed `mongodb-*`, each owning one narrow concern: `mongodb-graph.ts` only does graph traversal, `mongodb-trust.ts` only computes trust scores, `mongodb-schema-*.ts` files split schema definition, validators, and standard indexes into separate files rather than one large schema module. `MongoDBMemoryManager` (`packages/memory-engine/src/mongodb-manager.ts`) is composed from focused mixins — `mongodb-manager-read.ts`, `mongodb-manager-write.ts`, `mongodb-manager-search.ts`, `mongodb-manager-sync.ts`, `mongodb-manager-jobs.ts`, `mongodb-manager-admin.ts`, `mongodb-manager-relevance.ts`, `mongodb-manager-lifecycle.ts`, `mongodb-manager-host.ts` — instead of one monolithic class. When adding a capability, add a new focused module and wire it into the manager rather than growing an existing file past its purpose.

## Single source of contract truth

`packages/lib/src/contract.ts` (plus `contract-routes.ts` and `contract-mcp.ts`) is the one place the HTTP routes, the OpenAPI document, and the MCP tool schemas all derive their field sets and the canonical `MEMORY_SCOPE_VALUES` enum from. A conformance test (`apps/api/src/contract-conformance.test.ts`, `apps/mcp/src/mcp-contract-conformance.test.ts`) fails on drift. Before this module existed, the same contract was hand-maintained in four places and had already diverged — see the comment at the top of `contract.ts`. When adding or changing a field on an API route or MCP tool, edit the contract module first, then let the conformance tests confirm every consumer picked it up.

## Error handling

- `packages/lib/src/errors.ts` centralizes error introspection (`extractErrorCode`, `isErrno`, `formatErrorMessage`) and always redacts sensitive text (`packages/lib/src/redact.ts`) before a message is logged or returned.
- HTTP routes return one canonical error envelope, `{ error: { code, message } }` (`ApiErrorBody` in `packages/lib/src/contract.ts`). `apps/api/src/app.ts`'s `onError` handler passes through deliberate `HTTPException`s and converts anything unexpected into a generic `INTERNAL` 500 — raw driver errors never reach a client.
- Boundary input is validated with Zod schemas (`apps/api/src/lib/validation.ts`) rather than cast. A validation failure maps to `400 VALIDATION_ERROR` naming the first offending field; a body that fails `JSON.parse` maps to `400 INVALID_JSON` via `InvalidJsonError`.

## Retry and resilience

`packages/lib/src/retry.ts` provides one shared retry helper (`resolveRetryConfig`, exponential backoff with jitter, a `shouldRetry` predicate, and a `retryAfterMs` hook for rate-limit responses) used by embedding providers and remote HTTP calls (`packages/memory-engine/src/mongodb-embedding-retry.ts`, `packages/memory-engine/src/embeddings-remote-fetch.ts`) instead of ad hoc retry loops per call site.

## Logging

`createSubsystemLogger` (`packages/lib/src/logger.ts`) returns a leveled logger scoped to a subsystem name, configurable via `MEMONGO_LOG_LEVEL` (or `MEMONGO_DEBUG=1`/`DEBUG=1` for debug level). Loggers nest with `.child(name)` so a log line's subsystem tag reflects its call path (e.g. `memory-engine/search`). See [Debugging](debugging.md).

## Security-sensitive comparisons

Bearer token comparisons in `apps/api/src/app.ts` use `timingSafeBearerEquals` (SHA-256 digest + `crypto.timingSafeEqual`) rather than `===`, so a mismatched auth header can't leak the token prefix via response timing. Any new secret-comparison code should follow the same pattern rather than reintroducing a short-circuiting `===`.

## Comments explain "why," not "what"

Source comments in this codebase consistently explain the reasoning behind a decision or a historical bug it fixes (often referencing an issue or task number, e.g. "Issue #57", "P2.8", "Task 35") rather than restating the code. When adding a non-obvious constraint or working around a subtle bug, follow the same convention: say why, and reference the issue/spec if one exists.

## Commit style

Commits are short and action-oriented, scoped to a package or area, e.g. `engine: add graph expansion` or `fix(ci): update atlas-local image to preview tag`. Group related changes; avoid bundling unrelated refactors into one commit. See [Development workflow](development-workflow.md).
