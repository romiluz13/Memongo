# @memongo/client

TypeScript HTTP client for the Memongo API. Use this package when you want to call the supported public API from an app, job, or integration.

## Install

```bash
npm install @memongo/client
```

## When to use this package

- You are talking to `apps/api`.
- You want retrying HTTP requests and a typed client surface.
- You do not need direct engine access.

## Example

```ts
import { MemongoClient } from "@memongo/client"

const client = new MemongoClient({
	baseUrl: "http://127.0.0.1:3847",
})

await client.add({
	content: "The user prefers concise release notes.",
	sessionId: "main",
})

const results = await client.search({
	query: "What does the user prefer?",
	sessionKey: "main",
})
```

## Memory intelligence methods

- `client.traceChain()` -- reasoning chain traversal (`POST /v1/chain-trace`)
- `client.scanNovelty()` -- surprisal novelty detection (`POST /v1/novelty-scan`)
- `client.consolidate()` -- trigger consolidation agent (`POST /v1/consolidate`)

## Retries and idempotency

Every request is retried up to `maxRetries` (default 2) on `429` and `503`,
honoring the server's `Retry-After` header when present. Retrying is only
safe for requests that are idempotent by construction, so the client only
retries:

- `GET`/`HEAD` requests (no side effects), and
- `POST` requests carrying an `Idempotency-Key` header — `add`,
  `writeEvent` (one key per logical write, reused across that call's
  retries), and `writeEvents` (every batch item carries its own
  idempotency key, and the server turns per-item replays into receipt
  entries).

Every other `POST` fails fast on `429`/`503` instead of retrying. That
includes mutations where a replay could double-write memory
(`writeStructured`, `writeProcedure`, `selfEdit`, `consolidate`,
`importConversations`, `extract`, lifecycle updates, admin actions) and
query-shaped `POST`s such as `search` and `buildContextBundle`: the client
cannot prove an arbitrary unkeyed `POST` idempotent, so it treats all of
them conservatively. If you need retries for those calls, retry at the
application layer after verifying the operation is safe to repeat.

The client also sends `x-memongo-client-version` on every request; the
server logs a version-skew warning (once per client/server version pair)
when it does not match its own release version. The header is telemetry
only — requests are never rejected for skew.

If you need server-side helpers or direct engine access, use [`@memongo/memory-bridge`](../memory-bridge/README.md) or [`@memongo/memory-engine`](../memory-engine/README.md).
