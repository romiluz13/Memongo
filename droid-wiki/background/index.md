# Background: design decisions and rationale

Why Memongo looks the way it does. Each section is a bet the project made, with the evidence that anchors it.

## Why MongoDB-only

Memongo bets on a **single store** instead of the polyglot stack most memory frameworks assemble (vector DB + search engine + graph DB + relational store). One MongoDB deployment provides every primitive the system needs:

- **Vector search** — `$vectorSearch` stages, with server-side auto-embedding through mongot + Voyage (`docker/docker-compose.yml`)
- **Full-text search** — Atlas Search indexes (`packages/memory-engine/src/mongodb-schema.ts`)
- **Graph traversal** — `$graphLookup` for entity/relation walks (`packages/memory-engine/src/mongodb-graph.ts`)
- **Hybrid fusion** — `$rankFusion`/`scoreFusion`, with a client-side RRF fallback (`js-merge`)
- **Transactions, TTL, change streams, `$jsonSchema` validators, durable job leases** — all native

The claim discipline around this bet is written down in `docs/adr/0001-substrate-claim-and-score-claim-are-separate.md`: the **substrate claim** ("the architecture is better because MongoDB is the substrate") may only be proven by *self-facts* — verifiable properties of MongoDB and of Memongo's own code — never by competitor comparisons, which rot. The ADR also records the honest limits: `$graphLookup` is claimable for traversal only (typed edges come from an LLM, `mongodb-graph.ts`), and `$rankFusion` is a footnote because the shipped `js-merge` fallback produces a matching ranking. `docs/research/memory-framework-comparison.md` positions Memongo against Mem0, Graphiti, Zep, Cognee, LangMem, and Letta as maintainer research context.

The single-store bet costs something: plain `mongo:7` cannot serve the stack, so local development requires the `mongodb-atlas-local` preview container (see [Deployment](../deployment.md)). The project accepts that coupling deliberately and manages it with version-gated capability detection (`packages/memory-engine/src/mongodb-capability-registry.ts`).

## Why bitemporal

Every memory type carries `validAt` (when the assertion became true) and `invalidAt` (when it stopped being true; null = still valid). Retrieval at time `T` returns only memories satisfying `validAt <= T AND (invalidAt IS NULL OR invalidAt > T)` (`packages/memory-engine/src/mongodb-bitemporal.ts`).

The reasoning: agent memory is full of facts that *stop* being true — a preference changes, a decision is superseded, a dependency version moves. A store that only knows "now" forces deletion (losing history) or contradiction (returning stale facts as current). Bitemporal validity lets Memongo answer both "what is true" and "what was true when the agent made that decision," and lets corrections land as new validity windows instead of destructive edits. Pre-migration rows without `validAt` are treated as valid so retrieval stays monotonic across the rollout (`mongodb-bitemporal.ts:29`). Vector-search prefilters cannot express BSON null, so canonical writes *omit* `invalidAt` for open windows (`mongodb-bitemporal.ts:63`).

## Why 8-lane retrieval

Search is not one query against one index. `RetrievalPath` (`packages/memory-engine/src/mongodb-retrieval-planner.ts:14`) enumerates eight lanes:

```
active-critical · structured · raw-window · graph · hybrid · kb · episodic · procedural
```

The project's glossary (`CONTEXT.md`) fixes the rule: **lanes are fused, not chosen between.** Vector similarity finds meaning but misses exact names; full-text catches identifiers but misses paraphrase; graph recovers relationships; episodic and procedural lanes serve time-ordered and how-to memory. A planner classifies intent, assembles an ordered lane set (`PATH_PRIORITY`, `mongodb-retrieval-planner.ts:228`), fuses scores, and attaches trust metadata so the answer can point back to its evidence. Lane-coverage telemetry lets the planner skip *empty* lanes — except a `NEVER_SKIP_LANES` set that always runs (`mongodb-retrieval-planner.ts:1012`), because "empty ≠ error" for lanes that must speak up when they do have something.

## Why trust scoring

Retrieval results carry a trust object so consumers can inspect *why* a memory ranked, instead of trusting a bare score. The trust input spans seven dimensions (`packages/memory-engine/src/mongodb-trust.ts:214-219`):

1. **exactness** — exact-id vs exact-locator vs fuzzy
2. **freshness** — fresh vs stale, anchored on document timestamps
3. **contradiction** — whether the memory contradicts others
4. **scope match** — exact scope vs mismatch (`mongodb-trust.ts:239`)
5. **provenance** — source-event lineage
6. **source diversity** — single vs multi
7. **confidence** — the memory's own confidence, used as a weight multiplier (`mongodb-trust.ts:299`)

The design goal is *operational truth*: health, provenance, and stale/current labeling are first-class outputs, so memory can be inspected rather than trusted blindly.

## Why the Dreamer consolidation

Writing is explicit by default (`docs/research/memory-framework-comparison.md`: "Keep explicit-write-only as the default until background consolidation has a separate privacy, provenance, and rollback design"). The **Dreamer** is the offline pipeline that turns accumulated events into durable structured memory without blocking the write path (`packages/memory-engine/src/mongodb-consolidator.ts`):

- **Phase 0 — Gate:** atomic lease claim + rate limiter; every phase is idempotent, so an extra run is harmless
- **Phase 1 — Orient:** `$facet` parallel stats (unprocessed count, roles, top scopes)
- **Phase 2 — Extract + Decide:** 8-category pattern matching + `$vectorSearch` similarity for ADD/NOOP decisions; Phase 2.5 extracts entities; Phase 3.7 quality-filters memories derivable from code/context
- **Phases 3–4 — Deduction / Induction:** stubs reserved for future LLM reasoning (issue #31)
- **Phase 5 — Prune + Profile:** near-duplicate merge via `$vectorSearch` at > 0.92 similarity

The bet: memory quality compounds if consolidation is *offline, lease-gated, and idempotent* — never a hidden side effect of a search or write. The LLM-reasoning phases are deliberately left as stubs until their privacy/provenance/rollback design exists.

## Related pages

- [Architecture](../overview/architecture.md)
- [Cleanup opportunities](../cleanup-opportunities/index.md) — where the current code falls short of these ideals
- [Data models](../reference/data-models.md)
