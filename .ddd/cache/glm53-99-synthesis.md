# 99 — Synthesis: Cross-Category Unknown Unknowns, Systemic Risks, Ranked Recommendations

Meta-review across the ten category reports (01–10) of the GLM-5.3 full-framework review of memongo.
All category claims were verified against executing source at commit `1d98eb36f1` (main, clean tree);
citations below are repo-root relative and inherited from the category reports, each of which
re-verified its own anchors. Severity counts are each file's own headline labels.

## 1. Findings inventory

| Cat | Focus | P0 | P1 | P2 | P3 | Headline |
|-----|-------|----|----|----|----|----------|
| 01 | Core memory model & schema | 2 | 5 | 4 | — | Quarantine is an orphan sink; TTL orphans chunks; chunk projection lacks bitemporal invalidation |
| 02 | Embedding & vector pipeline | 1 | 2 | 4 | 4 | Entire product depends on MongoDB `autoEmbed` **Preview** with zero fallback |
| 03 | Retrieval & search quality | 0 | 3 | 7 | — | `lucene.standard` everywhere, rerank silent-skip, no query rewriting; eval harness is best-in-class |
| 04 | Lifecycle, consolidation, decay | 1 | 3 | 3 | — | No tenant/agent-level erasure exists; consolidation is dead code for API-only deployments |
| 05 | Security, tenancy, access | 0 | 3 | 3 | 1 | `kb:` locator is the only unscoped query; MCP HTTP zero client auth; injection classifier bypassable |
| 06 | API surface & client contracts | 1 | 5 | 7 | — | MCP HTTP transport is an open proxy; client retries non-idempotent mutations; search-detailed is the last unvalidated boundary |
| 07 | MongoDB operations & resilience | 1 | 1 | 4 | 5 | Raw URI with credentials can hit logs; change-stream watcher dies permanently after 3 re-opens |
| 08 | Observability, testing & QA | 1 | 6 | 6 | — | CI never runs 27 existing API tests; redaction utility wired to zero production paths; nightly gate green with suites skipped |
| 09 | Performance, scale & cost | 1 | 5 | 4 | — | Default mode = unbounded connection + 1 Hz polling per agent; token usage discarded at every transport |
| 10 | Integration, DX & deployment | 1 | 4 | 6 | — | MCP HTTP endpoint completely unauthenticated; pi-extension one-shot sticky probe; quarantine not applied on pi path |
| **Total** | | **9** | **37** | **44** | **10** | 100 findings/recommendations |

Process note: category files 06 and 07 were regenerated near the end of the review after a
wrong-model session overwrote them; both regenerations re-verified every citation anchor against
source before rewriting, and the restored files are the ones tallied here.

## 2. The nine P0s (one line each)

1. **MCP HTTP transport is an open proxy** — `refuseToServeOpen` treats upstream `MEMONGO_API_KEY` presence as endpoint auth; unauthenticated `/mcp` proxies authenticated reads/writes to anyone with network reach (`apps/mcp/src/http-transport.ts:69-73`). [06, 10, 05 — found independently three times]
2. **Raw MongoDB URI with credentials can be written to logs** — registry interpolates the unredacted key into a close-failure warning; the subsystem logger applies no redaction (`packages/memory-engine/src/mongodb-client-registry.ts:119`, `packages/lib/src/logger.ts:83-96`). [07]
3. **No tenant/agent-level erasure exists anywhere** — memories can only be soft-invalidated one handle at a time; events, chunks, episodes, revisions, jobs, traces and telemetry are never bulk-deletable. [04]
4. **Quarantine is an orphan sink** — poison-classified memories land in a collection with no review path, no TTL, no surfacing: silently lost forever. [01]
5. **TTL asymmetry orphans chunks** — events expire but their embedded chunks persist, so retention policy silently fails on the primary retrieval surface. [01]
6. **Entire vector pipeline depends on `autoEmbed` Preview** — a Preview feature MongoDB can change or retire, with a warn-and-continue deprecation path and zero fallback. [02]
7. **Default deployment mode is a scaling trap** — one connection pool per agent plus 1 Hz polling per manager by default; ~150 agents exhaust an M10's connections. [09]
8. **CI never runs 27 existing, passing API tests** — including the OpenAPI drift guard; 203 test cases dead in CI; nightly E2E gate reports green with all suites skipped. [08]
9. **pi/MCP-facing memory injection is unguarded on part of the surface** — quarantine envelope exists but is not applied on the pi path; `write-structured` bypasses the injection classifier. [10, 05]

## 3. Cross-category unknown unknowns (emergent patterns no single category saw)

**UU-S1 — The codebase already contains the fixes for its own P0s, unwired.**
A redaction utility exists and is tested but wired to zero production paths (08) while raw URIs hit logs (07 P0). A quarantine envelope exists (01, 05) but is not applied on the pi path (10). The client sends `x-memongo-client-version` on every request and no server code ever reads it (06). Fast-check property generators run but assert nothing binding (08). A 1,600-line client-side embedding provider stack is dead code (02). `buildOrJoinFtsQuery` is dead (03). No single reviewer could see this: each found one instance. The pattern says the remediation for this class is *wiring work, not new code* — and that "tested in isolation" defenses create false confidence while being unreachable in production.

**UU-S2 — Degradation is invisible by construction, at every layer.**
Silent-mode reads degrade 401/403 to "empty memory" (06 U2). Rate-limit throttling surfaces as "no memories found" (09). Rerank silently skips with no telemetry (03). The nightly E2E gate reports green with every suite skipped (08). Non-strict mode serves while search indexes are still building (07). Chain-trace fabricates `chainComplete: true` for an invalid collection name (06 B5). Guardrails fail open (02 U6). The repo's own tripwire philosophy (`403b62575d feat(guardrails): add silent-failure tripwires`) does not reach these paths. An operator cannot distinguish healthy from degraded without opening MongoDB by hand — and an agent cannot distinguish "no relevant memory" from "memory system broken", which is the worse failure for a memory product.

**UU-S3 — Nothing in the system ever forgets, at any layer.**
No erasure primitive (04 P0). Event TTL orphans chunks (01 P0). Quarantine has no TTL and no review path (01 P0). Episodes grow unbounded (04 U3). Idempotency fingerprints are stored forever behind a unique index (06 U1). Recall traces and telemetry carry raw memory values with no retention policy (04, 08). The manager cache is unbounded (07 Bug 5). Default mode spawns a connection per agent forever (09 P0). The irony is the point: a long-term *memory* product shipped without a *forgetting* story. Forgetting is a product feature (decay exists) that was never connected to a data-lifecycle story (nothing is ever actually deleted).

**UU-S4 — Every capability is verified once at boot and never again.**
Index readiness is a one-shot boot probe with no runtime re-poll (07 UU-2). `/ready`'s vector lane is a boot snapshot that keeps routing traffic to a broken search lane (08 U9). The pi-extension's availability probe is one-shot with a sticky cached failure (10 B2). And the deepest version: the vector pipeline itself rests on `autoEmbed` Preview (02 P0) whose deprecation path is warn-and-continue. The system's model of its own capabilities is always stale, and every staleness failure presents as UU-S2 (invisible degradation).

**UU-S5 — Money and trust are both unmeasured end-to-end.**
Token usage is discarded at every LLM transport (09 P1). Indexing-time embedding spend — the dominant cost — is uncounted (02 U2). There is no per-request or process-level budget and no admission control (09). No cost telemetry exists anywhere (08). Telemetry itself is written to an island with no sampling, no kill switch, no OTel export (08 U1/U8). Meanwhile the trust paths have asymmetric holes: revision-CAS is best-in-class (04), yet client retries can double-apply lifecycle mutations and increment outcome counters twice (06 B2), and app-level double-submits are not deduped at all (06 U1). Denial-of-wallet is as reachable as denial-of-service, and neither is observable.

## 4. Systemic risks (ranked)

1. **Unauthenticated MCP HTTP transport = network-reachable proxy to authenticated memory.** Found independently by 06, 10, and 05 — the strongest cross-category signal in the review. Compounded by no `Origin` header validation (DNS-rebinding exposure per the MCP spec) and a 500 handler that echoes raw `err.message` (`apps/mcp/src/http-transport.ts:69-93`).
2. **Secret and sensitive-data disclosure through logs.** Raw URI at rest in the registry and emitted on close failure (07); raw query strings logged (08); memory-value echo in consolidator logs (05 S-5); MCP transport error leak (06). All while a redaction utility sits unused (08) — see UU-S1.
3. **No data lifecycle: erasure, retention, and bounding absent system-wide.** UU-S3 above; compliance liability (GDPR right-to-erasure) plus operational liability (unbounded collections, unbounded connections).
4. **Single-vendor Preview dependency at the product's core.** `autoEmbed` Preview (02) with the model literal `"voyage-4-large"` duplicated across 9 production sites; a vendor deprecation notice is a production incident.
5. **Default deployment cannot scale and cannot be seen failing.** Connection/polling explosion defaults (09 P0) plus the observability island (08) plus UU-S2: the failure mode of the default deployment is invisible saturation.
6. **Stale capability snapshots.** UU-S4: one-shot probes across 07, 08, 10; Preview dependency (02).
7. **Hand-maintained contract surfaces drift silently.** Six drifts across the API/client/MCP/tools quadrilateral (06); the env-var family split `MEMONGO_LLM_*` vs `MEMONGO_ENRICHMENT_*` (10); declared schema fields never populated (01); no deprecation mechanism on any surface (06 U5).

## 5. Ranked recommendations

### P0 — before any network-facing or multi-agent deployment

1. **Close the MCP HTTP transport hole** (06 B1, 10, 05): require per-request auth on `/mcp` (independent of upstream `MEMONGO_API_KEY`), validate `Origin`/`Host` per the MCP spec, redact the 500 fallback. Highest leverage single change in the review.
2. **Redact secrets at the logging boundary** (07 Bug 1): wire the existing redaction utility into the subsystem logger; store a redacted alias on registry entries so no future diagnostic can emit the raw key. The fix already exists (UU-S1) — this is wiring.
3. **Build erasure primitives** (04 R1): `deleteAllForAgent(agentId, scope?)` across every collection (events, chunks, structured + revisions, entities, relations, episodes, jobs, ledgers, coverage, cache, traces, telemetry) with per-collection receipts and an audit record; propagate event TTL to chunks (01); TTL the quarantine collection with a review path (01); retention policy for idempotency fingerprints (06 U1). mem0 ships `delete_all` as table stakes.
4. **De-risk `autoEmbed` Preview** (02): abstract the embed step behind an interface, add a fallback path or a tested migration plan, centralize the `"voyage-4-large"` literal to one configuration point.
5. **Change deployment defaults** (09 R1): shared client + bounded pool + backoff polling as the default mode; the machinery exists, only the default is wrong.
6. **Wire CI to run what already exists** (08): run the 27 API tests and the OpenAPI drift guard in CI; fail the nightly gate when suites are skipped rather than reporting green.

### P1 — correctness, cost, and trust

7. **Stop retrying non-idempotent mutations** (06 B2): restrict client retries to requests carrying an `Idempotency-Key`, or give lifecycle update/delete, feedback, procedure-outcome, self-edit, and extract server-side revision-CAS idempotency.
8. **Validate `/v1/search-detailed` nested objects** (06 B3): the last unvalidated boundary on an otherwise strictly validated API; mirror `kbFilterSchema` strictness for the five type-cast objects and the `timeRange` casts.
9. **Runtime capability re-verification** (07 UU-2, 08 U9, 10 B2): re-probe index readiness on search-lane failure and surface it in status; make `/ready`'s vector lane live; retry the pi-extension availability probe.
10. **Cost observability** (09, 02, 08): capture token usage at every transport, count embedding spend at indexing time, add sampling and a kill switch to telemetry.
11. **Make degradation visible** (06 U2, 09, 03, 06 B5): distinguish 401/403 from empty in silent mode; report throttling as throttling; emit rerank-skip telemetry; return 400 from chain-trace for unknown collections.
12. **Scope the `kb:` locator to the tenant** (05 S-1): the only MongoDB query without an agentId/scope filter is a cross-tenant read.
13. **Schedule consolidation** (04 R2): the decay/dedupe/contradiction half of the lifecycle is dead code for API-only deployments; add the job type or an interval trigger.

### P2 — quality and hygiene

14. **Single-source the contract schemas** across API/client/MCP/tools plus a deprecation protocol (06): resolve the `mode` and `write-structured type` drifts, expose `customId`/`metadata`/`expiresAt` in the tools package, add OpenAPI `deprecated` flags.
15. **Bounded-growth pass**: manager cache bound (07 Bug 5), episode cap/coalesce (04 R4), query-length clamp (03), pagination continuation on list routes (06 U3).
16. **Contract ergonomics**: opaque server-issued lifecycle handles instead of fat structured objects the LLM must echo verbatim (06 U4); an unauthenticated counters-only `/healthz` so probes work during incidents (06).
17. **Eval expansion** (03): query rewriting, diversity control, rerank-skip telemetry folded into the eval harness.
18. **Wire the written-but-dead defenses** (UU-S1 as its own workstream): redaction utility (08), quarantine envelope on the pi path (10), version-skew header (06), fast-check assertions (08), retire the dead provider stack (02) and `buildOrJoinFtsQuery` (03).

## 6. What the review validated as strengths (ahead of the competitor set)

- **Eval harness is best-in-class**: SHA-256-pinned LongMemEval/LOCOMO contracts, threshold-gated; no competitor in the comparison ships anything comparable (03).
- **Revision-CAS update semantics** are stronger than mem0's (04).
- **Durable extraction outbox** with write latency excluding LLM inference — ahead of mem0 and graphiti (04, 09).
- **Stripe-style idempotent event writes** (header-first, fingerprint, replay receipt, 422) — mem0 has none (06).
- **Tenant isolation is architecturally sound** and fails closed on escalation vectors (05).
- **Index drift repair** is ahead of agent-memory (07).
- **OpenAPI conformance is tested against the live route table** — rare even in mature APIs (06).
- **No offset-pagination footguns**; caps are tight everywhere (03, 06, 09).

## 7. Method and verification status

Ten independent reviewers, one per category, each code-only (FIRST RULE: no docs, wikis, ADRs,
READMEs, benchmark logs, or prior reviews), each doing its own external-docs research and
competitor comparison (mem0, mongodb-partners/agent-memory, graphiti, zep partially; letta
excluded per its own repository policy). Every citation anchor was verified against the working
tree at `1d98eb36f1`. Not verified anywhere in the review: runtime MongoDB query evaluation of
operator-shaped keys passed through `search-detailed` (06 B3 states the contract inconsistency,
not a proven injection), end-to-end load behavior of the rate limiter (06), and any live-MongoDB
reachability claims (05, which relied on code reading).

The single deepest takeaway: **memongo's engineering quality is high where code was written, and
the failures cluster where code was written but never connected** — defenses unwired, degradation
unreported, forgetting unimplemented, capabilities unverified after boot, costs uncounted. The
remediation program is therefore mostly integration and lifecycle work, not re-architecture.
