# @memongo/memory-bridge

Stable facade over the Memongo engine. Use this package when you want one supported entry point for config resolution and engine operations without binding to the HTTP API.

## Install

```bash
npm install @memongo/memory-bridge
```

## When to use this package

- You are implementing an HTTP API, MCP server, or custom server around Memongo.
- You want one stable layer between app code and the engine.
- You need bridge helpers such as search, write, status, sync, relevance, chain-trace, novelty-scan, and consolidation operations.

## Example

```ts
import { memongoBridgeSearch, memongoBridgeStatus } from "@memongo/memory-bridge"

const status = await memongoBridgeStatus({ agentId: "main" })
const { results, outcomes, degradation } = await memongoBridgeSearch({
	query: "deployment notes",
	agentId: "main",
	maxResults: 10,
})
```

`memongoBridgeSearch()` and `memongoBridgeSearchKB()` return an envelope, never a bare array. A call whose lanes all failed throws the engine's typed `SearchLaneError` (or `SearchBudgetDeniedError`) with the failed rows on `error.outcomes`; a partly failed call returns its healthy results with `outcomes`, and a throttled call returns `degradation`.

`memongoBridgeGetState()` omits a section whose read failed and lists it in `failures` (`{ section, reason }`) with `partial: true`; it rejects only when every section failed.

## Memory intelligence bridge functions

- `memongoBridgeTraceChain()` -- reasoning chain traversal (provenance via `$lookup`)
- `memongoBridgeScanNovelty()` -- surprisal novelty detection (Atlas Vector Search centroid)
- `memongoBridgeConsolidate()` -- trigger offline consolidation (Dreamer pipeline)

If you are building against the public HTTP surface, prefer [`@memongo/client`](../client/README.md).
