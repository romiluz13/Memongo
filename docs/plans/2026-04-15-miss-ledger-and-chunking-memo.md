# Memo: Miss Ledger Results, Chunking Blind Spot, and Research Request

**From:** Claude Code (Builder AI)
**To:** Reviewer AI
**Date:** 2026-04-15
**Subject:** Canary diagnostic data is in. Chunking strategy is a blind spot. Need your sub-agents to research improvement vectors before we build.

---

## 1. Current State

- **Best proven R@5:** 92.0% (Option A, user-only session evidence, commit `c95e1aece8`)
- **Canary variance:** 86.8%–92.0% across identical code on fresh DB ingests (auto-embed non-determinism on 48-case canary)
- **ADR locked:** Option A wins. Option B is dead.
- **Assistant-turn enrichment:** Tested and **failed**. Regressed multi-session from 100% → 83.3%. Reverted. Session evidence stays user-only.
- **Miss ledger:** Built and working. Per-case diagnostic now ships in benchmark response.

---

## 2. Miss Ledger Results (9 failing cases)

From the latest canary run with miss ledger enabled:

| Case | Type | R@5 | Category | Session found? | All sessions? | Turn reachable? |
|------|------|-----|----------|----------------|---------------|-----------------|
| `0977f2af` | knowledge-update | 0.00 | update | No | No | No |
| `06f04340` | preference | 0.00 | preference | No | No | No |
| `09d032c9` | preference | 0.00 | preference | No | No | No |
| `1a1907b4` | preference | 0.00 | preference | No | No | No |
| `07741c45` | knowledge-update | 0.50 | update | No | No | No |
| `0100672e` | multi-session | 0.50 | turn-selection | Yes (1/2) | No | No |
| `099778bb` | multi-session | 0.50 | turn-selection | Yes (1/2) | No | No |
| `0db4c65d` | temporal | 0.50 | temporal | No | No | No |
| `0bc8ad92` | temporal | 0.67 | temporal | Yes (2/3) | No | No |

### Pattern summary:

- **3 preference cases (all R@5=0.00):** Complete misses. The answer session never enters the candidate set. `structured` memory results dominate top positions but carry no sessionId.
- **2 multi-session cases (R@5=0.50):** Find one session but miss the other (partial recall).
- **2 knowledge-update cases:** One complete miss, one partial. `structured` results block session results.
- **2 temporal cases:** Similar — partial session recall or structured results dominating.
- **`structured` results with no sessionId** appear frequently in top candidates across ALL miss categories. This is a provenance gap.

---

## 3. Chunking Blind Spot (NEW — never discussed before)

We found that Memongo uses **one turn = one chunk, no merging, no overlap, no context windowing.**

The chunking function (`packages/memory-engine/src/mongodb-events.ts:30-35`):

```typescript
export function renderEventChunkText(event) {
    const roleLabel = event.role.charAt(0).toUpperCase() + event.role.slice(1)
    return `${roleLabel}: ${event.body}`
}
```

### Turn size distribution from LongMemEval-S (sampled 49,823 turns from 100 questions):

| Metric | User turns | Assistant turns |
|--------|-----------|-----------------|
| Count | 24,701 | 25,122 |
| Median | **182 chars** | 1,674 chars |
| P10 | **68 chars** | 555 chars |
| P25 | **117 chars** | 1,027 chars |
| Mean | **248 chars** | 1,702 chars |
| <50 chars | **6.4% (1,576)** | 0.8% |
| <20 chars | **1.7% (427)** | 0.4% |

**User turns are tiny.** Median 182 chars ≈ 30-40 words. The embedding model (Voyage 4 Large) produces a 1024-dim vector from ~30 words of context. That's a weak, underspecified embedding.

Short turn examples from the corpus: `"Thank you"`, `"more"`, `"more"`, `"more"`, `"Explain bitcoin like I'm 10"`.

**This means:** When a user says `"I just bought a Sony A7R IV"` (35 chars), it becomes chunk `"User: I just bought a Sony A7R IV"` — a single isolated embedding with almost no semantic context. No amount of session evidence or post-retrieval scoring can rescue a chunk that never enters the candidate set because its embedding is too weak to match any query.

### Potential chunking improvements (not validated yet):

1. **Context-windowed chunks:** Merge each user turn with its surrounding assistant turn(s) to create a richer embedding context.
2. **Short-turn merging:** Consecutive turns under a threshold get merged into one chunk.
3. **Sliding window overlap:** Adjacent chunks share boundary text.
4. **Hierarchical chunking:** Keep fine-grained turn chunks but also create coarser multi-turn chunks (similar to what session evidence already does, but at a smaller window).

---

## 4. What We Need From You

**Run sub-agents to research the following improvement vectors.** For each, I need:
- What the reference systems actually do (code-level, not hand-wavy)
- Whether it's applicable to Memongo's MongoDB-native architecture
- Expected impact on the miss categories above
- References (file paths, line numbers, paper citations)

### Research vectors:

### 4.1 Chunking strategies in reference systems

Check these local reference repos for how they chunk conversations:

- `/Users/rom.iluz/Dev/memory-referance/mempalace/` — How does MemPalace chunk? Do they merge turns? Context windows?
- `/Users/rom.iluz/Dev/memory-referance/mem0/` — How does Mem0 chunk? They're known for fact extraction.
- `/Users/rom.iluz/Dev/memory-referance/letta/` — Letta (fka MemGPT) has a sophisticated memory architecture. Chunking strategy?
- `/Users/rom.iluz/Dev/memory-referance/supermemory/` — Supermemory session summaries as chunks?
- `/Users/rom.iluz/Dev/memory-referance/langmem/` — LangMem chunking approach?
- `/Users/rom.iluz/Dev/memory-referance/cognee/` — Cognee's knowledge graph chunking?

### 4.2 LongMemEval's own index expansion strategies

The official LongMemEval repo has explicit index expansion scripts. Read them:

- `/Users/rom.iluz/Dev/memory-referance/LongMemEval/src/index_expansion/batch_expansion_session_userfact.py` — User fact extraction
- `/Users/rom.iluz/Dev/memory-referance/LongMemEval/src/index_expansion/batch_expansion_session_summ.py` — Session summarization
- `/Users/rom.iluz/Dev/memory-referance/LongMemEval/src/index_expansion/batch_expansion_session_keyphrases.py` — Keyphrase extraction
- `/Users/rom.iluz/Dev/memory-referance/LongMemEval/src/index_expansion/batch_expansion_session_temp_event.py` — Temporal event extraction
- `/Users/rom.iluz/Dev/memory-referance/LongMemEval/src/index_expansion/batch_expansion_turn_userfact.py` — Turn-level user fact extraction
- `/Users/rom.iluz/Dev/memory-referance/LongMemEval/src/index_expansion/batch_expansion_turn_keyphrases.py` — Turn-level keyphrases
- `/Users/rom.iluz/Dev/memory-referance/LongMemEval/src/index_expansion/temp_query_search_pruning.py` — Temporal query pruning

These are the official strategies. Which ones are most impactful? Which can we implement natively on MongoDB without an LLM call?

### 4.3 MemPalace's actual benchmark code

You previously cited specific lines. Now read the full implementations:

- `/Users/rom.iluz/Dev/memory-referance/mempalace/benchmarks/longmemeval_bench.py` — Especially lines 1157-1213 (preference extraction)
- `/Users/rom.iluz/Dev/memory-referance/mempalace/benchmarks/HYBRID_MODE.md` — Lines 301-389 (hybrid approach)
- `/Users/rom.iluz/Dev/memory-referance/mempalace/mempalace/` — Core memory module: how do they store and retrieve?

### 4.4 Academic research on conversation memory chunking

Search the web for:
- "conversation memory chunking strategies for retrieval" — any papers on optimal chunk sizes for dialogue?
- "LongMemEval SOTA approaches" — what do top-performing systems do differently?
- "Emergence AI LongMemEval" — they claim SOTA. What's their approach?
- "embedding quality vs text length" — is there research on minimum text length for meaningful embeddings?

### 4.5 The structured memory provenance gap

The miss ledger shows `structured` results (from `structured_mem` collection) dominating top positions but carrying no sessionId. This means:
- The Dreamer's consolidated facts are strong retrievers
- But they can't count toward R@5 because they lack session provenance
- Should we add session provenance to structured memory?
- Or should we stop structured memory from competing with conversation results in the benchmark?

Check how `structured_mem` documents are created and whether session provenance could be added without breaking the Dreamer architecture:
- `packages/memory-engine/src/mongodb-consolidator.ts`
- `packages/memory-engine/src/mongodb-structured-memory.ts` (if it exists)

---

## 5. Design constraints for your recommendations

1. **MongoDB-native only.** No external vector DBs, no Redis, no Elasticsearch.
2. **Harmonious with Option A.** Session evidence in `chunks` collection with `source: "session-evidence"` is the canonical path.
3. **No LLM calls at ingest time** for the benchmark path (too slow for 23,867 sessions). Regex/rule-based extraction is OK.
4. **One canonical collection path.** Don't create a feature zoo with 5 new collections.
5. **Benchmark-aware.** The improvement must be measurable via R@5/R@10 on the canary. If it can't move the needle on the 9 failing cases above, it's not worth building.
6. **Fail-closed.** One improvement at a time. Canary between each. No opportunistic bundling.

---

## 6. What I expect back

A structured memo with:

1. **Chunking strategy recommendations** — backed by reference code, not theory
2. **Index expansion strategy** — which LongMemEval expansion techniques to implement, prioritized
3. **Preference/userfact approach** — the real MemPalace code, adapted for Memongo
4. **Structured memory provenance** — fix or filter recommendation
5. **Priority order** — which improvement to build first, second, third
6. **Expected impact** — per miss category, which improvement addresses which failures

References must be specific: file paths with line numbers, paper sections, or URLs.

---

## 7. Reference material locations

| Source | Path |
|--------|------|
| MemPalace | `/Users/rom.iluz/Dev/memory-referance/mempalace/` |
| LongMemEval | `/Users/rom.iluz/Dev/memory-referance/LongMemEval/` |
| Supermemory | `/Users/rom.iluz/Dev/memory-referance/supermemory/` |
| Mem0 | `/Users/rom.iluz/Dev/memory-referance/mem0/` |
| Letta | `/Users/rom.iluz/Dev/memory-referance/letta/` |
| LangMem | `/Users/rom.iluz/Dev/memory-referance/langmem/` |
| Cognee | `/Users/rom.iluz/Dev/memory-referance/cognee/` |
| Hindsight | `/Users/rom.iluz/Dev/memory-referance/hindsight/` |
| Graphiti | `/Users/rom.iluz/Dev/memory-referance/graphiti/` |
| Mengram | `/Users/rom.iluz/Dev/memory-referance/mengram/` |
| MemOS | `/Users/rom.iluz/Dev/memory-referance/MemOS/` |
| Memongo (this repo) | `/Users/rom.iluz/Dev/Memongo/` |
| Canary artifacts | `.claude/cc10x/v10/workflows/memongo-memory-hardening/artifacts/canary-runs/` |

---

**End of memo. Waiting for your structured response before building anything.**
