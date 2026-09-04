# Deployment-safe defaults: shared client, bounded manager cache, 30-second sweep

The shared-client runtime becomes the default for every MongoDB memory
deployment (one client and one bounded pool per URI, with an explicit
`MEMONGO_SHARED_CLIENT` opt-out), the manager cache is bounded
unconditionally (LRU cap plus idle eviction in every mode), and the
standing memory-job interval becomes a 30-second sweep in every mode
instead of the legacy per-manager 1 Hz poll. The bounded-pool and
quiescence machinery already existed behind a flag; the defect being
corrected is that the unsafe legacy behavior was the default.

## Context

DDD workstream WS-06 covers C-009 from the GLM-5.3 remediation program's
performance/scale/cost review (EL-009). The repository already contained
the safe machinery, added in an earlier hardening pass: a shared
MongoClient registry keyed by URI, a bounded manager cache (LRU eviction
at the cap, idle eviction at the TTL, a 60-second sweep timer), and a
wake-on-write memory-job worker whose standing interval could drop from a
1-second poll to a 30-second backstop sweep. All of it was gated behind
`MEMONGO_SHARED_CLIENT`, which defaulted OFF.

The default was the hazard. A default-mode deployment (the configuration
every new install gets without reading anything) spawned one connection
pool per agent — `maxPoolSize` 10 by default — plus a 1 Hz claim poll per
live manager. An M10 Atlas node carries a 1,500-connection budget, so
roughly 150 agents exhausted it: connect storms, evictions under
connection pressure, and per-manager polling traffic that scaled linearly
with agent count with no ceiling. EL-009's recommendation was that the
safe mode should simply be the default; the machinery existed and only
the default was wrong.

Adversarial refutation ran three rounds and reshaped the change's
documentation and one warning path. Round 1 returned partially refuted:
the default flip and its escape hatch were documented nowhere a deployer
would look (fixed: README env table and deployment-defaults paragraph,
self-host connection-budget paragraph, CHANGELOG upgrade note); the
registry's first-resolved-options semantics silently discarded later
agents' divergent pool options (fixed: the first acquirer's options are
snapshotted and later divergent acquires warn, listing diverging option
key names only, URI as the redaction alias); a new backend-config test
was decorative — it pinned unchanged defaults and would pass under a
full revert (fixed: renamed with an honest comment scoping it to the
budget half of the claim); a stale comment and dead import contradicted
the new behavior; and the opt-out mode's idle-eviction re-bootstrap cost
was undocumented (folded into all three docs). Round 2 sustained the
claim with two low findings, both fixed: the docs overstated that "agent
count no longer multiplies connections or poll traffic" (reworded:
connections are fixed per URI and standing poll traffic is capped by the
bounded cache at ≤50 sweeps per 30 s — each live cached manager still
runs one 30-second timer), and the divergence warning re-fired on every
post-eviction re-init of a divergent config (fixed: deduped once per
diverging-key signature per registered client). Round 3 sustained with
zero findings.

## Considered Options

**Keep the flag default off and document the risk.** Rejected: defaults
are the configuration most deployments run; a documented hazard that is
still the default remains the hazard. C-009 is a MUST on defaults, not on
availability.

**Remove the legacy path entirely.** Rejected: deployments that rely on
per-manager client isolation (per-agent pool tuning honored per manager)
have a legitimate use for it, and the bounded cache now applies in that
mode too, so the legacy path is no longer unbounded. Deleting it would be
a breaking change outside C-009's scope.

**Flip the default, bound the cache in every mode, keep the opt-out.**
Chosen. The flag inverts: the shared-client runtime is on unless
`MEMONGO_SHARED_CLIENT` is explicitly `0`/`false`/`no`/`off` (empty and
unrecognized values keep the safe default), `cacheManager`'s LRU cap,
recency refresh, idle eviction, and sweep timer lose their mode gates, and
`resolveMemoryJobSweepMs` returns the 30-second sweep unconditionally
(`MEMONGO_JOB_SWEEP_MS` still overrides) with the legacy
`MEMORY_JOB_POLL_MS` constant deleted.

## Decisions

1. **Shared-client runtime is the default; the opt-out is explicit.**
   `isSharedMongoClientEnabled` returns true unless the env var carries an
   explicit falsy token (`0`, `false`, `no`, `off`). Empty and unrecognized
   values keep the safe default rather than silently restoring the
   unsafe one.

2. **The manager cache is bounded in every mode.** LRU cap
   (`MEMONGO_MANAGER_CACHE_MAX`, default 50), recency refresh on access,
   idle eviction (`MEMONGO_MANAGER_CACHE_IDLE_TTL_MS`, default 10
   minutes), and the 60-second sweep timer run with no mode gate. In
   opt-out mode an idle agent re-bootstraps its manager and reconnects
   after the TTL — documented as the opt-out's cost.

3. **The standing job interval is a 30-second sweep in every mode.**
   Writes still wake the worker immediately; the interval is the backstop
   for missed wakes and expired leases. No 1 Hz poll survives anywhere in
   the worker path (the lease heartbeat is 20 seconds and only runs while
   a job is actively claimed).

4. **The pool budget is per URI.** `maxPoolSize` 10 / `minPoolSize` 2
   defaults bound total driver connections regardless of agent count in
   default mode. The registry keys by URI, so the first agent to connect
   fixes the pool options for that URI; later divergent acquires get a
   warning (diverging option key names only — values never enter logs,
   URI as the C-002 alias), deduped once per diverging-key signature so
   post-eviction re-inits stay quiet.

5. **Migration is documented at every deployer surface.** README env
   table, `docs/platform/self-host.md` connection-budget paragraph, and a
   CHANGELOG upgrade note state the new defaults, the escape hatch, the
   opt-out's re-bootstrap cost, and the first-resolved-options rule, with
   wording that does not overstate: connections are fixed per URI and
   standing poll traffic is capped by the bounded cache (≤50 sweeps per
   30 s), not eliminated per agent.

## Consequences

A default deployment now holds one bounded pool per MongoDB URI and a
hard ceiling on standing memory-job traffic (~1.7 sweeps/second at the
LRU-50 cap) regardless of agent count, so the ~150-agent M10 connection
exhaustion cannot recur in default mode. Deployments needing per-manager
isolation must set `MEMONGO_SHARED_CLIENT` explicitly and accept the
re-bootstrap cost after idle TTLs; their pool settings are again honored
per manager instead of per URI. Per-agent pool tuning in default mode is
deliberately not honored beyond the first acquirer per URI — the warning
makes that visible instead of silent. The droid-wiki pages describe the
pre-flip flag semantics until the next CI wiki refresh. Validation:
V-062 (unconditional cache bounding, both default and opt-out modes),
V-063 (default-on registry, divergence warning, cross-package suites),
V-064 (pool-budget defaults, workspace type-check); refutation
sustained across three independent rounds (`.ddd/reports/refutation-c-009.yaml`).
