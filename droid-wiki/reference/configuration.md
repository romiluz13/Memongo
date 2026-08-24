# Configuration

Memongo resolves settings from environment variables and an optional `~/.memongo/memongo.json` config file. Env vars generally take precedence over the file; see [Precedence](#precedence) below. For deployment context see `docs/platform/self-host.md` and `droid-wiki/overview/architecture.md`.

## MongoDB connection

| Variable | Default | Purpose |
|---|---|---|
| `MEMONGO_MONGODB_URI` | none (required) | MongoDB connection string. Required unless `memory.mongodb.uri` is set in the config file. |
| `MEMONGO_FORCE_MONGODB_URI` | unset | Overrides every other URI source at every config layer (env, config file). Used by the API/CI to pin a URI regardless of what a config file specifies. |
| `MEMONGO_MONGODB_DATABASE` | `memongo` | Database name inside MongoDB. |
| `MEMONGO_MONGODB_COLLECTION_PREFIX` | `memongo_` | Shared physical collection prefix; per-agent isolation stays logical (agentId leads every document/index). Set explicitly to opt into per-agent physical separation. |
| `MEMONGO_MONGODB_MAX_POOL_SIZE` | `10` | Driver connection pool max size. |
| `MEMONGO_MONGODB_MIN_POOL_SIZE` | `2` | Driver connection pool min size. |
| `MEMONGO_MONGODB_MAX_CONNECTING` | driver default | Max concurrent connection-establishment operations. |
| `MEMONGO_MONGODB_MAX_IDLE_TIME_MS` | driver default | Max idle time before a pooled connection is closed. |
| `MEMONGO_MONGODB_NETWORK_FAMILY` | driver default | Force IPv4 (`4`) or IPv6 (`6`) resolution. |
| `MEMONGO_MONGODB_SOCKET_TIMEOUT_MS` | driver default | Socket timeout for MongoDB operations. |
| `MEMONGO_MONGODB_SERVER_SELECTION_TIMEOUT_MS` | falls back to connect timeout, `10000` | Server selection timeout. |
| `MEMONGO_MONGODB_CONNECT_TIMEOUT_MS` | `10000` | Initial connection timeout. |
| `MEMONGO_MONGODB_HEARTBEAT_FREQUENCY_MS` | driver default | SDAM heartbeat frequency. |
| `MEMONGO_MONGODB_SERVER_MONITORING_MODE` | driver default | `auto`, `stream`, or `poll`. |
| `MEMONGO_MONGODB_WAIT_QUEUE_TIMEOUT_MS` | driver default | Max wait time for a pooled connection. |
| `MEMONGO_NUM_CANDIDATES` | `500` | Default vector search `numCandidates` (hard-capped at MongoDB's max of `10000`). |

## HTTP API (`apps/api`)

| Variable | Default | Purpose |
|---|---|---|
| `MEMONGO_API_HOST` | `127.0.0.1` | Bind host. |
| `MEMONGO_API_PORT` | `3847` | Bind port. |
| `MEMONGO_API_KEY` | none | Admin bearer token for `/v1/*` routes. Required in any untrusted network. |
| `MEMONGO_API_SCOPED_KEYS` | unset | JSON array (or object) of scoped API key policies (`token`, `agentIds`, `scopes`, `scopeRefs`), each constrained to a concrete value. Fail-closed: invalid JSON or an unconstrained policy prevents the API from starting. See `apps/api/src/app.ts`. |
| `MEMONGO_ALLOW_INSECURE_NO_AUTH` | `false` | Runs `/v1/*` unauthenticated when no `MEMONGO_API_KEY`/scoped keys are set. Logs a warning once per process. Local development only. |
| `MEMONGO_CORS_ORIGINS` | dev defaults (`http://127.0.0.1:3040`, `http://localhost:3040`) | Comma-separated explicit origin allow-list. Wildcard `*` is rejected. |
| `MEMONGO_API_RATE_LIMIT` | `600` | Requests per window per identity; `0` disables rate limiting. |
| `MEMONGO_API_RATE_WINDOW_MS` | `60000` | Rate-limit fixed window size. |
| `MEMONGO_TRUST_PROXY` | `false` | When true, unauthenticated rate-limit buckets key on `X-Forwarded-For` instead of one shared anonymous bucket. Only enable behind a trusted proxy. |
| `MEMONGO_API_MAX_BODY_BYTES` | `1000000` | Max request body size before JSON parsing; `0` disables the cap. |

## Memory defaults

| Variable | Default | Purpose |
|---|---|---|
| `MEMONGO_AGENT_ID` | `main` | Default memory isolation key (agent identity). |
| `MEMONGO_DEFAULT_SCOPE` | `agent` | Default scope applied to both reads and writes when a request omits `scope`. Wins over the legacy `MEMONGO_SEARCH_DEFAULT_SCOPE`. |
| `MEMONGO_SEARCH_DEFAULT_SCOPE` | `agent` | Legacy read-only default-scope alias; deprecated in favor of `MEMONGO_DEFAULT_SCOPE`. |
| `MEMONGO_MONGODB_RECALL_PROFILE` | `balanced` | `latency`, `balanced`, or `proof`. |
| `MEMONGO_MONGODB_FUSION_METHOD` | `scoreFusion` | `scoreFusion`, `rankFusion`, or `js-merge`, with capability fallback. |
| `MEMONGO_QUERY_EMBEDDING_MODEL` | `voyage-4-large` | Read-path query embedding model (`voyage-4-large`, `voyage-4`, or `voyage-4-lite`; all share one embedding space). |
| `MEMONGO_CONVERSATION_EVIDENCE_MODE` | `parallel` | `parallel`, `serial`, or `disabled` — controls whether conversation evidence retrieval overlaps primary retrieval. |
| `MEMONGO_RERANKING_ENABLED` | `true` | Enable/disable the Voyage rerank stage. |
| `MEMONGO_RERANK_MIN_SCORE` | `0.01` | Minimum score threshold applied post-rerank. |

## Logging

| Variable | Default | Purpose |
|---|---|---|
| `MEMONGO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

## Embedding and rerank providers (Voyage AI)

| Variable | Default | Purpose |
|---|---|---|
| `VOYAGE_API_KEY` | none | Atlas Model API key (`al-...` prefix) for MongoDB auto-embed and rerank. Generic fallback for the specific sub-keys below. |
| `VOYAGE_API_INDEXING_KEY` | none | Overrides `VOYAGE_API_KEY` for index-time embedding calls. |
| `VOYAGE_API_QUERY_KEY` | none | Overrides `VOYAGE_API_KEY` for query-time embedding calls. |
| `VOYAGE_RERANK_API_KEY` | none | Overrides `VOYAGE_API_KEY` for rerank calls. |

See `droid-wiki/systems/embeddings-and-providers.md` for how these keys flow through the search pipeline.

## LLM enrichment (optional, OpenAI-compatible or Anthropic)

Two independent credential sets exist: `MEMONGO_ENRICHMENT_*` (background memory enrichment) and `MEMONGO_LLM_*` (general LLM calls, for example graph entity extraction with `method: "llm"`).

| Variable | Default | Purpose |
|---|---|---|
| `MEMONGO_ENRICHMENT_API_KEY` | none | API key for the enrichment endpoint. |
| `MEMONGO_ENRICHMENT_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible or Anthropic endpoint. |
| `MEMONGO_ENRICHMENT_MODEL` | `gpt-4o-mini` | Model used for enrichment when enabled. |
| `MEMONGO_ENRICHMENT_AUTH_STYLE` | `authorization-bearer` | `authorization-bearer`, `api-key`, or `x-api-key`, for gateways needing a provider-specific header. |
| `MEMONGO_ENRICHMENT_TOKEN_PARAM` | `max_tokens` | Set to `max_completion_tokens` for gateways requiring the newer completion token naming. |
| `MEMONGO_LLM_API_KEY` | none | API key for general LLM calls. |
| `MEMONGO_LLM_BASE_URL` | `https://api.openai.com/v1` | Endpoint for general LLM calls. |
| `MEMONGO_LLM_MODEL` | `gpt-4o-mini` | Model for general LLM calls. |
| `MEMONGO_LLM_AUTH_STYLE` | `authorization-bearer` | Same options as `MEMONGO_ENRICHMENT_AUTH_STYLE`. |
| `MEMONGO_LLM_TOKEN_PARAM` | `max_tokens` | Same options as `MEMONGO_ENRICHMENT_TOKEN_PARAM`. |

## Workspace and config file paths

| Variable | Default | Purpose |
|---|---|---|
| `MEMONGO_WORKSPACE_DIR` | `~/.memongo/workspace` | Standalone workspace directory (see `packages/memory-bridge/src/memory-config.ts`). |
| `MEMONGO_CONFIG_PATH` | `~/.memongo/memongo.json` | Path to the optional JSON config file. |

## Docker community stack

Used by `docker/mongodb/docker-compose.mongodb.yml` (replicaset/fullstack tiers). Both are required with no defaults — compose fails closed when unset.

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | none (required) | MongoDB admin password for the community stack. |
| `MONGOT_PASSWORD` | none (required) | `mongot` search process password. |

The simpler one-command stack at `docker/docker-compose.yml` (`mongodb/mongodb-atlas-local:preview`) only reads `VOYAGE_API_KEY` and an optional `MONGODB_PORT` (default `27017`); see `droid-wiki/reference/dependencies.md` for the image details.

## The `~/.memongo/memongo.json` config file

README.md documents an optional file config path as an alternative to environment variables. Its shape mirrors `MemongoConfig` (`packages/lib/src/types.ts`) and `MemoryConfig` (`packages/lib/src/types.memory.ts`):

```json
{
  "memory": {
    "backend": "mongodb",
    "citations": "auto",
    "mongodb": {
      "uri": "mongodb://127.0.0.1:27017/?directConnection=true",
      "database": "memongo",
      "recallProfile": "balanced",
      "fusionMethod": "scoreFusion"
    }
  },
  "agents": {
    "defaults": { "workspace": "~/.memongo/agents/main" }
  }
}
```

Every field under `memory.mongodb` in the config file has a matching resolver in `packages/memory-engine/src/backend-config.ts` (`resolveMemoryBackendConfig`), including nested `kb`, `episodes`, `graph`, `reranking`, `cache`, and `relevance` blocks not exposed as top-level env vars.

## Precedence

Precedence is not uniform across every field — it is decided per-field in `packages/memory-bridge/src/memory-config.ts` and `packages/memory-engine/src/backend-config.ts`:

1. **`MEMONGO_FORCE_MONGODB_URI`** always wins for the MongoDB URI, overriding both the plain env var and the config file, at every layer (`applyMongoDbForceUriOverride`). This exists so operators (for example the API process or CI) can pin a URI regardless of what a config file specifies.
2. For most `memory.mongodb.*` settings resolved in the engine (`backend-config.ts`), a dedicated env var (for example `MEMONGO_MONGODB_MAX_POOL_SIZE`) takes precedence over the config-file value, which takes precedence over a hardcoded default.
3. For the MongoDB URI specifically at the engine layer, an explicit `memory.mongodb.uri` in the config file is treated as intentional and beats the plain `MEMONGO_MONGODB_URI` env fallback (the opposite order from the bridge layer, which is env-first). See the comments in `packages/memory-engine/src/backend-config.ts` (`configuredUri || process.env.MEMONGO_MONGODB_URI`) versus `packages/memory-bridge/src/memory-config.ts` (`uriFromEnv || uriFromFile`).
4. `MEMONGO_MONGODB_DATABASE` and `MEMONGO_MONGODB_COLLECTION_PREFIX` env vars always beat their config-file counterparts at both layers.
5. Enum-like settings (`fusionMethod`, `recallProfile`, `queryEmbeddingModel`) fall back silently to the config-file value or a hardcoded default when the env var is unset or invalid, except `queryEmbeddingModel` and `MEMONGO_DEFAULT_SCOPE`, which throw on an invalid explicit value instead of silently falling back.

Related pages: `droid-wiki/overview/architecture.md`, `droid-wiki/overview/getting-started.md`, `docs/platform/self-host.md`.
