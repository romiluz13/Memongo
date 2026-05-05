# Synthetic Preference/Userfact Evidence — Implementation Design

**Date:** 2026-04-15
**Author:** Claude Code (Builder AI)
**Status:** Awaiting review before coding
**Baseline:** ~88-92% R@5 on canary (Option A, user-only session evidence)
**Target:** Lift single-session-preference from 62-75% toward 87-100%

---

## What this is

Rule-based extraction of user preferences and personal facts from conversation turns at benchmark ingest time, creating synthetic evidence documents in the canonical `chunks` collection (Option A path) with full session provenance.

Implementation note: the runtime surface should use the broader `userfact-evidence` name, while continuing to honor the legacy `MEMONGO_PREFERENCE_EVIDENCE_MODE` flag as a compatibility alias.

## Reference implementations

| Source | Approach | Key detail |
|--------|----------|------------|
| MemPalace `longmemeval_bench.py:1138-1213` | 16 regex patterns, rule-based, no LLM | Synthetic docs: `"User has mentioned: X; Y; Z"` with same `sess_id` |
| MemPalace `HYBRID_MODE.md:280-400` | Preference Wing + Diary Mode | Same session identity mapping |
| LongMemEval `batch_expansion_session_userfact.py` | LLM-based (Llama-3.1-8B) | `"Extract all personal information, life events, preferences..."` |

**Key insight from MemPalace:** Synthetic docs carry the **same session ID** as their source session. This is how they count toward retrieval recall.

## Extraction patterns

Adapted from MemPalace's 16 patterns, tuned for the LongMemEval corpus:

```typescript
const PREFERENCE_PATTERNS: RegExp[] = [
  /i prefer ([^,\.!?]{5,60})/i,
  /i usually ([^,\.!?]{5,60})/i,
  /i(?:'m| am) (?:a fan of|into|fond of) ([^,\.!?]{5,60})/i,
  /i(?:'ve| have) (?:always |really )?(?:liked|loved|enjoyed) ([^,\.!?]{5,60})/i,
  /i want to ([^,\.!?]{5,60})/i,
  /i(?:'m| am) thinking (?:about|of) ([^,\.!?]{5,60})/i,
  /i(?:'ve been| have been) having (?:trouble|issues?|problems?) with ([^,\.!?]{5,80})/i,
  /i (?:just )?(?:bought|got|purchased|ordered|picked up) (?:a |an |the )?([^,\.!?]{5,80})/i,
  /i(?:'m| am) (?:currently |now )?(?:using|working with|driving|wearing) (?:a |an |the )?([^,\.!?]{5,80})/i,
  /my (?:favorite|favourite) ([^,\.!?]{5,60})/i,
  /i(?:'m| am) (?:looking for|searching for|trying to find) ([^,\.!?]{5,60})/i,
  /i(?:'m| am) (?:planning|going) to ([^,\.!?]{5,60})/i,
  /i(?:'ve| have) (?:been|started) ([^,\.!?]{5,60})/i,
  /lately[,\s]+(?:i(?:'ve| have) been|i(?:'m| am)) ([^,\.!?]{5,80})/i,
  /i (?:really )?(?:need|could use) ([^,\.!?]{5,60})/i,
  /i(?:'ve| have) (?:recently )?(?:moved|switched|changed|upgraded) (?:to )?([^,\.!?]{5,80})/i,
]
```

## Document shape

```typescript
{
  source: "userfact-evidence",            // new source discriminator
  text: "User has mentioned: bought a Sony A7R IV camera; looking for compatible flash units; prefers Sony ecosystem",
  agentId: "<scenario-agent>",
  scope: "agent",
  scopeRef: "agent:<scenario-agent>",
  sessionId: "<same session ID as source>", // critical for benchmark recall
  canonicalId: "userfact-chunk/<sessionId>", // new canonical prefix
  status: "active",
  timestamp: <session timestamp>,
  updatedAt: <session timestamp>,
  metadata: {
    sourceEventIds: [...],                  // same source event IDs as session
    docType: "userfact",
    extractedFacts: 3,                      // count of matched patterns
  }
}
```

## How it fits the architecture

### Collection path
Same `chunks` collection as Option A session evidence. No new collection.

### Source filter
`buildConversationChunkFilter()` at `mongodb-manager.ts:925` adds `"userfact-evidence"` to the `$in` array when the feature flag is active.

### Auto-embed
The `chunks_vector` auto-embed index embeds the `text` field. New docs get embedded automatically. `source` is already a filter field in the index definition. No index changes needed.

### $rankFusion
Preference docs compete natively in the same `$rankFusion` pipeline as conversation chunks and session evidence. The vocabulary-bridging text ("User has mentioned: bought a Sony A7R IV") is designed to score well against generic queries ("suggest accessories for my photography setup").

### Experiment flag
`MEMONGO_USERFACT_EVIDENCE_MODE` env var:
- `"enabled"`: Extract and create preference docs at ingest
- `"none"` (default): No preference evidence

Legacy compatibility: `MEMONGO_PREFERENCE_EVIDENCE_MODE` should remain accepted as an alias until the benchmark workflow fully migrates.

### Provenance
- `sessionId`: Same as source session (enables benchmark R@5 matching)
- `canonicalId`: `pref-chunk/<sessionId>` (distinct from `session-chunk/<sessionId>`)
- `sourceEventIds`: Same event IDs as the session evidence doc
- `metadata.docType`: `"preference"` (distinct from `"session"`)

## Where it hooks in

### Ingest time (`mongodb-manager.ts:~2548-2601`)
After session evidence creation, add preference extraction in the same block:

```
if (preferenceMode === "enabled") {
    const count = await writePreferenceEvidence({
        chunksCollection,
        conversations: scenario.conversations,
        agentId: scenarioManager.agentId,
        scope: "agent",
        scopeRef,
        eventIds: sessionEventMap,
    })
}
```

### Search time (`mongodb-manager.ts:925-935`)
Add `"userfact-evidence"` to the source filter when mode is enabled.

## New file

`packages/memory-engine/src/mongodb-userfact-evidence.ts` (~200-250 LOC):

- `PREFERENCE_PATTERNS` — 16 regex patterns
- `extractUserfactFacts(text: string): string[]` — run all patterns, deduplicate
- `buildUserfactEvidenceDocuments(params)` — one doc per session with extracted facts
- `writeUserfactEvidence(params)` — insert into chunks collection
- `resolveUserfactEvidenceMode(envValue, legacyEnvValue?)` — env var resolution

## What this targets in the miss ledger

| Miss case | Type | R@5 | Why preference evidence helps |
|-----------|------|-----|-------------------------------|
| `06f04340` | preference | 0.00 | "What should I serve for dinner" — user mentioned homegrown ingredients |
| `09d032c9` | preference | 0.00 | "Battery life tips for my phone" — user mentioned phone model |
| `1a1907b4` | preference | 0.00 | "Cocktail suggestions" — user mentioned preferences in prior turns |

The synthetic doc `"User has mentioned: having trouble with battery life; using iPhone 13 Pro"` bridges the gap between "battery life tips" and "iPhone 13 Pro."

## What this does NOT target

- Multi-session partial recall (turn-selection category) — needs different fix
- Temporal misses — needs date-aware pruning
- Knowledge-update misses — needs recency semantics

## Success criteria

1. single-session-preference lifts from 62-75% toward 87-100%
2. No regression on multi-session, single-session-user, single-session-assistant (all at 100%)
3. Clear canary comparison against frozen baseline
4. Provenance remains clean (sessionId, canonicalId traceable)

## Risk assessment

| Risk | Mitigation |
|------|------------|
| Preference docs dilute non-preference queries (like assistant turns did) | Preference docs are short (~100-300 chars), tightly focused. Unlike assistant turns (1600+ chars of verbose text), these are vocabulary-bridging summaries. |
| Regex patterns don't match LongMemEval preference language | Patterns adapted from MemPalace which was tested on the same benchmark |
| Too many false-positive extractions inflate the collection | Cap at 10 facts per session (same as MemPalace), skip sessions with 0 matches |
| Source filter expansion breaks existing search paths | Behind experiment flag, only adds to filter when explicitly enabled |

---

**Waiting for review before coding.**
