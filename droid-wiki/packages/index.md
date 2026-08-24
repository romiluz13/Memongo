# Packages

Memongo's `packages/` directory holds seven workspace packages. `apps/api` depends on the bridge and engine; `apps/mcp`, `packages/tools`, and external consumers depend on `packages/client`. See [Architecture](../overview/architecture.md) for how these fit together.

| Package | Purpose |
| --- | --- |
| [`@memongo/memory-engine`](../packages/memory-engine/index.md) | Core MongoDB memory engine: embeddings, graph, episodes, search, knowledge base, and analytics. |
| [`@memongo/memory-bridge`](memory-bridge.md) | Stable facade between `apps/api` and the engine, so the engine's internal types can change without breaking the API. |
| [`@memongo/memory`](memongo-memory.md) | Published re-export barrel (package dir `packages/memongo-memory`) that combines the bridge and engine into one npm import. |
| [`@memongo/client`](client.md) | TypeScript HTTP client SDK (`MemongoClient`) for the `apps/api` `/v1/*` routes. |
| [`@memongo/tools`](../packages/tools.md) | AI SDK tool helpers (Vercel AI SDK, OpenAI) built on top of `packages/client`. |
| [`@memongo/lib`](../packages/lib.md) | Shared types, contract definitions, auth, and utilities used across the workspace (private, internal). |
| [`@memongo/pi-extension`](../packages/pi-extension.md) | Pi coding-agent extension that adds semantic memory to Pi sessions. |

## Related pages

- [Architecture](../overview/architecture.md) — how the API, bridge, engine, and MongoDB fit together
- [Apps](../apps/index.md) — the HTTP API, MCP server, and web console that consume these packages
- [Reference: data models](../reference/data-models.md) — full type catalogs referenced by the bridge and client
