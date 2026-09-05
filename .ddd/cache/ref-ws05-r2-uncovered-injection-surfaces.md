# REF-WS05-R2 — WS-05 round-2 refutation finding: uncovered injection surfaces
# Captured 2026-09-05 from .ddd/reports/refutation-c-008.yaml (round_2 section)
# for the C-040 claim citation "REF-WS05-R2#findings/uncovered-injection-surfaces".
# The refutation round was executed by an independent worker subagent
# (refuter_context: worker-subagent-independent-round2) against the WS-05
# landed tree (commit 3c2dee0fdd, feat(guardrails): prompt-injection write
# gate and pi envelope (WS-05)).

## Provenance

- Source: WS-05 (C-008) round-2 refutation, finding `uncovered-injection-surfaces`.
- Refuter: factory-droid worker subagent, independent of the WS-05 implementer.
- Round-2 verdict: partially_refuted (this finding plus three others, all
  resolved; round 3 sustained with zero findings).
- Disposition: adjudicated as a claim-scope defect, not an implementation
  defect; the gap was routed to the new claim C-040 rather than dropped.
- Round-3 corroboration (same report): "C-040 spot-checked accurate:
  packages/tools/src/index.ts:308-358 returns raw payloads;
  apps/mcp/src/server.ts:321-323 serializes raw JSON."

## findings/uncovered-injection-surfaces (verbatim excerpt)

- id: uncovered-injection-surfaces
- severity: high
- description: >
    The claim preamble said "every injection surface," but the AI-SDK
    tools return raw stored search/KB/profile/context-bundle payloads
    (packages/tools/src/index.ts createMemongoTools) and the MCP server
    serializes raw tool results (apps/mcp/src/server.ts), while the
    enumerated obligations only cover the pi surfaces. The envelope
    obligation was PARTIALLY satisfied relative to the preamble wording;
    the classifier and default-scope obligations were satisfied.
- resolution: >
    Adjudicated as a claim-scope defect, not an implementation defect:
    EL-005#S-3 obligates exactly the pi surfaces (it cites the tools
    renderer as the porting SOURCE, the defender), so the preamble
    overstated the evidence. C-008's statement narrowed to "the
    identified injection-surface gaps" with a scope note in the
    rationale; the tools/MCP retrieval-envelope gap is tracked as the
    new claim C-040 (behavioral, high, T2 per deriveTier) rather than
    silently dropped.

## C-040 obligation derived from this finding

Model-visible retrieval payloads from the AI-SDK tools
(memongo_search, search_kb, profile, build_context_bundle,
recall_conversation) and the MCP tool results that serialize the same
payloads MUST carry the untrusted-memory quarantine envelope or an
equivalent provenance label, so stored memory rendered into a model
context is never presented as trusted system text.
