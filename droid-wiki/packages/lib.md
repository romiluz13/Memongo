# @memongo/lib

The shared foundation package: types and utilities imported by every other Memongo package. It has **no MongoDB dependency** and is private to the monorepo. Everything cross-cutting that more than one package needs — the canonical scope enum, URI precedence rules, logging, redaction, SSRF defense — lives here exactly once so the layers cannot drift apart.

Source: `packages/lib/src/` (16 modules). Public surface is re-exported through `packages/lib/src/index.ts`.

## Modules

### contract.ts — the single source of truth

`MEMORY_SCOPE_VALUES` (`session`, `user`, `agent`, `workspace`, `tenant`, `global`) is the **only** definition of the scope enum; the OpenAPI document, MCP tool schemas, zod schemas, and scoped-API-key policy validation all derive from it (issue #57 divergence class — see [Multi-tenancy](../features/multi-tenancy.md)). Also exports `MEMORY_SCOPE_VALUES_TUPLE` (mutable tuple for `z.enum`), the shared API error schema (`ApiErrorBody`, `API_ERROR_OPENAPI_SCHEMA`, `apiErrorOpenApiResponse`), the bearer security scheme, and `MEMONGO_API_ROUTES` route contracts.

### types.memory.ts / types.ts — config types

`MemoryScope` (derived from the contract enum so the type can never drift from the runtime array), `MemoryMongoDBConfig` (the full engine config shape: deployment profile, embedding mode, fusion method, pool settings, KB/episodes/graph/reranking/cache/relevance sections), `MemongoConfig`, and `SecretInput`.

### ssrf.ts — SSRF guard

Blocks requests to private/internal network targets: private IPv4 ranges (10/8, 127/8, 169.254/16, 172.16–31, 192.168/16, 0/8), private IPv6 (`::1`, `fe80:`, `fc`/`fd`, v4-mapped), and blocked hostnames (`localhost`, `metadata.google.internal`, `*.local`, `*.internal`). Resolves hostnames via DNS (`assertAllowedHostOrIp`) so a public hostname that resolves to a private IP is still caught. Policy escape hatches (`allowPrivateNetwork`, hostname allowlists, custom `isAllowed`) are explicit; violations throw `SsrFBlockedError`.

### redact.ts — secret redaction

`redactSensitiveText` scrubs logs and error text with 18 default patterns: `KEY|TOKEN|SECRET|PASSWORD` assignments, JSON credential fields, `--api-key` CLI flags, `Authorization: Bearer` headers, PEM private-key blocks, and provider token shapes (`sk-`, `ghp_`, `github_pat_`, `xox*`, `gsk_`, `AIza`, `pplx-`, `npm_`, Telegram bot tokens, and `mongodb(+srv)://` connection-string passwords). Tokens are masked keep-start/keep-end (`abcdef***wxyz`); PEM blocks keep their BEGIN/END lines.

### retry.ts — bounded retry

`retryAsync` with `resolveRetryConfig` (defaults: 3 attempts, 300ms–30s delay, clamped to sane bounds), optional `shouldRetry`/`retryAfterMs`/`onRetry` hooks and jitter. Used by the engine's search aggregation retry and elsewhere.

### auth.ts — provider API keys

`resolveApiKeyForProvider` maps 14 providers (OpenAI, Anthropic, Google/Gemini, Voyage, Mistral, Groq, DeepSeek, Together, Fireworks, Perplexity, Cohere, xAI) to their canonical env vars with generic `{PROVIDER}_API_KEY` / `MEMONGO_{PROVIDER}_API_KEY` fallbacks; `requireApiKey` throws with actionable guidance. Also `ApiKeyRotation`/`resolveApiKeyRotation` and `parseGeminiAuth`.

### env.ts — env parsing + URI precedence

`isTruthyEnvValue`/`isFalsyEnvValue`, `resolveEnv`, `resolveEnvCascade`, and `applyMongoDbForceUriOverride` — the single MongoDB URI precedence rule (P2.6) shared by the bridge and the engine so `MEMONGO_FORCE_MONGODB_URI` outranks every other URI source in every layer.

### errors.ts, logger.ts — diagnostics

Error formatting/extraction helpers (`formatErrorMessage`, `formatUncaughtError`, `extractErrorCode`, `isErrno`, `hasErrnoCode`) and `createSubsystemLogger` — the namespaced logger (`memory:backend-config`, `memory:mongodb:kb`, ...) used across the engine.

### concurrency.ts, paths.ts, mime.ts, secrets.ts — utilities

- `runTasksWithConcurrency` — bounded-parallel task runner.
- `resolveUserPath` (expands `~`), `memongoDataDir`, `memongoAgentDir`, `ensureTrailingSlash`.
- `detectMime`, `isTextMime`/`isImageMime`/`isAudioMime` — MIME detection for ingestion paths.
- `normalizeOptionalSecretInput` — normalizes optional secret config values.

## Design rule

If a constant, enum, or rule is needed by two or more layers (engine, bridge, API, MCP, tools), it belongs here — not re-typed at the call site. The scope enum (`contract.ts`) and the force-URI rule (`env.ts`) are the two canonical examples: both were extracted after divergence bugs (issue #57; the P2.6 URI divergence between bridge and engine).

**Top contributors:** Rom Iluz (11 commits).

## Related pages

- [Packages overview](./index.md)
- [Multi-tenancy](../features/multi-tenancy.md) — consumers of the scope contract
- [Auth and security](../security.md) — SSRF guard and redaction in the request path
- [The core engine](./memory-engine/index.md) — the largest consumer
