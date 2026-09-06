# Master finding-index — 2026-09-05 independent audit dispositions

Compiled: 2026-09-06, from the 14 per-document disposition fragments in this
directory (each finding cross-referenced against HEAD d9784266d2 by an
independent worker subagent; class counts below are recomputed from the
fragment tables, not from worker summaries).

## Inventory reconciliation

The audit directory holds 19 markdown documents. 16 carry numbered
finding series; `test_review_write.md` and `test_review_retrieval.md` are
supplements that map test gaps onto EXISTING finding IDs (no new IDs), and
`README.md` / `architecture.md` / `verification.md` are framing documents.
The remediation inventory is therefore **178 findings** — the "189" figure
from the earlier session inventory was an overcount (it treated the
supplements' inline finding references and framing docs as findings).

## Aggregate dispositions (HEAD d9784266d2, before Wave 1a)

| Doc (series) | Findings | OPEN | FIXED | PARTIAL | SUPERSEDED | STATIC | Fragment |
|---|---|---|---|---|---|---|---|
| logic_write (W01–W19) | 19 | 14 | 1 (W04) | 4 (W08 W15 W18 W19) | 0 | 0 | W-logic-write.md |
| technical_storage (S01–S16) | 16 | 13 | 0 | 3 (S11 S12 S13) | 0 | 0 | S-technical-storage.md |
| logic_learning (L01–L22) | 22 | 20 | 0 | 2 | 0 | 0 | L-logic-learning.md |
| logic_retrieval (RET-01–22) | 22 | 14 | 0 | 8 | 0 | 0 | RET-logic-retrieval.md |
| technical_learning (TLG-01–11) | 11 | 8 | 0 | 3 | 0 | 0 | TLG-technical-learning.md |
| technical_search (SEARCH-01–13) | 13 | 9 | 1 (SEARCH-01) | 2 | 1 (SEARCH-04) | 0 | SEARCH-technical-search.md |
| benchmark_delivery (B01–B26) | 26 | 20 | 1 (B21) | 5 | 0 | 0 | B-benchmark-delivery.md |
| public_integrations (PI-01–10) | 10 | 9 | 0 | 1 (PI-05) | 0 | 0 | PI-public-integrations.md |
| public_api (API-01–07) | 7 | 7 | 0 | 0 | 0 | 0 | API-public-api.md |
| test_review_learning (TEST-01–10) | 10 | 9 | 0 | 1 (TEST-06) | 0 | 0 | TEST-test-review.md |
| changes_during_audit (D1–D6) | 6 | 0 | 2 (D2 D4) | 4 | 0 | 0 | D-changes-during-audit.md |
| delta_write (DW01–04) | 4 | 4 | 0 | 0 | 0 | 0 | DW-delta-write.md |
| delta_retrieval (DRET-01–08) | 8 | 2 | 2 (DRET-01 DRET-02) | 4 | 0 | 0 | DRET-delta-retrieval.md |
| delta_learning (DL-01–04) | 4 | 3 | 0 | 1 (DL-04) | 0 | 0 | DL-delta-learning.md |
| **Total** | **178** | **132** | **7** | **38** | **1** | **0** | — |

Notes:
- FIXED_IN_HEAD = already remediated by WS-11..WS-19/D2/D4 landings before
  this remediation effort (verified, not taken from the audit text).
- PARTIAL = a remediation stream landed part of the finding; the residual
  defect is described in each fragment's evidence column. Repairs must
  target the residual, not re-do the whole finding.
- The audit's own verification-interpreted "18 failing engine tests" no
  longer reproduce at HEAD: the full engine unit suite is 2585 passed /
  0 failed after Wave 1a (the drift failures were fixed by the WS streams).
- Working-tree caveat carried from RET fragment: `mongodb-conversation-
  recall.ts` has uncommitted user edits; disposition line refs reflect the
  working tree.

## Wave mapping (master plan, 7 waves in dependency order)

- Wave 1a (landed 2026-09-06): W01 + the structured-canonicalId skip and
  relation-locator mismatch (RET-20's id-mapping aspect). RED->GREEN probed
  against the live server. See
  `../2026-09-06-wave1a-w01-access-identity.md`.
- Wave 1b: W02, W03, W12 (erasure retry fencing, erasure-vs-worker race,
  quarantine promotion crash window) — the erasure/lifecycle safety core.
- Wave 1c: ownership registry completeness (W05/S13 residual, W18/W19
  residuals, lease-fence write-side predicates).
- Waves 2–7: remaining OPEN/PARTIAL findings by area (write durability
  W06–W11, W13–W17; retrieval RET-*; search SEARCH-*; learning L-*/TLG-*;
  public surfaces PI-*/API-*; benchmark/test honesty B-*/TEST-*; deltas
  DW/DRET/DL/D). Sequencing per the master plan; each wave grounded in
  official documentation before implementation per DDD v0.7.0.
- test_review_write/retrieval supplement lists (wrong-policy tests) are
  consumed by the test-honesty pass, not as separate findings.
