# Tools

Active contributors: Rom Iluz

`packages/tools` (`@memongo/tools`) turns a `MemongoClient` (see [`packages/client.md`](client.md)) into function-calling tools and LLM middleware. It has two consumption modes: a `createMemongoTools()` factory that returns a flat map of named tools for manual wiring into an agent framework, and two ready-made provider middlewares (`vercel/`, `openai/`) that inject memory context and capture conversation turns automatically around a model call. Every code path routes through `@memongo/client` — there is no hand-rolled `fetch` in this package — so the same auth, retry, and SSRF behavior applies everywhere the package is used. See [`../overview/architecture.md`](../overview/architecture.md) for where `packages/tools` sits relative to `apps/api` and `packages/client`.

## `createMemongoTools()`

`packages/tools/src/index.ts` exports `createMemongoTools(client: MemongoClient): MemongoToolSet`, a `Record<string, Tool>` (Vercel AI SDK `Tool` type) covering the full Memongo surface: search (`memongo_search`, `memongo_search_kb`, `memongo_recall_conversation`), writes (`memongo_add`, `memongo_write_event`, `memongo_self_edit`), lifecycle-handle operations (`memongo_lifecycle_get/update/delete/history`, `memongo_procedure_outcome`, `memongo_memory_feedback`), synthesis (`memongo_profile`, `memongo_build_context_bundle`, `memongo_state_unified`), and admin/observability (`memongo_status`, `memongo_chain_trace`, `memongo_novelty_scan`, `memongo_consolidate`, `memongo_import_conversations`, `memongo_admin_access_trends`, `memongo_admin_access_summaries`, `memongo_admin_list_traces`, `memongo_admin_get_trace`, `memongo_list_jobs`, `memongo_get_job`). Every tool's `inputSchema` is a zod schema; the `scope` fields reuse `MEMORY_SCOPE_VALUES_TUPLE` from `@memongo/lib` rather than re-declaring the scope enum, so it can never drift from the canonical values in `packages/lib/src/contract.ts`.

## Provider integrations

| Integration | File | Wraps | Mechanism |
|---|---|---|---|
| Vercel AI SDK | `packages/tools/src/vercel/index.ts` | A `LanguageModelV2` | `withMemongo(model, options)` returns `wrapLanguageModel({ model, middleware })`. Per-request identity (`agentId`, `userId`, `scope`, `sessionId`, `mode`) comes from `params.providerOptions.memongo`, read fresh on every call — never from a module closure — so concurrent invocations for different tenants under Vercel Fluid Compute's shared warm process can't cross-contaminate. |
| OpenAI SDK | `packages/tools/src/openai/index.ts` | Any object shaped like `{ chat: { completions: { create() } } }` | `createOpenAIMiddleware(client, options)` wraps `chat.completions.create` in a `Proxy` chain (client -> chat -> completions) so no runtime `openai` dependency is required. The chat-completions shape has no `providerOptions` channel, so identity comes only from the constructor `options` (one identity per middleware instance). |

Both middlewares inject memory context as a synthetic `system` message ahead of the real prompt, and both perform after-turn capture (writing the user prompt and assistant response back as conversation events) once generation completes.

## `memory-context.ts`: quarantining retrieved memory

`packages/tools/src/memory-context.ts` renders the memory bundle the middlewares inject as an explicit untrusted-input envelope. Retrieved memory can contain text a user stored that itself looks like an instruction ("ignore your rules..."); `renderMemoryContextBlock()` wraps the rendered bundle between `<<<BEGIN_UNTRUSTED_MEMORY_CONTEXT>>>` / `<<<END_UNTRUSTED_MEMORY_CONTEXT>>>` delimiters plus a preamble telling the model to treat the block as reference data only. Before wrapping, it breaks every run of `<<` or `>>` characters in the retrieved text with a zero-width space in one linear pass, so stored content cannot forge a closing delimiter and smuggle text back out as a directive.

## `cache-identity.ts`: canonical cache identity

`packages/tools/src/cache-identity.ts` computes the cache key for the middleware's context-bundle cache: a full SHA-256 digest over the ordered tuple `{ agentId, apiUrl, apiKeyHash, mode, scope, sessionId, userId, query }`. `apiKeyHash` is the SHA-256 of the raw API key — the raw key never enters the cache. Digest-based keying (replacing an earlier 32-bit hash) removes the birthday-bound collision risk and guarantees two tenants never share a cache entry unless every identity dimension matches, which matters because Vercel Fluid Compute can serve concurrent tenants from one warm process. The module uses WebCrypto (`globalThis.crypto.subtle`) rather than `node:crypto` so it works unmodified on Vercel Edge and in browsers; if WebCrypto is unavailable, `sha256Hex` returns `undefined` and callers bypass the cache entirely rather than falling back to a weaker hash. The cache itself is a bounded in-process LRU (50 entries, 60s TTL) — sufficient to dedup within one warm instance, but not shared across instances in multi-instance production deployments.

## `middleware-core.ts`: shared middleware engine

`packages/tools/src/middleware-core.ts` is the logic both `vercel/` and `openai/` build on via `createMemongoMiddlewareCore(options)`, exposing `getContextBundle()` and `captureTurn()`. It:

- Builds a `MemongoClient` **without** `silent` mode so the core observes every failure, then re-wraps each call so failures still degrade the same way silent mode would (inject -> empty string, capture -> dropped) but are reported through an `onError` hook (or a single `console.warn` per middleware instance if none is supplied).
- Resolves per-request identity over constructor defaults, decides `mode` (`"full"` when a user query is present, else `"wake-up"`), and skips the cache entirely when no tenant discriminator (`userId`/`agentId`/`sessionId`) is present, since there's no safe boundary to key on.
- Derives capture idempotency keys as a SHA-256 over the identity tuple plus the tail of the turn's source text, so retries of the same logical turn produce the same `customId` and dedupe server-side, while distinct turns get distinct keys.

## Integration points

- Wraps `@memongo/client`'s `MemongoClient` — see [`packages/client.md`](client.md) for the HTTP surface being called.
- Depends on `@memongo/lib` for the canonical `MEMORY_SCOPE_VALUES`/`MEMORY_SCOPE_VALUES_TUPLE` — see [`packages/lib.md`](lib.md).
- Not consumed directly by `packages/pi-extension`, which instead calls `@memongo/client` directly (see [`packages/pi-extension.md`](pi-extension.md)); `packages/tools` targets agent frameworks built on the Vercel AI SDK or the OpenAI SDK.

## Key source files

| File | Role |
|---|---|
| `packages/tools/src/index.ts` | `createMemongoTools()` factory and every zod tool schema |
| `packages/tools/src/memory-context.ts` | Untrusted-memory quarantine envelope for injected context |
| `packages/tools/src/cache-identity.ts` | Canonical SHA-256 cache key + bounded LRU for context bundles |
| `packages/tools/src/middleware-core.ts` | Shared inject/capture engine behind both provider middlewares |
| `packages/tools/src/vercel/index.ts` | `withMemongo()` — Vercel AI SDK `LanguageModelV2Middleware` |
| `packages/tools/src/openai/index.ts` | `createOpenAIMiddleware()` — Proxy-based OpenAI client wrapper |
| `packages/tools/package.json` | Package metadata, `ai` peer dependency, subpath exports (`.`, `./vercel`, `./openai`) |
