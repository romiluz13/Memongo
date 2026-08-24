# Lib

Active contributors: Rom Iluz

`packages/lib` (`@memongo/lib`) is the shared runtime foundation every other Memongo package and app depends on: shared types, the canonical wire contract, auth helpers, error/log/retry utilities, an SSRF guard, and secret handling. It is published to npm only because the public packages (`packages/client`, `packages/tools`) need it at install time, not because it is meant to be consumed standalone. See [`../overview/architecture.md`](../overview/architecture.md) for how it fits under `apps/api`, `packages/memory-bridge`, and `packages/memory-engine`.

## Key modules

| File | Role |
|---|---|
| `packages/lib/src/index.ts` | Barrel re-exporting every public type and function below |
| `packages/lib/src/contract.ts` (+ `contract-routes.ts`, `contract-mcp.ts`) | Canonical wire contract: `MEMORY_SCOPE_VALUES`, the `/v1` route table, MCP tool field sets, and the shared `ApiError` envelope — see below |
| `packages/lib/src/auth.ts` | Provider API-key resolution (`resolveApiKeyForProvider`, `requireApiKey`), Gemini auth parsing, and `ApiKeyRotation` for round-robin multi-key providers |
| `packages/lib/src/env.ts` | Env var parsing helpers (`isTruthyEnvValue`, `resolveEnvCascade`) and `applyMongoDbForceUriOverride`, the one rule ensuring `MEMONGO_FORCE_MONGODB_URI` always outranks other URI sources across both the bridge and the engine |
| `packages/lib/src/errors.ts` | Error normalization: `formatErrorMessage`, `formatUncaughtError`, `extractErrorCode`, `isErrno`/`hasErrnoCode`; routes all output through `redactSensitiveText` |
| `packages/lib/src/logger.ts` | `createSubsystemLogger(name)` — level-filtered console logger honoring `MEMONGO_LOG_LEVEL`/`MEMONGO_DEBUG`, with a `child()` method for namespaced subsystems |
| `packages/lib/src/mime.ts` | `detectMime`/`isTextMime`/`isImageMime`/`isAudioMime` — extension-to-MIME table plus header/buffer fallback, used by file ingestion |
| `packages/lib/src/paths.ts` | `resolveUserPath`, `memongoDataDir`, `memongoAgentDir` — tilde-expanding path helpers for the local `~/.memongo` data directory |
| `packages/lib/src/redact.ts` | `redactSensitiveText`/`redactSecrets` — pattern-based masking of API keys, bearer tokens, PEM blocks, and MongoDB URI passwords before text is logged or surfaced in errors |
| `packages/lib/src/retry.ts` | `retryAsync`/`resolveRetryConfig` — exponential backoff with jitter, `Retry-After`-aware delay, and an `onRetry` observability hook |
| `packages/lib/src/secrets.ts` | `normalizeOptionalSecretInput` — resolves a `SecretInput` (plain string or `{ secretRef }` env pointer) to a sanitized string |
| `packages/lib/src/ssrf.ts` | SSRF guard: `assertAllowedHostOrIp`, `assertPublicHostname` (DNS-resolves and rechecks), private IPv4/IPv6 range detection, and a fail-closed `defaultSsrfPolicy` |
| `packages/lib/src/types.ts` | `MemongoConfig` and `SecretInput` — the standalone config surface shape |
| `packages/lib/src/types.memory.ts` | Memory-domain types (`MemoryConfig`, `MemoryMongoDBConfig`, deployment profiles, fusion methods, recall profiles); `MemoryScope` is a type alias of `MemoryScopeValue` from `contract.ts`, not a separate enum |
| `packages/lib/src/concurrency.ts` | `runTasksWithConcurrency` — bounded-parallelism task runner with `"continue"`/`"stop"` error modes |
| `packages/lib/package.json` | Package metadata; only `typescript`/`vitest` devDependencies — no runtime dependencies |

## The contract as single source of truth

`packages/lib/src/contract.ts` is the one place `MEMORY_SCOPE_VALUES` (the six-value scope enum: `session`, `user`, `agent`, `workspace`, `tenant`, `global`), the `/v1` route table, the OpenAPI `ApiError` schema, and the MCP tool field sets are defined. Every other layer — the HTTP API's OpenAPI document, the MCP server's tool schemas, the zod schemas in `packages/tools`, and scoped-API-key policy validation — imports these values rather than re-declaring them, and a conformance test (`apps/api/src/contract-conformance.test.ts`) fails on drift. This pattern, why it replaced four independently hand-maintained copies, and how to extend it are covered in [`../how-to-contribute/patterns-and-conventions.md`](../how-to-contribute/patterns-and-conventions.md); this page only names the module.

## Security-relevant modules

`ssrf.ts`, `redact.ts`, and `secrets.ts` are the building blocks behind Memongo's secret-handling and outbound-request safety posture — see [`../security.md`](../security.md) for how the API and engine apply them (webhook/URL fetches, log sanitization, credential storage).

## Integration points

`@memongo/lib` has no dependency on any other Memongo package — it sits at the bottom of the dependency graph. Every other package and app depends on it directly: `packages/client`, `packages/tools`, `packages/memory-bridge`, `packages/memory-engine`, `apps/api`, and `apps/mcp` all import types, the contract, or the utility modules above. See [`packages/index.md`](index.md), [`packages/client.md`](client.md), [`packages/memory-bridge.md`](memory-bridge.md), [`packages/memongo-memory.md`](memongo-memory.md), and [`packages/memory-engine/index.md`](memory-engine/index.md) for how each consumer uses it.
