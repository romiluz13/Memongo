# Memongo Benchmark Full Picture Roadmap

Status: control document for the benchmark publication journey.

Last updated: 2026-06-01.

This document answers four questions:

1. What branch and evidence base are real?
2. What has already been proved?
3. What did we learn on the road here?
4. What remains before any "best memory framework" claim is defensible?

## One-Sentence Strategy

Memongo wins only when every public row is artifact-backed, apples-to-apples,
repo-backed, and reproducible: same dataset, same scorer, same retrieval unit,
same top-k, explicit LLM/rerank posture, zero hidden fallback, and exact MongoDB
prefix cleanup proof.

## Branch Truth

| Path | Branch | Role | State |
| --- | --- | --- | --- |
| `/Users/rom.iluz/Dev/memongo-world-class-replay` | `codex/benchmark-ecosystem-evidence` | Real benchmark/publication branch | Clean, ahead of origin with committed evidence work |
| `/Users/rom.iluz/Dev/memongo` | `codex/mongodb-auto-embed-dogfood` | Old dogfood/source-material worktree | Dirty; do not run publication benchmarks here |

Rules:

- Continue benchmark work only from `codex/benchmark-ecosystem-evidence`.
- Treat dogfood branch changes as source archaeology, not integration truth.
- Do not make README/global claims from the dirty dogfood worktree.

## Claim Ladder

| Claim level | Allowed wording | Required evidence |
| --- | --- | --- |
| Row-level win | "Memongo beats X on this benchmark lane under this scorer." | Complete artifact pack for that row |
| Family-level win | "Memongo has artifact-backed wins across MemPalace P0 retrieval lanes." | All MemPalace P0 rows complete and reviewed |
| Ecosystem leadership | "Memongo beats reproduced repo-backed claims across MemPalace, Mem0, Supermemory, Zep, Mastra, Hindsight, OpenViking, and related lanes." | P0/P1/P2 lanes beaten or honestly scoped out |
| Best in world | Not allowed yet | Every repo-backed competitor claim is beaten or non-reproducible/out of scope, with proof |

Never use the old README `98.1%` number. It remains unproven because no
artifact pack was found.

## Current Proven Rows

These rows are currently artifact-backed in `docs/benchmarks/BENCHMARKS.md`.
They support scoped MemPalace P0 claims after release checks and secret scans.

| Competitor | Benchmark lane | Memongo | Competitor | Status |
| --- | --- | ---: | ---: | --- |
| MemPalace | LongMemEval raw session full 500, session RecallAny@5 | 99.15% | 96.60% | PROVED |
| MemPalace | LongMemEval held-out 450 hybrid no-LLM, session RecallAny@5 | 99.11% | 98.44% | PROVED |
| MemPalace | LongMemEval full 500 hybrid no-LLM, session RecallAny@5 | 99.20% | 96.60% raw / 99.20% Haiku rerank | COMPLETE, different lane |
| MemPalace | LoCoMo raw session top-10, 1,986 rows avg recall | 91.71% | 60.29% | PROVED |
| MemPalace | LoCoMo hybrid session top-10, 1,986 rows avg recall | 93.30% | 88.91% | PROVED |
| MemPalace | ConvoMem raw message top-10, 250 items avg recall | 100.00% | 92.87% | PROVED |
| MemPalace | MemBench movie hybrid top-5, 8,500 rows hit@5 | 88.75% | 80.33% | PROVED |

Interpretation:

- MemPalace P0 retrieval evidence is strong.
- The MemPalace Haiku rerank lane is not yet a Memongo rerank win; Memongo
  native hybrid no-LLM ties the committed 99.20% row but is a different lane.
- These rows do not prove broader ecosystem dominance.

## Competitor Map

The refreshed inventory lives in
`docs/benchmarks/COMPETITOR-BENCHMARK-INVENTORY.md`.

| Priority | Competitor/source | Current posture |
| --- | --- | --- |
| P0 | MemPalace | P0 retrieval rows proved; rerank/LLM lane still separate |
| P1 | Mem0 / `memory-benchmarks` | Active frontier; official harness adapter exists; 12-case materialized-evidence rehearsal passed |
| P1 | Supermemory / MemoryBench | Provider-neutral harness exists; Memongo provider still needed |
| P1 | Zep | LoCoMo and LongMemEval surfaces exist; reproducible command conversion still needed |
| P2 | Mastra | LongMemEval answer-quality package exists; compare judged QA only |
| P2 | Hindsight | Benchmark scripts exist; score artifacts still need reproduction |
| P2 | OpenViking / OpenClaw Eval | LoCoMo/OpenClaw surfaces exist; benchmark commands need artifact-backed reproduction |
| Watchlist | Letta | No repo-backed reproducible benchmark claim found yet |

Non-reproducible marketing screenshots, blog claims, or README tables are not
victory targets until tied to a public repo commit and scorer.

Latest competitor refresh:

- Snapshot: `artifacts/competitor-snapshots/20260601-refresh/manifest.json`.
- Refresh report: `artifacts/competitor-snapshots/20260601-refresh/refresh-report.json`.
- Fast-forwarded repos: Hindsight, Mastra, Mem0, OpenViking, and Supermemory.
- Benchmark-adjacent changes: Hindsight retrieval docs and Mastra
  LongMemEval/evals package files.
- Unchanged official comparison sources: MemPalace result artifacts, Mem0
  `memory-benchmarks`, MemoryBench, Zep, LoCoMo, MemBench dataset, OpenClaw
  Eval, and Letta.
- Next inventory rule: re-audit Hindsight and Mastra before any adapter run;
  continue Mem0 from `memory-benchmarks` because that official harness did not
  move.

## Road Already Traveled

### 1. We Stopped Trusting The Old 98.1%

The old README number had no committed artifact, no dataset SHA, no run id, no
command, and no replayable result file. It is excluded from public claims.

### 2. We Moved From Branch Chaos To A Clean Replay Branch

The old dogfood branch remained valuable as source material, but final work
moved to the clean replay branch. This prevents dirty artifacts and unrelated
code from becoming accidental proof.

### 3. We Built Prefix-Isolated Atlas Discipline

Every serious run uses an exact prefix:

`memongo_bench_<competitor>_<benchmark>_<lane>_<date>_<suffix>_`

Run lifecycle:

1. preflight,
2. exact-prefix dry-run,
3. benchmark,
4. artifact capture,
5. scorer/status check,
6. exact-prefix drop,
7. zero-prefix inventory proof.

No whole-database drops are part of benchmark work.

### 4. We Proved MemPalace P0 Retrieval Rows

Memongo now has artifact-backed wins on MemPalace raw LongMemEval, held-out
LongMemEval hybrid no-LLM, LoCoMo raw/hybrid, ConvoMem raw, and MemBench full
8,500.

### 5. We Started Ecosystem Work With Mem0's Official Harness

Mem0's public benchmark story points to `memory-benchmarks`, so we built a
Mem0-compatible adapter and ran the official harness against Memongo.

Important fixes were product-generic:

- isolate the workspace instead of syncing local dogfood state,
- disable heavy derived background work for official raw benchmark lanes,
- search the Mem0 user namespace correctly,
- wait for per-user Search/vector settle instead of allowing fallback,
- preserve query-relevant evidence passages instead of head-clipping long
  retrieved memories,
- add source-backed count/action evidence only from retrieved memories,
- materialize canonical event text from returned Memongo file sources.

### 6. We Separated Retrieval Quality From Judge Transport

The same saved retrieval artifacts can pass or fail depending on LLM transport
timeouts. The runbook now requires conservative Grove/Kimi bounds and preserves
failed judge artifacts instead of hiding them.

Most recent Mem0 gate:

- official `memory-benchmarks` LongMemEval predict-only run,
- 12 questions, two per LongMemEval type,
- exact Atlas cleanup proof,
- first offline rejudge: 11/12 because one structured output returned empty,
- second offline rejudge with stronger transport bounds: 12/12 at top-10 and
  top-50,
- passing SHA:
  `fcee7162f42509b9c9a19db6832d57158130c6d00af665909d1c4bbf01aa3042`.

This is a rehearsal gate, not a publishable full Mem0 row.

## MongoDB Rulebook

MongoDB is not an implementation detail here; it is the proof surface.

The benchmark stack must follow these rules:

- Atlas Search for lexical/proper-name/exact-ish evidence.
- Vector Search / autoEmbed for semantic evidence.
- Hybrid search when exact terms and semantic matches both matter.
- `$rankFusion` / `$scoreFusion` only when the server supports them and the
  input pipeline shape is valid.
- `$vectorSearch.filter` only on fields declared as vector index filter fields.
- Search/vector indexes must be queryable before measurement.
- Evidence returned to competitor harnesses must preserve enough canonical text
  for the downstream scorer or judge to see what MongoDB retrieved.
- Highlight-like snippets are diagnostic, not always sufficient answer context.
- Search score, score details, source id, timestamp, and provenance must remain
  available for miss analysis.

## Still Not Proved

| Area | Why not proved yet | Next gate |
| --- | --- | --- |
| MemPalace LLM/rerank | Memongo has not run a matching rerank lane | Reproduce committed MemPalace rerank row, then run Memongo rerank with identical disclosure |
| Mem0 LongMemEval top-50/top-200 | 12-case rehearsal passed, full 500 not run | Larger predict-only rehearsal, repeated offline judge, then full top-50/top-200 |
| Mem0 LoCoMo top-50/top-200 | Adapter path not run on LoCoMo official row set | Build/run same scorer and row filter |
| Mem0 BEAM 1M/10M | Adapter not built for BEAM | Implement BEAM adapter only after competitor command is reproducible |
| Supermemory MemoryBench | Memongo provider not implemented | Add provider and run official compare lanes |
| Zep | Harnesses not converted into artifact-backed Memongo comparisons | Reproduce Zep command first, then adapter |
| Mastra/Hindsight/OpenViking | Runnable claims need command-level reproduction | Inventory exact commands and result artifacts |
| Letta | No reproducible benchmark claim found | Watchlist only |

## Next Execution Queue

### Gate A: Mem0 Larger Retrieval-Judge Rehearsal

Goal: prove materialized evidence and Grove transport bounds hold beyond 12
cases without spending on a full run too early.

Run shape:

- official `memory-benchmarks` LongMemEval,
- predict-only first,
- exact Atlas prefix,
- saved prediction files,
- exact-prefix cleanup,
- two offline `--evaluate-only --rejudge` passes,
- same answerer/judge model posture as competitor artifact where possible,
- status and SHA for every result.

Stop if:

- retrieval is empty,
- prefix cleanup is not exact,
- a miss requires question-id logic,
- judge instability remains after saved-prediction rejudge.

### Gate B: Mem0 Answerer-Mode Rehearsal

Goal: compare judged answer accuracy only after retrieval evidence is stable.

Run shape:

- same saved prediction discipline where possible,
- answerer artifact validator required,
- no blank non-abstention generated answers,
- count-policy audit saved,
- retrieval recall and judged QA kept in separate tables.

### Gate C: Mem0 Full Rows

Run only after Gates A and B pass:

- LongMemEval top-50,
- LongMemEval top-200,
- LoCoMo top-50,
- LoCoMo top-200,
- BEAM 1M top-200,
- BEAM 10M top-200.

### Gate D: Supermemory / MemoryBench

Add a Memongo provider and run official MemoryBench compare lanes. Do not claim
against README prose unless the competitor row is reproducible from the harness.

### Gate E: Zep, Mastra, Hindsight, OpenViking

For each competitor:

1. reproduce their command first,
2. save competitor artifact and hash,
3. build Memongo adapter,
4. run same scorer/data/top-k/LLM posture,
5. compare only matching metric types.

## Publication Readiness Checklist

Before any README update beyond scoped MemPalace P0 wording:

- `bun run check-types`
- `bun run build`
- relevant status/scorer commands for every row,
- artifact SHA verification,
- secret scan,
- Atlas prefix inventory clean,
- old `98.1%` absent or explicitly marked unproven,
- every row has dataset SHA, command, scorer, retrieval unit, top-k, LLM/rerank
  disclosure, warnings/degradations, and cleanup proof.

## Final Gate For "Best Memory Framework"

The phrase is allowed only when:

- every repo-backed competitor benchmark claim is beaten, or explicitly marked
  non-reproducible/out of scope,
- retrieval recall, hit@k, and judged QA are not mixed,
- every public row links to artifacts and hashes,
- no row uses benchmark-specific question IDs or gold-answer shortcuts,
- MongoDB capability usage is documented and verified,
- security scan is clean,
- branch is clean and merged intentionally.

Until then, the honest public story is:

"Memongo has artifact-backed wins on MemPalace P0 retrieval lanes, and broader
ecosystem benchmark validation is in progress under the same proof contract."
