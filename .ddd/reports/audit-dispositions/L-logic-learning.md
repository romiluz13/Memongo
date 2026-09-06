# Dispositions: docs/audits/2026-09-05-independent/logic_learning.md (L01–L22)

Verified against HEAD `d9784266d2` (2026-09-05 post-remediation tree). All paths
repo-relative; `packages/memory-engine/src/` abbreviated as `src/` below.

| ID | Priority | Short title | Class | Evidence |
|---|---|---|---|---|
| L01 | P1 | Preference extraction destroys positive/negative meaning | OPEN_IN_HEAD | Preference regex still non-capturing on the verb, key hashes object only: `src/mongodb-derived-memory.ts:277`, `:286`. Supporting evidence still matches object text only: `src/mongodb-derived-memory.ts:400`. |
| L02 | P1 | Quarantined new facts can still invalidate accepted facts | OPEN_IN_HEAD | `writeStructuredMemory` still returns `{upserted:false, quarantined:true}` without throwing: `src/mongodb-structured-memory.ts:991-996`. Promoter checks only `result.upserted` (`src/mongodb-derived-memory.ts:757`) and feeds ALL promotable facts (quarantined included) to `invalidateContradictedFacts`: `src/mongodb-derived-memory.ts:793-804`. |
| L03 | P1 | Contradiction = latest ingestion wins | OPEN_IN_HEAD | newFacts payload still key/value only: `src/mongodb-derived-memory.ts:797-803`. Handle still `revision: 0`, and revision 0 is explicitly non-enforceable: `src/mongodb-contradiction.ts` (handle build ~:185), `src/mongodb-structured-memory.ts:687-689,704-714`. Existing candidates filtered by state+TTL only, not validity: `src/mongodb-contradiction.ts` query ~:155-172. |
| L04 | P1 | End-only temporal statements become indefinitely current | OPEN_IN_HEAD | `if (!validFrom) { return fallback }` still returns before reading `validTo`: `src/mongodb-temporal-extraction.ts:128-131`. |
| L05 | P1 | Relation validTo accepted but not persisted | OPEN_IN_HEAD | `validTo` still mapped only to `reviewAt`: `src/mongodb-graph.ts:258-267,554`. No `$unset` of stale `validTo` on reactivation; changed branch still resets `validFrom = now`: `src/mongodb-graph.ts:650`. `hasRelationChanged` still compares sourceEventIds/provenance: `src/mongodb-graph.ts:215-246`. |
| L06 | P1 | Historical model overwrites valid-time with transaction-time | OPEN_IN_HEAD | Revision snapshots still stamp `validTo: params.now` unconditionally: `src/mongodb-structured-memory.ts:563`, `src/mongodb-procedures.ts:379`. Invalidation stamps wall-clock now: `src/mongodb-structured-memory.ts:1573`. Search reads only the current collection with `state:"active"` + current-validity clause: `src/mongodb-structured-memory.ts:1975-1976`. |
| L07 | P1 | Retention/validity lost when observations become derived memory | OPEN_IN_HEAD | Job event read has no unexpired guard: `src/mongodb-manager-jobs.ts:361-371`. Dreamer scan has no TTL guard: `src/mongodb-consolidator.ts:511-512`. Derived candidate base carries no `expiresAt`: `src/mongodb-derived-memory.ts:232-253`; Dreamer promotion entry omits expiresAt/sessionId/validFrom: `src/mongodb-consolidator.ts:956-981`. No `expiresAt` anywhere in `src/mongodb-episodes.ts` or `src/mongodb-procedures.ts`. |
| L08 | P1 | Similarity pruning destroys distinct/contradictory memories | OPEN_IN_HEAD | NOOP gate still fires on score > 0.85 with a filter lacking type/state/validity (only agentId/scope + post-ANN TTL): `src/mongodb-consolidator.ts:188,883-924`. Prune still invalidates the older of a >0.92 pair with no entailment/polarity/temporal check: `src/mongodb-consolidator.ts:1412-1423`. |
| L09 | P1 | Consolidator merge/prune bypass revision, CAS, audit, cache | OPEN_IN_HEAD | Merge still updates kept doc by `_id` and sets loser `state:"invalidated"` with no revision precondition, no snapshot, no validTo, no cache invalidation: `src/mongodb-consolidator.ts:1290-1312`. Prune likewise state-only: `src/mongodb-consolidator.ts:1421-1423`. In-memory survivor still not refreshed between merges. |
| L10 | P1 | Dreamer lease fences completion only | OPEN_IN_HEAD | `leaseToken` is used only at gate claim (`src/mongodb-consolidator.ts:434,464`) and terminal completion (`:552,:1468`); no heartbeat/fence before fact writes, inference, merge, prune, or event acknowledgement. Scoped/unscoped gates remain intentionally separate: `src/mongodb-consolidator.ts:299-306`. |
| L11 | P1 | Reasoning outputs accept invented premises; no chain linkage | OPEN_IN_HEAD | Parser still accepts empty/invented `from`: `src/mongodb-consolidation-reasoning.ts:80-98`. Inferred entries store only prose `derivedFrom`, no premise IDs/sourceEventIds: `src/mongodb-consolidation-reasoning.ts:179-208`. Reasoning input still filters only state!=invalidated + TTL: `src/mongodb-consolidator.ts:1063-1071`. No dependency-edge invalidation exists. |
| L12 | P1/P2 | Reasoning-chain API cannot uniquely identify scoped facts | OPEN_IN_HEAD | Start match still `{[idField]: factId, agentId}` + `results[0]`, no scope/type/revision: `src/mongodb-reasoning-chain.ts:108-127`. Leaf event lookup omits `expiresAt`: `src/mongodb-reasoning-chain.ts:159-164`. Unknown/missing root still returns `chainComplete: true`: `src/mongodb-reasoning-chain.ts:84`. (An allowlist now exists, WS-08, but the identity/leaf/completeness defects persist.) |
| L13 | P2 | Reverse multihop expansion selects wrong connected entity | OPEN_IN_HEAD | Connection target still `toEntityId === entityId ? from : to`, so transitive C→B (root A) selects B not C: `src/mongodb-graph.ts:1209-1213`. Bidirectional = two separate directional aggregations, not undirected BFS: `src/mongodb-graph.ts:1062-1176`. Depth still `maxDepth-1` for graphLookup, direct edges counted separately: `src/mongodb-graph.ts:1032`. |
| L14 | P1 | Graph bulk failures swallowed, published as success | OPEN_IN_HEAD | Non-duplicate bulkWrite failures still warn-and-continue: `src/mongodb-graph.ts:1526-1530`; duplicate-retry failures also swallowed: `:1545-1549`. `relationsCreated` incremented before persistence: `:1878`. Caller returns all extracted entities, emits ok telemetry and `status:"ok"` projection runs with `itemsProjected = extracted.length`: `:1902-1935`; job marks graph lane available on `entities.length > 0`: `src/mongodb-manager-jobs.ts:404-413`. |
| L15 | P2 | Re-observation reverses rejected links; unbounded provenance | PARTIAL | Fixed: entity bulk path caps sourceEventIds at 200 via `$slice`: `src/mongodb-graph.ts:1702-1723`; canonical `upsertRelation` caps via `mergeSourceEventIds`: `src/mongodb-graph.ts:196-212`. Remaining: co-mention relation/link ops still use raw uncapped `$addToSet`: `src/mongodb-graph.ts:1834-1836,1873-1875`; `upsertEntityLink` sets sourceEventIds wholesale: `:784-786`; procedures merge uncapped and revisions copy the full set: `src/mongodb-procedures.ts:184-194,415-419`; co-mention still `$set status:"active"` unconditionally, reversing rejected links: `src/mongodb-graph.ts:1824` and `upsertEntityLink` `:770-800`. |
| L16 | P1/P2 | Structured creation/history race holes despite CAS | PARTIAL | Fixed: E11000 duplicate-key retry for sessionless creation (Fleet P1-2, commit 0ac9577820): `src/mongodb-structured-memory.ts:1317-1337`. Remaining: upsert that matches a concurrently inserted identity still overwrites with `revision:1` and no snapshot (`:1125-1144`); `expectedRevision` enforced only when the record exists — deletion-then-recreate resurrects (`:1166-1178` vs `:1125`); revisionless legacy rows can never match the CAS filter `revision:1` (`:1188-1203`); revision snapshot inserted BEFORE the CAS update in sessionless writes, so a loser persists wrong history (`:1220-1223` before `:1279`). |
| L17 | P1 | KB path identity vs parent identity divergence | OPEN_IN_HEAD | Dedup still looks up `source.path = title` while the inserted parent preserves the missing `source.path`: `src/mongodb-kb.ts:186-190,283-287`. Force still queries only the NEW hash, never the path: `src/mongodb-kb.ts:240-245`. Parent uniqueness still hash-based while chunks are keyed by `(scopeRef, path, startLine, endLine)`: `src/mongodb-kb.ts:252-275`. |
| L18 | P2 | File KB auto-refresh cannot use transaction client | OPEN_IN_HEAD | `ingestFilesToKB` has no `client` param and scan/read errors are log-only (not in `result.errors`): `src/mongodb-kb.ts:547-566,580-585,610-614`. Manager passes no client and advances `kb_last_auto_refresh` unconditionally: `src/mongodb-manager-sync.ts:370-389`. |
| L19 | P1/P2 | One isolated old event permanently blocks auto episodes | OPEN_IN_HEAD | session_gap trigger still checked first and always wins: `src/mongodb-episodes.ts:997-1006`; window resolver still returns only the pre-gap slice: `:142-150`; a singleton slice still returns `insufficient_events` with no acknowledgement or cursor advance: `:1024-1027`. The WS-16 negative memo only defers re-checks ~60s, it does not unblock: `:968-970`. |
| L20 | P2 | Profile/discovery disagree with current-validity reads | OPEN_IN_HEAD | Profile structured facet checks state+TTL only (no validFrom/validTo): `src/mongodb-profile.ts:133-141`. Relation popularity counts include invalidated edges: `src/mongodb-profile.ts:186-221`. Entity/topic brief structured queries check `state:"active"` + TTL only: `src/mongodb-discovery-projections.ts:486-502`. Novelty event filter has no `expiresAt` guard: `src/mongodb-novelty.ts:102-119`. |
| L21 | P2 | Session aggregate retention extends expired constituents | OPEN_IN_HEAD | Session evidence still inherits the LATEST constituent expiry (now a documented choice): `src/mongodb-session-evidence.ts:215-217,251-266`. Userfact and mirror evidence still omit `expiresAt` entirely (no occurrences in `src/mongodb-userfact-evidence.ts` / `src/mongodb-evidence-mirror.ts`). Reachability still benchmark-only: `scripts/benchmark/mongodb-manager-benchmark.ts`. |
| L22 | P2 | Promised capabilities disconnected/weaker in live path | OPEN_IN_HEAD | Extraction job still passes no extractor → regex default: `src/mongodb-manager-jobs.ts:391-401`, `src/mongodb-graph.ts:1580`, `src/mongodb-entity-extractor.ts:155`. `withTieredSummaries` still drops the episode `type` when invoking the base summarizer: `src/mongodb-tiered-summary.ts:99-105`. Dreamer still calls `traceReasoningChain` with `collection: "events"`, outside the allowlist → empty result with `chainComplete: true`: `src/mongodb-consolidator.ts:822-831`, `src/mongodb-reasoning-chain.ts:44-50,84-97`. |

## Notes on PARTIAL / ambiguous cases

- **L15 (PARTIAL):** Two independent defects. (a) Review-disposition reversal is
  fully open — every automated co-mention re-`$set`s `status:"active"` on the
  canonical link identity with no terminal-review guard. (b) Unbounded
  provenance is partially fixed: the entity bulk path and canonical
  `upsertRelation` now cap `sourceEventIds` at 200, but the co-mention
  relation/link bulk ops and `upsertEntityLink` still grow arrays uncapped, and
  procedures (merge + revision snapshots) remain uncapped.
- **L16 (PARTIAL):** Commit 0ac9577820 added a duplicate-key retry that covers
  the insert-rejected (E11000) variant of the creation race. The audit's other
  three holes are untouched: match-and-overwrite on concurrent creation (no
  `upsertedCount === 0` detection/retry, unlike procedures), `expectedRevision`
  not enforced when the record is missing (resurrection), revisionless legacy
  rows permanently failing the `revision: 1` CAS filter, and the
  snapshot-before-CAS ordering in sessionless writes. The match-and-overwrite
  race also still wants live interleaving confirmation (audit-flagged).
- **L12:** WS-08 added a route/engine allowlist (C-015), which removes the
  "fabricated chain for unknown collection" vector but does not touch the
  finding's core: unscoped `{key, agentId}` + `results[0]` identity, unguarded
  leaf-event TTL, `fromEntityId` collision for relations, and
  `chainComplete: true` for missing roots.
- **L08/L14/L20:** Peripheral guards landed (post-ANN TTL matches, state
  exclusions in prune/dedup candidate sets, duplicate-key retry in graph bulk
  writes) but each finding's described destructive/incorrect behavior is still
  reachable on the same code paths; classified OPEN rather than PARTIAL because
  no element of the core defect was removed.
- **L21:** The latest-expiry inheritance is now explicitly documented as
  intended ("stays readable as long as any of its content is"), which weakens
  the "accidental leak" framing but does not change the mechanism the finding
  objects to; deployment reachability remains benchmark-only, as the audit
  itself flagged.
- **No STATIC_UNVERIFIABLE:** every finding's cited construct was locatable and
  classifiable by source inspection. Race-strength claims within L16 retain the
  audit's original caveat.
