# Prompt-injection defense: envelope scope, write-gate placement, and 202 hold dispositions

The untrusted-memory quarantine envelope renders stored memory as
provenance-labeled untrusted text on the pi extension's session context and
search injection points, `classifyInjection` gates every write-structured
entry behind a single engine seam with human review as the only overrule,
and a held write answers with an accepted 202 disposition — never a silent
success and never a 500 — while the pi default memory scope stops being
global. The AI-SDK tools' and MCP's raw retrieval payloads are deliberately
out of this decision's scope and tracked as claim C-040.

## Context

DDD workstream WS-05 covers C-008 from the GLM-5.3 remediation program's
security review (EL-005, corroborated by EL-010). The repository already had
a forgery-proof quarantine envelope (`renderMemoryContextBlock`, the #29
retrieval injection defense) wired into the AI-SDK adapters' session-context
render, but the sibling pi extension rendered raw profile and memory text as
trusted session context and returned raw `memongo_search` results;
`/v1/write-structured` (and the self-edit, lifecycle-update, and
memory-feedback surfaces built on the same writer) bypassed the injection
classifier entirely, so injection-shaped entries reached canonical memory
with no review; and the pi extension defaulted its memory scope to global,
so one project's memory auto-injected into every other project's sessions.

Adversarial refutation ran three rounds and reshaped both the claim and the
details. Round 1 returned partially refuted: the claim's sources under-cited
its obligations (repaired to EL-005#S-3/S-4), the transactional self-edit
branch discarded the quarantine disposition (fixed, with a regression pair),
`/v1/memory/feedback` answered a held correct-patch with 500 (fixed to the
202 disposition), and the response contracts omitted the new disposition
fields (widened across client, engine, and bridge). Round 2 returned
partially refuted again: the claim's "every injection surface" preamble
overstated its evidence — the AI-SDK tools' and MCP's retrieval payloads are
raw model-visible surfaces, but the evidence obligates exactly the pi
surfaces and cites the tools renderer as the porting source — so the claim
was narrowed to its enumerated obligations and the uncovered surfaces were
filed as C-040 rather than silently absorbed or dropped; the pending-row
dedup conflated scopes (fixed with a scope-keyed filter); and the client's
lifecycle/feedback methods promised only the item shape (fixed with a
disposition intersection). Round 3 sustained: no caller can turn a held
write into a false success, the narrowed claim is faithful to its evidence,
and every suite is green.

## Considered Options

- **Port the existing #29 envelope into the pi surfaces — chosen.** The pi
  extension's `renderSessionContext` and `memongo_search` results wrap their
  rendered memory in `renderMemoryContextBlock`, imported from a new
  `./memory-context` subpath export of `@memongo/tools` so the published
  pi-extension package (which cannot depend on the private `@memongo/lib`)
  shares the one tested renderer with the vercel/openai adapters instead of
  growing a local copy.
- **A pi-local envelope copy — rejected.** The extension's diagnostic
  classifier precedent shows local mirrors drift (WS-02 needed a parity
  repair for exactly this shape); one renderer, three consumers, one test
  battery.
- **Envelope every tools/MCP retrieval payload inside this workstream —
  rejected.** No locked evidence obligates it: EL-005#S-3 names the pi
  surfaces and cites the tools renderer as the existing defense being
  ported. Expanding silently would have made the claim green by redefining
  it; the honest move is the narrowed claim plus C-040 tracking the real
  gap (memongo_search, search_kb, profile, build_context_bundle,
  recall_conversation, and MCP's raw serialization) as future work.
- **Classify inside `writeStructuredMemory` with an explicit skip overrule —
  chosen.** The gate runs the frozen tier-1 `classifyInjection` over the
  joined key/value/context free text at the single engine seam every writer
  funnels through (API routes, bridge, SDK tools, MCP, pi save, self-edit,
  feedback), routing injection-likely entries to `memory_quarantine`
  (pending-review) with canonical `structured_mem` untouched. The only
  bypass is `injectionClassification: "skip"`, passed solely by
  `promoteQuarantined` after a completed human review — the overrule cannot
  loop back into quarantine.
- **Classify at each API route — rejected.** The engine seam is the only
  place every writer (including future ones) is forced through; route-level
  gates multiply surfaces and miss the engine-internal callers.
- **Classify on read/render instead of write — rejected.** Read-side
  labeling is the envelope's job (provenance), not classification; poison
  that never enters canonical memory needs no read-side defense, and
  review-then-promote is the only path past the gate.
- **202 accepted disposition for held writes — chosen.** A held write is
  not an error: the write was received, routed to the review queue, and is
  recoverable by a human. Every write surface answers
  `{quarantined: true, quarantineId|id, matchedPatterns}` with HTTP 202
  (documented per route in the OpenAPI path files), and the client carries
  the fields via `MemongoSelfEditResponse` and the
  `MemongoQuarantineDisposition` intersection on `updateLifecycleItem` /
  `applyMemoryFeedback` — all fields optional, so normal 200 payloads
  type-check unchanged.
- **4xx/5xx error for held writes — rejected.** A 422/500 invites caller
  retries (the write is deliberately not applied, retrying cannot succeed)
  and round 1 demonstrated the failure mode concretely: the feedback route's
  500 on a legitimately held patch. `updateStructuredMemoryByHandle` still
  throws `MemoryQuarantinedWriteError` internally so no caller can mistake
  a held write for an applied one; routes translate the throw to the 202
  disposition and nothing swallows it (round-3 caller audit).
- **Scope-keyed quarantine dedup — chosen.** Pending-row reuse keys on
  `(agentId, content, scope, scopeRef)`: exact match when the entry carries
  scope fields, `$exists: false` when it does not — consistent with the
  insert, which persists scope fields only when present, and exact in both
  production MongoDB (missing ≠ value equality) and the stateful fake
  (strict deepEqual, `$exists` via path presence). Two authorized scopes
  under one agent never share a review decision's provenance.
- **Agent+content dedup (round-2 pre-fix shape) — rejected.** It conflated
  scopes: the second scope's held write reused the first scope's quarantine
  id and row metadata, so a review on one scope silently covered another.
- **Pi default scope "agent" — chosen.** The global default let one project
  poison every project; "agent" confines the blast radius to the agent's own
  memory, and lifecycle injection, capture, search, and save all consume the
  same resolved default.

## Consequences

- **The pi surface is no longer a trusted-text injection point.** Session
  context and search results render through the provenance-labeled envelope;
  the default scope is agent-scoped, so cross-project auto-injection stops.
- **Held writes are visible, honest, and recoverable.** Every write surface
  returns the 202 disposition with the quarantine id and matched patterns;
  the review queue (`promoteQuarantined` / `rejectQuarantined`, C-004) is
  the recovery path, and a completed review is the only classifier
  overrule.
- **The scope boundary is explicit, not implicit.** C-008's statement now
  enumerates exactly what EL-005 entails; the tools/MCP retrieval-envelope
  gap is C-040 in the claim ledger (open, +1 pending-claim sweep violation
  until its workstream lands). Future refuters cannot re-litigate the
  boundary because it is written down.
- **Quarantine rows are provenance-exact.** Identical poisoned content under
  different scopes creates distinct pending rows (duplicate review-queue
  entries) — deliberate: a review decision on one scope must not silently
  cover another.
- **Accepted residual.** The stateful fake's strict equality made
  `null`-vs-missing divergence a real portability hazard; the `$exists`
  form avoids it, but any future dedup filter that uses null equality must
  re-check both environments. `mongodb-manager-host.ts` carries 11
  pre-existing unused-import warnings (interface-only module, present at
  HEAD); out of scope. C-040's surfaces remain raw until that claim lands —
  the single largest known injection-surface residual in the repository.
