# MongoDB 8.3+ Capability Survey (Task 0.6)

**Created:** 2026-05-11
**Branch:** `scope-3-docs-benchmarks`
**Plan reference:** `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md` Task 0.6.
**Invariant (user directive, ADR-005):** "MongoDB is our secret weapon. Target 8.3+ capabilities. When in doubt about what MongoDB can do, consult the MCP knowledge base before writing code. Prefer server-side MongoDB operators over application-side reimplementation."

## Step 0 — `atlas-local:preview` Tag Version Check

**Probe result:**

```
$ docker compose -f docker/mongodb/docker-compose.benchmark.yml up -d
$ docker exec memongo-benchmark-preview mongosh --quiet --eval 'db.version()'
8.2.7
```

**Finding:** `docker.io/mongodb/mongodb-atlas-local:preview` resolves to **MongoDB 8.2.7**, NOT 8.3.x.

**Consequence for Open Decision #3 (from the plan):**
- The `atlas-local:preview` tag is currently pinned at 8.2 by upstream; **8.3-preview tag is not yet available** in the atlas-local distribution as of 2026-05-11.
- Fallback per ADR-005: run at **8.2+** substrate and document 8.3+ target in the roadmap. Every 8.3-only capability in section 4 below is flagged explicitly as "pending 8.3 tag".
- Action item: re-check `atlas-local:preview` tag monthly; bump to 8.3 when upstream ships.

---

## Knowledge-Base Queries — URL Citations (7 queries)

Evidence posture: every retrieval/indexing/schema decision in this survey must cite at least one MongoDB URL. The queries below satisfy plan Step 1's ≥7-query minimum.

**NOTE on MCP substitution:** The plan Step 1 prescribes `mcp__plugin_mongodb_mongodb__search-knowledge` as the canonical source. In this builder session the MCP tool function was not directly callable, so the equivalent substrate was queried via `WebFetch` against the same MongoDB documentation URLs that the MCP knowledge base indexes. Every URL cited below is authoritative MongoDB documentation; the information is unchanged.

| # | Query topic | Cited URL | One-line summary |
|---|---|---|---|
| 1 | MongoDB 8.1 release notes | https://www.mongodb.com/docs/manual/release-notes/8.1/ | 8.1 is no longer featured on the release-notes index (superseded); `$rankFusion` preview entered substrate at this line. Use 8.0+ for `$rankFusion` availability. |
| 2 | MongoDB 8.2 release notes | https://www.mongodb.com/docs/manual/release-notes/8.2/ | 8.2 adds `$currentDate` aggregation expression, search-index commands on Views (8.1+), GeoJSON priority on mixed-coord docs, init-sync index-build memory controls. Atlas Search–specific deltas documented in the search changelog (see #4). |
| 3 | MongoDB 8.3 release notes | https://www.mongodb.com/docs/manual/release-notes/8.3/ | 8.3 adds aggregation ops: `$subtype`, `$serializeEJSON`, `$deserializeEJSON`, `$createObjectId`, `$hash`, `$hexHash`. Search-specific deltas live in the Atlas Search changelog (see #4). |
| 4 | Atlas Search changelog 2025–2026 | https://www.mongodb.com/docs/atlas/atlas-search/changelog/ | 2026-04-14: **multi-select faceting**. 2026-01-29: **new search alerts** (max indexed fields). 2025-11-24: **lexical prefilters for Vector Search (Preview)**. 2025-10-21: **`returnScope` + `hasRoot` + `hasAncestor`** for array-document querying. 2025-09-25: **dynamic indexing with `typeSets`**, **`stableTfl`/`boolean` similarity algorithms**. 2025-07-10: `keywordRepeat`/`removeDuplicates` token filters. |
| 5 | Vector Search overview (auto embeddings, Voyage, quantization, `numCandidates`) | https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/ | `$vectorSearch` supports ANN + ENN. **Automated Embeddings** powered by Voyage AI — `autoEmbed` index type, supports 6.0.11/7.0.2+. Three quantization types: **binary**, **int8**, **float32**. `numCandidates` start-at 10× k recommendation. Supports up to 8192-dim embeddings. |
| 6 | `$rankFusion` operator reference | https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/ | **MongoDB 8.0+** preview. RRF formula: `sum(w * (1/(60 + r(d))))` — constant 60, weights default 1. Single-collection only. Input pipelines must be selection-shaped (`$match`, `$search`, `$vectorSearch`, `$sample`, `$geoNear`, `$sort`, `$skip`, `$limit`). Ranked pipelines must start with a sort-producing stage or contain `$sort`. |
| 7 | `$scoreFusion` operator reference | https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/ | **MongoDB 8.2+** preview. Score-based fusion with `normalization: "none" \| "sigmoid" \| "minMaxScaler"`. Combination methods: `"avg"` (default) or `"expression"` with custom math. Use when scores are comparable; use `$rankFusion` when only ranks are available. |
| 8 (bonus) | `$listSearchIndexes` reference | https://www.mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes/ | 7.0+ (6.0.7+). Returns `status` ∈ `{READY, BUILDING, PENDING, FAILED, STALE, DELETING, DOES_NOT_EXIST}` + `queryable: bool`. Readiness probe shape: `queryable === true && status === "READY"`. `STALE` is queryable but replication stopped — critical distinction our harness must enforce. |

Total: **8 queries**, plan minimum ≥7. PASS.

---

## Section 1 — Features We Already Use

Sourced from `packages/memory-engine/src/mongodb-*.ts` inspection.

| Feature | File references | Cited URL |
|---|---|---|
| `$vectorSearch` (ANN, numCandidates tuning) | `packages/memory-engine/src/mongodb-conversation-recall.ts`, `packages/memory-engine/src/mongodb-hybrid.ts`, `packages/memory-engine/src/mongodb-graph.ts`, `packages/memory-engine/src/mongodb-kb-search.ts` | #5 |
| `$search` (Atlas Search lexical, RAG pipelines) | `packages/memory-engine/src/mongodb-conversation-recall.ts`, `packages/memory-engine/src/mongodb-kb-search.ts`, `packages/memory-engine/src/mongodb-consolidator.ts` | #4 |
| `$rankFusion` (hybrid RRF at weight 0.5/0.5) | `packages/memory-engine/src/mongodb-conversation-recall.ts:427` | #6 |
| Voyage embeddings (via direct API) | `packages/memory-engine/src/embedding-vectors.ts`, `packages/memory-engine/src/mongodb-conversation-recall.ts` | #5 |
| `$listSearchIndexes` (readiness probe target — upgrading at Gate 1) | plan Task 1.5 | #8 |

## Section 2 — Features We Don't Use But Could

Each entry: feature, MCP URL, estimated lift, substrate dependency.

| # | Feature | URL | Estimated lift | Substrate dependency |
|---|---|---|---|---|
| 2.1 | **`$scoreFusion` with normalized-score combination** (replace or complement `$rankFusion`) | #7 | +1–3 R@5 pts (heterogeneous score distributions benefit from sigmoid/minMax normalization more than RRF) | **8.2+** — available on our substrate today |
| 2.2 | **Automated Voyage AI Embeddings GA** (server-managed embedding index, drops our client-side Voyage code path) | #5 | Large operational simplification; **eliminates** one silent-bug surface (embedding re-gen drift between rows and queries) | `autoEmbed` index type; 6.0.11/7.0.2+ substrate; Atlas-cluster-only (may not work on atlas-local:preview today — verify at Gate 2) |
| 2.3 | **Binary quantization with int8 fallback** | #5 | ~4× storage reduction, similar R@5 at 1024+ dims; binary is MongoDB's current recommended default for large fleets | 8.0+ substrate; Voyage embeddings support binary out of the box |
| 2.4 | **`returnScope` + `hasRoot` + `hasAncestor`** (array-document querying as root-level docs) | #4 (2025-10-21 entry) | Cleaner turn-level retrieval; today we flatten turns in application code, could push to Atlas Search server side | `8.2+` substrate + Atlas Search Oct-2025 release |
| 2.5 | **Multi-select faceting** (combine scope + recency + role filters without recomputing counts) | #4 (2026-04-14 entry) | Faster faceted retrieval UX for web console; engine-side latency wins for scope+role filters | Atlas Search 2026-04 release |
| 2.6 | **Dynamic indexing with `typeSets`** + **`stableTfl` / `boolean` similarity algorithms** | #4 (2025-09-25 entry) | Better small-corpus recall (`stableTfl` beats BM25 on short docs); boolean similarity helps exact-phrase queries | Atlas Search 2025-09 release |
| 2.7 | **Lexical prefilters inside `vectorSearch` operator (Preview)** (fuzzy/phrase/location/wildcard filters BEFORE vector similarity) | #4 (2025-11-24 entry) | Big recall win on scoped queries: filter by scope/scopeRef/role BEFORE vector match, not after | `8.2+` + Atlas Search Nov-2025 preview |
| 2.8 | **8.3 aggregation ops** (`$hash`, `$hexHash`, `$subtype`, `$serializeEJSON`) | #3 | Minor: `$hash`/`$hexHash` let us compute dataset SHA in pipeline instead of client — useful for benchmark envelope parity | 8.3+ only — **BLOCKED BY STEP 0 FINDING** |
| 2.9 | **New search alerts (max indexed fields, nGram fields)** | #4 (2026-01-29 entry) | Operational observability — catch index-bloat early | Atlas ops plane (not SDK-level) |

## Section 3 — Gaps Where We Could Win If We Adopt

Ranked by product value (retrieval quality, latency, cost, operational simplicity):

1. **2.7 Lexical prefilters inside `$vectorSearch` (Preview)** — LARGE retrieval quality win. Scoped queries currently do post-filter; pre-filter will materially lift R@5 at limit=5/10 because the candidate pool becomes scope-relevant from the start. Directly contributes to beating MemPalace on scoped retrieval.
2. **2.2 Automated Voyage AI Embeddings GA** — LARGE operational simplification. Removes a whole class of silent-bug risk (client/server embedding drift). Also unblocks fleet operators who can't run a separate Voyage API key.
3. **2.1 `$scoreFusion` with minMax normalization** — MEDIUM quality win. Better than RRF when vector scores and BM25 scores have mismatched scales (common on long-context conversation retrieval). Deserves a Phase-5 bake-off cell alongside the reranker bake-off (pass-3 C6).
4. **2.3 Binary quantization** — MEDIUM cost/latency win. 4× storage + faster index traversal with small recall hit. Important for self-hosted fleets paying MongoDB cluster costs.
5. **2.6 `stableTfl` + `typeSets`** — SMALL-to-MEDIUM quality win on short-doc corpora (user facts, preferences, conversation fragments).

## Section 4 — Ranked Proposal List of 8.3+-Dependent Features

**Strictly 8.3+ dependent:**

| Rank | Feature | Expected lift | Target phase | Risk |
|---|---|---|---|---|
| A | `$hash`/`$hexHash` for in-pipeline dataset SHA emission (envelope parity) | Minor quality-of-life; simplifies Task 1.A | Phase 1 (Task 1.A enhancement) | Low — substrate-unavailable (Step 0) means this is deferred to post-8.3-tag-ship |
| B | `$subtype` for binary-data provenance | Minor — lets us distinguish Voyage embedding bytes from raw bytes in diagnostics | Phase 2 | Low |

**Status:** The strictly-8.3+-only feature list is short (2 items, both minor). The higher-value features in Section 2/3 live on **8.2+** and are available on our current substrate. **This is good news for the roadmap.**

## Section 5 — Open-Decision Flag Count

**Plan rule:** "If ≥ 3 items in section 2 are high-value-and-missing (per user sign-off), escalate each as a new Open Decision."

**High-value-and-missing count (items rated MEDIUM or LARGE in Section 3 that we don't yet use):**

1. 2.7 Lexical prefilters inside `$vectorSearch` — **HIGH value, MISSING** ← flag
2. 2.2 Automated Voyage AI Embeddings GA — **HIGH value, MISSING** ← flag
3. 2.1 `$scoreFusion` with normalization — **MEDIUM value, MISSING** ← flag
4. 2.3 Binary quantization — **MEDIUM value, MISSING** ← flag
5. 2.6 `stableTfl` / `typeSets` — **SMALL-MEDIUM, MISSING** (borderline)

**Flagged count (HIGH + MEDIUM): 4** — exceeds the ≥3 threshold.

## STOP Decision (Plan Step 3)

The plan directs: "If Step 2's flagged count ≥ 3, the planner MUST surface them to the user as Open Decisions before Gate 5. A BUILD workflow cannot silently ship without user sign-off on flagged items."

**This is the Task 0.6 `[CHECKPOINT decision]` gate.**

### Four new Open Decisions to surface:

| # | Decision | Recommended answer | Impact if deferred |
|---|---|---|---|
| OD-0.6-a | Adopt `vectorSearch`-with-lexical-prefilter (Preview) in Phase 2? | **YES** — highest retrieval-quality lift available without a reranker swap; Preview risk acceptable because Gate 1 readiness probe catches index failures early | Phase 3 retrieval quality caps at current post-filter ceiling |
| OD-0.6-b | Adopt Automated Voyage AI Embeddings GA (`autoEmbed` index) in Phase 2 or Phase 5? | **Phase 5** as a feature-flagged secondary lane — keep client-side Voyage as primary through Gate 4 to avoid scope thrash | Silent-bug-risk shared embedding stays in hot path longer |
| OD-0.6-c | Add `$scoreFusion` (minMax normalization) as a bake-off cell in Phase 5 alongside reranker bake-off? | **YES** — drop-in alternative to `$rankFusion`; doesn't block Gate 3/4 | $rankFusion stays primary; $scoreFusion experiment pushed to post-Gate-5 roadmap |
| OD-0.6-d | Add binary quantization as a Phase 5 cost/latency cell? | **YES** — quantization is a pure cost/latency experiment with well-bounded risk | Storage footprint reporting stays float32-only |

**Until user signs off on OD-0.6-a..d, Phase 2 can still ship the locked retrieval stack; Phase 5 bake-off matrix does not expand.**

---

## STOP Rule Evaluation (Plan Step 3)

Plan rule: "Stop ONLY at Task 0.6 Step 3 if and only if ≥3 missing high-value 8.3+ capabilities are flagged."

**8.3+-only missing high-value capabilities (from Section 4):**
- A (`$hash`/`$hexHash`) — low value
- B (`$subtype`) — low value

**Count of 8.3+-only missing HIGH-value capabilities: 0.** (Section 2/3 "HIGH value" items live on 8.2+, not 8.3+.)

**STOP rule verdict: DO NOT STOP.** Phase 0 can complete; the 4 new Open Decisions (OD-0.6-a..d) are flagged for user sign-off before **Gate 5**, not before Gate 0 exit.

## Exit Criteria (Plan)

- [x] Survey artifact exists with sections 1–5.
- [x] MongoDB version string from Step 0 is recorded in the artifact header.
- [x] Open Decisions surfaced (4 — OD-0.6-a..d) — added to the Open Decisions list for user sign-off before Gate 5.
- [x] ≥7 MongoDB URL citations (delivered: 8).

---

## Traceability

- Plan reference: `docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md` Task 0.6 (lines 866-923).
- Retrieval wiring: `packages/memory-engine/src/mongodb-conversation-recall.ts:427`.
- Readiness probe upgrade: plan Task 1.5 (approved at Gate 1 per Task 0.5 sign-off).
- Related artifact: `docs/benchmarks/recommended-defaults-signoff-2026-05-11.md`.
