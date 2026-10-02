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

An explicit `customId` must be a nonblank string. `add` and `writeEvent`
also require a valid HTTP header value: Latin-1 characters are allowed;
NUL, CR, LF, and characters above U+00FF are rejected. Batch IDs in
`writeEvents` are sent in JSON and can contain Unicode. Invalid IDs reject
the call before any request is sent; one invalid batch ID rejects the whole
batch. Omitted or null IDs still receive generated UUIDs. Untyped callers
that supplied numeric IDs must now supply strings.

Eligible requests are retried up to `maxRetries` (default 2) on `429` and `503`,
honoring the server's `Retry-After` header when present. Retrying is only
safe for requests that are idempotent by construction, so the client only
retries:

- `GET`/`HEAD` requests,
- `getLifecycleItem`, `getLifecycleHistory`, `profile`, `hydrateActiveSlate`
  and `recallConversation`, whose `POST` endpoints retrieve existing memory, and
- `POST` requests carrying an `Idempotency-Key` header — `add`,
  `writeEvent` (one key per logical write, reused across that call's
  retries), and `writeEvents` (every batch item carries its own
  idempotency key, and the server turns per-item replays into receipt
  entries).

The three direct conversation write endpoints return `429 WRITE_QUEUE_FULL`
when the per-agent queue rejects admission. The rejected call writes nothing;
a rejected batch returns no receipts, including per-item validation receipts.
The server supplies no `Retry-After` estimate for queue saturation. The SDK
uses its existing bounded backoff for retry-safe writes: `add` and `writeEvent`
with their idempotency keys, and `writeEvents` with per-item keys. Raw unkeyed
write requests need a caller-controlled retry decision. Conversation imports
can commit earlier batches before failing and retain their existing error
response; this queue classification does not change import retry behavior.

Lifecycle updates, lifecycle deletion and memory feedback return `409` with code `MEMORY_LIFECYCLE_CONFLICT` when the handle is stale or invalidated. Fetch the current item and decide whether the change still applies before submitting a new mutation; an invalidated item cannot be updated. The client does not automatically retry `409`.

`updateLifecycleItem` and `applyMemoryFeedback` return `MemongoLifecycleMutationResult`.
A held `202` response has `quarantined: true`, `matchedPatterns` and an optional
`quarantineId`; it has no memory handle or data and does not mean the write was
applied. A normal response is the lifecycle item. TypeScript callers that
previously accessed item fields unconditionally must now check the disposition:

```ts
const result = await client.updateLifecycleItem({ handle, patch })
if (result.quarantined === true) {
	console.log(result.quarantineId, result.matchedPatterns)
} else {
	console.log(result.handle, result.data)
}
```

The HTTP response and JavaScript behavior are unchanged. The exported
`MemongoQuarantineDisposition` retains its optional fields; use the result union
when consuming these methods.

Every other `POST` fails fast on `429`/`503` instead of retrying. That
includes mutations where a replay could double-write memory
(`writeStructured`, `writeProcedure`, `selfEdit`, `consolidate`,
`importConversations`, `extract`, lifecycle updates, admin actions) and
query-shaped `POST`s such as `search` and `buildContextBundle`. Apart from
the read methods above, the client treats unkeyed `POST`s
conservatively. If you need retries for those calls, retry at the
application layer after verifying the operation is safe to repeat.

Each retry can repeat coordination-gate writes, telemetry and retrieval work.
The timeout is per attempt; no overall deadline spans retries and backoff.

`state` returns an error when all three state reads reject. It returns `503`
only when every rejection matches the supported dependency-unavailable
classifier; other total failures return `500`. As a `GET`, `state` retries
`503` within the configured retry budget. Fulfilled partial state still returns
`200` with `partial: true`. Helpers can fulfill empty results after handling
their own failures, so a dependency outage does not always produce `503`.

The client also sends `x-memongo-client-version` on every request; the
server logs a version-skew warning (once per client/server version pair)
when it does not match its own release version. The header is telemetry
only — requests are never rejected for skew.

If you need server-side helpers or direct engine access, use [`@memongo/memory-bridge`](../memory-bridge/README.md) or [`@memongo/memory-engine`](../memory-engine/README.md).

Quarantine `promoteQuarantined` and `rejectQuarantined` return `404` (`NOT_FOUND`)
when the row is missing for the selected agent, or `409`
(`QUARANTINE_REVIEW_CONFLICT`) when it was already reviewed, has an active
promotion lease, or lost a concurrent claim. Refresh the quarantine state before
deciding again. The client does not automatically retry either status.

The quarantine-list endpoint returns `400` for an unsupported status, including
an empty `?status=`. Omit `status` to list all stages. The client does not retry
`400`; its query builder omits empty strings and undefined values.

Structured writes, lifecycle updates/deletes and structured feedback return `409 STRUCTURED_MEMORY_REVISION_CONFLICT` when the engine's specific revision-conflict error propagates. This differs from `409 MEMORY_LIFECYCLE_CONFLICT` for a stale or invalidated handle. Fetch current state and decide whether to resubmit; the SDK does not automatically retry 409, and no `Retry-After` is supplied. Generic transaction errors, uncertain commit outcomes and timeout wrappers retain their existing error handling. Public admitted writes use the driver's fenced transaction retries, so this response does not imply exactly three attempts or that the full request is safe to repeat.
