# Cleanup opportunities

This is a short list, because the codebase gives a short list: very few
TODOs, and only a handful of files large enough to call out given the
system's complexity. For repo-wide size/churn totals, see
[By the numbers](by-the-numbers.md); this page sticks to what's actionable.

## Largest files (non-test and test)

| File | Lines | Note |
|---|---:|---|
| `packages/memory-engine/src/production-readiness.e2e.test.ts` | 3766 | End-to-end release-gate test suite; large because it exercises every release lane in one file. |
| `packages/memory-engine/src/real-e2e-v2.e2e.test.ts` | 2551 | Full live-MongoDB e2e coverage. |
| `packages/memory-engine/src/e2e-evaluation.e2e.test.ts` | 2335 | Evaluation-harness e2e coverage. |
| `packages/memory-engine/src/mongodb-graph.ts` | 2113 | Largest non-test source file; graph extraction, typed-edge enrichment, and traversal live here together. |
| `packages/memory-engine/src/mongodb-structured-memory.ts` | 2015 | Structured-memory lifecycle (active/invalidated/conflicted) plus revision history. |
| `packages/memory-engine/src/mongodb-search-executor.ts` | 1945 | Search-lane execution across vector/text/graph. |
| `packages/memory-engine/src/mongodb-manager.ts` | 1855 | Composes every manager mixin into `MongoDBMemoryManager`; the project's central integration point. |
| `packages/memory-engine/src/mongodb-procedures.ts` | 1745 | Stored-procedure lifecycle, mirrors structured-memory's shape. |
| `packages/memory-engine/src/types.ts` | 1737 | Carries the full public and internal type surface for the engine. |
| `packages/memory-engine/src/mongodb-search-v2.ts` | 1691 | Second-generation search implementation. |

`mongodb-manager.ts` and `types.ts` are the two worth watching: they are
both large and both high-churn (below), which is the combination that
usually signals a file absorbing more responsibility than it should.

## Churn hotspots (last 90 days)

| File | Commits touching it | Signal |
|---|---:|---|
| `packages/memory-engine/src/mongodb-manager.ts` | 40 | By far the most-touched file in the repo; expect ongoing API shape changes here. |
| `packages/memory-engine/src/mongodb-schema.ts` | 24 | Schema is still moving — new collections/indexes are landing regularly. |
| `packages/memory-engine/src/mongodb-schema.test.ts` | 21 | Tracks the schema churn above. |
| `packages/memory-engine/src/mongodb-manager.test.ts` | 21 | Tracks the manager churn above. |
| `packages/memory-engine/src/types.ts` | 17 | Type surface is changing alongside the manager and schema. |

This is where most of the recent design pressure has landed. It's a signal
for where to expect API instability and where extra test coverage matters
most before relying on these interfaces — not a defect in itself for an
actively developed solo project.

## TODO / FIXME / HACK

`grep -rn "TODO\|FIXME\|HACK" --include="*.ts" packages apps scripts` returns
6 matches, and none of them are unaddressed work markers:

| File | Line | Context |
|---|---:|---|
| `packages/memory-engine/src/mongodb-capability-registry.test.ts` | 15 | Asserts every gated feature declares a tracked TODO reference — a test enforcing the convention, not a TODO itself. |
| `packages/memory-engine/src/mongodb-capability-registry.ts` | 15 | Comment describing the registry's own convention (gated features must cite a tracked TODO). |
| `packages/memory-engine/src/mongodb-capability-registry.ts` | 45 | Field doc comment: "Tracked TODO reference for the re-enable follow-up." |
| `packages/memory-engine/src/mongodb-capability-registry.ts` | 329 | Comment about surfacing half-wired features, referencing "TODO" as a concept. |
| `packages/memory-engine/src/mongodb-consolidator.ts` | 137 | A regex literal that matches the word "TODO" in user-authored memory text, for pattern-based consolidation — not a code TODO. |
| `packages/memory-engine/src/mongodb-consolidator.part2.segment2.test.ts` | 464 | Test fixture string `"TODO: fix the login bug by Friday"` used as sample input. |

There are no genuine unresolved `TODO`/`FIXME`/`HACK` markers in the
codebase as of this writing.

## Dependency overrides

`package.json` pins these transitive versions via `overrides`:

```
body-parser, fast-uri, fast-xml-builder, fast-xml-parser, form-data,
ip-address, lodash, postcss, qs, react, socket.io-parser, tar, vite, ws
```

These read as security-driven CVE pins on transitive dependencies (the set
matches packages with known past advisories), not staleness — there's no
indication any of them are outdated on purpose or need attention beyond
periodically confirming the pinned versions still resolve upstream
advisories.
