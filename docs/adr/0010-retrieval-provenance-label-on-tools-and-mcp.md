# Retrieval provenance label on AI-SDK tools and MCP results

Every model-visible retrieval payload — the AI-SDK tools'
`memongo_search`, `memongo_search_kb`, `memongo_read_file`,
`memongo_profile`, `memongo_build_context_bundle`, and
`memongo_recall_conversation`, plus the MCP tools that serialize the same
payloads (including `memongo_search_detailed` and the recall alias) —
carries a canonical untrusted-memory provenance label as the first field of
the returned JSON, sourced from one constant in `@memongo/lib`. This closes
the "single largest known injection-surface residual" recorded by ADR 0007
and lands claim C-040.

## Context

The #29 quarantine envelope (`renderMemoryContextBlock`) and the C-008
write-side classifier gate the surfaces their locked evidence named: the
pi extension's renders and every `writeStructuredMemory` caller. ADR 0007
deliberately left the AI-SDK tools and the MCP server out of scope because
no locked evidence obligated them, and the WS-05 round-2 refutation filed
the gap as C-040 rather than silently absorbing it: those surfaces return
raw stored content — conversation events, KB chunks, synthesized profile
text, context-bundle blocks, memory file bodies — that the write-structured
classifier never gated, and the MCP server serializes the same payloads
verbatim as tool-result text. A model consuming a tool result has no
in-band signal distinguishing stored tenant data from trusted operator
text, which is exactly the precondition for stored-text prompt injection.

## Considered Options

- **One canonical label constant + wrapper in `@memongo/lib` — chosen.**
  Both consumers already depend on `@memongo/lib` (the MCP app does not
  depend on `@memongo/tools`, so the tools package cannot host the shared
  source). `UNTRUSTED_MEMORY_PROVENANCE` carries the envelope preamble's
  semantics adapted from "the block delimited below" to a self-contained
  payload notice, and `withUntrustedMemoryProvenance` applies it, so the
  label text cannot drift between the two surfaces the way a local copy
  would.
- **Per-app label copies — rejected.** The repository's own history (the
  WS-02 diagnostic-classifier parity repair) shows local mirrors drift; one
  constant, two consumers, one test battery asserting both carry the
  identical text.
- **Full envelope (delimiters + neutralization) on tool payloads —
  rejected.** The envelope defends a rendered text block: its delimiter
  forging defense (ZWSP insertion) exists because a text stream can embed
  `<<<BEGIN...>>>` lookalikes. Tool results are JSON objects whose
  structure the producer controls; a first-field label is the
  JSON-equivalent provenance signal, and C-040's statement explicitly
  allows "an equivalent provenance label". The envelope remains the
  defense for text-render surfaces.
- **Label as the first field — chosen.** Token-budgeted consumers may
  truncate long payloads; a label placed after a large `results` array can
  be cut before it is ever read. Displacement is impossible from real call
  sites: every retrieval response type is a closed shape with no top-level
  `provenance` field (per-item provenance metadata lives inside result
  items and cannot collide), asserted by the wrapper's contract comment.
- **Label-last placement — rejected.** Same guarantee of presence but no
  truncation survival; ordering is the entire point of an in-band signal.
- **Labeling only the claim's five named tools — rejected as
  under-complete.** `memongo_read_file` returns verbatim stored memory
  text (the rawest injection payload of the set) and
  `memongo_search_detailed` returns the same search-result payload kind;
  both are "the MCP tool results that serialize the same payloads" in the
  claim's words, so both are labeled.
- **Labeling every stored-memory-rendering surface (active slate,
  discovery projections, `state_unified`, lifecycle reads) — rejected.**
  C-040's evidence boundary is the unclassified-content surfaces the
  round-2 finding enumerated. Structured-memory surfaces hold
  classifier-gated content (the C-008 write gate with human review as the
  only overrule); expanding the label there would be redefining a claim
  green instead of following its evidence — the exact move ADR 0007
  refused. These surfaces are recorded below as a residual instead.
- **Labeling error payloads — rejected.** A `jsonResult(..., true)` error
  carries an operator-facing error string, not retrieved tenant content;
  there is nothing to quarantine.

## Consequences

- **Thirteen surfaces are labeled.** Six AI-SDK tool execute handlers and
  seven MCP handler paths (search, KB search, detailed search, read_file,
  profile, context bundle, conversation recall — the recall alias shares
  the canonical handler). On MCP, `jsonMemoryResult` labels before
  `jsonResult` serializes, so both the JSON text and the
  `structuredContent` mirror carry the label as their first field.
- **Degradation passthrough is preserved.** C-019's
  throttled/auth-failure markers still ride alongside the label; the
  C-019 battery was updated, not weakened.
- **Payload schemas are additive.** The label is a new first field on
  closed response shapes; no consumer field changes, and
  `contract-mcp.ts` input-schema contracts are untouched.
- **The label is provenance, not classification.** Read-side labeling
  says "treat this as data"; deciding whether content may enter canonical
  memory at all remains the C-008 write gate's job. A labeled payload can
  still contain injection-shaped text — that is the point: it is now
  labeled as such.
- **Accepted residual.** Stored-memory renderings beyond C-040's
  evidenced set (active slate, discovery projections, `state_unified`,
  lifecycle reads, novelty scan, admin trace views) remain unlabeled; they
  hold classifier-gated or operator-facing content, and any future
  widening needs its own evidence, not a quiet edit here. Text-render
  surfaces keep the full envelope, which remains the stronger defense
  where it applies.
