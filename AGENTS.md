# Memongo Repository Guidelines

- Repo: https://github.com/romiluz13/memongo
- In chat replies, file references must be repo-root relative only (example: `packages/memory-engine/src/mongodb-manager.ts:80`); never absolute paths or `~/...`.

## Project Structure

Memongo is a **Turborepo/Bun monorepo** providing MongoDB-native long-term AI memory.

```
memongo/
  apps/
    api/          HTTP API server (Hono)
    mcp/          MCP server (stdio, calls HTTP API)
    web/          Next.js web console
  packages/
    memory-engine/   Core MongoDB memory: embeddings, graph, episodes, search, KB, analytics
    memory-bridge/   Stable facade for the engine used by apps
    memongo-memory/  Published re-export package
    client/          TypeScript HTTP client SDK
    tools/           AI SDK tool helpers
    lib/             Shared types and utilities
  docker/
    mongodb/         Local MongoDB dev stack (atlas-local + mongot)
  docs/              Memongo documentation
```

## Build, Test, and Development

- Runtime: Node 20+, Bun 1.2+ as package manager
- Install: `bun install`
- Build: `bun run build` (Turbo)
- Dev: `bun run dev`
- Test: `bun run test` (Turbo -> Vitest)
- Type-check: `bun run check-types`
- Lint/format: `bun run lint` / `bun run format` (Biome)
- MongoDB local: `cd docker && docker compose up` (or `docker compose -f docker/docker-compose.yml up`)

## Coding Style

- Language: TypeScript (ESM). Strict typing; avoid `any`.
- Formatting/linting via Biome (tabs, double quotes, semicolons as needed).
- Keep files under ~500 LOC; split/refactor when it improves clarity.
- Tests: colocated `*.test.ts` with source, Vitest + V8 coverage.
- Written English: American spelling and grammar.

## Package Naming

- `@memongo/memory-engine` -- core engine
- `@memongo/memory-bridge` -- facade
- `@memongo/client` -- HTTP client SDK
- `@memongo/tools` -- AI SDK tools
- `@memongo/lib` -- shared utilities (private)
- `@memongo/api`, `@memongo/mcp`, `@memongo/web` -- apps (private)

## Commit Guidelines

- Follow concise, action-oriented commit messages (e.g., `engine: add graph expansion`).
- Group related changes; avoid bundling unrelated refactors.

## Security

- Never commit secrets. Use environment variables (`MEMONGO_MONGODB_URI`, `MEMONGO_API_KEY`, etc.).
- Never publish real connection strings, API keys, or personal data in code or docs.
