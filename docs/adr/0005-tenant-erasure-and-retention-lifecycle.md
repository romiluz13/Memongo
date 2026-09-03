# Tenant erasure and the retention lifecycle

Every tenant-data surface gets one erasure primitive with receipts and a
surviving audit record, quarantined memories get a human review lifecycle with a
TTL, event retention propagates onto every derived document at write time with
read guards for TTL-monitor lag, and idempotency fingerprints get a retention
prune — retention is enforced by construction, not by hoping the TTL monitor
covers every collection.

## Context

DDD workstream WS-03 covers four lifecycle claims from the GLM-5.3 remediation
program. C-003: no bulk erasure existed anywhere — memories could only be
soft-invalidated one handle at a time, so every auxiliary collection retained
tenant data forever (a right-to-erasure liability the lifecycle review ranked
P0). C-004: poison-classified memories landed in a quarantine collection with no
review path, no TTL, and no surfacing, so classifier false positives were silent
permanent data loss. C-005: events expired on TTL while their embedded chunks
persisted forever — the retention policy silently failed on the primary
retrieval surface. C-006: idempotency fingerprints accumulated forever behind
their unique index.

Adversarial refutation reshaped two of the four. C-005 was refuted in round 1
with a decisive counterexample: the normal `MongoDBManagerWriteOps` path
correctly resolved and persisted `expiresAt` on the event, then reconstructed
the projection payload without it — so the (correct, pinned) chunks TTL index
never saw those chunks and no sweeper deleted them. Round 1 also found the
`$setOnInsert`-only projector could never backfill already-created chunks, the
outbox-repair path dropped expiry, conversation-window projection neither
excluded expired events nor stamped windows, bridge and direct chunk readers
returned expired chunks during TTL-monitor lag, and benchmark session-evidence
documents carried no expiry. All seven defect classes were fixed and pinned; the
round-2 refutation sustained the claim (186 pinning tests, 8 independent probes
on the real manager path, 7 vacuity mutations all caught). C-003 and C-004
sustained across their rounds; C-006 is T1 (mechanical) and validated by its
battery without an independent refuter.

## Considered Options

- **Erasure as one primitive with post-delete audit — chosen.**
  `deleteAllForAgent` sweeps every tenant-data collection in one call, returns
  per-collection deleted-count receipts with an overall status, and writes the
  critical-severity proof-of-erasure audit record AFTER the deletes so it
  survives the erase. A failed audit write surfaces on the receipt
  (`auditError`) and forces status `partial` — the receipt never claims more
  success than the durable evidence.
- **Erasure as soft-invalidation sweeps — rejected.** The pre-existing
  one-handle-at-a-time invalidation is agent-facing memory semantics, not an
  erasure mechanism; every cache, ledger, and telemetry row would still hold
  tenant data.
- **Quarantine review lifecycle with TTL on unreviewed entries — chosen.**
  List (oldest-first, status and limit filters, tenant-isolated), promote
  (through the consolidator's extraction path, with reviewer/reason/decidedAt
  decision metadata), reject (with an audit trail), surfaced through admin-only
  API routes, MCP admin tools, and the web console; a partial TTL index bounded
  by `quarantineRetentionDays` caps unreviewed accumulation so a never-reviewed
  queue cannot grow forever.
- **Count cap instead of TTL for quarantine — rejected.** A cap silently drops
  the oldest entries under load — the same silent-loss failure mode the claim
  exists to close — while a TTL bounds time-in-review, which is the actual
  review SLA dimension.
- **Retention propagation by construction plus read guards — chosen.** The
  resolved event expiry is stamped onto every document derived from that event
  at write time (single and batch manager writes, projector `$set` so
  re-projection self-heals chunks created expiry-less, outbox repair,
  conversation windows with max-expiry semantics and `$unset` when permanent,
  session-evidence documents), each on a collection with a `expireAfterSeconds: 0`
  partial TTL index; every chunk-reading surface (conversation search filter,
  bridge chunk filter, direct chunk readers, session-chunks vector lane)
  additionally composes an unexpired clause so expired chunks are hidden during
  the TTL monitor's lag window.
- **Sweeper deleting chunks whose source event is gone — rejected.** A sweeper
  is a second, schedulable, failure-prone process that must enumerate every
  chunk surface and races every writer; stamping the expiry the writer already
  resolved onto the document it already writes is the same information with no
  new moving parts. The claim allowed either; construction won on parts count.
- **Warning-only documentation — rejected.** The claim permits an explicit
  warning as a stopgap; with propagation actually wired, an honest description
  of the shipped behavior replaces the warning (the `ttl` config group's JSDoc
  documents the propagation surfaces).
- **Fingerprint retention as a field-level prune on canonical events —
  chosen.** Fingerprints ride on event documents (no separate collection), so
  retention is `$unset` of `idempotencyKey`/`idempotencyFingerprint` from events
  whose fingerprints predate the window, run behind an hourly gate on the write
  path and awaited in the worker drain, with the prune failure swallowed after
  logging so a retention hiccup cannot fail tenant writes.
- **Separate fingerprint collection with its own TTL index — rejected.** A new
  collection adds a second write per request and a cross-collection consistency
  problem for the unique-index dedup the fingerprints exist to serve; the prune
  keeps the dedup state where the dedup already lives.

## Consequences

- **Receipts report what was deleted, audit proves it happened.** The
  per-collection counts are the operator's confirmation; the audit record is
  the durable evidence that outlives the erase. A partial failure or failed
  audit is reported as partial, never as a clean success.
- **Admin surfaces are admin-only.** The erase and quarantine routes reject
  scoped and agent-scoped API keys; MCP admin tools require
  `MEMONGO_MCP_ADMIN=1`; the web console drives the admin routes. Irreversible
  and review operations are not reachable with tenant credentials.
- **Propagation is self-healing, not insert-only.** The projector moved expiry
  from `$setOnInsert` to `$set`: re-projecting an expiry-less chunk backfills
  it, and window re-projection heals in both directions (`$set` a later
  expiry, `$unset` when events are permanent). Immutable event ids keep the
  text insert-only; expiry deliberately does not share that freeze.
- **Windows inherit the max expiry of their events.** A window is only as
  permanent as its most-durable event, and expired events are excluded from
  window text on recompute. Residual bounded leak (accepted): a window chunk
  projected before its events expire retains the expired text until the
  window's own stamped expiry — TTL-bound and self-terminating, never
  unbounded.
- **Read guards fail closed.** The unexpired clause on every chunk-reading
  surface over-excludes during TTL-monitor lag (a recall risk bounded by
  seconds-to-a-minute monitor cadence), never leaks expired content.
- **Negative knowledge.** The session-chunks vector lane's
  `$or: [{expiresAt: null}, {expiresAt: {$gt: now}}]` pre-filter is correct
  under documented `$match` semantics (null matches missing), but its behavior
  inside `$vectorSearch` pre-filtering could not be validated against the
  stateful fake (strict equality) and needs one live-mongot check; any
  divergence over-excludes rather than leaks. `writeEventAndProject` (dead
  code, unreachable for expiring events today) does not carry the TTL handoff
  and would reintroduce the round-1 gap if it ever becomes reachable — the
  pinning batteries are the tripwire. Analytics counts may include expired
  rows during TTL lag (aggregate staleness, not content exposure).
