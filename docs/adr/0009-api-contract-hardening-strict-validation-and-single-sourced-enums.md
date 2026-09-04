# API contract hardening: strict nested validation, lib-sourced enums, keyed retries, version-skew observability

The HTTP API's last unvalidated request boundaries are closed: every
nested object on `/v1/search-detailed` and the context routes is parsed
against a strict zod schema (unknown or operator-shaped keys return 400
naming the field instead of flowing into MongoDB query construction or
the engine's config merge), the context-bundle `mode` and chain-trace
`collection` parameters become enums single-sourced from `@memongo/lib`
with 400 on out-of-enum values, the client's automatic retry loop is
restricted to requests carrying an `Idempotency-Key` (plus inherently
idempotent GETs and the per-item-keyed bulk write), and the server reads
`x-memongo-client-version` and warns once per client/server pair on
version skew. The common thread is that every silent degradation the
contract review (EL-006) flagged — a swallowed mode value, a fabricated
`chainComplete: true` chain, a typo'd time range that quietly removed a
constraint, a doubled lifecycle write — now surfaces as an explicit,
named error or an observable log line.

## Context

DDD workstream WS-08 covers C-011 through C-015 from the GLM-5.3
remediation program's API contract review (EL-006). Four of the five
findings are instances of one pattern: the API returned success for
input it never actually honored. `POST /v1/context-bundle` accepted any
`mode` string and silently produced the default `full` bundle — callers
could request `wakeup` or `FULL` and never learn the mode was dropped.
`POST /v1/chain-trace` accepted any `collection` name and answered a
plausible-but-wrong name with an empty `chainComplete: true` chain,
indistinguishable from "no premises exist". `/v1/search-detailed` type-
cast its nested objects (`searchConfig`, `timeRange`, scope inputs)
straight through, so a typo'd time-range preset silently degraded to no
time constraint and operator-shaped keys reached the engine's config
merge. The client's `apiFetch` retried every request on 5xx — including
non-idempotent mutations without an idempotency key — so a 503 that had
actually applied a lifecycle write could double-apply it on retry. The
fifth finding was the inverse defect: the client sent
`x-memongo-client-version` on every request and no server code read it,
decorative telemetry that created false confidence in contract-drift
detection.

The validation machinery already existed (`kbFilterSchema` had gated
`/v1/search-kb` since P2.8); the defect was that the strictness stopped
at the routes the review happened to examine first.

## Considered Options

**C-011 retry safety: server-side natural idempotency for every
mutation.** Rejected: making every mutation endpoint naturally
idempotent is a server-side state-machine change per route (dedupe
windows, replay semantics, key lifecycle on the server) far beyond the
claim's scope. The client's per-item UUIDv4 idempotency-key generator
(P1.3) already provides the standard mechanism; the missing piece was
that the retry loop ignored which requests carried it.

**C-011 retry safety: stop retrying everything except GETs.** Rejected
as too broad: the bulk write is per-item keyed, so retrying it is safe
by construction, and callers who pass an `Idempotency-Key` explicitly
opt into retry semantics. A blanket GET-only rule would remove safe
retries that the key infrastructure already guarantees.

**C-013/C-015 enums: keep per-package enums in sync by convention.**
Rejected: hand-maintained copies in the client, MCP schema, and tools
package are exactly how the drift arose (the client and MCP accepted a
mode value the API ignored). Single-sourcing in `@memongo/lib` makes the
canonical set a one-file change, and the mirror is enforced rather than
conventional.

**C-014 telemetry: remove the header.** Rejected: with the server
reading it, the header becomes real drift observability at near-zero
cost (one comparison per request, one deduped warn per pair). Removing
it also breaks no caller but gains nothing the warn doesn't.

**C-012 strictness: validate only the fields the review named.**
Rejected: the review named the pattern (type-cast objects), not an
exhaustive field list. Parity with `kbFilterSchema`'s strictness across
every nested object on the route family is the durable fix.

## Decisions

1. **Retries are restricted to keyed or inherently idempotent requests.**
   `apiFetch` retries a request on 5xx only when the method is GET, the
   request carries an `Idempotency-Key`, or the write is the per-item
   keyed bulk write. Unkeyed mutations fail fast on the first 5xx (and
   on 429); the caller sees the error and decides. The retry-safety
   battery pins both directions (GET retried, keyed POST retried, unkeyed
   POST exactly one attempt).

2. **Every nested object on the search and context routes is schema-
   validated.** `searchConfigSchema` is `.strict()` and mirrors the
   engine's `SearchConfig` field-for-field; `searchModeSchema`,
   `sourcePreferenceSchema`, `timeRangeSchema`, and the four scope
   schemas parse what the routes used to cast. Rejections return 400
   `VALIDATION_ERROR` naming the offending field, and the bridge is
   never called on a rejection. The context routes' `timeRange` casts
   (unknown preset, preset-less `{}`) are closed with the same 400s.

3. **`mode` and `collection` are enums single-sourced from
   `@memongo/lib`.** `CONTEXT_BUNDLE_MODE_VALUES` (exactly `full` and
   `wake-up`) and `CHAIN_TRACE_COLLECTION_VALUES` (the five traversable
   collections that key `COLLECTION_ID_FIELDS` in the engine) are the
   canonical sets. The API validates through
   `z.enum(CONTEXT_BUNDLE_MODE_VALUES_TUPLE)` /
   `z.enum(CHAIN_TRACE_COLLECTION_VALUES_TUPLE)`, the client types
   `mode` as `ContextBundleModeValue | undefined` (equality enforced at
   compile time by `expectTypeOf` under the workspace type-check), the
   MCP tool schemas and the tools package enums import the same arrays,
   and out-of-enum values return 400 (or an MCP tool error) naming the
   valid set.

4. **The server reads the client version header and warns on skew.**
   `x-memongo-client-version` is compared against the server's API
   version once per request; a mismatch warns exactly once per
   client/server pair (deduped), a matching version never warns, and an
   absurdly long header value is ignored entirely as a log-spam bound.

## Consequences

Callers that previously sent silently-ignored input now get a named 400
and must fix their request; there is no compatibility shim for
`mode: "wakeup"` or `collection: "events"` because those requests never
did what the caller thought. Unkeyed mutations no longer retry, so a
transient 503 after a write that actually applied surfaces to the caller
instead of being masked by a second attempt — the safer failure mode
for the revision-CAS trust path. Adding a context-bundle mode or a
traversable collection is now a one-file change in `@memongo/lib` that
the workspace type-check and the contract conformance tests propagate
to every consumer. Version skew between a client and the server is
observable in server logs as a deduped warn, making slow client
upgrades visible in operations for the first time. Validation: V-065
(keyed-retry restriction), V-066/V-067/V-068 (search-detailed and
context-route strict validation), V-069/V-070/V-071 (mode single-
sourcing across API, client, MCP), V-072/V-073 (version header sent and
read), V-074/V-075 (chain-trace collection gate and tools enum mirror);
all evidence in `.ddd/reports/runs/ws08-*.log` with the WS-08 sweep
recorded in `.ddd/reports/sweep-ws08.json`.
