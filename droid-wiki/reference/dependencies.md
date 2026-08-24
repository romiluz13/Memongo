# Dependencies

Core runtime, build tooling, and external service dependencies across the Memongo monorepo. See [Architecture](../overview/architecture.md) for how these packages compose.

## Core runtime dependencies by role

| Package | Used by | Purpose |
|---|---|---|
| `mongodb` (`^7.5.0`) | `packages/memory-engine` | Official MongoDB Node.js driver — connections, aggregation pipelines (`$vectorSearch`, `$rankFusion`/`$scoreFusion`, `$graphLookup`), change streams. |
| `hono` (`^4.13.2`) | `apps/api` | HTTP framework serving `/v1/*`, `/health`, `/ready`, `/openapi.json`. |
| `@hono/node-server` (`^1.19.17`) | `apps/api` | Node.js server adapter for Hono. |
| `@modelcontextprotocol/sdk` (`^1.30.0`) | `apps/mcp` | MCP protocol implementation — the stdio server that exposes Memongo tools to MCP-compatible clients. |
| `ai` (`^5.0.237`, peer `>=5.0.0`) | `packages/tools` | Vercel AI SDK — tool-calling schema types consumed by the `./vercel` export. |
| `zod` (`^3.25.0`) | `apps/api`, `packages/tools` | Runtime schema validation for API request bodies and AI SDK tool arguments. |
| `next` (`^15.5.21`), `react` / `react-dom` (`^19.2.8`) | `apps/web` | Web console framework and UI runtime. |
| `chokidar` (`^4.0.3`) | `packages/memory-engine` | File-system watcher for knowledge-base auto-import path monitoring. |
| `node-llama-cpp` (`>=3.20.0`, optional) | `packages/memory-engine` | Optional local LLM runtime, declared as an `optionalDependency` so installs do not fail without it. |
| `tsx` (`^4.23.12`) | `apps/api` | TypeScript execution for dev/start scripts without a separate build step. |
| `gsap` (`3.15.0`) | `apps/web` | Animation library for the web console UI. |
| `@memongo/lib`, `@memongo/memory-bridge`, `@memongo/client` (workspace packages) | cross-package | Internal workspace dependencies — shared types/contract, engine facade, and HTTP client SDK respectively; see `packages/*/package.json` for the exact graph. |

## Root `overrides` block

`package.json` pins these transitive dependency versions across the whole workspace:

| Package | Pinned version |
|---|---|
| `body-parser` | `2.3.0` |
| `fast-uri` | `3.1.5` |
| `fast-xml-builder` | `1.3.1` |
| `fast-xml-parser` | `5.11.0` |
| `form-data` | `4.0.6` |
| `ip-address` | `10.5.0` |
| `lodash` | `4.18.1` |
| `postcss` | `8.5.26` |
| `qs` | `6.15.3` |
| `react` | `19.2.8` |
| `socket.io-parser` | `4.2.7` |
| `tar` | `7.5.22` |
| `vite` | `8.2.1` |
| `ws` | `8.21.3` |

Every entry here except `react` is a transitive dependency pulled in indirectly (none of these appear as a direct `dependency` in any workspace `package.json`), which is the signature of a security-driven pin: forcing a fixed-CVE version of a package several levels down the tree rather than a version bump the team chose for features. `react` is pinned to keep `apps/web`'s direct `react`/`react-dom` versions aligned with whatever transitively depends on `react` elsewhere in the graph. See [Security](../security.md) for the security-review process these pins feed into.

## External services

| Service | Role | Notes |
|---|---|---|
| MongoDB Atlas (managed cloud) or Atlas Local Preview (`mongodb/mongodb-atlas-local:preview`, via `docker/docker-compose.yml`) | Primary data store, vector search, full-text search | Atlas Local Preview bundles `mongod` and `mongot` (community search engine) in one container; MongoDB documents Automated Embedding as an upstream Preview feature not for production use. |
| Voyage AI (via a MongoDB Atlas Model API key, `al-...` prefix) | Embeddings (index- and query-time) and reranking (`rerank-2.5`) | Configured through `VOYAGE_API_KEY` and the optional `VOYAGE_API_INDEXING_KEY` / `VOYAGE_API_QUERY_KEY` / `VOYAGE_RERANK_API_KEY` overrides; routed through `ai.mongodb.com` — a direct Voyage key (`pa-...` prefix) does not work. See [Configuration](configuration.md) and [Embeddings and providers](../systems/embeddings-and-providers.md). |
| Optional OpenAI-compatible or Anthropic-compatible endpoint | LLM enrichment and graph entity extraction (`method: "llm"`) | Configured through `MEMONGO_ENRICHMENT_*` and `MEMONGO_LLM_*` env vars; defaults to `https://api.openai.com/v1` with `gpt-4o-mini`. |

## Build and dev tooling

| Package | Purpose |
|---|---|
| `turbo` (`^2.10.10`) | Monorepo task orchestration (`build`, `dev`, `test`, `check-types` pipelines across workspaces). |
| `@biomejs/biome` (`2.4.10`) | Lint and format (tabs, double quotes) — replaces separate ESLint/Prettier configs. |
| `typescript` (`^5.9.3` at root; `^5.8.0` in most packages) | Type-checking and compilation for every TypeScript workspace. |
| `fast-check` (`^4.9.0`) | Property-based testing, used alongside Vitest. |
| `vitest` (`^4.1.10`, per-package) | Test runner across `apps/api`, `apps/mcp`, `packages/memory-engine`, `packages/tools`, etc. |

Bun (`packageManager: bun@1.3.13`) is the package manager and workspace runner for the whole monorepo (`bun install`, `bun run build/dev/test`).
