# How to monitor

This page covers observing a running Memongo instance: logs, telemetry and
analytics surfaces, and the two health endpoints. For how the underlying
telemetry and analytics code is implemented, see
[Jobs, telemetry, and sync](systems/jobs-telemetry-and-sync.md).

Be clear about what this is, and what it isn't: Memongo has structured
logging and MongoDB-backed telemetry/analytics collections, but there is no
separate metrics, tracing, or alerting product layered on top. Observing a
deployment means reading logs, querying the telemetry collection, and
polling `/ready` — there is nothing else to point a dashboard at out of the
box.

## Logs

Logging is subsystem-scoped, built by `createSubsystemLogger` in
`packages/lib/src/logger.ts`. Every logger is created with a name (e.g.
`"memory:mongodb:telemetry"`) and every line is prefixed with that
subsystem, a timestamp, and level:

```
14:32:07.512 [memory:mongodb:telemetry] warn: telemetry emit failed {"operation":"search","error":"..."}
```

Levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`, with
priority ordering used to filter what actually gets written. The minimum
level is resolved once per call from environment variables, in this order:

1. `MEMONGO_LOG_LEVEL` — an exact level name (`trace` through `silent`).
2. `MEMONGO_DEBUG=1` or `DEBUG=1` — forces `debug` if `MEMONGO_LOG_LEVEL`
   isn't set.
3. Default: `info`.

`error` and `fatal` write to `console.error`, `warn` to `console.warn`,
`debug`/`trace` to `console.debug`, everything else to `console.log`. A
`raw()` method exists for unformatted lines gated at `info`. Loggers can be
namespaced further with `.child(name)`, which appends `/name` to the
subsystem string — used to scope a logger to a specific operation within a
subsystem without constructing a new one by hand.

To add a new log statement: call `createSubsystemLogger("<area>")` once at
module scope (existing subsystems follow a `memory:<area>` or
`memory:mongodb:<module>` convention — grep existing calls for the pattern
in your area before inventing a new name), then call `.info()`/`.warn()`/
etc. with a message and an optional metadata object.

## Telemetry and analytics

Two different MongoDB-backed surfaces exist, and they answer different
questions.

**Operation telemetry** (`packages/memory-engine/src/mongodb-telemetry.ts`)
records individual operation events — search, event-write, rerank,
graph-expansion, and so on — into a time-series collection keyed by
`agentId` and `operation`. `emitTelemetry` is fire-and-forget and
error-swallowing: it never blocks the caller and never throws, because
telemetry is observability, not product behavior, and an aggregation or
insert failure here must not fail the request that triggered it. Three
aggregation helpers read that collection back:

- `getLatencyStats` — p50/p95/p99 latency for an operation over a time
  window, computed server-side with MongoDB's `$percentile` operator.
- `getCacheHitRate` — cache hit rate over a time window.
- `getOperationDistribution` — operation counts and average duration,
  sorted by volume.

These are the closest thing Memongo has to a metrics API, and they are
queried on demand rather than continuously scraped or pushed anywhere.

**Memory analytics** (`packages/memory-engine/src/mongodb-analytics.ts`,
`getMemoryStats`) answers a different question: not "how fast was the
system," but "what does the stored memory look like." It aggregates
per-source file and chunk counts and last-sync timestamps from the
knowledge-base collections — useful for auditing ingestion coverage, not
for latency or error-rate monitoring.

**Operation accounting**
(`packages/memory-engine/src/mongodb-operation-accounting.ts`) is
run-scoped, not continuous: it exists for diagnostic harnesses (like
benchmark runs) that need to count attempts/successes/failures per
operation without coupling production search and write code to benchmark
implementations. It explicitly marks some operations (`embedding`,
`vector-query`) as unobservable, with a stated reason, rather than guessing
— for example, MongoDB automated-embedding calls aren't exposed to the
calling process, so that accounting entry is `observability: "unknown"` by
design, not a bug.

## `/health` vs `/ready`

The API exposes two distinct endpoints, and they check different things:

- **`GET /health`** (`apps/api/src/app.ts`) is a liveness check — it returns
  `{ ok: true, service: "memongo-api" }` unconditionally if the process can
  respond at all. It carries no auth and does no dependency checks.
- **`GET /ready`** (backed by `apps/api/src/lib/readiness.ts`,
  `checkReadiness`) is a deep dependency check across three required lanes,
  run in parallel:
  - `mongo` — a live round-trip through the memory-bridge (`memongoBridgePingMongo`), to detect a MongoDB that died after boot.
  - `vector` — vector-search availability on this deployment (`memongoBridgeProbeVector`).
  - `embedding` — embedding-provider availability (`memongoBridgeProbeEmbedding`).

  All three lanes must be `ok` for the overall report to be `ok`. `/ready`
  is unauthenticated and infra-facing, so lane failure messages are
  sanitized before being returned: MongoDB URI credentials are redacted via
  regex, and messages are capped at 300 characters.

Use `/health` for process-alive checks (load balancer liveness probes);
use `/ready` for whether the instance can actually serve memory requests
(readiness probes, deployment gating).

## Adding a new telemetry point

To add a new observed operation: extend the `TelemetryOperation` union and
`TelemetryDocument` shape in `packages/memory-engine/src/mongodb-telemetry.ts`,
then call `emitTelemetry(db, prefix, { meta: { agentId, operation }, ... })`
at the call site. Because `emitTelemetry` is fire-and-forget, adding a call
never changes the latency or failure behavior of the code path it
instruments — that is the intended tradeoff, and it's why telemetry can be
added liberally without a performance review.
