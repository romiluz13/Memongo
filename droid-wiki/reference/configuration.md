# Configuration

Memongo is configured almost entirely through environment variables. Engine behavior is resolved into a typed `ResolvedMongoDBConfig` in `packages/memory-engine/src/backend-config.ts` (~803 LOC), which applies defaults over the user-facing `MemongoConfig` / `MemoryMongoDBConfig` shapes in `packages/lib/src/types.memory.ts`.

## API server

Read by `apps/api/src/app.ts` and `apps/api/src/server.ts`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MEMONGO_API_KEY` | — | Bearer token for `/v1`. Unset + no scoped keys ⇒ 401 `AUTH_NOT_CONFIGURED` |
| `MEMONGO_API_SCOPED_KEYS` | — | JSON array/object of scoped key policies (`agentIds`, `scopes`, `scopeRefs`) |
| `MEMONGO_ALLOW_INSECURE_NO_AUTH` | off | Opt out of auth (trusted local dev only; logs a warning) |
| `MEMONGO_API_HOST` / `MEMONGO_API_PORT` | `127.0.0.1` / `3847` | Bind address |
| `MEMONGO_CORS_ORIGINS` | dev defaults (`localhost:3040`) | Explicit origins only; wildcard is a boot error |
| `MEMONGO_API_RATE_LIMIT` | `600` | Requests per window per identity (`0` disables) |
| `MEMONGO_API_RATE_WINDOW_MS` | `60000` | Rate-limit window |
| `MEMONGO_API_MAX_BODY_BYTES` | `1000000` | Body cap, enforced before JSON parse (`0` disables) |
| `MEMONGO_TRUST_PROXY` | off | Trust `X-Forwarded-For` for rate-limit identity |
| `MEMONGO_REQUIRE_VECTOR` | off | Strict mode: boot exits 1 if the vector lane is unavailable |
| `MEMONGO_AGENT_ID` | `main` | Default agent partition |

## MongoDB connection and engine

Resolved in `packages/memory-engine/src/backend-config.ts`.

| Variable | Meaning |
|----------|---------|
| `MEMONGO_MONGODB_URI` | Connection string (required) |
| `MEMONGO_FORCE_MONGODB_URI` | Override applied last (tests/tooling) |
| `MEMONGO_MONGODB_DATABASE` | Database name (default `memongo`) |
| `MEMONGO_MONGODB_COLLECTION_PREFIX` | Per-agent collection prefix; empty selects shared collections with `agentId` discriminator |
| `MEMONGO_MONGODB_FUSION_METHOD` | `scoreFusion` \| `rankFusion` \| `js-merge` |
| `MEMONGO_MONGODB_RECALL_PROFILE` | `latency` \| `balanced` \| `proof` |
| `MEMONGO_NUM_CANDIDATES` | Vector-search `numCandidates` |
| `MEMONGO_MONGODB_MAX_POOL_SIZE` / `MIN_POOL_SIZE` / `MAX_CONNECTING` | Driver pool tuning |
| `MEMONGO_MONGODB_MAX_IDLE_TIME_MS` / `SOCKET_TIMEOUT_MS` / `CONNECT_TIMEOUT_MS` / `SERVER_SELECTION_TIMEOUT_MS` / `WAIT_QUEUE_TIMEOUT_MS` / `HEARTBEAT_FREQUENCY_MS` | Driver timeouts |
| `MEMONGO_MONGODB_NETWORK_FAMILY` | `4` or `6` |
| `MEMONGO_MONGODB_SERVER_MONITORING_MODE` | `auto` \| `stream` \| `poll` |
| `MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_ATTEMPTS` / `MIN_DELAY_MS` / `MAX_DELAY_MS` | Transient write retry policy |
| `MEMONGO_SKIP_OPTIONAL_SEARCH_INDEXES` | Skip non-critical search index creation |
| `MEMONGO_STRICT_SEARCH_INDEX_READY` | Fail when search indexes never reach READY |
| `MEMONGO_SEARCH_INDEX_READINESS_POLL_MS` / `TIMEOUT_MS` | Index-readiness polling |
| `MEMONGO_SEARCH_MAX_TIME_MS` | Server-side per-search time cap |
| `MEMONGO_SEARCH_DEFAULT_SCOPE` | Default scope for searches |
| `MEMONGO_VECTOR_INDEXING_METHOD` / `MEMONGO_VECTOR_STORED_SOURCE` | Vector index shape overrides |
| `MEMONGO_MANAGER_CACHE_MAX` / `IDLE_TTL_MS` / `SWEEP_MS` | Per-agent manager cache bounds |
| `MEMONGO_JOB_SWEEP_MS` / `MEMONGO_JOB_WORKER_CONCURRENCY` | Job-queue sweep interval and worker count |
| `MEMONGO_EVIDENCE_MIRROR_MODE` / `MEMONGO_EVIDENCE_SETTLE_MS` | Optional `memory_evidence` mirror collection |

## MCP server

Read by `apps/mcp/src/server.ts` and `apps/mcp/src/http-transport.ts`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MEMONGO_API_URL` / `MEMONGO_API_KEY` | — | Where the MemongoClient points |
| `MEMONGO_MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MEMONGO_MCP_HTTP_HOST` / `MEMONGO_MCP_HTTP_PORT` | `127.0.0.1` / `3110` | HTTP transport bind |
| `MEMONGO_MCP_ADMIN` | off | Enable admin/benchmark tools |
| `MEMONGO_MCP_ALIASES` | off | Enable semantic alias tools |

## Providers, enrichment, reranking

| Variable | Meaning |
|----------|---------|
| `<PROVIDER>_API_KEY` / `MEMONGO_<PROVIDER>_API_KEY` | Provider keys (OpenAI, Anthropic, Google/Gemini, Voyage, Mistral, Groq, DeepSeek, Together, Fireworks, Perplexity, Cohere, xAI) — resolution in `packages/lib/src/auth.ts` |
| `MEMONGO_ENRICHMENT_PROVIDER` / `BASE_URL` / `API_KEY` / `MODEL` / `CONCURRENCY` / `AUTH_STYLE` / `TOKEN_PARAM` | LLM enrichment endpoint |
| `MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK` | SSRF opt-in for private enrichment endpoints |
| `MEMONGO_LLM_ENRICHMENT_MODE` / `STRICT` / `MAX_RETRIES` / `MAX_TOKENS` / `TIMEOUT_MS` | Enrichment behavior |
| `MEMONGO_RERANKING_ENABLED` / `MEMONGO_RERANK_MIN_SCORE` / `MEMONGO_RERANK_STRICT` | Voyage cross-encoder reranking |
| `MEMONGO_EXPORT_SIGNING_KEY` | Signing key for export artifacts |

## Config file and resolution

`MemongoConfig` (`packages/lib/src/types.memory.ts`) is the typed in-repo config shape: `backend`, `citations`, per-source toggles (`reference`/`conversation`/`structured`), and the full `mongodb` block (pool, TTL, KB chunking, episodes, graph, query rewriting, reranking, cache, relevance telemetry). Agent-level overrides come from an `agents` map resolved in `packages/memory-engine/src/agent-config.ts` (`agents.list[].id`, `agents.defaults.workspace`); per-agent workspace dirs default to `~/.memongo/agents/<id>`.

## Capability detection and version gating

Memongo adopts MongoDB features aggressively and gates them on server version so older deployments degrade instead of breaking.

- **`mongodb-capability-registry.ts`** is the single registry where every gated feature declares its `minServerVersion` (or the external fix that unblocks it), a re-enable condition, and a tracked TODO. `detectCapabilities` evaluates every gate against the server's `buildInfo` `versionArray`; `serverVersionAtLeast` returns false for unknown versions — an unknown version never lights a gate up. Features with no trustworthy static gate start optimistic and record a server rejection via `recordCapabilityProbe`.
- **Example gates:** `$jsonSchema` `validationAction: "errorAndLog"` requires MongoDB ≥ 8.1 (`packages/memory-engine/src/mongodb-schema.ts:1518`); `storedSource`, quantization, and `returnStoredSource` all moved through this registry.
- **Boot surface:** the API logs the retrieval-lane capability table once at boot and fails fast under `MEMONGO_REQUIRE_VECTOR=1` (`apps/api/src/server.ts`).

## Testing and tooling variables

| Variable | Meaning |
|----------|---------|
| `MONGODB_TEST_URI` / `MEMONGO_TEST_MONGODB_URI` | E2E target; `mongodb+srv://` scales vitest timeouts up for Atlas |
| `MEMONGO_E2E_TIER` | E2E tier selection (see `turbo.json`) |
| `MEMONGO_BENCHMARK_*` | Benchmark harness knobs (dataset root/SHA, measurement passes, settle timeouts, strict gate, ingest batch size, …) |
| `MEMONGO_LOG_LEVEL` / `MEMONGO_DEBUG` / `MEMONGO_DEBUG_EMBEDDINGS` | Logging verbosity |
| `MEMONGO_BUILD_ID` / `MEMONGO_BUILD_COMMIT` / `MEMONGO_BUILD_LABEL` | Build provenance stamped into status output |
| `MEMONGO_WEB_STATIC_EXPORT` | Next.js static export for `apps/web` |
| `MEMONGO_PI_*` | Pi-extension behavior (`AUTO_CAPTURE`, `SESSION_INJECTION`, `MEMORY_SCOPE`) |

## Related pages

- [Security](../security.md) — auth-related variables in context
- [Deployment](../deployment.md) — container environment
- [Dependencies](dependencies.md)
