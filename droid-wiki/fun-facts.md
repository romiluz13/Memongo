# Fun facts

## One author, four months, 188,000 lines

Memongo's entire history — 219 commits, roughly 188,323 lines of TypeScript/TSX, 429 `.ts` files — was written by a single contributor (Rom Iluz) between 2026-05-06 and 2026-08-24, about four months. That's an average of close to 47,000 lines of TypeScript per month from one person. Commit messages throughout carry agent-workflow markers — `scope-1:`/`scope-4:` checkpoint tags, `Task 0.5`/`Task 1.9` identifiers, `B1`–`B15` builder-queue batches (see [Lore](lore.md)) — which points to a heavily AI-agent-assisted build process rather than unusually fast solo typing. The repository doesn't state this explicitly anywhere, so treat it as what the commit pattern suggests, not a documented fact.

## The biggest file in the repo is a test, not a feature

`apps/api/src/production-readiness.e2e.test.ts` is 3,766 lines long — bigger than the largest production source file, `packages/memory-engine/src/mongodb-graph.ts`, by more than 1,600 lines (see [By the numbers](by-the-numbers.md)). The top three files in the whole repository by line count are all end-to-end test suites (`production-readiness.e2e.test.ts`, `real-e2e-v2.e2e.test.ts`, `e2e-evaluation.e2e.test.ts`), which says something about how much this project leans on end-to-end proof over any single production module.

## The consolidation pipeline has a nickname: "Dreamer"

`docs/platform/PLATFORM-README.md` refers to the offline memory-consolidation agent — the background job that merges, promotes, or invalidates memories in `packages/memory-engine/src/mongodb-consolidator.ts` — by the internal name "Consolidation agent (Dreamer)." It runs behind `POST /v1/consolidate` and is one of the codebase's few pieces of internal codenaming to survive into the shipped documentation.

## A written rule for which sentences the team is allowed to say

`CONTEXT.md` and the [glossary](overview/glossary.md) define two formally separate claim types: the **substrate claim** ("Memongo's architecture is better because MongoDB is its substrate," provable only by self-facts about MongoDB or Memongo's own code) and the **score claim** ("Memongo is the best memory framework," earned only by beating competitors on LongMemEval under identical methodology). The two are deliberately kept independent — a strong self-fact can't be used to prop up the score claim, and a good benchmark number can't be used to prop up the substrate claim. It's an unusually formal, almost legal-style constraint on marketing language for a project this size.
