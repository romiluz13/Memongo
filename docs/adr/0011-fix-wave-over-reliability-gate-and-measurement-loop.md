# Fix-wave over reliability gate, and the accuracy measurement loop

The reliability-gate campaign is stopped, the engine freeze is lifted, and the
engine lands as one reviewed wave; accuracy claims are then made only through a
frozen 50-question measurement loop (R-metric and Q-metric on identical answer
and judge models) against the AMB `bm25`/`vanilla` baselines, with every fix
measured alone and reviewed against the ordered backlog
(`docs/handoff/` consultant report of 2026-09-23; backlog IDs B0 to B31 below
refer to it).

## Context

The a004 settlement run (2026-09-22 to 2026-09-23) answered the reliability
question: 24 of 40 planned queries, 20 correct answers, zero reliability
failures, dead-letter kill at 08:08Z after 21.5 hours. Reliability is no longer
the binding constraint. The binding constraint is that no accuracy number in
the repo is attributable to a sha with a comparable baseline: the working tree
held roughly 300 dirty paths, extraction-on and extraction-off were not
separable (one provider served both the answer model and the fact extractor),
and the question-date guard dropped answer sessions that sat later on the
question's own day (every `question_date` carries time-of-day and both the
driver and the engine parse it leniently in the machine's local timezone),
leaving 20 of 500 LongMemEval questions with all evidence dated after the
question.

Two independent reviews landed on the same day. A competitor code scan (13
findings) produced a feature-parity roadmap. A fresh-eyes consultant report
found four defects where Memongo measurably loses accuracy to its own pipeline:
a diversity penalty that zeroes the evidence lane, a reranker threshold that
routes most candidates around the cross-encoder, a promotion gate that
discards effectively all LLM-extracted facts (verbatim reinforcement regex
against a paraphrase-mandating prompt — by construction, unmeasured; B13's
first step counts promotions), and reader packaging/context budget that hides
much of the answer in LongMemEval assistant turns (the 700-character
truncation, B5, was quantified in the report's second pass). The consultant's ordered backlog
(B0 to B31) supersedes the parity roadmap: its top items (B3, B5, B6/B7, B9)
are where the measurable points are, and none of them is a competitor feature.

While the campaign ran, the engine accumulated a durability wave (W8 durable
receipts, W11 repair writer and worker effects, W13 fresh diagnostics, W16 TTL
maintenance) plus the erasure-epoch fence work, all validated by its own test
battery but uncommitted. Eight engine test failures from the wave were
triaged this cycle: six were stale tests or missing fakes, two were real
contract gaps (one admission token per write chain; benchmark attribution of
post-write provider failures) — both fixed, suite green at 2928/2928.

## Considered Options

- **Continue the reliability campaign to 40 queries — rejected.** The marginal
  information per overnight hour is near zero after 24 clean queries, and the
  cross-ocean topology (EU host to US cluster, ~116 ms RTT) made wall-clock
  runs a proxy for geography, not for user experience.
- **Keep the engine frozen and land everything after publication — rejected.**
  Every accuracy measurement must be attributable to a sha; with the tree
  dirty, nothing is. B0 (land the tree in reviewed slices) is the backlog's
  own prerequisite for every later item.
- **Fix-wave first, then measure — chosen.** Land the durability wave and the
  fix-wave red tests now (engine suite green), then build the instrument
  (B1 decouple answer/extraction models, B2 the frozen 50-question loop,
  B4 mandatory index readiness), then execute Tier 1 retrieval/reader fixes
  in leverage order, each measured alone.
- **Adopt the competitor-parity roadmap (the 13 findings) — rejected as the
  ordering.** The consultant adjudicated all 13: several are confirmed and
  mapped to backlog IDs (B15, B16, B18, B23), several are opt-in in the
  competitors' shipped defaults and were demoted, and the intern's top three
  omit every defect that carries measurable points. Parity items that survive
  adjudication are scheduled by their backlog ID, not by their origin.
- **Tier 2 (fact promotion chain B13 to B18) immediately — deferred behind
  B20.** Fixing promotion turns on the structured lane, contradiction,
  invalidation, the consolidator, and as-of queries, all currently near-inert;
  every latent bug there becomes live. The chain ships behind a flag, and the
  B20 extraction-on/off ablation (at least 3 net questions with R agreeing) is
  the go/no-go before any of it is default or published.

## Consequences

- The engine freeze is lifted; the tree is landed in reviewed slices (B0), and
  origin/main must equal local before any measurement.
- The engine's production semantics stay unchanged where fixes are
  benchmark-driver-only (B3's question-date local end-of-day widening, B8's
  answer hygiene): the engine guard stays correct for production, the driver
  adapts to the LongMemEval data quirk, and each such change is documented as
  such.
- Every fix PR names its backlog ID, carries a unit test encoding the failure
  scenario, and carries before/after R and Q on the frozen 50 questions with
  its sha and config manifest (reranker key present, extraction on/off,
  strict readiness). R is the session-level recall-any of the official
  retrieval metrics (`longMemEval.session.recallAnyAt10` / `At50`,
  deterministic, no LLM in the loop; turn-level `longMemEval.turn.*` is
  projected alongside it for turn-level fixes like B10); Q is the
  official-protocol judged answer accuracy (`official-anscheck`, judge
  pinned to `gpt-4o-2024-08-06`). The noise rule (tightened in the round-2
  review, after the original co-movement rule was shown to admit +1 recall
  question / +1 correct answer as real): deltas are computed over PAIRED
  populations — R over questions with recall in both runs, Q over questions
  judged in both runs — with unpaired counts reported; `netR` is the net
  recall questions and `netQ` the net correct answers over those pairs;
  `T = max(3, baselineFlips + 1)` where `baselineFlips` is the flip count
  measured between two repetitions of the same configuration (3 until
  measured). A change is REAL iff `|netQ| >= T`, or R and Q co-move in the
  same direction with `|netR| >= 2` and `|netQ| >= 1`. `|netR| >= 3` with
  `netQ == 0` is reported separately as retrieval-real, answer-neutral
  (expected for retrieval-only fixes; R-neutral fixes can only be REAL via
  the `|netQ| >= T` arm). A missing or partial judge sidecar is refused
  (`--r-only` opts out and verdicts on `|netR| >= 3` alone), and a run with
  failed cases is reported with its failure count, never as a clean number.
- The measurement loop uses stratified frozen 50 questions (~8 per type, at
  least 4 abstention, at least 4 same-day-later-evidence questions — B3
  canaries, since the widened local end-of-day guard leaves no question with
  all evidence strictly after the question date), the AMB `bm25` and
  `vanilla` providers as baselines on the same answer and judge models
  (judge pinned to `gpt-4o-2024-08-06`), run twice to establish the natural
  flip rate.
- A readiness failure mid-run (convergence timeout, permanent probe error,
  empty required lane) aborts the run rather than marking the scenario's
  cases as system-failures and continuing (B4 (d), decided in the round-2
  review follow-up): such failures are cluster-correlated, so continuing
  would spend answer and judge tokens on every remaining scenario against a
  half-indexed store. Recovery is the checkpoint `--resume`, which keeps
  every completed scenario and re-runs (and re-pays) only the failed one;
  the abort is logged with that guidance before the error propagates.
- Query decomposition (F-B1-1, decided in the round-2 review follow-up)
  stays ungated by `MEMONGO_EXTRACTION_LLM`: it is a query-time call in the
  answer pipeline, resolved on the benchmark answer provider, billed to the
  answerer (`query-decomposition` accounting), never enabled in the shipped
  profile, and gated by its own `MEMONGO_QUERY_DECOMPOSITION_MODE`, which is
  part of the run identity. `MEMONGO_EXTRACTION_LLM=off` gates ingest-time
  extraction only. Accepted consequence: with a dedicated answerer
  configured, decomposition uses the answer model even on extraction-on
  runs — correct attribution, since the call serves answering, not fact
  extraction. The answerer's provider source (`dedicated` vs
  `enrichment-fallback`) and answer base URL (hashed) are recorded in the
  run configuration, and a half-configured dedicated answerer (model or
  base URL without an API key) warns instead of silently falling back.
- If B20 shows extraction-on does not beat extraction-off by 3 net questions,
  the facts machinery is a production feature (audit, profile, contradiction),
  not a benchmark lever, and that is said publicly.
- Tier 4 items (B25 to B31: server-side fusion, `$rerank`, collection
  consolidation, context-bundle budget) are scheduled after publication; they
  do not move LongMemEval or LoCoMo.
- The B3 date-guard fix is expected to recover up to +4 pp concentrated in
  temporal-reasoning; B3, B5, B6/B7, B9 and B10 together are roughly 3 to 4
  engineer-days and the most likely path from the reported ~83% (a004) toward
  the published 90%+ of the competitor set.
