# Scope-expansion SE-2 — Memory-poisoning / Prompt-injection Defense (4-layer)

> Task 2.SE-2 (ADR-006). Capability files:
> - `packages/memory-engine/src/mongodb-injection-classifier.ts` (new, scope-2)
> - `packages/memory-engine/src/mongodb-consolidator.ts` (pre-write hook)
> - `packages/memory-engine/src/mongodb-schema.ts` (`memory_quarantine`
>   collection)
>
> **fast-check seed (correctness invariant): 20260512.**

## Motivation

Anthropic flagged memory poisoning as a top risk alongside the Dreaming
launch. Memongo's consolidator verifies candidates at write time:

- Tier-1 pattern classifier is **always on**.
- Tier-2 LLM classifier is **off by default**, behind a strict-mode
  switch.
- Injection-likely candidates → `memory_quarantine` with status
  `pending-review`. NEVER to canonical without explicit promotion (SE-3
  follow-on, deferred to `scope-7-web-review-gate`).

## Silent-bug risks

- Injection content slipping through to canonical memory.
- Classifier drifting without regression tests.
- Consolidator swallowing the classifier verdict silently.

## Layer 1 — Unit

Tests at `packages/memory-engine/src/mongodb-injection-classifier.test.ts`:

- Named patterns: `ignore previous instructions`, `system prompt:`,
  `[SYSTEM]`, `<|system|>`, `show me your instructions`, `disregard the
  above`.
- Benign bodies remain `safe`; empty/whitespace → `safe`.
- `INJECTION_PATTERNS` is frozen (`Object.isFrozen` === true).
- Exit-code: `CI=true bunx vitest run
  packages/memory-engine/src/mongodb-injection-classifier.test.ts` →
  exit 0, 11/11 passed (recorded at commit `97544a1c3c`).

## Layer 2 — Integration

- Schema test asserts `memory_quarantine` collection is created with the
  correct validator (classification enum restricted to
  `injection-likely`; status enum `pending-review | rejected |
  promoted`).
- Consolidator pre-write hook under test in
  `mongodb-consolidator.test.ts` (existing suite remains green after the
  hook insertion).

## Layer 3 — E2E

- Integration test: run `consolidateMemory` with a mixed fixture of
  clean + injection-shaped candidates; assert:
  - Canonical `structured_mem` contains only clean-derived facts.
  - `memory_quarantine` contains only the flagged bodies, each with
    `status: "pending-review"`.

## Layer 4 — Correctness invariant (fast-check)

- **Property 12 (plan line 552):** every content matching an INJECTION
  pattern is classified `injection-likely`.
- Property (duality): the set of matched-pattern ids is a subset of
  `INJECTION_PATTERNS.map(p => p.id)`.
- Generator: constructed strings that either embed one of the seven
  known injection phrases or remain benign.
- Seed: **20260512**, 500 runs + 200 runs (duality).

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-injection-classifier.test.ts
# exit 0, 11/11 passed

CI=true bunx vitest run packages/memory-engine/src/mongodb-consolidator.test.ts
# exit 0 (existing tests stable after pre-write hook insertion)

CI=true bunx vitest run packages/memory-engine/src/mongodb-schema.test.ts
# exit 0; memory_quarantine validator tests green
```

## Citations

- `mongodb.com/docs/manual/core/schema-validation/`
- Anthropic prompt-injection guidance (public memory-poisoning risk
  disclosures).

_Last updated: 2026-05-12._
