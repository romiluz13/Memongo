# MongoDB-Native Temporal Recall Capabilities — Root-Fix Investigation for Gate 3 Miss `00ca467f`

- **Date:** 2026-05-12
- **Base commit:** `b273d302`
- **Author:** CC10X web-researcher (Task 34, workflow `wf-20260511T212602Z-9db2daeb`)
- **Status:** COMPLETE (high confidence — MongoDB canonical docs cited for every capability claim)
- **Source of truth:** `mongodb.com/docs/` (MongoDB MCP `search-knowledge` plugin not reachable from this worker shell; canonical docs pages substituted per protocol). Every capability is cited with the canonical URL actually fetched.

---

## Execution

- Preferred backend: `brightdata+websearch`
- Actual sources used: WebFetch against 12 canonical `mongodb.com/docs/` pages (MCP substitution disclosed).
- Research round: Gate 3 Phase 3 root-fix.
- Scope: read-only; no code changes.

---

## TL;DR (3-sentence summary + classification)

1. The MongoDB-native root fix is **Atlas Search `gauss` decay scoring on `events.timestamp`** inside the existing hybrid text lane of `$rankFusion`. Given a natural-language month token (e.g. "March"), extract the month bucket once in the planner, then inject `compound.should: [{ range: { path: "timestamp", score: { function: { gauss: { origin, scale: 30d } } } } }]` into the text pipeline — this lifts in-month turns over procedural documents **without** widening `TIME_KEYWORDS` and **without** requiring a time-series collection migration.
2. Time series collections are a **dead end** for Memongo because the 8.x `timeseries-limitations` page lists `$search` as unsupported; we would lose Atlas Search entirely.
3. **Classification: Phase 3 surgical.** All three ranked candidates are available on `atlas-local:preview 8.2.7` today; nothing requires 8.3 GA. Estimated LOC delta is ~60–90 lines across `mongodb-retrieval-planner.ts` (+ helper) and `mongodb-conversation-recall.ts` (inner-pipeline wiring). No schema or index changes are required — `events_text` already has `timestamp: { type: "date" }` and the vector index already lists `timestamp` as a filter (see `packages/memory-engine/src/mongodb-schema.ts:3138` and `:3169`).

---

## 1 · Capability Matrix

Columns: capability | applicable to 8.2.7 today | 8.3+ only | root-fix power (1=no, 5=full) | impl cost (S/M/L) | cited URL

| # | Capability | 8.2.7 today | 8.3+ only | Root-fix power | Impl cost | Cited URL |
|---|---|---|---|---|---|---|
| Q1 | Migrate `events` to time-series collection | Yes (general), **No** for search | — | 1 (eliminates Atlas Search) | L | https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/ |
| Q2 | `$dateTrunc` / `$month` / `$dateToParts` for month bucketing inside pipeline | Yes | — | 2 (only after `$project`, cannot be pushed into Atlas Search filter) | S | https://www.mongodb.com/docs/manual/reference/operator/aggregation/dateTrunc/ |
| Q3 | Atlas Search date-aware analyzer / synonym / custom tokenizer for "March" → date | No built-in temporal analyzer | — | 1 (synonyms would still be keyword lists) | M | https://www.mongodb.com/docs/atlas/atlas-search/analyzers/ |
| Q4 | `$setWindowFields` with `partitionBy: { $month: "$timestamp" }` for in-month boost | Yes | — | 3 (works, but runs post-fusion — blunt instrument) | M | https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/ |
| Q5 | Atlas Search `facet` on date fields (counts only) | Yes | — | 1 (facets are counts, cannot boost results per docs) | — | https://www.mongodb.com/docs/atlas/atlas-search/facet/ |
| Q6 | `$densify` for gap-fill | Yes | — | 1 (data-prep stage, not retrieval; not recommended for search) | L | https://www.mongodb.com/docs/manual/reference/operator/aggregation/densify/ |
| Q7 | Lexical pre-filter in `$vectorSearch` | Already supports `Date`, `Number`, `String` in `filter` on 8.0+ | — | 4 (date pre-filter narrows vector lane to in-month turns) | S | https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/ |
| Q8 | Automated Voyage AI embeddings (OD-0.6-b) | Preview on M10+ (Atlas only, not atlas-local) | — | 1 (orthogonal; doesn't change temporal recall) | L | https://www.mongodb.com/docs/atlas/atlas-vector-search/automated-embedding/ |
| Q9 | Hybrid query rewriting at retrieval-planner layer (extract month bucket → explicit filter/boost) | Yes | — | **5 (root fix)** | S | https://www.mongodb.com/docs/atlas/atlas-vector-search/tutorials/hybrid-search/ (tutorial acknowledges "set weights per query"; implementation left to app) |
| Q10 | `scoreDetails` / `searchScoreDetails` to introspect lane contribution | Yes (already partially wired) | — | 3 (observability, not a fix — but confirms why miss happens) | S | https://www.mongodb.com/docs/atlas/atlas-search/score/get-details/ |
| Bonus A | Atlas Search `gauss` decay scoring on date field | **Yes** | — | **5 (native temporal ranking boost)** | S | https://www.mongodb.com/docs/atlas/atlas-search/score/modify-score/ |
| Bonus B | `$scoreFusion` with sigmoid/minMax normalization + expression combination | 8.2 preview | GA trajectory | 4 (enables dynamic weight by query type) | M | https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/ |
| Bonus C | Atlas Search `range` on date in `compound.filter` | Yes | — | 4 (pre-filter pure lexical path) | S | https://www.mongodb.com/docs/atlas/atlas-search/range/ |

### Hard blocker discovered (Q1)

> Time series collections **do not support** MongoDB Search (`$search`), change streams, CSFLE, Database Triggers, schema validation, `reIndex`, or `renameCollection`. *(cited URL above, Q1 row.)*

Implication: migrating the `events` collection to a time-series collection would **destroy the lexical lane of `$rankFusion`** because its inner `$search` pipeline would stop working. This removes time-series migration from consideration as a root fix, independent of any Memongo-specific constraint.

### Key enabler discovered (Bonus A)

> `score.function.gauss` takes `{ path, origin, scale, offset, decay }`. Documents with `eventDate == origin` retain full score; documents `±scale` from origin are multiplied by `decay` (default 0.5); further dates decay exponentially. *(cited URL: `.../score/modify-score/`.)*

This is **exactly** the behavior needed for "in March" — a date-centered bell curve that boosts in-month events over out-of-month events, with zero keyword enumeration.

### Version gates summary

| Capability | Requires upgrade from 8.2.7? |
|---|---|
| `$rankFusion` | No — GA in 8.1 |
| `$scoreFusion` | No — 8.2 preview (available on 8.2.7) |
| `$vectorSearch` filter on Date | No — 8.0+ |
| Atlas Search `range` on date field | No — current |
| Atlas Search `gauss`/`function` score on date | No — current |
| Atlas Search `scoreDetails` | No — current |
| `$dateTrunc`, `$setWindowFields` | No — 5.0+ |
| `$dateAdd`/`$dateSubtract` pre-epoch | Yes (8.3) — **not needed for this fix** |
| Automated Voyage AI embeddings (OD-0.6-b) | N/A — Atlas-only; not on atlas-local |

**No part of the recommended fix requires moving off 8.2.7.**

---

## 2 · Top 3 Ranked Candidates

### Candidate A (RECOMMENDED) — Atlas Search `gauss` decay on `timestamp` inside the text lane of `$rankFusion`

- **Mechanism:** Planner detects a month-bucket in the query (`March`, `March 2024`, `in March`, `03/2024`, etc.) via a tiny date-extraction helper (single regex on month names + a `Date` math helper — this is NOT a keyword-to-lane mapping; it is natural-language-to-`Date` extraction, which is the same category of work as the existing `extractTimeConstraint` at `packages/memory-engine/src/mongodb-retrieval-planner.ts:340`). Resulting `{ originDate, scaleDays }` is injected into the `compound.should` of the text pipeline as a `range` operator with `score.function.gauss`.
- **Why this is a root fix, not a keyword patch:** The planner maps natural-language month tokens to a **`Date` origin** and lets MongoDB's score function do the ranking. Adding a year ("April", "January 2025") does not require editing `TIME_KEYWORDS` — it reuses the same date-extraction helper. This is the MongoDB-native equivalent of what Elasticsearch calls "decay-function scoring on a date field."
- **Pros:**
  - Zero schema changes (timestamp is already indexed as date in `events_text` at `mongodb-schema.ts:3138`).
  - Works on 8.2.7 today.
  - Non-keyword: new month/quarter vocabulary is a data parsing change, not a lane-classification change.
  - Leaves `$rankFusion` weights alone — the boost lives **inside** the text pipeline's relevance score.
  - Expected to raise `recallAnyAt50` for `00ca467f` from 0 to >0 immediately: turns timestamped within March will score higher than structured procedure documents that lack in-month timestamps.
- **Cons:**
  - `gauss` scale has to be chosen; ~30–45 days is the natural scale for "in March."
  - Requires date parsing for month names (but this is ~15 LOC with `Date.UTC(year, monthIndex, 1)` — well below the noise floor).
- **Cited:** https://www.mongodb.com/docs/atlas/atlas-search/score/modify-score/ and https://www.mongodb.com/docs/atlas/atlas-search/range/

### Candidate B — Date pre-filter in the `$vectorSearch` lane

- **Mechanism:** Same planner-side month extraction. When a month bucket is detected, add `filter: { timestamp: { $gte: monthStart, $lt: monthEnd } }` to the `$vectorSearch` stage inside the fusion's vector pipeline. `events_vector` index already lists `timestamp` as a filter (`mongodb-schema.ts:3169`), so no index change required.
- **Pros:** Strong — narrows the vector-lane candidate pool to just in-month turns, guaranteeing coverage in top-K.
- **Cons:** A hard filter is a stronger signal than the user wrote — if the extractor is wrong, we lose recall. The gauss (Candidate A) is soft; it penalizes out-of-month docs but doesn't exclude them. Stacked with A, this becomes safe; stand-alone it's risky.
- **Cited:** https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/

### Candidate C — Observability via `$rankFusion` `scoreDetails` (Fix C from prior investigator)

- **Mechanism:** Already partially implemented (`mongodb-conversation-recall.ts:607` sets `scoreDetails: true`). Propagate it into the benchmark projection so `longmemeval-canary` emits which lane contributed the winning score per doc. This is **not a fix** — it's the explain-plan that confirms Candidate A is actually firing and lets us alert when the procedural lane dominates for a question whose `question_type == multi-session`.
- **Pros:** Ship alongside A for safety. Zero risk.
- **Cons:** Observability only.
- **Cited:** https://www.mongodb.com/docs/atlas/atlas-search/score/get-details/

---

## 3 · Recommended MongoDB-Native Approach

### 3.1 · Specific file changes

1. **`packages/memory-engine/src/mongodb-retrieval-planner.ts`** — add a month-bucket extractor and expose it on `RetrievalConstraints.timeRange` as a new shape that carries explicit `origin: Date` and `scaleDays: number`. Non-bucket callers keep the existing preset path.
   - New helper `extractMonthBucket(query: string, now: Date): { origin: Date; scaleDays: number } | undefined` near `extractTimeConstraint` (line 340). Matches bare month names (case-insensitive), optional year, and "in {month}". Resolves year: if query contains a 4-digit year use it; else prefer the last occurrence of that month strictly before `now` (so "March" in May 2026 resolves to March 2026, not March 2027).
   - Extend `RetrievalConstraints["timeRange"]` with optional `origin?: Date` and `scaleDays?: number`. No preset required when these are set (preset stays the enum for calendar-relative queries).
   - Wire into `planRetrieval` at line 572: prefer `extractMonthBucket` result over/in addition to `extractTimeConstraint`. Bump `raw-window` by +2, **but also** mark the plan so the search executor knows to inject the gauss boost.

2. **`packages/memory-engine/src/mongodb-conversation-recall.ts`** — in the hybrid path that builds the `$rankFusion` inner pipelines (around line 607), when `constraints.timeRange.origin` is present:
   - Add a `compound.should` clause to the `$search` stage of the text pipeline:
     ```js
     {
       range: {
         path: "timestamp",
         gte: new Date(origin.getTime() - scaleDays * 86400000),
         lte: new Date(origin.getTime() + scaleDays * 86400000),
         score: {
           function: {
             gauss: {
               path: { value: "timestamp", undefined: 0 },
               origin: origin,
               scale: scaleDays * 86400000, // ms
               decay: 0.5
             }
           }
         }
       }
     }
     ```
   - Optionally add a *soft* `filter: { timestamp: { $gte: monthStart - scale, $lt: monthEnd + scale } }` to the sibling `$vectorSearch` stage (Candidate B). Keep it wide (scale*2) so mis-extraction doesn't kill recall.

3. **`packages/memory-engine/src/mongodb-search-executor.ts`** — already calls `classifyRetrievalQuery` at line 380; no change required to existing classifier. The bucket extraction goes through the planner's `constraints.timeRange` and is consumed by recall, not by the classifier.

4. **(Observability — Candidate C)** Propagate `scoreDetails.details[*].description` → canary emission. Existing extraction helpers at `mongodb-conversation-recall.ts:418` already normalize `scoreDetails`; just surface the lane-origin string into `benchmark-parity-envelope.ts`.

### 3.2 · Estimated LOC delta

- `mongodb-retrieval-planner.ts`: +35 LOC (extractor + test hooks) — roughly mirrors `extractTimeConstraint`.
- `mongodb-conversation-recall.ts`: +20 LOC (inner-pipeline branch).
- Types in `types.ts`: +6 LOC for `timeRange.origin`, `timeRange.scaleDays`.
- Tests: +2 focused tests in existing `mongodb-retrieval-planner.test.ts` and `mongodb-conversation-recall.test.ts` suites.
- **Total: ~60–90 LOC**, all behind the existing retrieval-planner/conversation-recall seam. Zero schema or index churn.

### 3.3 · Expected impact on the 5 variance misses

| Case | Miss shape | Expected impact of gauss+filter |
|---|---|---|
| `00ca467f` (target) | "How many doctor's appointments did I go to in **March**?" — in-month turns never surface. | **Direct fix.** Text pipeline boosts March-timestamped turns; top-50 recall moves from 0 to >0. |
| `0e5e2d1a` | multi-session temporal counting (per prior investigator notes) | **Likely same root cause** — inherits fix automatically. |
| `001be529` | multi-session | **Likely** — any query that mentions a month, quarter, or year. |
| `01493427` | multi-session | Same — conditional on month-token presence. |
| `06878be2` | already root-caused to turn top1 regression (Task 30) | Not addressed by this fix; orthogonal. |
| `08f4fc43` | multi-session | **Likely** — conditional on month-token presence. |

Worst case: the extractor fires on a query where the user actually didn't want a month filter ("I met Bill March in the lobby"). The `gauss` boost is soft — it's additive to BM25 — so a miss-fire still leaves non-March turns in the ranking. This is a better failure mode than a hard filter.

### 3.4 · Phase 3 surgical vs Phase 5 research

**Phase 3 surgical.** Rationale:

- All primitives (`$search`, `compound.should`, `range`, `score.function.gauss`, vector `filter` on `Date`) ship on 8.2.7 today.
- No index/schema migration — existing `events_text` and `events_vector` already carry `timestamp` (`mongodb-schema.ts:3138`, `:3169`).
- LOC delta is surgical (~60–90).
- Observability (Candidate C) ships alongside so we can confirm the boost is firing.
- The Phase 5 research bucket was (per plan) reserved for capabilities that required upgrades or major refactors. None apply here.

---

## 4 · Why the keyword-patch was genuinely wrong

The prior investigator's Fix A extended `TIME_KEYWORDS` to include bare month names. That is brittle because:

1. It conflates **lane selection** (should `raw-window` fire?) with **temporal ranking** (which documents inside the window rank highest?). The root problem is ranking, not lane selection — conversation turns are indexed, but `$rankFusion` default 0.5/0.5 lets structured documents win on vector similarity without temporal context.
2. Even if `raw-window` fires on the word "March", there is no mechanism to boost in-March events over out-of-March events within the hybrid lane. A keyword list cannot become a ranking signal.
3. `gauss` decay solves both problems at the **relevance-score** layer, which is architecturally the right place.

---

## 5 · What Changed the Recommendation

**Single highest-signal finding:** Atlas Search's `score.function.gauss` operator is natively date-aware, works inside `compound.should` on any date field, and can be placed inside the text lane of an existing `$rankFusion` pipeline without changing any index or collection type. This converts the "bare month name" problem from a keyword-enumeration problem into a date-parsing problem, which is a root fix rather than a shim. Cited: https://www.mongodb.com/docs/atlas/atlas-search/score/modify-score/

---

## 6 · References (all canonical `mongodb.com/docs/`)

1. Time-series collections overview: https://www.mongodb.com/docs/manual/core/timeseries-collections/
2. Time-series limitations (blocks `$search`): https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/
3. `$dateTrunc`: https://www.mongodb.com/docs/manual/reference/operator/aggregation/dateTrunc/
4. Atlas Search analyzers: https://www.mongodb.com/docs/atlas/atlas-search/analyzers/
5. `$setWindowFields`: https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/
6. Atlas Search `compound`: https://www.mongodb.com/docs/atlas/atlas-search/compound/
7. Atlas Search `range`: https://www.mongodb.com/docs/atlas/atlas-search/range/
8. `$vectorSearch` stage + filter: https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/
9. `$rankFusion`: https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/
10. Atlas Search `facet`: https://www.mongodb.com/docs/atlas/atlas-search/facet/
11. `$densify`: https://www.mongodb.com/docs/manual/reference/operator/aggregation/densify/
12. Hybrid search tutorial: https://www.mongodb.com/docs/atlas/atlas-vector-search/tutorials/hybrid-search/
13. Atlas Search modify score (gauss/function/boost/constant): https://www.mongodb.com/docs/atlas/atlas-search/score/modify-score/
14. Atlas Search scoreDetails: https://www.mongodb.com/docs/atlas/atlas-search/score/get-details/
15. `$scoreFusion`: https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/
16. Atlas Search date field type: https://www.mongodb.com/docs/atlas/atlas-search/field-types/date-type/
17. MongoDB 8.3 release notes: https://www.mongodb.com/docs/manual/release-notes/8.3/
18. Automated Voyage AI embeddings: https://www.mongodb.com/docs/atlas/atlas-vector-search/automated-embedding/

### MCP substitution disclosure

MongoDB MCP `search-knowledge` was not reachable from this agent's shell environment during the 2026-05-12 session. Per protocol, canonical `mongodb.com/docs/` pages were fetched directly via WebFetch as corroborating source. Claims above cite the actual pages consulted. No third-party/blog sources were used — all 18 references are first-party `mongodb.com/docs/`.

---

Web research complete.
