# @memongo/memory-engine

MongoDB-native memory engine for Memongo. Use this package when you need direct access to search, graph, episodes, structured memory, procedures, sync, telemetry, reasoning chains, novelty detection, access tracking, memory consolidation, and retrieval internals.

## Install

```bash
npm install @memongo/memory-engine
```

## When to use this package

- You are building server-side infrastructure around Memongo.
- You need direct engine access instead of the HTTP API.
- You want the lowest-level supported memory primitives in this repo.

## Example

```ts
import { getMemorySearchManager } from "@memongo/memory-engine"

const { manager } = await getMemorySearchManager({
	cfg,
	agentId: "main",
})

if (!manager) {
	throw new Error("Memongo memory unavailable")
}

const results = await manager.search("release notes")
```

## Memory intelligence modules

- `mongodb-reasoning-chain.ts` -- provenance chain traversal via `$lookup` on `sourceEventIds`
- `mongodb-novelty.ts` -- surprisal novelty detection using Atlas Vector Search centroid distance
- `mongodb-access-tracker.ts` -- `AccessTracker` with batched writes for memory access frequency
- `mongodb-trust.ts` -- `computeImportanceDecay()` with `temporalScope`-aware decay (permanent/ongoing memories never decay)
- `mongodb-consolidator.ts` -- offline consolidation agent (Dreamer) with rule-based pattern matching
- KB schema fields: `wikiSource`, `vault`, `section` for wiki source categorization

Most apps should use [`@memongo/memory-bridge`](../memory-bridge/README.md) or [`@memongo/client`](../client/README.md) instead of calling the engine directly.
