# Dependencies

External dependencies per package, from each `package.json`. The monorepo is installed with Bun 1.2+ and pinned by `bun.lock` (CI installs with `--frozen-lockfile`).

## Runtime dependencies

| Dependency | Version | Used by | Purpose |
|------------|---------|---------|---------|
| `mongodb` | `7.2.0` (pinned) | `packages/memory-engine` | Official Node.js MongoDB driver — the only database client in the repo |
| `hono` | `^4.12.0` | `apps/api` | HTTP framework |
| `@hono/node-server` | `^1.19.0` | `apps/api` | Node adapter for Hono |
| `zod` | `^3.25.0` | `apps/api`, `packages/tools` | Request/schema validation |
| `@modelcontextprotocol/sdk` | `^1.25.0` | `apps/mcp` | MCP server (stdio + Streamable HTTP) |
| `ai` (Vercel AI SDK) | `>=5.0.0` (peer) | `packages/tools` | Tool wrappers / middleware |
| `typebox` | peer (`1.1.33` dev) | `packages/pi-extension` | Schema typing for Pi tools |
| `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` | peer (`0.83.0` dev) | `packages/pi-extension` | Pi coding-agent host APIs |
| `chokidar` | `^4.0.3` | `packages/memory-engine` | File watching (KB auto-import paths) |
| `next` | `^15.1.0` | `apps/web` | Web console framework |
| `react` / `react-dom` | `^19.0.0` | `apps/web` | UI |
| `gsap` | `3.15.0` (pinned) | `apps/web` | Landing-page scroll animation |
| `tsx` | `^4.19.0` | `apps/api` | Dev-time TypeScript execution |

## Workspace (internal) dependencies

| Package | Version | Consumers |
|---------|---------|-----------|
| `@memongo/lib` | `2.0.0` | engine (`2.0.0`), api (`workspace:*`), mcp (`2.0.0`), tools (`2.0.0`) |
| `@memongo/memory-engine` | `2.0.1` | memory-bridge |
| `@memongo/memory-bridge` | `workspace:*` | api |
| `@memongo/client` | `2.0.0` / `workspace:*` | mcp, tools, pi-extension, web |

Note the mixed reference style: published packages pin exact versions (`2.0.0`), in-repo-only consumers use `workspace:*`.

## Optional and dev tooling

| Dependency | Version | Role |
|------------|---------|------|
| `node-llama-cpp` | `>=3.0.0` | Optional dependency of the engine (local embeddings path) |
| `typescript` | `^5.8.0` | Everywhere; `check-types` gate |
| `vitest` | `^4.1.0` | Test runner + V8 coverage |
| `turbo` | `^2` | Task orchestration (also used by `turbo prune --docker` in `apps/api/Dockerfile`) |
| `mintlify` | `^4.2.112` | Docs site (`apps/docs`) |
| `@opennextjs/cloudflare` | `^1.0.0` | Web console Cloudflare deployment |
| `wrangler` | `^4.42.0` | Cloudflare deploy CLI |
| Biome | repo-root `biome.json` | Lint/format (tabs, double quotes) |

## Version floor

- **Runtime:** Node.js 20+ (Docker image builds on Node 22)
- **Package manager:** Bun 1.2+ (CI pins 1.2.5 in `.github/workflows/ci.yml`)
- **Database:** MongoDB 8.x with mongot — the `mongodb/mongodb-atlas-local` image locally; individual features gate on server version via the capability registry (see [Configuration](configuration.md#capability-detection-and-version-gating))

## Related pages

- [Configuration](configuration.md)
- [Tooling](../how-to-contribute/tooling.md) — how the build/lint/test toolchain runs
- [Deployment](../deployment.md)
