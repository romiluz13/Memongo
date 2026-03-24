# Memongo platform (standalone workspace)

This folder is a **standalone product layer** in the same sense as [Supermemory](https://github.com/supermemoryai/supermemory): its own **pnpm workspace** (SDK, HTTP API, MCP, web). You can **`git clone` only this tree** into its own GitHub repo and ship it separately from the main Memongo gateway repo.

## Install (from this repo root)

```bash
pnpm install
```

The HTTP API (`apps/api`) depends on **`@romiluz/memongo`** via **`pnpm link:`** to your engine checkout (no dependency on the parent monorepo’s `pnpm-workspace.yaml`). The package must provide the built `memongo-bridge` chunk (`pnpm build` in the engine repo).

### Default layout (this repo inside the Memongo tree)

`apps/api/package.json` uses:

```json
"@romiluz/memongo": "link:../../../"
```

That resolves to the **Memongo repo root** when `memongo-platform` lives at `<memongo>/memongo-platform`.

### Standalone: this repo only on GitHub

Clone [Memongo](https://github.com/romiluz/memongo) and this tree **side by side**, then point the API at the engine folder:

```bash
# Example: both repos under the same parent directory
#   Dev/memongo/          ← engine (run pnpm build here)
#   Dev/memongo-platform/      ← this workspace

cd memongo-platform/apps/api
pnpm add @romiluz/memongo@link:../../../memongo
```

Adjust the path if your folder names differ.

### When `@romiluz/memongo` is published to npm

Replace the `link:` dependency with a semver range, for example:

```bash
cd apps/api
pnpm add @romiluz/memongo@^2026.3.29
```

## Why Memongo (vs hosted “memory APIs”)

- **Your data, your cluster:** MongoDB + mongot as the substrate.
- **Event-sourced memory, hybrid retrieval, graph, episodes** — see the main repo docs for the engine.

For a **factual** comparison to common reference projects (for example Claude Code–centric local memory vs Memongo’s MongoDB platform story), see [versus-local-reference-memory.md](docs/versus-local-reference-memory.md). For a **pre-publish** checklist, see [PRODUCTION-READY.md](docs/PRODUCTION-READY.md).

## Supermemory-shaped layout

| Pattern      | Supermemory          | This repo                                                                                                     |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| npm SDK      | `supermemory` client | `MemongoClient` in [`src/client.ts`](src/client.ts)                                                           |
| HTTP API     | Hosted worker API    | [`apps/api`](apps/api) — versioned `/v1/*` (search, KB, files, writes, profile, ops, probes, admin relevance) |
| OpenAPI      | Public spec          | `GET /openapi.json` (no auth)                                                                                 |
| AI SDK tools | `@supermemory/tools` | [`packages/tools`](packages/tools) — `createMemongoTools(client)`                                             |
| MCP          | MCP server package   | [`apps/mcp`](apps/mcp) — stdio MCP                                                                            |
| Dashboard    | Cloud console        | [`apps/web`](apps/web) — Next.js console (tabs)                                                               |
| Turborepo    | Optional pipelines   | [`turbo.json`](turbo.json) task graph                                                                         |

## Docs

- [Capability matrix](docs/capability-matrix.md) — engine ↔ bridge ↔ HTTP ↔ SDK.
- [Publishing](docs/publish.md) — npm and Docker notes.
- [Production-ready checklist](docs/PRODUCTION-READY.md) — gates before you publish or claim production.
- [Versus reference memory projects](docs/versus-local-reference-memory.md) — positioning vs typical “memory reference” trees.

## Architecture

1. **`MemongoClient`** calls `apps/api` over HTTP (`MEMONGO_API_URL`, optional `MEMONGO_API_KEY`).
2. **`apps/api`** loads `@romiluz/memongo/memongo-bridge` and uses your existing OpenClaw/Memongo config and MongoDB. If `~/.openclaw` already sets `memory.mongodb.uri`, set **`MEMONGO_FORCE_MONGODB_URI`** so the API process uses a different cluster (for example a local Docker Mongo) without editing the file.

## Tests

```bash
pnpm test
pnpm check-types:all
```

## Local MongoDB

```bash
docker compose -f docker-compose.yml up -d mongodb
```

## Run the API sidecar

```bash
cd apps/api
# Uses ~/.openclaw-style config + MongoDB; optional MEMONGO_API_KEY for Bearer auth.
# Optional: MEMONGO_FORCE_MONGODB_URI=mongodb://127.0.0.1:27017/openclaw?directConnection=true
# For real Voyage embeddings + reranking in-process, set VOYAGE_API_KEY (same as atlas-local container).
pnpm start
```

Health: `GET http://127.0.0.1:3847/health` (override with `MEMONGO_API_PORT`).

## MCP (stdio)

```bash
cd apps/mcp
MEMONGO_API_URL=http://127.0.0.1:3847 pnpm exec tsx src/server.ts
```

## Web console

```bash
cd apps/web
MEMONGO_API_URL=http://127.0.0.1:3847 pnpm dev
```

## Try the SDK

```bash
MEMONGO_API_URL=http://127.0.0.1:3847 pnpm exec tsx examples/hello.ts
```
