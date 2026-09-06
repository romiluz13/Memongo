# Dispositions: `docs/audits/2026-09-05-independent/test_review_learning.md` (TEST-01..10)

Verified against HEAD `d9784266d2`. Audit line numbers are from the frozen 2026-09-05 snapshot; evidence below cites current HEAD. Findings describe test-code constructs; classes reflect whether the cited construct still exists unchanged at HEAD.

## Summary table

| ID | Priority | Short title | Class | Evidence |
|---|---|---|---|---|
| TEST-01 | P1 | Evaluation doesn't provision the novelty path it measures; rewards its failure | OPEN_IN_HEAD | Setup still creates manual `idx_events_vector` on `embedding` (`packages/memory-engine/src/e2e-evaluation.e2e.test.ts:263-276`) while production resolves `${prefix}events_vector` (`packages/memory-engine/src/mongodb-novelty.ts:41-43`); `mongot_unavailable`/empty still earns degradation=100 + accuracy=70 (`e2e-evaluation.e2e.test.ts:1785-1794`); weighted math unchanged (`:112-113`) |
| TEST-02 | P1 | Quality/constraint test titles exceed asserted guarantees | OPEN_IN_HEAD | `makeExecutePass` still bypasses public boundaries and hardcodes `reranked:false` (`packages/memory-engine/src/production-readiness.e2e.test.ts:3328-3371`); adversarial-constraint test still checks `constraintsApplied` strings + pass count only, never zero results from nonexistent session (`:3456-3499`); cache-coherence test still compares signatures/pass structure without touching a cache (`:3623-3668`); semantic-cache test still accepts `["semantic","miss"]` (`:1229-1245`) |
| TEST-03 | P2 | "Transactional/retry" tests introduce no failure | OPEN_IN_HEAD | `withTransaction retries on transient errors` still runs one successful transaction, no transient error/retry counter/failpoint (`packages/memory-engine/src/mongodb-e2e.e2e.test.ts:1018-1047`) |
| TEST-04 | P2 | Explain helper can miss SBE COLLSCAN; no examined/returned budgets | OPEN_IN_HEAD | `hasCollScan` handles `inputStage`/`inputStages`/`queryPlanner.winningPlan`/`stages` but still not a `winningPlan.queryPlan` wrapper (`packages/memory-engine/src/production-readiness.e2e.test.ts:296-335`); still no `totalDocsExamined`/`nReturned` assertions anywhere in the file |
| TEST-05 | P1/P2 | Tests explicitly preserve problematic policies (7 items) | OPEN_IN_HEAD | All seven persist: (1) full token in startup error (`apps/api/src/app.segment2.test.ts:760-768`); (2) NOOP keeps `sourceEventIds:["evt-original"]` while processing the new event (`packages/memory-engine/src/mongodb-consolidator-state.test.ts:259,277`); (3) `conflictsResolved:1` with resolution disabled / no provider (`packages/memory-engine/src/mongodb-consolidator.part3.test.ts:675,693`); (4) fabricated-premise inference `from:["x","y"]` (`packages/memory-engine/src/mongodb-consolidator.part2.test.ts:650`); (5) invalid `fusionMethod`/`status` dropped (`apps/api/src/app.segment4.test.ts:773`, `apps/api/src/app.segment3.test.ts:1247-1257`); (6) eventId-only processing filters (`packages/memory-engine/src/mongodb-consolidator.part2.test.ts:530,1166`); (7) deletion succeeds on audit failure (`packages/memory-engine/src/mongodb-graph.segment2.test.ts:681-711`) |
| TEST-06 | P2 | Provenance/temporal property tests stop below advertised guarantee | PARTIAL | Cited property tests unchanged (array filtered through `isMemoryValidAt`, `packages/memory-engine/src/mongodb-bitemporal.test.ts:92-154`); but WS-15 `a8cdf60d96` added a live native bitemporal vector-prefilter suite with per-run DB (`packages/memory-engine/src/mongodb-vector-bitemporal.e2e.test.ts:17,48-249`) and chunk bitemporal filter-field pins (`packages/memory-engine/src/mongodb-schema.part4.test.ts:348-368`); public as-of/revision round-trip and reasoning-chain evidence-support gaps remain |
| TEST-07 | P2 | Graph tests don't verify direction-preserving evidence rendering | OPEN_IN_HEAD | Dedup test still returns the same forward edge as both forward and reverse (`const reverseRel = { ...forwardRel }`, `packages/memory-engine/src/mongodb-graph.test.ts:1200-1266`); no search test asserts rendered subject/predicate/object direction (grep `direction`/`incoming` over `*search*.test.ts`: no matches) |
| TEST-08 | P2 | Isolation tests choose identities that avoid the collision | OPEN_IN_HEAD | KB isolation e2e still uses only distinct default agent scopeRefs (`packages/memory-engine/src/mongodb-kb-isolation.e2e.test.ts:98-192`); unique index still omits agentId (`uq_kb_scope_hash` on `{scopeRef,hash}`, `packages/memory-engine/src/mongodb-schema-standard-indexes-core.ts:118-125`); mocked 11000-as-clean-dedup persists (`packages/memory-engine/src/mongodb-kb.test.ts:155-176`); agentId-only scoped key reaching agent-global `/v1/stats` with mocked bridge persists (`apps/api/src/app.test.ts:1174-1188`) |
| TEST-09 | P2 | Fixed end-to-end databases permit cross-run interference | OPEN_IN_HEAD | `memongo_evaluation` fixed with eval_* collection drops (`packages/memory-engine/src/e2e-evaluation.e2e.test.ts:57-58,253,313`); `memongo_e2e_test` fixed with whole-DB drops (`packages/memory-engine/src/mongodb-e2e.e2e.test.ts:64-65,130,135`) |
| TEST-10 | P2 | Contract/security/export tests narrower than their names | OPEN_IN_HEAD | Route table test still checks format only (`packages/lib/src/contract.test.ts:165-181`); "rebinding guard" still one mocked DNS lookup (`packages/lib/src/ssrf.test.ts:270-278`); export determinism still signs the same bundle twice (property-based now, same construct, `packages/memory-bridge/src/memongo-export.test.ts:251-287`) |

## Notes

- **TEST-01**: the scorecard arithmetic the audit computed (`(70+100)/2*0.15 + 85 = 97.75`) is unchanged — the novelty lane can still be skipped entirely while the suite passes its 90 overall threshold. Highest-value test repair in this document.
- **TEST-05**: the finding itself says "first decide the product invariant, then align implementation and tests" — these are policy decisions, not mechanical reversals. None of the seven sites was touched by WS-05..WS-19.
- **TEST-06**: PARTIAL only because WS-15 delivered genuinely new live bitemporal retrieval coverage the audit asked for; the cited helper-level property tests and the public-path (API date conversion, as-of revision, storedSource expiry combination) gaps remain.
- **TEST-08**: WS-13 hardened KB reads, but the specific collision vector (two agents sharing one global/user/session scopeRef against a scopeRef-only unique index) is still untested and the index still omits agentId.

## Existing tests that encode/assert wrong policies (test-honesty pass candidates)

Extracted from `docs/audits/2026-09-05-independent/test_review_write.md` and `test_review_retrieval.md`; all paths re-verified to exist at HEAD, key constructs spot-checked unchanged.

### From test_review_write.md

| Test file | Wrong policy encoded | Verified at HEAD |
|---|---|---|
| `packages/tools/src/vercel/index.test.ts:554-579` | Identical repeated prompt treated as the same logical retry with equal capture keys (PI03 content-vs-occurrence) | Yes — "Retry of the same logical turn reuses the same keys" |
| `apps/mcp/src/tool-registry.test.ts` | Asserts admin aliases present while canonical admin tools disabled (preserves PI01) | File exists; construct not re-verified line-by-line |
| `packages/memory-engine/src/mongodb-tenant-erasure.test.ts` | Expects `relevance_runs` deleted even when phase-1 artifact join fails; partial first receipt accepted, never retried (W02 destructive reachability loss) | File exists |
| `packages/memory-engine/src/mongodb-audit-integration.test.ts` | Primary success accepted when audit insertion fails (best-effort audit) | File exists |
| `packages/memory-engine/src/mongodb-self-edit.test.ts` | User blocks exempt from injection classification; user source/confidence pinned at 1 | File exists |
| `packages/memory-engine/src/mongodb-chunk-retention.test.ts:328,359` | Window takes latest expiry of all member events; any permanent event makes the whole mixed window permanent (retention policy mismatch vs per-event deletion) | Yes — `:359` "keeps a window permanent when any of its events never expires" |
| `packages/memory-engine/src/mongodb-consolidator-state.test.ts`, `mongodb-consolidator.part2/part3.test.ts`, `app.segment2/3/4.test.ts`, `mongodb-graph.segment2.test.ts` | (The seven TEST-05 items — see table above) | Yes |

### From test_review_retrieval.md

| Test file | Wrong policy encoded | Verified at HEAD |
|---|---|---|
| `scripts/benchmark/mongodb-manager-benchmark-scenario.test.ts:369` | Expects QA envelope `e2eQa` to be undefined (B02) | Yes — `expect(result.e2eQa).toBeUndefined()` |
| `scripts/benchmark/mongodb-benchmark-runner.test.ts:596,620,725` | Requires fixed duplicate rank slots, no duplicate DCG gain, native flattened attribution labeled canonical (B01) | File exists |
| `scripts/benchmark/mongodb-manager-benchmark.part2.test.ts:613` | Requires `gatePass=1`; extra passes are query-loop repeats, not independent ingest trials (B09) | File exists |
| `scripts/benchmark/benchmark-parity-envelope.test.ts:315` | Validates collStats `size`/`storageSize` mislabel fixture (physical accounting mislabel) | File exists |
| `scripts/benchmark/mongodb-conversation-recall-benchmark.test.ts:93` | Fake matcher accepts every unknown field incl. scope/scopeRef/expiresAt — gate required for publication can't prove tenant isolation/expiration | File exists |
| `packages/memory-engine/src/mongodb-query-cache-invalidation.test.ts` | Requires invalidation failures to resolve as zero (availability-over-freshness policy) | File exists |
| `packages/memory-engine/src/mongodb-search-executor.test.ts:1134-1181` | Explicitly expects time-constraint removal on caller `timeRange` (encodes RET-01 relaxation) | Yes — `:1134` "triggers constraint relaxation when all results are rejected" |
| `packages/memory-engine/src/mongodb-context-bundle.test.ts` | Recent-events filters without expiresAt/bitemporal predicates; Direct Evidence from confidence=1.0 alone | File exists |
| `packages/memory-engine/src/mongodb-manager-search.part2.test.ts:559` | Accepts recorded aggregation count <= actual DB calls (allows accounting undercount) | File exists |
| `packages/memory-engine/src/mongodb-manager-search.part2.test.ts:854` | Lane coverage incremented from extracted candidates while promotion never runs (activity reported as coverage) | File exists |
| `packages/memory-engine/src/mongodb-conversation-recall.test.ts` | Names fourfold overfetch as "eliminating starvation" but asserts only numeric greater-than | File exists |

Note: these are audit-identified candidates for modification/removal in a test-honesty pass; per TEST-05's own guidance, decide the product invariant before reversing any assertion.
