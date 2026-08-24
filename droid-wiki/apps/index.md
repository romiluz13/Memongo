# Apps

Memongo ships four deployable apps under `apps/`. Three form the runnable product surface (API, MCP server, operator console); the fourth is the public documentation site.

| App | What it is | Page |
|---|---|---|
| `apps/api` | Hono HTTP server, the only process that talks to MongoDB in a standard deployment. Every other surface calls it. | [API](../apps/api/index.md) |
| `apps/mcp` | Stdio MCP server that exposes the same operations as typed tools for MCP-compatible hosts (coding agents, chat clients). | [MCP server](../apps/mcp/index.md) |
| `apps/web` | Next.js operator console and marketing landing page, deployed to Cloudflare Workers. | [Web console](web.md) |
| `apps/docs` | Mintlify site with the public, user-facing product documentation. | [Docs site](docs.md) |

See [Architecture](../overview/architecture.md) for how these apps relate to `packages/memory-bridge` and `packages/memory-engine`, and [Getting started](../overview/getting-started.md) for the commands to run each one locally.
