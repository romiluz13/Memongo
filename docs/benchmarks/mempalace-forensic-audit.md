# MemPalace Forensic Audit (Gate 0 — Task 0.1)

**Source:** https://www.mempalace.net/benchmarks
**Canonical repo (pass-3 resolution):** `github.com/MemPalace/mempalace@68319dc` — NOT `milla-jovovich/mempalace`.
**Capture date:** 2026-05-11
**Audit purpose:** Neutralization targets for Memongo's honest LongMemEval-S comparison lane. Every item below is a methodology gap we will close in our own publication.

> This audit does NOT attempt to discredit MemPalace's engineering. It documents **what their public benchmark page does and does not disclose**, so that Memongo's comparable headline numbers are reviewed by a skeptic as apples-to-apples, not as rhetorical equivalents.

---

## 0. 2026-05-20 Refresh — Latest Repo And Current Proof State

This refresh was run after pulling the competitor workspace under `/Users/rom.iluz/Dev/memongo-competitors` with fast-forward-only updates. All checked repos were clean and equal to upstream after the pull:

| Repo | Branch | Head |
|---|---|---|
| OpenViking | `main` | `fd9ada9` |
| hindsight | `main` | `bd86e7e` |
| letta | `main` | `1131535` |
| mastra | `main` | `5a3f337` |
| mem0 | `main` | `74d0437` |
| mempalace | `develop` | `1b94f4e` |
| supermemory | `main` | `065fcf4` |
| zep | `main` | `faf2ace` |

MemPalace's current README is more conservative than the 2026-05-11 public-page snapshot:

- It headlines LongMemEval raw R@5 `96.6%`, held-out hybrid v4 R@5 `98.4%`, and hybrid v4 + LLM rerank as `>=99%`.
- It explicitly says the 100% number is not headlined because the last `0.6%` came from inspecting specific wrong answers.
- It says side-by-side comparisons against Mem0, Mastra, Hindsight, Supermemory, and Zep are deliberately omitted because those projects publish different metrics/splits.

Latest MemPalace raw reproduction on `mempalace@1b94f4e`:

| Field | Value |
|---|---|
| Command | `uv run python benchmarks/longmemeval_bench.py /Users/rom.iluz/.memongo/workspace/benchmarks/longmemeval_s_cleaned.json --mode raw --granularity session --out artifacts/competitors/mempalace/raw-full-20260520-latest/results.jsonl` |
| Dataset SHA-256 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| Retrieval unit | Session |
| LLM / reranker | None / none |
| Embedding | ChromaDB default `all-MiniLM-L6-v2` |
| R@5 | `0.9660` |
| R@10 | `0.9820` |
| NDCG@10 | `0.8888` |
| Runtime | `778.8s` |

Additional latest MemPalace reproductions completed on 2026-05-20:

| Lane | Artifact | Result | Notes |
|---|---|---|---|
| LongMemEval held-out 450 `hybrid_v4`, no LLM | `artifacts/competitors/mempalace/heldout-hybrid-v4-20260520-latest/results.jsonl` | R@5 `0.9844`, R@10 `0.9978`, NDCG@10 `0.9379` | Matches their committed held-out result and remains the next Memongo LongMemEval target. |
| LoCoMo raw session top-10 | `artifacts/competitors/mempalace/locomo-full-20260520-latest/raw-session-top10.json` | avg recall `0.6029` over 1,986 QA pairs | Reproduces their honest no-rerank LoCoMo baseline. |
| ConvoMem raw top-10 sample | `artifacts/competitors/mempalace/convomem-full-20260520-latest/raw-all-limit50-top10.json` | avg recall `0.9287` over 250 loaded items | `changing_evidence` was skipped by their script because the HuggingFace path returned 404, matching the effective 250-item sample row. |
| MemBench hybrid movie top-5 | smoke artifact `artifacts/competitors/mempalace/membench-smoke-20260520/simple-movie-limit2-hybrid-top5.json` | smoke R@5 `1.0000` over 2 items | Full 8,500-item reproduction was started but stopped after about 3h with no artifact; their script buffers progress and rebuilds Chroma per item, so this lane needs a monitored unbuffered rerun before we call it reproduced. |

Memongo raw-session full-500 artifact available in `artifacts/benchmark-runs/memongo-raw-session-full500-20260520-atlas-b/benchmark-response.json`:

| Field | Value |
|---|---|
| Dataset SHA-256 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| Retrieval unit | Session |
| LLM / reranker | None / none |
| Embedding | MongoDB autoEmbed `voyage-4-large` |
| R@5 | `0.9729` |
| R@10 | `0.9933` |
| NDCG@10 | `0.9538` |
| Official session RecallAny@5 | `0.9915` |
| Empty rate | `0` |
| Warnings / degradations | `[] / []` |
| `benchmark:status` | PASS |

Current claim status:

| Claim | Status | Reason |
|---|---|---|
| Memongo beats MemPalace raw LongMemEval session retrieval | Allowed with disclosure | Same dataset and retrieval unit, no LLM, no rerank. Embedding/backend differ, so disclose MongoDB autoEmbed `voyage-4-large` vs ChromaDB MiniLM. |
| Memongo beats MemPalace held-out hybrid v4 | Not proven | MemPalace reproduced held-out score is R@5 `0.9844`, R@10 `0.9978`; Memongo has not run a held-out hybrid parity lane yet. |
| Memongo beats MemPalace hybrid v4 + LLM rerank | Not proven | MemPalace committed full-500 rerank file scores R@5 `0.9920`, R@10 `1.0000`; Memongo has not run a rerank parity lane yet. |
| Memongo beats MemPalace LoCoMo | Not proven | MemPalace raw top-10 was reproduced at `0.6029`; hybrid top-10 remains committed-only at `0.8891`. Memongo needs a LoCoMo adapter. |
| Memongo beats MemPalace ConvoMem | Not proven | MemPalace sample score was reproduced at `0.9287` over 250 loaded items. Memongo needs a ConvoMem adapter. |
| Memongo beats MemPalace MemBench | Not proven | MemPalace committed score is `0.8033` over 8,500 items; our full reproduction attempt needs a monitored rerun. Memongo needs a MemBench adapter. |
| Memongo is the best memory framework in the world | Not allowed yet | One raw retrieval win is not enough; needs artifact-backed wins across the relevant benchmark lanes plus product/dogfood proof. |

Immediate next gates:

1. Run Memongo on the MemPalace `lme_split_50_450.json` held-out 450 lane.
2. Build a generic hybrid no-LLM lane that mirrors the *class* of signals MemPalace uses: lexical exactness, temporal anchors, preference evidence, assistant/session evidence, without question-id tuning.
3. Run Memongo rerank parity separately and label it as rerank.
4. Add or run adapters for LoCoMo, ConvoMem, and MemBench before any "every benchmark" claim.
5. Publish only lane-specific wording until all rows above are proven by artifacts.

---

## 1. MemPalace's Claims (Verbatim From Public Page)

- "96.6% LongMemEval R@5 — Raw Mode"
- "100% LongMemEval — Hybrid Mode with Haiku rerank"
- "highest-scoring free AI memory system"
- "the highest published result for any system that requires no API key and no external service"
- 98.4% on "unseen questions" (held-out test)
- LoCoMo R@10 = 60.3% (no accompanying explanation of the gap vs LongMemEval)

## 2. MemPalace's Disclosures (To Their Credit)

The page includes a **"⚠️ What's Been Questioned"** self-audit section. We credit them explicitly:

- Acknowledges Haiku reranking is not purely local.
- Acknowledges AAAK compression regresses accuracy to 84.2%.
- Acknowledges `top_k=50` on LoCoMo "may exceed candidate pool size".
- Reproducibility claim: "@gizmax reproduced on M2 Ultra in under 5 minutes".

## 3. Missing Methodology (Our Apples-To-Apples Neutralization Targets)

| Field | MemPalace | Memongo commitment |
|---|---|---|
| Dataset commit SHA | MISSING | Record `longmemeval_s_cleaned.json` SHA-256 in every artifact |
| Retrieval unit (turn / session / memory) | MISSING | Publish both turn-level and session-level metrics, per-lane |
| NDCG | MISSING | Publish `ndcg@10` |
| Embedding model | MISSING | Publish Voyage model name + dimensions + quantization mode |
| Reranker identity | Implicit (Haiku) | Publish reranker model + version + stage placement |
| Official vs custom scorer | MISSING | Use the dataset's official scorer; link and pin its version |
| Latency | MISSING | Publish p50/p95 retrieval latency |
| Cost / token usage | Partial ($0 raw; "~500 calls" hybrid) | Publish strict-mode cost: embedding calls, rerank calls, LLM enrichment calls |
| Storage footprint | MISSING | Publish collection byte counts + index byte counts (via `collStats`) |
| Per-case raw outputs | Aggregate only | Publish per-case JSONL + miss-ledger diagnostics |
| Competitor version pins | Tilde estimates ("~85%") | Do NOT cite competitor numbers we haven't reproduced ourselves, OR clearly label them "MemPalace-reported estimate, not our reproduction" |
| Run date / git SHA | MISSING | Artifact timestamp + git SHA per run |

## 4. MemPalace Self-Documented Asymmetries (pass-3 D1)

This section is **required by the plan** and is the load-bearing honesty disclosure. Quoted directly from MemPalace's own repository:

- **`benchmarks/longmemeval_bench.py:1339-1366`** names three question IDs that the `hybrid_v4` configuration is explicitly designed to patch: `d6233ab6`, `4dfccbf8`, `ceb54acb`. Their own code describes them as "the final 3 misses" that v4 resolves.
- **`BENCHMARKS.md:88-94`** contains the verbatim self-description: *"teaching to the test"* (MemPalace's own phrasing) for the v4 patch.
- **`v2`, `v3`, `v4`** numbers cannot be cited without an explicit asterisk — MemPalace's own codebase self-documents test-set leakage via the three named question IDs above.
- **When Memongo reproduces MemPalace**, we enforce one of:
  1. `--mode raw` only (no hybrid_v4 test-set patches), OR
  2. a **held-out 450-case split** (see `docs/benchmarks/heldout-split-protocol.md` + Task 5.2 Step 2).

**This is the single most important neutralization target.** Without it, any "MemPalace 100%" comparison is meaningless because their own repo documents the 100% as a test-set-tuned number.

## 5. Asymmetries Memongo Will NOT Replicate

1. Reporting raw and hybrid as if they're comparable headline numbers.
2. Using tilde-prefixed competitor scores (e.g. "~85% Mem0") without pinning competitor version.
3. Framing "96.6% raw" as "highest-scoring free AI memory" without retrieval-unit disclosure.
4. Publishing v2/v3/v4 scores that self-document as test-set-tuned (point 4 above).
5. Reporting aggregate numbers without per-case outputs.
6. Claiming reproducibility without pinning dataset SHA, embedding model, reranker, and scorer.

## 6. What Memongo CAN Legitimately Claim Once Gates Pass

**Allowed after strict Gate 5 passes:**
- "Memongo scored X R@5 / Y NDCG@10 on the official LongMemEval-S 500-case set with [config details], reproducible at [commit SHA]."
- "Memongo outperformed our reproduction of MemPalace on [specific lane] by Z points; see `[reproduction artifact path]`."
- "Memongo's strict-mode run cost [exact token counts]; p50/p95 retrieval latency = [values]; storage footprint = [values]."

**Not allowed — ever:**
- "Best memory framework" from LongMemEval alone.
- "Beats Mem0 / Zep / Letta" without reproducing their setup ourselves.
- Any headline number without a retrieval unit (`turn` vs `session`) suffix.
- Any held-out split score mixed into the public split score.

## 7. Cross-Reference — Our Countermeasures

| Asymmetry | Memongo countermeasure | File / Phase |
|---|---|---|
| Missing dataset SHA | SHA-256 in every envelope | Phase 1 Task 1.A (`packages/memory-engine/src/mongodb-benchmark-runner.ts`) |
| Missing retrieval unit | Publish session + turn metrics | Phase 3 `any@1` reporting |
| Missing NDCG | Emit `ndcg@10` | Phase 1 Task 1.A |
| Missing embedding model | Emit `embedding.model`, `embedding.dimensions`, `embedding.quantization` | Phase 1 Task 1.A |
| Missing reranker | Emit `reranker.model`, `reranker.stage` | Phase 1 Task 1.A |
| Test-set tuning (3 question IDs) | Raw mode + held-out 450 split | Task 0.7 + Phase 5 Task 5.2 Step 2 |
| Tilde competitor numbers | Reproduce before citing; otherwise label | Phase 5 Task 5.2 |

## 8. Reproduction Plan (Summary)

Full steps land in Phase 5 Task 5.2. One-line summary:
> Clone `github.com/MemPalace/mempalace@68319dc`, pin our `longmemeval_s_cleaned.json` SHA, run **their** code against **our** dataset and **our** held-out split, tolerate ±3 R@5 points vs their reported number, publish reproduction artifact.

---

**Audit owner:** Memongo benchmarks working group.
**Status:** captured 2026-05-11; refreshed whenever `mempalace.net/benchmarks` updates.
