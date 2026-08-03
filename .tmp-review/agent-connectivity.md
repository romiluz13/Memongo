# Agent Connectivity — Deep Review Findings

## Findings

- [SEV: high] MCP server is not published and has no `bin` entry — no `npx` install path exists
  - Where: `apps/mcp/package.json:4-11`
  - What: The package is `"private": true`, has no `bin` field, and `start` is `node --import tsx src/server.ts`. Wiring into any MCP-capable agent (Claude Code, Cursor, Pi) therefore requires a source checkout and a config block pointing at a tsx-run TypeScript file inside the monorepo, e.g. `{"command":"node","args":["--import","tsx","<checkout>/apps/mcp/src/server.ts"],"env":{"MEMONGO_API_URL":"...","MEMONGO_API_KEY":"..."}}`.
  - Why it matters: The single most common way agents connect to memory (MCP) has the highest friction of any surface in the repo. Competitors ship `npx <pkg>` one-liners; here the "10-minute agent" test fails before the first call.
  - Recommendation: Publish `@memongo/mcp` with a `bin` entry (prebuilt JS, no tsx), so config becomes `{"command":"npx","args":["-y","@memongo/mcp"],"env":{...}}`.

- [SEV: high] MCP tool list is polluted with ~14 duplicate/alias and admin/benchmark tools, and output shape is inconsistent
  - Where: `apps/mcp/src/server.ts:19-38` (alias sets), `apps/mcp/src/server.ts:134-1442` (toolList), `apps/mcp/src/server.ts:110-123` (`jsonResult` with `structuredContent` used by only some tools; others return bare `{content:[{type:"text",text:JSON.stringify(out)}]}`).
  - What: 40 tools are registered, but 8 are pure aliases (`memongo_memory_get`/`lifecycle_get`, `recall_messages`/`recall_conversation`, `import_conversations`/`import_conversation_history`, `benchmark_ingest`/`import_conversations` overlap) and ~10 more are operator/benchmark tools (`memongo_admin_*`, `memongo_relevance_benchmark`, `memongo_benchmark_ingest`, `memongo_list_jobs`...). Every MCP host injects all 40 schemas into the LLM's context window on every session. Only alias-set tools use `structuredContent`; the rest are text-only JSON dumps, so hosts that parse structured output get an inconsistent contract.
  - Why it matters: Tool-count bloat degrades tool selection accuracy for every agent and wastes thousands of tokens per turn. An LLM-facing surface of ~10 core tools with `structuredContent` everywhere would be strictly better.
  - Recommendation: Split into a core agent tool set (~10: search, add/write-event, recall, profile/state, context-bundle, self-edit, lifecycle CRUD, feedback) and gate admin/benchmark tools behind a `MEMONGO_MCP_ADMIN=1` env flag; register aliases only behind a flag; emit `structuredContent` for every tool.

- [SEV: high] Client SDK reads `process.env` at call time — breaks in browser/edge runtimes
  - Where: `packages/client/src/client.ts:84-91` (`resolveBaseUrl`/`resolveApiKey` use `process.env.MEMONGO_API_URL`/`MEMONGO_API_KEY`)
  - What: Any runtime without a `process` global (browsers, Cloudflare Workers without the node compat flag, Deno without polyfill) throws `ReferenceError: process is not defined` even when the caller passes `baseUrl`/`apiKey` explicitly, because `??` still evaluates the right operand when the left is undefined... actually `opts.baseUrl ?? process.env...` only evaluates the right side when `baseUrl` is undefined — but `resolveApiKey` runs on every request via `buildHeaders`, so an explicit-`baseUrl`-only caller still crashes.
  - Why it matters: "Any agent" includes web bots and edge workers; the SDK is otherwise pure `fetch` and would run anywhere.
  - Recommendation: Guard with `typeof process !== "undefined" ? process.env.X : undefined`.

- [SEV: medium] Client SDK has no timeout/cancellation and zero tests
  - Where: `packages/client/src/client.ts:114-140` (`apiFetch` — plain `fetch`, no `AbortSignal`/`signal` option, no timeout); `packages/client/` has zero test files.
  - What: A hung API (TCP blackhole) hangs the agent's memory call forever. Retries exist only for 429/503 with fixed 200 ms linear backoff and no jitter; `maxRetries` is the only knob. Errors collapse into one `MemongoClientError` whose `body` is the raw response text — the API returns structured `{error:{code,message}}` JSON (see `apps/api/src/app.ts:124-129`) but the client never parses it, so programmatic error handling (e.g. distinguish RATE_LIMITED) requires string matching.
  - Why it matters: Agents embedding this SDK get unbounded stalls and unparseable errors; the package has no test coverage at all (per repo map).
  - Recommendation: Add `timeoutMs` (AbortSignal.timeout) and `signal` passthrough, parse the API error envelope into `error.code`, and add at least retry/error-shape tests.

- [SEV: medium] Three copies of the same fetch logic in packages/tools bypass the client SDK and fail silently
  - Where: `packages/tools/src/vercel/index.ts:93-130` and `packages/tools/src/openai/index.ts:29-65` (duplicate `fetchContextBundle`/`fireWriteEvent` with raw `fetch`); vs `packages/client/src/client.ts:114`.
  - What: The Vercel and OpenAI middlewares re-implement the HTTP calls instead of using `@memongo/client`, and on any non-OK response return `""` (no logging, no retry — `vercel/index.ts:117-119`). The OpenAI middleware additionally cannot capture streamed assistant text (acknowledged at `openai/index.ts:130-134`).
  - Why it matters: Behavior of the same API diverges across the three connect paths (client retries 429/503; middleware silently drops); bug fixes to one path never reach the others. Silent failure means an agent "has memory" but actually doesn't.
  - Recommendation: Make middleware depend on `@memongo/client`; surface failures via an `onError` callback option.

- [SEV: medium] pi-extension bakes a hardcoded default API key into shipped code
  - Where: `packages/pi-extension/extensions/index.ts:26-30` (`const API_KEY = process.env.MEMONGO_API_KEY ?? "local-dev-secret"`)
  - What: A literal credential default ships in source. The comment says defaults are baked so Pi works without shell env, but any operator whose API is reachable beyond localhost and whose key happens to match the dev default is exposed.
  - Why it matters: Repo guidelines say never commit secrets; a default shared secret in code is a credential by another name, and it trains users to run an authenticated API with a publicly known key.
  - Recommendation: Default to no key and warn on first probe, or generate-and-persist a local key on first run.

- [SEV: medium] No workspace/project filter on the search API — every scoped agent must over-fetch and post-filter
  - Where: `packages/client/src/client.ts:436-465` (`searchDetailed` input has no `scope`/`scopeRef` fields); worked around at `packages/pi-extension/extensions/index.ts:166-180` ("Memongo's search API doesn't expose a direct scopeRef filter, so we over-fetch and narrow in the adapter").
  - What: An agent wanting "search only this project's memories" must fetch up to 4x results and filter client-side, silently dropping recall when matches cluster outside the scope. The write path accepts `scope`/`scopeRef` (`/v1/write-event`, `/v1/write-structured`), so the asymmetry is a genuine API gap.
  - Why it matters: Multi-agent/multi-project deployments are a stated goal; every new agent type will rediscover and re-implement this workaround, each with different recall degradation.
  - Recommendation: Add `scope`/`scopeRef` to `/v1/search` and `/v1/search-detailed` (prefiltered in the search index, per MongoDB guidance).

- [SEV: medium] MCP server is stdio-only; no remote/SSE/HTTP transport
  - Where: `apps/mcp/src/server.ts:2080-2086` (`main()` only creates `StdioServerTransport`)
  - What: Remote or sandboxed agents (cloud IDEs, CI bots, agents in containers without repo checkout) cannot use MCP without colocating the process. Given the server is already a thin proxy over HTTP, an HTTP-transport MCP variant would be nearly free.
  - Why it matters: "Connect from anywhere" is currently gated on running a local Node process.
  - Recommendation: Add optional `StreamableHTTPServerTransport` selected by env/flag.

- [SEV: medium] Default single bearer key grants full cross-tenant access; isolation is opt-in via env JSON
  - Where: `apps/api/src/app.ts:164-185` (`ScopedApiKeyPolicy` via `MEMONGO_API_SCOPED_KEYS`), and `apps/mcp/src/server.ts:11-14` (MCP client constructed with one global key, `agentId` passed per call).
  - What: With the common single `MEMONGO_API_KEY` setup, any caller (including an MCP-connected LLM) can read/write any agent's memory by changing the `agentId` argument — the server-side `agentId` scoping is a namespace, not a boundary, unless the operator configures scoped keys. The MCP server forwards arbitrary `agentId` from tool args.
  - Why it matters: Two agents sharing one deployment are safe only if the operator discovered and configured the scoped-keys JSON; nothing in the connect path enforces or even nudges that.
  - Recommendation: Document-enforce in code: when a scoped key is presented, reject cross-scope `agentId` (policy exists — verify it applies on MCP-forwarded args), and consider per-agent key issuance as the default local setup.

- [SEV: low] MCP server declares no MCP resources/prompts capabilities and lacks `memongo_extract`
  - Where: `apps/mcp/src/server.ts:1446-1455` (`capabilities: { tools: {} }` only); client method exists at `packages/client/src/client.ts:635-641` (`extract` → `/v1/extract`) with no corresponding MCP tool.
  - What: MCP resources (e.g. exposing memory blocks/profile as readable resources hosts can auto-attach) and prompts are unimplemented; one client SDK method (`extract`) is unreachable via MCP.
  - Why it matters: Minor parity gap; resources would be the cheapest "context injection" for hosts that support them.
  - Recommendation: Add `memongo_extract` tool; evaluate exposing `/v1/context-bundle` as an MCP resource.

- [SEV: low] Input schema quality is uneven across MCP tools
  - Where: `apps/mcp/src/server.ts:146-159` (`memongo_search`: bare `{query:{type:"string"}}`, no descriptions, no defaults/max) vs `apps/mcp/src/server.ts:262-310` (`memongo_recall_conversation`: rich per-property descriptions).
  - What: Roughly half the tools (search, add, read_file, write_structured with `entry:{type:"object"}`) give an LLM no field-level guidance, while the lifecycle tools are well documented. `memongo_write_structured`'s `entry` is an undifferentiated `object` — an agent cannot know it needs `{type,key,value,scope,salience,...}` (that shape is only discoverable in the pi-extension source).
  - Why it matters: Tool-call accuracy for the most common tools (search/add) is the worst.
  - Recommendation: Bring core tools up to the recall/lifecycle description standard; give `write_structured` a concrete schema.

## 10-minute agent test (Python Slack bot, raw HTTP)

Minimum viable integration, from code alone:
1. `POST /v1/add` `{content, agentId}` with `Authorization: Bearer $MEMONGO_API_KEY` — save a memory (`apps/api/src/routes/v1.ts:1494`).
2. `POST /v1/search` `{query, agentId, limit}` — recall (`apps/api/src/routes/v1.ts:819`).
3. Optionally `POST /v1/context-bundle` `{agentId, query, mode}` for prompt injection (`apps/api/src/routes/v1.ts:1408`).
Discovery aids: `GET /health` and `GET /openapi.json` exist unauthenticated (`apps/api/src/app.ts:632-633`) — a real OpenAPI spec makes raw-HTTP integration viable without the TS SDK.
Friction points: (a) `agentId` is optional on every route with no code-visible default — a caller can't tell what namespace unscoped writes land in without reading deep engine code; (b) three overlapping write verbs (`/v1/add`, `/v1/write-event`, `/v1/write-structured`) with no in-code guidance on which a new agent should use; (c) no scope/scopeRef filter on search; (d) error envelope `{error:{code,message}}` is consistent (good) but `code` values are not enumerated anywhere in the API source.

## Framework-agnosticism audit

- Embedding provider is pluggable: `EmbeddingProviderId = "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama"` plus `"auto"` selection (`packages/memory-engine/src/embeddings.ts:49-66`) — good; not Voyage-locked, though `voyage-4-large` is the default model in schema/KB paths (`packages/memory-engine/src/mongodb-schema.ts:3103`, `packages/memory-engine/src/mongodb-kb.ts:126`).
- Enrichment/LLM provider is OpenAI-compatible-HTTP with pluggable auth (`packages/memory-engine/src/mongodb-llm-enrichment.test.ts:176,252`).
- Framework targets: Vercel AI SDK (`packages/tools/src/vercel/index.ts`) and OpenAI client shape (`packages/tools/src/openai/index.ts`); Pi coding agent (`packages/pi-extension`); MCP (any host). No LangChain/Mastra adapters exist, but the HTTP API + OpenAPI spec is the generic fallback.
- Node-only APIs in client packages: `process.env` in `@memongo/client` (finding above); `@memongo/tools` Vercel middleware is otherwise fetch-only.

## Top 5

1. [high] MCP server unpublished, no `bin`, requires tsx source checkout — `apps/mcp/package.json:4-11`.
2. [high] 40-tool MCP surface with 8 aliases + ~10 admin/benchmark tools and inconsistent `structuredContent` — `apps/mcp/src/server.ts:134-1442`.
3. [high] `process.env` in `@memongo/client` breaks browser/edge runtimes — `packages/client/src/client.ts:84-91`.
4. [medium] No scope/scopeRef filter on search API; every scoped agent post-filters with degraded recall — `packages/client/src/client.ts:436-465`, workaround at `packages/pi-extension/extensions/index.ts:166-180`.
5. [medium] Client SDK: no timeout/AbortSignal, unparsed error envelope, zero tests — `packages/client/src/client.ts:114-140`.

## Harmony note

The connectivity layer is architecturally harmonious — a single clean funnel (engine → bridge → Hono HTTP API → thin adapters: MCP, TS client, Vercel/OpenAI middleware, Pi extension) with one auth model (Bearer + optional scoped keys) and one consistent error envelope — but it is operationally out of tune with itself. The HTTP API is the most polished surface (rate limiting, timing-safe auth, OpenAPI spec, scoped multi-tenant keys), yet every downstream adapter re-implements or degrades it: the MCP server bypasses structured output for most tools and forwards unscoped `agentId`, the two middlewares duplicate fetch logic and fail silently, the client can't run outside Node and can't parse the API's own error codes, and the Pi extension hardcodes a credential and works around a missing search filter that should live in the API. The result is that "ease of connection" is inversely proportional to distance from the HTTP API: raw HTTP + OpenAPI is the best-documented path, while the flagship agent surfaces (MCP, SDK) are the roughest. Closing the gaps above (publish MCP, prune tool list, scope-filter search, runtime-safe client) would make the adapters feel like one organism with the API rather than four partial translations of it.

## Out-of-scope sightings

- `packages/memory-engine/src/mongodb-schema.ts:3103` — `voyage-4-large` hardcoded as autoEmbed default model; engine-side concern (embedding default, not connectivity).
- `packages/client/src/client.ts:520` — deprecated `containerTag` alias admitted-but-ignored on `searchDetailed`; API-contract drift the contract reviewer should note.
