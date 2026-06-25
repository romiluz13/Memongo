# @memongo/tools

AI SDK tool helpers for Memongo. Use this package when you want to expose supported Memongo operations as Vercel AI SDK tools.

## Install

```bash
npm install @memongo/tools
```

## When to use this package

- You are wiring Memongo into an AI SDK agent.
- You want ready-made tool definitions for search, KB search, read, add, write-event, profile, status, chain-trace, novelty-scan, and consolidate.

## Example

```ts
import { MemongoClient } from "@memongo/client"
import { createMemongoTools } from "@memongo/tools"

const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3847" })
const tools = createMemongoTools(client)
```

## Memory intelligence tools

- `memongo_chain_trace` -- reasoning chain traversal (provenance via `$lookup`)
- `memongo_novelty_scan` -- surprisal novelty detection (Atlas Vector Search centroid)
- `memongo_consolidate` -- trigger offline consolidation (Dreamer pipeline)

If you need a different agent wrapper or a custom tool set, build on top of [`@memongo/client`](../client/README.md).
