# Fun Facts

*Data collected on 2026-08-03.*

## 1. The god module is one-seventh of all the TypeScript

`packages/memory-engine/src/mongodb-manager.ts` is **12,449 lines** — the longest file in the repo by a wide margin (the runner-up source file, `mongodb-schema.ts`, is 4,591). That single file is:

- ~7.4% of every TypeScript line in the repo
- ~20% of the engine's source LOC
- touched by **47 of 202 commits (23%)** — nearly one commit in four pokes the god module

Its test file, `mongodb-manager.test.ts`, is itself 9,307 lines — bigger than any other source file in the repo except the schema.

## 2. Only 6 TODOs, and two of them are test bait

The entire repo contains just **6 TODO/FIXME lines across 4 files** (source only, build output excluded) — remarkably clean for 85K+ lines of shipping code. And even those 6 are deliberate:

- 3 live in `mongodb-capability-registry.ts`, where gated features must declare a *tracked* TODO reference to be re-enabled — TODOs as a managed registry, not litter.
- 1 is the consolidator's regex that *detects* "TODO:" and "FIXME:" inside memory content it extracts.
- 2 are in tests feeding strings like `"TODO: fix the login bug by Friday"` to that regex as fixtures.

## 3. The 2-line published package

The npm package `@memongo/memory` (directory `packages/memongo-memory`) is literally this, in full:

```ts
export * from "@memongo/memory-bridge"
export * from "@memongo/memory-engine"
```

Two lines, zero exported declarations of its own, average file size: 2 LOC. It exists purely so consumers can install one name and get the bridge plus the engine.

## 4. The tests outweigh the code they test

Inside `@memongo/memory-engine`, test code beats source code on both axes:

| | Files | LOC |
|---|---|---|
| Source | 118 | 60,673 |
| Tests | 125 | 73,138 |

That's a **1.2 : 1 test-to-source ratio** — 12,465 more lines of test than of shipping code. Repo-wide the ratio is 0.97 : 1 (82,813 test vs 85,591 source), with 147 test files against 197 source files.

## 5. The name is a portmanteau

**Memongo = Memory + MongoDB.** The project is MongoDB-native long-term AI memory — no external vector database, no sidecar search service — and the name just says it.

## Bonus: the biggest file in the repo isn't code

`benchmarks/data/longmemeval_s_cleaned.json` is **1,101,877 lines** — about 87% of all lines in the repository on disk. It's the real LongMemEval benchmark dataset, fetched and checked in so the release-gate benchmarks run against verified data rather than synthetic stand-ins. One data file outweighs all 168K lines of TypeScript six times over.
