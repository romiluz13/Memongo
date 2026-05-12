# Scope-expansion SE-4 — Exportable-memory Guarantee (4-layer evidence)

> Task 2.SE-4 (ADR-006). Capability file:
> `packages/memory-bridge/src/memongo-export.ts` (new, scope-4).
>
> **fast-check seed (correctness invariant): 20260512.**

## Motivation

Users can export every memory scoped to an `agentId` as a signed JSON
bundle and verify integrity off-line. This is the durability plank of
ADR-006 — own-your-memory posture.

## Silent-bug risks

- Non-deterministic serialization (maps/objects with insertion-order
  dependency produce different signatures for the same data).
- Weak signature (e.g., truncated HMAC) accepting forgeries.
- Signing with an empty key silently "succeeds".
- **CRIT-6 (remfix):** `JSON.stringify` silently renders `Map`/`Set` as
  `{}`, and a naive deep-sort drops `Date` objects to `{}` as well. Any
  memory field of those types would be silently lost on export.

## Layer 1 — Unit

Tests at `packages/memory-bridge/src/memongo-export.test.ts`:

- `canonicalizeExportBundle` is stable under key-insertion-order
  permutations.
- `signExportBundle` produces 64-char lowercase-hex HMAC-SHA256 digest;
  deterministic for same input+key.
- Signature changes when bundle changes; signature changes when key
  changes.
- `verifyExportBundle` rejects tampered bundle, wrong key, malformed
  signature. Uses `timingSafeEqual`.
- Empty signing key → **throws** (strict mode, no silent fallback).
- **CRIT-6 remfix:** `canonicalize()` now tags non-plain-object values so
  JSON never drops them silently:
  - `Date` → ISO-8601 string.
  - `Buffer` / `Uint8Array` → `{ __type: "Buffer", base64: string }`.
  - `Map` → `{ __type: "Map", entries: [[k,v],...] }` (key-sorted).
  - `Set` → `{ __type: "Set", values: [...] }` (JSON-sorted).
  Tests cover all four types and assert `Map` is stable across insertion
  orders (`memongo-export.test.ts` — 5 new cases in the "non-JSON type
  handling (CRIT-6)" describe block).
- Exit-code: `CI=true bunx vitest run
  packages/memory-bridge/src/memongo-export.test.ts` → exit 0, 15/15
  passed (2026-05-12, commit covers CRIT-6 + original SE-4 baseline).

## Layer 2 — Integration (deferred)

Bridge entry `memongoBridgeExportAgent` is scaffolded as follow-on
wiring. Integration test against atlas-local:preview will:

- Insert N events for an agent.
- Export → sign → record bundle hash.
- Export again with no intervening writes → expect byte-identical
  bundle + identical signature.
- Insert one more event; export; expect a different signature.

## Layer 3 — E2E (deferred)

- `POST /v1/export/{agentId}` end-to-end via web → API → bridge →
  MongoDB.
- Verify via `verifyExportBundle` in the client SDK
  (`packages/client/src/client.ts`).
- Latency budget: < 5s for a 10k-event corpus.
- AI SDK tool surface: `memongo_export_agent` (follow-on).

## Layer 4 — Correctness invariant (fast-check)

- **Property 14 (plan line 553):** two exports of the same scopeRef
  with no intervening writes produce byte-identical signatures.
- Generator: random `ExportBundle` shapes (bounded event count,
  arbitrary signing keys).
- Assertion: `signExportBundle(b, k) === signExportBundle(b, k)` every
  run, and `verifyExportBundle` round-trips.
- Seed: **20260512**, 200 runs.

## Commands

```bash
CI=true bunx vitest run packages/memory-bridge/src/memongo-export.test.ts
# 2026-05-12: exit 0, 15/15 passed (SE-4 baseline + CRIT-6 non-JSON canonicalization).
```

## Open items (follow-on)

- Bridge `memongoBridgeExportAgent` + API route + client method + AI SDK
  tool land as a follow-on commit on scope-4. The core determinism
  invariant is proven here first; wiring is mechanical.
- Streaming export for very-large corpora (>100k events): NDJSON +
  running HMAC — defer to Gate 5 scale testing.

## Citations

- Node `crypto.createHmac` + `crypto.timingSafeEqual`.
- ADR-006 user-approved scope expansion (plan pass-3 E6).

_Last updated: 2026-05-12._
