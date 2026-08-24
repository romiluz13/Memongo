# Provenance and evidence

Active contributors: Rom Iluz

Every search result Memongo returns carries a computed trust signal and a trail back to the events it came from. `packages/memory-engine/src/mongodb-trust.ts` computes that signal (see [Glossary](../overview/glossary.md) for the trust score and importance decay definitions); `packages/memory-engine/src/mongodb-access-tracker.ts` and three evidence-building modules feed it real usage and provenance data.

## Trust score computation (`mongodb-trust.ts`)

`computeResultTrust()` builds a `MemoryResultTrust` for a single `MemorySearchResult` from six independently resolved factors, each with a label and a 0–1 sub-score (`packages/memory-engine/src/types.ts:9-45`):

| Field | Possible labels | What it measures |
|---|---|---|
| `exactness` | `exact-id`, `exact-locator`, `approximate` | Whether the result has a `canonicalId` (score 1), a `path` (0.9), or neither (0.25). |
| `freshness` | `fresh`, `aging`, `stale`, `timeless`, `unknown` | Age of `lastConfirmedAt`/`timestamp` relative to now (fresh <= 24h, aging up to 30 days, stale beyond); `validTo` in the past forces `stale`; a past `reviewAt` on an active result forces `aging`; reference-source results with no anchor are `timeless`. |
| `contradiction` | `none`, `conflicted`, `invalidated` | Derived from `result.state`; caps the overall score at 0.42 (`conflicted`) or 0.18 (`invalidated`) regardless of other factors. |
| `scopeMatch` | `exact`, `partial`, `unknown`, `mismatch` | Session key match is strongest signal (`exact`), then exact `scopeRef`, then same `scope`; any explicit mismatch caps the score at 0.35. |
| `provenance` | `dense`, `partial`, `sparse`, `none` | Number of resolvable `sourceEventIds` (>=2 is `dense`, 1 is `partial`); falls back to `sparse` if a `provenance` object exists without ids, or `partial` if the path looks like an event/episode reference. |
| `sourceDiversity` | `single`, `multi` | Whether the surrounding result set spans more than one `MemorySource` (`reference`/`conversation`/`structured`); computed once per search by `annotateResultsWithTrust()`, not per result. |

These combine into a weighted score (exactness 0.20, scopeMatch 0.15, provenance 0.15, freshness 0.15, temporal validity 0.15, source reliability 0.10, reinforcement 0.05, retrieval score 0.03, diversity 0.02), then multiplied by a `confidence` weight if the underlying memory document carries an explicit `confidence` field. `resolveConfidence()` buckets the final score into `high` (>=0.75), `medium` (>=0.5), or `low`. `buildFactors()` produces a human-readable factor list (e.g. `exact-id`, `scope-mismatch`, `provenance-thin`, `low-trust`) attached to every trust object for debugging and UI display.

`annotateResultsWithTrust()` attaches `trust` to every result in a search response. `rerankResultsByTrust()` is a separate, optional re-sort that blends normalized retrieval score (55%) with trust score (45%) and applies extra penalties for `invalidated` (0.6), `conflicted` (0.25), or `stale` (0.1) results — how and where this gets invoked in the ranking pipeline is covered in `systems/retrieval-and-search.md`; this page covers only how the trust numbers themselves are computed. `summarizeTrust()` rolls a result set into a `MemorySearchTrustSummary` (top score/confidence, average, confidence distribution, contradiction/stale/exact counts) used for abstention decisions (`shouldAbstainForLowTrust()`): if every surviving result is low-trust and the query needed exact evidence, the search can abstain rather than answer from weak evidence.

## Importance decay

`computeImportanceDecay()` (same file) applies exponential half-life decay to a memory's `importance` value: `importance * 0.5^(daysSinceCreation / halfLifeDays)`, default half-life 7 days. Memories with `temporalScope` of `"permanent"` or `"ongoing"` are excluded and never decay — this is how Memongo keeps durable preferences and facts from fading purely by search-time factors like `freshness` while still letting recency-sensitive results lose relevance over time.

## Access tracking (`mongodb-access-tracker.ts`)

`AccessTracker` batches access-count increments instead of writing to MongoDB on every read. It buffers `(collection, memoryId) -> count` in memory and flushes when either a threshold (default 10 buffered accesses) or an interval (default 60s) is hit, or on explicit `flush()`/`close()`. A flush does two things per batch: inserts raw `AccessEventDocument`s into a time-series `access_events` collection (for trend queries) and bulk-updates `accessCount`/`lastAccessedAt` on the canonical documents (`events`, `structured_mem`, `procedures`, `episodes`, `entities`, `relations` — see `COLLECTION_ID_FIELDS`) so existing scoring paths that read those denormalized fields keep working unchanged.

Failure handling is deliberately conservative: if the `access_events` insert fails, the entire snapshot is re-buffered for the next flush attempt (`rebufferSnapshot()`); if a per-collection bulk write fails, only that collection's keys are re-buffered, since the events insert may already have succeeded. No access counts are silently dropped.

`getAccessSummaries()` and `getAccessTrends()` run aggregations against `access_events` — the former returns rolled-up counts per memory ID over a window, the latter buckets by day and computes a rolling 7-day count via `$setWindowFields`, feeding recency/popularity boosts in the ranking pipeline described in `systems/retrieval-and-search.md`.

## Evidence-building modules

These three modules construct synthetic evidence documents (used in benchmark/ingestion pipelines) that carry provenance metadata back to source conversation turns:

- **`packages/memory-engine/src/mongodb-userfact-evidence.ts`** — regex-pattern extraction of first-person facts ("I prefer...", "I usually...", "my favorite...") from user turns, deduplicated and capped (10 facts, 700 chars per document), written as `source: "userfact-evidence"` documents with `metadata.sourceEventIds` pointing back to the originating events. Mode is controlled by an env value normalized through `resolveUserfactEvidenceMode()` (`"enabled"` / `"none"`, default `"none"`).
- **`packages/memory-engine/src/mongodb-session-evidence.ts`** — concatenates a whole session's user turns (assistant turns are deliberately excluded; the module's own comment records that including them regressed multi-session benchmark accuracy by 16.7 points due to embedding dilution from verbose AI responses) into one document per session, truncated at a sentence boundary at 8000 chars (`truncateAtSentenceBoundary()`). `MEMONGO_SESSION_EVIDENCE_MODE` selects between writing into the canonical `chunks` collection ("A") or a dedicated `session_chunks` collection ("B"), or skipping session evidence entirely ("none", default).
- **`packages/memory-engine/src/mongodb-evidence-mirror.ts`** — the most granular of the three: splits user turns into individual statements and classifies each as `preference` or `userfact` via regex (`PREFERENCE_RE`, `USERFACT_RE`, capped at 12 extracted statements per session), and separately mirrors whole user-turn and assistant-turn blocks as `session`/`temporal_anchor`/`assistant` evidence units. Every document carries a `provenance` object (`lane: "memory-evidence"`, `evidenceUnit`, `sourceCollection`, `sourceEventIds`, `builder: "benchmark-fast-ingest"`) plus a stable identity hash (`stableHash()` over unit+session+text) used to deduplicate across ingestion runs. Reuses `truncateAtSentenceBoundary()` from the session-evidence module rather than re-implementing truncation.

All three are opt-in, env-gated pipelines aimed at improving benchmark/evaluation recall by giving the search index more granular, provenance-tagged documents to match against — they are not part of the default runtime write path for normal `writeEvent` calls.

## Key source files

| File | Role |
|---|---|
| `packages/memory-engine/src/mongodb-trust.ts` | Trust score computation, importance decay, trust-based reranking and abstention |
| `packages/memory-engine/src/mongodb-access-tracker.ts` | Batched access-count writes, `access_events` time series, trend aggregation |
| `packages/memory-engine/src/mongodb-userfact-evidence.ts` | Regex-based first-person fact extraction into evidence documents |
| `packages/memory-engine/src/mongodb-session-evidence.ts` | Session-level user-turn concatenation into evidence documents |
| `packages/memory-engine/src/mongodb-evidence-mirror.ts` | Fine-grained statement classification and session/assistant mirroring with full provenance tagging |
| `packages/memory-engine/src/types.ts` (lines ~9-60) | `MemoryResultTrust`, `MemorySearchTrustSummary`, and related label types |

## Related pages

- [Glossary](../overview/glossary.md) for the trust score, novelty, access tracker, and importance decay definitions
- [Retrieval and search](retrieval-and-search.md) for how trust scores and access-tracker boosts are consumed in the ranking pipeline
- [Systems](index.md) and [Memory engine](../packages/memory-engine/index.md) for where this system sits among the rest of the engine
