# 05 — Security, Tenancy & Access Control — Findings

Reviewer: independent deep review (category 05) of memongo at commit `1d98eb36f1`.
Method: code-only verification (no live MongoDB; reachability claims rest on code
reading), checklist from `/tmp/memongo-glm53-review/05-security-tenancy-access.md`,
external comparison against Zep, mem0/OpenMemory MCP, the MCP authorization spec,
and the OWASP Top 10 for LLM Applications. All paths below are repo-root relative.

## Executive summary

The tenant-isolation architecture is sound and consistently enforced for the
common case: one physical MongoDB set (single shared collection prefix from
`mongoCfg.collectionPrefix`, `packages/memory-engine/src/mongodb-manager.ts:482-630`)
with isolation done purely via `{agentId, scope, scopeRef}` filters, resolved by a
single shared resolver (`apps/api/src/scope-identity.ts`) used by both the auth
layer and the route layer, so the two cannot diverge. Auth is a constant-time
bearer comparison (SHA-256 digest + `timingSafeEqual`, `apps/api/src/app.ts:187`),
scoped keys fail closed on every escalation vector I could construct, and
NoSQL-operator injection is blocked at validation (`apps/api/src/routes/v1-write-routes.ts:47,144,293`).

Four real gaps survive that otherwise-clean record:

1. **The `kb:` locator in `readFile` is the one Mongo query with no tenant filter**
   — a cross-tenant read primitive, gated only by the route being admin-only
   (`packages/memory-engine/src/mongodb-manager-read.ts:390-400`).
2. **The MCP HTTP transport has zero client authentication**, and the
   routable-bind guard treats the *upstream* API key as the auth signal — the
   wrong side of the trust boundary (`apps/mcp/src/http-transport.ts:72-74`).
3. **The Pi coding-agent extension injects retrieved memories with no provenance
   labeling or untrusted-data envelope**, while the sibling `@memongo/tools`
   package has exactly that defense (#29) — solved in one surface, missing in the
   other (`packages/pi-extension/extensions/lifecycle.ts:150-190`).
4. **`/v1/write-structured` bypasses the injection classifier entirely**, so
   "instruction"-shaped poison can be written verbatim and later surface in
   context bundles and the Pi session-start injection
   (`apps/api/src/routes/v1-write-routes.ts:413`; `classifyInjection` is only
   called at `packages/memory-engine/src/mongodb-consolidator.ts:784` and in
   `mongodb-self-edit.ts`).

No P0 was found: no scoped-key escalation, no unauthenticated data path (outside
the explicitly-gated `MEMONGO_ALLOW_INSECURE_NO_AUTH` dev mode), no operator
injection, no unrestricted file read (import is root-confined to the agent
workspace + dataset roots, `packages/memory-engine/src/mongodb-manager.ts:1130-1143`).

## Checklist verification

| # | Item | Verdict | Evidence (highlights) |
|---|------|---------|----------------------|
| 1 | Tenant isolation in every Mongo query | **Pass with one exception (S-1)** | Memory/KB/events/profile/episodes/procedures/recall-traces/telemetry/query-cache all filter `agentId` and/or `scopeRef` (e.g. `mongodb-profile.ts:106`, `mongodb-recall-traces.ts:44`, `mongodb-query-cache.ts:190`, `mongodb-manager-admin.ts:242-250`). Exception: `kb:` locator in `readFile` (`mongodb-manager-read.ts:397`). Deployment-wide `stats` aggregations are intentionally unfiltered admin observability (`mongodb-analytics.ts:65-288`). |
| 2 | Auth middleware | **Pass** | `timingSafeBearerEquals` SHA-256 + `timingSafeEqual` (`app.ts:187,598-603`); no-auth mode is env-gated with a loud warning (`app.ts:540,658`); health/openapi intentionally open; every `/v1/*` path goes through the policy gate. |
| 3 | Scoped-key escalation | **Pass (fail-closed)** | `routePolicyError` (`app.ts:299-305`) — `search-kb` requires a concrete `scopeRefs` constraint; agent-global paths blocked for scope-constrained keys (`app.ts:389-430,638-639`); admin-only paths (read-file, import) blocked for ALL scoped keys (`app.ts:401`); `resolveScopeField` accepts trimmed strings only, so no `$or`/operator smuggling (`scope-identity.ts:68-85`); lifecycle-handle identity enforced (`v1-helpers.ts`). Omitting `agentId`/`scopeRef` when the policy constrains them returns 403, not a default-scope fallback. |
| 4 | Memory poisoning / prompt injection at render time | **Fail on two surfaces (S-3, S-4)** | Quarantine exists only at consolidation write (`mongodb-consolidator.ts:784` → `memory_quarantine`) and self-edit protected blocks (`mongodb-self-edit.ts:35-46`). Pi extension injects raw snippets (`lifecycle.ts:186`, `SNIPPET_MAX=200`); `/v1/write-structured` (`v1-write-routes.ts:413`) has no classifier call. |
| 5 | Secrets hygiene | **Pass with one leak (S-5)** | `packages/lib/src/redact.ts` is comprehensive (keys/tokens/passwords/Mongo URIs), used in session-files and error paths; logger has no default redaction but memory content is not logged — except the consolidator's 80-char value echo (`mongodb-consolidator.ts:931`). |
| 6 | MCP surface | **Fail for HTTP (S-2)** | stdio = local trust, acceptable. HTTP transport has no auth; `refuseToServeOpen(host, hasApiKey)` (`http-transport.ts:72-74`) checks the upstream key, which authenticates the API, not the MCP client. SSRF: `MEMONGO_API_URL` is operator-set env, not request input; `packages/lib/src/ssrf.ts` guards the embedding provider URL. |
| 7 | Input validation | **Pass** | `validateWithSchema` on structured/procedure/event bodies; P2.8 rejects operator-shaped metadata keys (`v1-write-routes.ts:47,144,293`); `bodyLimit` (`app.ts:578`); ISO-string `expiresAt` coerced and past-expiry rejected (`v1-write-routes.ts:419-431`). |
| 8 | Rate limiting / brute force | **Pass (single shared key caveat, S-7)** | Fixed-window limiter, 100k bucket cap (`app.ts:95`), keyed by credential/IP, applied to all `/v1/*`. Brute force on tokens is rate-limited and tokens are compared in constant time. |
| 9 | CORS + security headers | **Pass** | `secureHeaders()` (`app.ts:522`); CORS restricted to explicit `MEMONGO_CORS_ORIGINS` list (`app.ts:538-544`); no wildcard default. |
| 10 | Web console | **Pass** | Client-side only (`apps/web/app/console/page.tsx`); API key held in React state, never persisted; read/search only — no delete or destructive ops. |

## Findings (severity-ranked)

### S-1 (P1) — `kb:` locator read has no tenant filter: cross-tenant read primitive

**Evidence:** `packages/memory-engine/src/mongodb-manager-read.ts:390-400` — for
`relPath` starting `kb:` or `reference:`, the query is:

```ts
.findOne({ $or: [{ "source.path": kbPath }, { title: kbPath }] })
```

No `agentId`, no `scope`, no `scopeRef`. All agents share one `kbCollection`
(single config-level prefix, `mongodb-manager.ts:482-630`), so this is the only
read path in the engine that can return another tenant's document. Contrast
`mongodb-kb-search.ts:76-90`, where `scopeRef` is documented as "the tenant
isolation predicate" and always applied, and `mongodb-kb.ts`, where every write
records `{agentId, scope, scopeRef}`.

**Reachability:** the only caller is `/v1/read-file`
(`apps/api/src/routes/v1-context-routes.ts:147`), which is in
`ADMIN_ONLY_V1_PATHS` (`app.ts:401`) — blocked for ALL scoped keys, so a
scoped-key holder cannot reach it. Reachable by: (a) the single global admin key
— but global-key holders are admin-equivalent by definition; (b)
`MEMONGO_ALLOW_INSECURE_NO_AUTH` dev mode, where there is no auth anyway. So this
is not a scoped-key evasion; it is a violation of the otherwise-universal filter
invariant (checklist item 1 says any such query = cross-tenant leak) and a
landmine for any future route that reuses `readFile` with `kb:` paths.

**Fix:** resolve the tenant triple exactly like every other KB read (or route
`kb:` reads through `mongodb-kb-search.ts`'s filter set) and add a regression
test asserting a `kb:` read by agent A cannot see agent B's KB doc.

### S-2 (P1) — MCP HTTP transport: upstream API key mistaken for client auth

**Evidence:** `apps/mcp/src/http-transport.ts:60-74`:

```ts
// MCP HTTP transport has no auth of its own — it proxies to the API server
// via MemongoClient. The API key it uses authenticates upstream, but the
// MCP endpoint itself is open. Check the API key presence as the auth signal.
const hasApiKey = Boolean(process.env.MEMONGO_API_KEY)
refuseToServeOpen(host, hasApiKey)
```

The guard's own comment concedes the endpoint is open. `MEMONGO_API_KEY`
authenticates the MCP server *to the API*; it says nothing about who may talk to
the MCP server. A deployment that sets `MEMONGO_MCP_HTTP_HOST=0.0.0.0` (plus any
API key) passes the guard and exposes every MCP tool — search, write, self-edit,
KB — to the whole network as the global admin identity.

**Standards:** the MCP authorization spec (2025-06-18 and later revisions)
recommends OAuth 2.1 (RFC 9728 discovery, PKCE) for Streamable HTTP transports;
memongo's transport implements none of it. The spec's default posture for
non-local transports is "must authorize."

**Fix (minimum):** require a dedicated MCP-layer bearer token
(`MEMONGO_MCP_AUTH_TOKEN`-style env) before `refuseToServeOpen` will allow a
routable bind, and reject requests without it. **Fix (proper):** implement the
MCP spec's OAuth 2.1 resource-server flow for the HTTP transport.

### S-3 (P1) — Pi extension injects retrieved memories with no untrusted-data envelope

**Evidence:** `packages/pi-extension/extensions/lifecycle.ts:150-190`
(`renderSessionContext`) formats retrieved memories and profile items as:

```
## Memongo long-term memory (auto-injected at session start)
Profile (scope: global):
- preference: <key> — <value truncated to 200 chars>
Recent memories:
1. [<source>] <path> — <snippet truncated to 200 chars>
```

No provenance labeling, no sanitization, no delimiters — the snippets are
attacker-writable text (any client that can write memories in the searched
scope) rendered as if they were the agent's own context header. The contrast is
`packages/tools/src/memory-context.ts:13`, which has the #29 defense:
`<<<BEGIN_UNTRUSTED_MEMORY_CONTEXT>>>` / `<<<END_UNTRUSTED_MEMORY_CONTEXT>>>`
with an explicit preamble. The same defense exists in this codebase and is
simply not applied on the Pi surface.

**Aggravating default:** the Pi extension's one scope knob
(`MEMONGO_PI_MEMORY_SCOPE`) defaults to **`global`**
(`packages/pi-extension/extensions/index.ts:161,242,334,371`), and `global`
scope is writable by every agent in the deployment. So by default, agent X's
written memory is auto-injected, unlabeled, at agent Y's session start. The
single-user assumption is documented in the code comment, but nothing enforces
or warns about it at runtime.

**Fix:** port the #29 envelope (delimiters + preamble) from
`@memongo/tools` into `renderSessionContext` and the search-injection path; treat
`value`/`snippet` as data, never as context structure.

### S-4 (P2) — `/v1/write-structured` bypasses the injection classifier

**Evidence:** `apps/api/src/routes/v1-write-routes.ts:413-453` validates the
entry (schema, P2.8 operator-key rejection, expiry) and writes it, but
`classifyInjection` (`packages/memory-engine/src/mongodb-injection-classifier.ts`)
is never called — its only production call sites are the consolidator
(`mongodb-consolidator.ts:784`) and self-edit protected blocks
(`mongodb-self-edit.ts`). A caller (or a poisoned agent) can therefore write an
`instruction`- or `identity`-shaped structured entry verbatim; it then surfaces in
context bundles and the Pi session-start injection (S-3) unscreened. The
classifier is regex-tier only (tier-2 LLM is stubbed), so even the screened paths
are best-effort — but the write route skipping the screen entirely removes the
defense from the most direct poisoning channel.

**Fix:** run `classifyInjection` on `entry.value` in `/v1/write-structured` (at
minimum for `type: "instruction" | "identity"`) and either reject or route to
`memory_quarantine`, mirroring the consolidator's pre-write hook.

### S-5 (P2) — Consolidator logs unredacted memory content

**Evidence:** `packages/memory-engine/src/mongodb-consolidator.ts:931` —
`quality-filter: skipping derivable memory for event=<id>: "<match.value.slice(0, 80)>"`
at info level. Memory values are user/agent text and can contain secrets;
`packages/lib/src/redact.ts` is never applied on this path, and the logger has no
default redaction hook.

**Fix:** route the echoed value through `redact()` or drop it from the log line
(identifiers suffice).

### S-6 (P2) — KB read paths filter `scopeRef` only, never `agentId`

**Evidence:** `packages/memory-engine/src/mongodb-kb-search.ts:76-107` (search
always filters `scopeRef`, by documented design) and `mongodb-kb.ts` management
ops (list/remove/stats) likewise. For agent-scoped KB this is safe
(`scopeRef = agent:<id>` encodes the tenant); for `global` scope it means any
caller authorized for global-scope KB reads every agent's KB docs. That is the
intended shared-scope semantic, but it should be stated in the security docs, and
the S-1 locator shows the fragility of leaning on `scopeRef` alone.

### S-7 (P3) — Single global key: no rotation, no per-credential audit, shared rate budget

The common deployment is one global admin key held by every client. Consequences:
(a) access events (`mongodb-access-tracker.ts`) record `agentId` but not which
credential performed the read — "who read whose memories" is not answerable;
(b) the rate limiter is per-credential, so all tenants share one bucket (no
per-tenant fairness/quota, and embedding-cost consumption per search is bounded
only by that shared limit — a denial-of-wallet consideration); (c) no rotation
story for the root key. Scoped keys mitigate all three when used, but nothing
pushes deployments toward them.

## Positives worth keeping (verified, not assumed)

- Constant-time bearer auth, both global and scoped tokens (`app.ts:187,598-603`).
- Scoped-key policy is fail-closed everywhere I probed: omitted `agentId` when
  constrained → 403; scope-constrained keys blocked from agent-global routes
  (`app.ts:638-639`); all scoped keys blocked from admin routes (`app.ts:401`);
  `search-kb` demands a concrete `scopeRefs` constraint (`app.ts:304`).
- Scope resolution shared between auth and routes (`scope-identity.ts`), so the
  enforced identity cannot diverge from the query identity.
- Cross-scope event access returns 404 `EVENT_NOT_FOUND`, not a leaky error
  (`v1-write-routes.ts:406-412`).
- Self-edit screens the *final merged* value for persona/instructions, defeating
  split-smuggling across append/prepend calls (`mongodb-self-edit.ts:35-46`).
- Import is root-confined: `allowedRoots = [workspaceDir, MEMONGO_DATASET_ROOT, MEMONGO_DATASET_ROOTS]`
  with `workspaceDir` defaulting to `~/.memongo/agents/<safe-segment>`
  (`mongodb-manager.ts:1130-1143`, `agent-config.ts:50-70`) — not the
  unrestricted read I initially suspected.
- `secureHeaders`, explicit-origin CORS, body limit, 100k-bucket-capped rate
  limiter (`app.ts:95,522,538-544,578`).
- The #29 quarantine envelope in `@memongo/tools` is well-designed — it just
  needs to be applied on the Pi surface too (S-3).

## Unknown unknowns (beyond the checklist)

1. **No per-credential read audit.** The AccessTracker answers "which memories
   were read," not "which client read them." In a shared-global-key deployment,
   post-incident attribution of reads is impossible.
2. **Tier-1 classifier is trivially bypassable.** Eight frozen regexes
   (`mongodb-injection-classifier.ts`) catch canonical phrasings; paraphrased or
   non-English injections pass. The quarantine is a tripwire, not a wall — worth
   saying out loud in the docs so users don't over-trust it.
3. **Global-scope blast radius is undocumented at runtime.** The Pi extension
   defaults every write and search to `global` scope
   (`extensions/index.ts:161-371`); cross-agent poisoning within one deployment
   is by-design-shared, and only a code comment says so.
4. **Denial-of-wallet.** Every search triggers query embedding; scoped keys have
   no cost quota beyond the shared rate limit (see S-7).
5. **`stats` observability is deployment-wide.** Unfiltered counts and
   cross-tenant stale-file *paths* (not contents) are returned by the analytics
  aggregations (`mongodb-analytics.ts:65-135`) — fine for admin-only, worth
   confirming the route classification stays admin-only.

## Competitor comparison

| Capability | memongo | Zep | mem0 / OpenMemory MCP |
|---|---|---|---|
| Key model | Global admin key + scoped keys (agentIds/scopes/scopeRefs constraints, route classes) | API keys with **ABAC policy sets** — endpoint-level and graph-data-level least privilege (help.getzep.com/policy-based-access-control) | Project-scoped platform API keys; OpenMemory is local-first/self-hosted |
| Per-user/agent isolation | `agentId`/`scope`/`scopeRef` on every query (one gap: S-1) | Graph-level policies per key | Per-user memory via user IDs (client-supplied `user_id`); OpenMemory keeps memory user-owned and local |
| Default sharing posture | Pi extension defaults to **shared `global` scope** | Least-privilege policies attached to keys | Per-user isolation by default |
| MCP transport auth | Streamable HTTP with **no client auth** (S-2) | UserGroup-scoped Memory MCP access | Local-first stdio focus; remote MCP guidance follows OAuth 2.1 |
| Injection defenses | Tier-1 regex quarantine at consolidation + self-edit; envelope in `@memongo/tools` only (S-3/S-4) | Not published in comparable detail | Not published in comparable detail |
| Bind guard | `refuseToServeOpen` shared pattern with mongodb-partners/agent-memory — but auth signal is wrong-sided for MCP (S-2) | n/a | n/a |

**Takeaways:** Zep's ABAC shows the endpoint-granular direction memongo's route
classes are reaching toward (search-kb's forced `scopeRefs` constraint is already
ABAC-shaped); mem0's per-user default is the opposite of memongo's Pi-extension
`global` default and is the safer posture for anything multi-user; the MCP spec's
OAuth 2.1 recommendation makes S-2 a spec-compliance issue, not just a hardening
nice-to-have.

## External standards alignment (OWASP Top 10 for LLM Applications, 2025)

| OWASP item | memongo posture |
|---|---|
| LLM01 Prompt Injection | Partial: quarantine at write-time (consolidator, self-edit), envelope in `@memongo/tools` — but raw injection at Pi session start (S-3) and unscreened write channel (S-4) |
| LLM02 Sensitive Info Disclosure | Good redaction library; one log leak (S-5); no per-credential read audit (unknown #1) |
| LLM04 Data & Model Poisoning / LLM08 Vector & Embedding Weaknesses | Memory poisoning partially screened (regex-only, tier-2 stubbed); S-4 is an open poisoning channel |
| LLM06 Excessive Agency | MCP network exposure under admin identity (S-2); no cost quotas for scoped keys (S-7) |
| LLM10 Unbounded Consumption | Rate limiter present (default window, 100k bucket cap); embedding spend per search unbounded within it |

## Prioritized recommendations

**P1 (fix before any network-facing or multi-agent deployment)**
1. S-1: add `{agentId, scope, scopeRef}` filters to the `kb:` locator query in
   `readFile` (`mongodb-manager-read.ts:390-400`) + regression test.
2. S-2: require a dedicated MCP-layer credential for non-loopback MCP HTTP bind
   (or implement MCP-spec OAuth 2.1); never treat upstream `MEMONGO_API_KEY`
   presence as caller authentication (`http-transport.ts:60-74`).
3. S-3: port the #29 `<<<BEGIN_UNTRUSTED_MEMORY_CONTEXT>>>` envelope + preamble
   from `packages/tools/src/memory-context.ts` into
   `packages/pi-extension/extensions/lifecycle.ts:150-190` and the search
   injection path; flip the Pi default scope from `global` to `agent` (or at
   minimum warn at startup when `global` is active).

**P2**
4. S-4: run `classifyInjection` on `/v1/write-structured` entries (at minimum
   `instruction`/`identity` types); reject or quarantine injection-likely values.
5. S-5: redact (or drop) the memory-value echo in the consolidator's
   quality-filter log line (`mongodb-consolidator.ts:931`).
6. S-6: document the shared-global KB read semantic; consider an `agentId` filter
   for agent-scoped KB management ops as defense-in-depth.
7. Unknown #1: record the authenticated credential identity on access events
   (per-credential read audit).

**P3**
8. S-7: per-tenant rate/cost quotas for scoped keys; key-rotation guidance for
   the global key.
9. State the tier-1 classifier's limits in the security docs (tripwire, not wall).

## Unverified items / assumptions

- No live MongoDB was run; all reachability claims (including S-1's admin-only
  gating and the scoped-key 403 paths) are from code reading, not executed PoCs.
- The per-aggregation audit covered the main memory/KB/events/profile/episodes/
  procedures/recall/telemetry/query-cache/admin paths; the long tail of
  discovery-projection and relevance modules was sampled, not exhaustively
  line-checked. The `kb:` locator is the only unfiltered *content* read found;
  `mongodb-analytics.ts` unfiltered aggregations are counts/index metadata on
  admin-only observability routes.
- apps/web was reviewed at the console-page level (key handling, capability
  set), not a full Next.js build-output audit for embedded secrets.
- External comparisons (Zep ABAC, mem0 OpenMemory per-user model, MCP OAuth 2.1
  guidance) are from public docs/blogs retrieved during this review, not from
  auditing those products' source.
