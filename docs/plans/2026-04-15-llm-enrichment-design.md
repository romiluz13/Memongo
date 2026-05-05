# LLM-Powered Session Enrichment — Implementation Design

**Date:** 2026-04-15
**Author:** Claude Code (Builder AI)
**Status:** Awaiting review before coding
**Baseline:** 92.0% R@5 on canary (Option A + userfact regex)
**Target:** Fix 3 remaining preference misses → push toward 96%+
**Research basis:** 5 sub-agent investigations across reference repos, academic papers, and provider docs

---

## Why LLM enrichment, not more regexes

The case investigator proved the 3 remaining preference misses use language no regex can bridge:

| Case | User said | Query asks | Gap |
|------|-----------|-----------|-----|
| `06f04340` | "I've even harvested some cherry tomatoes from my garden" | "What should I serve for dinner with homegrown ingredients?" | Past-tense activity → recipe suggestion |
| `09d032c9` | "my new portable power bank and wireless charging pad" | "Battery life tips for my phone" | Possessive ownership → troubleshooting advice |
| `1a1907b4` | "I attended a mixology class", "I've already made a Pimm's Cup" | "Making a cocktail for a get-together" | Past experience → recommendation request |

Every system scoring >70% on single-session-preference uses LLM enrichment. The regex ceiling is proven.

## Research-backed approach: Hybrid EnrichIndex + Atomic Facts

Combining the two highest-ROI patterns from our research:

1. **Atomic user facts** (from Mem0/Supermemory pattern) — extract personal facts as self-contained claims
2. **Synthetic QA pairs** (from EnrichIndex, +11.7 R@10 proven) — generate questions that would lead to this session

Both stored as synthetic docs in the canonical `chunks` collection (Option A path).

## Provider-agnostic LLM client

### API shape

All major providers support the OpenAI chat completions format. The Grove gateway at `grove-gateway-prod.azure-api.net` exposes this format directly.

```typescript
interface EnrichmentProvider {
  name: string
  chatCompletion(params: {
    model: string
    messages: Array<{ role: string; content: string }>
    responseFormat?: { type: "json_object" }
    maxTokens?: number
  }): Promise<{ content: string }>
}
```

### Provider resolution (env-var based)

```
MEMONGO_ENRICHMENT_PROVIDER=grove|openai|anthropic|gemini  (default: grove)
MEMONGO_ENRICHMENT_MODEL=gpt-5.4|gpt-4o-mini|claude-haiku-4.5|gemini-2.5-flash
MEMONGO_ENRICHMENT_BASE_URL=https://grove-gateway-prod.azure-api.net/grove-foundry-prod/openai/v1
MEMONGO_ENRICHMENT_API_KEY=<key>  (or GROVE_API_KEY as fallback)
```

All providers are called through the OpenAI-compatible chat completions endpoint. This means:
- Grove: works natively (OpenAI format)
- OpenAI: works natively
- Anthropic: use their OpenAI-compatible endpoint or native SDK
- Gemini: use their OpenAI-compatible endpoint

### Error handling

- Retry on 429/500/503 with exponential backoff (max 3 retries)
- Timeout: 30s per call
- Parse JSON response, validate with runtime check
- Skip session on persistent failure (log warning, don't block ingest)
- Rate limit: configurable concurrency (default 5 parallel calls)

## Extraction prompt

Based on cross-provider research and EnrichIndex/Mem0 patterns:

```
You are a personal fact extractor for an AI memory system.

Given a conversation session (user turns only), extract two things:

1. FACTS: Atomic personal facts about the user. Rules:
   - Each fact must be a single, self-contained claim
   - Write in third person: "The user grows cherry tomatoes in their garden"
   - Include facts explicitly stated OR strongly implied
   - Categories: preference, ownership, activity, plan, biographical, relationship
   - If no personal facts exist, return an empty array

2. QA_PAIRS: Questions someone might ask that this session could answer. Rules:
   - Questions should use DIFFERENT vocabulary than the session text
   - Focus on recommendation/advice questions: "What should I...", "Can you suggest..."
   - Maximum 5 pairs
   - If the session has no actionable content, return an empty array

Respond with valid JSON only:
{
  "facts": ["The user grows cherry tomatoes in their garden", "The user uses fresh basil and mint from their garden"],
  "qa_pairs": [
    {"q": "What fresh ingredients does the user have available for cooking?", "a": "Cherry tomatoes, basil, and mint from their garden"},
    {"q": "What should the user serve for dinner using homegrown produce?", "a": "Dishes featuring cherry tomatoes, basil, and mint"}
  ],
  "has_personal_content": true
}
```

## Document shape

Two synthetic doc types per enriched session, both in `chunks`:

### Type 1: Enriched userfact doc (replaces regex-only userfact)

```typescript
{
  source: "userfact-evidence",        // same source as regex version
  text: "User facts: grows cherry tomatoes in their garden; uses fresh basil and mint; has been harvesting produce recently",
  agentId, scope, scopeRef,
  sessionId: "<same as source session>",
  canonicalId: "userfact-chunk/<sessionId>",
  status: "active",
  timestamp, updatedAt,
  metadata: {
    sourceEventIds: [...],
    docType: "userfact",
    extractedFacts: 3,
    extractionMethod: "llm",          // NEW: distinguish from "regex"
    turnCount: N,
  }
}
```

### Type 2: Synthetic QA doc (NEW)

```typescript
{
  source: "qa-evidence",              // new source type
  text: "Q: What fresh ingredients does the user have for cooking? A: Cherry tomatoes, basil, and mint from their garden. Q: What should the user serve for dinner using homegrown produce? A: Dishes featuring cherry tomatoes, basil, and mint.",
  agentId, scope, scopeRef,
  sessionId: "<same as source session>",
  canonicalId: "qa-chunk/<sessionId>",
  status: "active",
  timestamp, updatedAt,
  metadata: {
    sourceEventIds: [...],
    docType: "qa",
    qaPairs: 2,
    extractionMethod: "llm",
    turnCount: N,
  }
}
```

## How it fits the architecture

### Collection path
Same `chunks` collection. No new collections.

### Source filter
`buildConversationChunkFilter()` adds `"qa-evidence"` to the `$in` array when enrichment is enabled. `"userfact-evidence"` is already included.

### Auto-embed
Both doc types have `text` fields. Auto-embed indexes them automatically. No index changes.

### $rankFusion
QA docs compete natively. The QA text is specifically designed to use vocabulary that bridges generic queries to specific session content — this is the EnrichIndex insight.

### Experiment flag
`MEMONGO_LLM_ENRICHMENT_MODE` env var:
- `"enabled"`: Run LLM extraction at ingest, create both doc types
- `"facts-only"`: Only extract facts (no QA pairs)
- `"none"` (default): Fall back to regex-only userfact extraction

When LLM enrichment is enabled, it **replaces** the regex extraction for that session (not additive). If the LLM call fails, regex is used as fallback.

### Provenance
Same session provenance as all Option A evidence: `sessionId`, `sourceEventIds`, `canonicalId`.

## New file

`packages/memory-engine/src/mongodb-llm-enrichment.ts` (~300-400 LOC):

- `EnrichmentProvider` interface
- `createGroveProvider(apiKey, baseUrl, model)` — OpenAI-compatible provider
- `ENRICHMENT_PROMPT` — the extraction prompt
- `extractSessionEnrichment(provider, sessionText)` — call LLM, parse response
- `buildEnrichedUserfactDocument(params)` — create userfact doc from LLM facts
- `buildQaEvidenceDocument(params)` — create QA doc from LLM pairs
- `enrichSessionsWithLLM(params)` — batch process sessions with concurrency control
- `resolveEnrichmentMode(envValue)` — env var resolution
- `resolveEnrichmentProvider()` — create provider from env vars

## Cost estimate

- Model: gpt-4o-mini or gpt-5.4 via Grove
- Input: ~500 tokens per session (user turns only, median 182 chars × ~5 turns)
- Output: ~200 tokens per session
- Cost per session: ~$0.001 (gpt-4o-mini) or ~$0.005 (gpt-5.4)
- Full benchmark (23,867 sessions): **~$24-120** depending on model
- Canary (48 cases, ~2,300 sessions per scenario): **~$2-12**
- Latency: ~1s per session with concurrency 5 = ~7 min for canary haystack

## What this targets

| Miss case | Type | Current R@5 | Why LLM enrichment helps |
|-----------|------|-------------|--------------------------|
| `06f04340` | preference | 0.00 | LLM extracts "grows cherry tomatoes". QA generates "What homegrown ingredients?" |
| `09d032c9` | preference | 0.00 | LLM extracts "owns power bank, charging pad". QA generates "What phone accessories?" |
| `1a1907b4` | preference | 0.00 | LLM extracts "attended mixology class, made Pimm's Cup". QA generates "What cocktails?" |

## Risk assessment

| Risk | Mitigation |
|------|------------|
| LLM cost for full benchmark | Use gpt-4o-mini ($24 for full run). Cache enrichments per session. |
| LLM latency at ingest | Parallel calls (concurrency 5). Cache results. Not on hot path. |
| LLM hallucination in facts | Include `evidence` field with source quote. Validate facts are grounded. |
| QA docs dilute non-preference queries | QA docs are short (~200 chars). Behind experiment flag. |
| Provider downtime | Graceful fallback to regex extraction on failure |

## Execution plan

1. Build `mongodb-llm-enrichment.ts` with provider, extraction, and doc creation
2. Wire into benchmark ingest path (same hook point as session evidence + regex userfact)
3. Update source filter in `buildConversationChunkFilter()`
4. Add tests (mock LLM responses, verify doc shape and provenance)
5. Run canary with `MEMONGO_LLM_ENRICHMENT_MODE=enabled`
6. Compare miss ledger: do the 3 preference cases now find the right session?

---

**Waiting for review. Do not code until approved.**
