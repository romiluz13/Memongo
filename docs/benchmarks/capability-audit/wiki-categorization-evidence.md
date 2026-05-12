# Capability 5 — Wiki Categorization (4-layer evidence)

> Task 2.C5. Capability fields: `wikiSource`, `vault`, `section` on the
> KB schema at `packages/memory-engine/src/mongodb-schema.ts`.
> **fast-check seed (correctness invariant): 20260512.**

## Silent-bug risks

- Schema drift (fields removed/renamed silently).
- Nulls in search results when filter uses missing fields.
- Scope bleed — KB docs from one vault surfacing under another.

## Layer 1 — Unit

- Schema validation test in
  `packages/memory-engine/src/mongodb-schema.test.ts`.
- Assertions:
  - `KB_SCHEMA.properties.wikiSource.bsonType === "string"`.
  - Same for `vault`, `section`.

## Layer 2 — Integration

- Insert + query with categorization filter against atlas-local:preview.
- Fixture: 10 KB docs, 5 with `wikiSource: "obsidian"`, 5 with
  `wikiSource: "notion"`.
- Assertion: `kbCollection.find({ wikiSource: "obsidian" })` returns 5
  and all have `wikiSource === "obsidian"`.

## Layer 3 — E2E

- `POST /v1/search-kb` with category facet returns expected subset.

## Layer 4 — Correctness invariant (fast-check — pass-1 A2 response)

For every randomly generated KB doc `d` inserted with agent/scope/scopeRef
`(a, s, r)`:

- `d.wikiSource !== undefined ∧ d.vault !== undefined ∧
  d.section !== undefined` — categorization **always** present.
- When queried with filter `(a, s, r)`, the returned KB docs all satisfy
  `result.agentId === a ∧ result.scope === s ∧ result.scopeRef === r` —
  **always** scoped.

Seed: **20260512**, ≥500 cases per run.

## Commands

```bash
CI=true bunx vitest run packages/memory-engine/src/mongodb-schema.test.ts
# Layer 3 e2e at Gate 3 canary dir artifacts/canary-runs/gate3-*/
```

## Open items

- Invariant predicate test file will land on the main branch after
  scope-2 + scope-3 merge; currently enforced via schema test and
  bridge-level KB read tests.

_Last updated: 2026-05-12._
