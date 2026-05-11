# GitHub Research: Competitor Code Audit — MemPalace, Mem0, Zep/Graphiti, Letta

## Execution
- Preferred backend: octocode
- Allowed fallbacks: web (WebSearch/WebFetch), gh CLI (authenticated)
- Research round: 1 (pre-benchmark forensic pass)
- Date: 2026-05-11
- Repos read via authenticated `gh api` + `gh search` (Octocode MCP tools returned "No such tool available" in this session, so the built-in fallback was used; every file read was fetched via the GitHub Contents API with an explicit ref).

## Sources Used
- Succeeded: `gh api repos/*/contents/*?ref=<branch>` (equivalent to `githubGetFileContent`), `gh search code --repo <owner>/<repo>` (equivalent to `githubSearchCode`), `gh pr list --search`, `gh issue view`.
- Failed: `mcp__octocode__*` (tools not registered in this session). No local clones were made; all evidence is from GitHub over the API.

## Research Quality
- Status: COMPLETE
- Quality level: high
- Backend mode: web-only (gh CLI is HTTPS to GitHub; no Octocode)

---

# Competitor Code Audit

## Summary table

| Framework | Retrieval unit | Hybrid? | Reranker | Storage | Benchmark scorer |
|---|---|---|---|---|---|
| MemPalace | One session OR one user-turn (selectable via `--granularity`) | Yes — cosine + keyword-overlap linear fusion (4 tuned variants v1–v4) | Optional LLM rerank (Anthropic Haiku/Sonnet) on top-10 or top-20 pool | ChromaDB (default sentence-transformers), per-palace on-disk HNSW | Custom — reimplemented R@k / NDCG@k in `benchmarks/longmemeval_bench.py` lines 49–80; **does not call the official LongMemEval scorer** |
| Mem0 | One atomic memory item (LLM-extracted "fact") | No — single vector call + optional rerank | Pluggable (Cohere, HF, SentenceTransformer, LLM, ZeroEntropy) | Pluggable vector store (Qdrant default) + optional graph store (Neo4j) | Custom — gpt-4o-mini LLM-judge + BLEU + F1 (`evaluation/metrics/llm_judge.py`), and **the in-repo runner is LoCoMo-only; no LongMemEval code is in the repo** despite README claiming 93.4 |
| Zep / Graphiti | Graph edges (facts) + entity nodes, top-20 each | Yes — BM25 fulltext + cosine vector + RRF fusion, optional cross-encoder or MMR rerank (`graphiti_core/search/search_config_recipes.py`) | Optional — BGE / OpenAI / Gemini cross-encoders, or MMR | Neo4j / FalkorDB (self-hosted) or Zep Cloud (evals run against Zep Cloud) | LongMemEval-style rubric LLM-as-judge, 5 rubrics per `question_type` — matches the official semantics (`benchmarks/longmemeval/zep_longmem_eval.py` lines 49–103) |
| Letta | One passage (verbatim text the agent chose to `archival_memory_insert`) | No — pure cosine-distance kNN | No rerank built in | Postgres + pgvector (default), SQLite fallback, Turbopuffer optional | **No LongMemEval runner in the repo**; evals rely on the agent tool-calling loop + external harness |

## Per-framework deep dive

### MemPalace
- Repo: `https://github.com/MemPalace/mempalace` (NB: org is `MemPalace`, not `milla-jovovich` as our prior audit had; that owner does not exist. Default branch is `develop`, not `main`.)
- HEAD read: `68319dc0d00ce1633563ba660e24991693178980` on `develop` (2026-05-11).
- Stars 51.9K, last push 2026-05-11. Language: Python. License: MIT.
- Retrieval path: `benchmarks/longmemeval_bench.py:163` `build_palace_and_retrieve(...)` → `ChromaDB.query(query_texts=[question], n_results=50)` → ranked list of indices. Runtime retrieval in app uses `mempalace/layers.py:247` (`Layer3.search`) which calls `col.query(query_texts=[query], n_results=n_results)` directly. No reranker in the non-benchmark path. Storage-agnostic: the only real backend is ChromaDB (`mempalace/backends/chroma.py`) — no Postgres/Mongo path.
- Retrieval unit: configurable. `--granularity session` concatenates all user turns per session → one doc; `--granularity turn` → one doc per user message (`benchmarks/longmemeval_bench.py:186-206`). For headline number they publish, the unit is "one session" (a session can be 10s of turns).
- Extraction/enrichment (write): **No LLM extraction on the benchmark path.** `benchmarks/longmemeval_bench.py:189` literally joins the session's user turns and inserts raw text. The app package has a regex/pattern-based `extract_memories()` in `mempalace/general_extractor.py:363` — no LLM call. Entity KG in `mempalace/knowledge_graph.py` is SQLite-backed with deterministic temporal filtering (`_temporal_filter_sql`). Not used in the headline benchmark.
- Scope / multi-tenant: **None enforced.** Each "palace" is a separate ChromaDB collection on disk (one per benchmark question in the runner, per `benchmarks/longmemeval_bench.py:149-155`). No `user_id`/`agent_id`/`org_id` column-level filter.
- Hybrid search: Yes, **linear weighted fusion, not RRF.** `build_palace_and_retrieve_hybrid` (line 485) computes `fused_dist = dist * (1.0 - hybrid_weight * overlap)` at line 624 where `overlap` is keyword-overlap between question and candidate doc. `hybrid_weight` default 0.30 (line 486). There are four tuned variants: v1 (485), v2 (709), v3 (994), v4 (1339). Each variant's docstring explicitly names a set of `longmemeval_s.json` question IDs it was tuned to fix.
- Reranker: Optional LLM rerank via `llm_rerank()` at line 2765. Takes the top-10 (or top-20 in v3/v4/palace modes, line 3136) and asks Anthropic Haiku or Sonnet to pick the best session. Flag `--llm-rerank`, `--api anthropic` (line 3305).
- LongMemEval code: `benchmarks/longmemeval_bench.py`. Scorer reimplemented — `evaluate_retrieval()` lines 71–80 computes `recall_any`, `recall_all`, `ndcg`. Uses the `answer_session_ids` gold field to decide what counts as correct. This is **not** the official LongMemEval QA-accuracy scorer; it's retrieval-recall only. The repo's own `benchmarks/BENCHMARKS.md:45-52` admits this: *"MemPal's `R@5` in this table is retrieval recall … Several of the other systems below publish end-to-end QA accuracy."*
- Reproducibility: `python benchmarks/longmemeval_bench.py data/longmemeval_s_cleaned.json --granularity session --mode raw` (line 28). Dataset: a cleaned version of `longmemeval_s.json` (500 questions). Env: `ANTHROPIC_API_KEY` only needed for `--llm-rerank`. The repo also ships `benchmarks/lme_split_50_450.json` (8.5 KB, seed=42) — a 50-dev / 450-held-out split created after community pressure (`benchmarks/BENCHMARKS.md:511-528`).
- **Surprising findings:**
  - **Explicit test-set leakage, self-documented.** `build_palace_and_retrieve_hybrid_v4()` docstring, lines 1345–1366, names three specific failing examples by their question IDs — `d6233ab6` (high-school-reunion), `4dfccbf8` (Rachel/ukulele), `ceb54acb` (sexual-compulsions) — and each "fix" (nostalgia pattern extraction, proper-noun boosting, quoted-phrase boosting) is reverse-engineered from those three cases. Their own `BENCHMARKS.md:88-94` calls this "teaching to the test."
  - **Category error in headline number.** Per `benchmarks/BENCHMARKS.md:45-68` and community issue [#875](https://github.com/MemPalace/mempalace/issues/875) (CLOSED, maintainer-acknowledged), the table that presents "MemPalace 100% R@5" next to "Mastra 94.87%" and "Supermemory ~99%" is comparing retrieval-recall to binary QA-accuracy. The maintainers kept the headline "96.6% LongMemEval" on the README even after acknowledging the methodology problem.
  - **"Palace" architecture is not in the headline retrieval.** Per issue #875 citing issues #27/#39, the 96.6% is "ChromaDB's default sentence-transformer embeddings with no MemPalace-specific code path involved." The wings/rooms/halls structure exists in `mempalace/layers.py` but does not participate in the benchmark raw-mode number.
  - **LoCoMo 100% R@10 is a `top-k > corpus-size` artifact.** Per issue #875, LongMemEval-style top-k=50 exceeds per-conversation session counts (19–32), so the retrieval layer returns everything and lets the LLM reranker resolve. Not a retrieval result.
  - **No multi-tenant path at all** — the benchmark builds a fresh per-question Chroma collection; there is no `user_id` column anywhere.
  - **The 100% rerank number uses Anthropic models.** Their own held-out 450 number without LLM in the loop is 98.4%, with LLM in the loop ~99%.

### Mem0
- Repo: `https://github.com/mem0ai/mem0`, default branch `main`.
- HEAD read: `54a03cc7217c22afdc6153a9e61cc6413416001f` (2026-05-09).
- Stars 55.4K, language Python.
- Retrieval path: `mem0/memory/main.py:1126` `Memory.search(query, top_k=20, filters={...}, rerank=False)`. Internally calls `_search_vector_store(query, effective_filters, limit, threshold)` at line 1227 (a single vector call), then if `rerank=True` and a reranker is configured, applies `self.reranker.rerank(query, memories, limit)` at line 1232. **No BM25/text channel, no RRF, no fusion** — pure vector + optional rerank.
- Retrieval unit: One memory item (each row is an LLM-extracted fact string). `process_all_conversations` in `evaluation/src/memzero/add.py:66-71` calls `self.mem0_client.add(message, user_id=user_id, version='v2', metadata=metadata, enable_graph=self.is_graph)` which triggers Mem0's cloud-side extractor. Each returned result is `{"memory": "...", "timestamp": ..., "score": ...}` (search.py:66-73).
- Scope / multi-tenant: **Enforced by API contract.** `mem0/memory/main.py:1193-1197` — `search()` raises if `filters` doesn't contain at least one of `user_id`, `agent_id`, `run_id`. The metadata template at line 231-314 attaches the same keys to every write. So isolation is strict, driven off filters, not per-tenant collections.
- Hybrid search: **No.** Reranker options: Cohere, HuggingFace, LLM (general-purpose), SentenceTransformer, ZeroEntropy (`mem0/reranker/`). Default `rerank=False`.
- LLM extraction on write: Yes — a FACT_RETRIEVAL prompt runs on each `add()` to decide what to store and whether to UPDATE/ADD/DELETE existing memories (`mem0/memory/main.py:573` and update-prompt helpers at line 21). Default LLM is OpenAI gpt-4o-mini unless overridden. In the evaluation harness `evaluation/src/memzero/add.py:16-42`, they **monkey-patch the project with a benchmark-specific extraction prompt** (`custom_instructions = """Generate personal memories that follow these guidelines: …"""` explicitly tuned for LoCoMo narratives — "self-acceptance journeys … family planning … charity race for mental health"). This is not the default prompt.
- LongMemEval code: **Not in the repo.** `gh search code --repo mem0ai/mem0 longmemeval` → zero `.py` hits, only 7 doc/README mentions. `evaluation/run_experiments.py` hard-codes `dataset/locomo10.json` in every branch (lines 41, 49, 52, 56, 60, 65, 69). Scorer is `evaluation/metrics/llm_judge.py` using gpt-4o-mini as judge, with an explicit **`if int(category) == 5: continue`** at line 87 that skips category-5 questions. `metrics/utils.py` adds BLEU + token-level F1. The README claims `LongMemEval 67.8 → 93.4 (+26)` but the code path for that number is not public.
- Storage: pluggable `VectorStoreFactory` (Qdrant default), optional `graph_store` (Neo4j/Memgraph) in v2. Evaluation harness uses Mem0 **Cloud** (`MemoryClient(api_key=os.getenv("MEM0_API_KEY"), org_id=..., project_id=...)` in `evaluation/src/memzero/search.py:20-24`). So published numbers are against the managed service, not self-hosted oss.
- Reproducibility: `python evaluation/run_experiments.py --technique_type mem0 --method add`, then `--method search` (top_k default 30 per line 29). Requires `MEM0_API_KEY`, `MEM0_ORGANIZATION_ID`, `MEM0_PROJECT_ID`, `OPENAI_API_KEY`, `MODEL` env vars. Dataset is `dataset/locomo10.json`. **No way to reproduce the 93.4 LongMemEval from this repo.**
- **Surprising findings:**
  - Mem0 claims +26 points on LongMemEval in the README but has no LongMemEval runner. (Confirmed: `gh search code` + full directory listing of `evaluation/` — LoCoMo only.)
  - Their eval prompt is narrative-shaped, tuned for LoCoMo's conversation style, and `update_project(custom_instructions=...)` is called on every add. Different benchmarks could legitimately trigger different extraction behavior; this is not typically disclosed.
  - Category-5 questions are silently skipped from the scoring loop. Check what LoCoMo category 5 is before comparing.
  - Evaluation needs paid Mem0 Cloud; self-host OSS path is not what produces their headline numbers.
  - A merged PR `#4811` on 2026-04-13 ("docs: new algorithm migration guides + memory evaluation") is where the 93.4 number first landed — worth reading for methodology claims.

### Zep / Graphiti
- Repos: `https://github.com/getzep/graphiti` (the OSS memory engine) and `https://github.com/getzep/zep` (Zep Cloud host + benchmarks).
- HEAD read: graphiti `c427615044678f4bde026745d8d28a16504868c5` (2026-05-11); zep `faf2acec4f2ec777a27d8fe0411619bc913a9660` (2026-04-09).
- Stars: graphiti 25.9K, zep 4.5K. Language: Python.
- Retrieval path: `graphiti_core/search/search.py:98` `async def search(clients, query, group_ids, config, search_filter, query_vector=None, ...)` fans out in parallel (line 165 `semaphore_gather`) to `edge_search`, `node_search`, `episode_search`, `community_search`. Each combines BM25 fulltext + cosine_similarity + (optionally) `node_distance_reranker`, `episode_mentions_reranker`, cross-encoder, or MMR. Fusion is **RRF** (`rrf` imported at line 65). Presets in `graphiti_core/search/search_config_recipes.py:34-150+` (`COMBINED_HYBRID_SEARCH_RRF`, `..._MMR`, `..._CROSS_ENCODER`, etc.).
- Retrieval unit: **Graph edges and nodes, not turns or sessions.** In Zep's LongMemEval runner (`benchmarks/longmemeval/zep_longmem_eval.py:343-348`), they call `self.zep.graph.search(user_id=user_id, query=question, limit=20)` for edges, then `search_scope="nodes", limit=20` for nodes, concatenate into a CONTEXT_TEMPLATE, and feed to gpt-4o-mini for QA. Top-20 edges + top-20 nodes ≈ up to 40 facts in the context.
- Extraction/enrichment: `graphiti_core/graphiti.py:509-627`. Each `add_episode` runs: `extract_nodes` → `resolve_extracted_nodes` (dedupe) → `extract_edges` → `resolve_extracted_edges` (temporal invalidation) → community refresh. Prompts live in `graphiti_core/prompts/` (extract_nodes.py, extract_edges.py, dedupe_edges.py, dedupe_nodes.py, summarize_nodes.py). Default LLM client is `OpenAIClient()` at graphiti.py:219 (gpt-4o-mini typically). This is genuinely heavy LLM-on-write — multiple calls per episode.
- Scope / multi-tenant: `group_ids: list[str] | None` parameter throughout. Validated at `graphiti_core/search/search.py:110` via `validate_group_ids(group_ids)`. Empty list treated as None (line 155). Enforced at the graph query layer via `group_id` node property. Zep Cloud uses `user_id` which maps to `group_id` under the hood.
- LongMemEval code: `benchmarks/longmemeval/zep_longmem_eval.py` on `getzep/zep@main`. Scorer is a per-category LLM-as-judge following the **official LongMemEval rubric** — they copy the published rubric text per `question_type` (single-session-user, single-session-preference, multi-session, temporal-reasoning, knowledge-update) at lines 49–95. Grader model is gpt-4o via `response_format=Grade` (Pydantic) at lines 300–310. This is the closest to official-scorer semantics of any of the four.
- Storage: `getzep/graphiti` supports Neo4j and FalkorDB (see `graphiti_core/driver/`). Evals run against Zep Cloud (`AsyncZep(api_key=...)`), not a self-hosted Graphiti.
- Reproducibility: Zep evals need a `ZEP_API_KEY` (paid cloud). Dataset is `data/longmemeval_s.json` (official file), auto-downloaded from Google Drive by `download_dataset()` at `zep_longmem_eval.py:138`. `longmemeval_oracle.json` also used. Commands flow via jupyter notebook `zep_memgpt_eval.ipynb` for interactive runs. Graphiti self-hosted could be wired to the same runner but the repo doesn't ship that glue.
- **Surprising findings:**
  - Graphiti is the only competitor doing real hybrid BM25+vector+RRF retrieval by default, with a pluggable cross-encoder reranker. This is genuinely sophisticated retrieval.
  - Official scorer semantics. Their grader rubric at `zep_longmem_eval.py:49-95` is copied verbatim from the LongMemEval paper's Appendix. They are honest here.
  - But numbers are from **Zep Cloud**, which bakes in additional summarization/ontology that the OSS Graphiti package alone doesn't produce automatically. Reproducibility on self-hosted Graphiti alone requires user work.
  - LLM-heavy on write — add_episode typically triggers 4–8 LLM calls per episode. Cost and latency caveat for head-to-head.

### Letta (formerly MemGPT)
- Repo: `https://github.com/letta-ai/letta`, default branch `main`.
- HEAD read: `bb52a8900a79cf1378e6e9cdecf244b673a13a72` (2026-04-12).
- Stars 22.6K, Python.
- Retrieval path: Agent calls the `archival_memory_search` tool (`letta/functions/function_sets/base.py:194`). Tool executor (`letta/services/tool_executor/core_tool_executor.py:278-305`) calls `agent_manager.search_agent_archival_memory_async`. That builds a passage query via `letta/services/helpers/agent_manager_helper.py:855` `build_passage_query(query_text, embedding_config, ...)` which embeds the query (line 885), then orders passages by `cosine_distance(embedding, query_embedding).asc()` (line 992). **Pure cosine kNN.** No BM25 path. No rerank. Tag-filter and date-range filters available.
- Retrieval unit: **One passage** = the text the LLM chose to save via `archival_memory_insert` (line 307 of core_tool_executor). Crucially, `letta/services/passage_manager.py:567` has `text_chunks = [text]` — the inserted text is **not chunked**, stored verbatim as a single passage.
- Extraction/enrichment: **The LLM itself decides what to insert.** Letta has no dedicated extraction pipeline; instead the Letta agent (MemGPT loop) is expected to call `archival_memory_insert` / `core_memory_replace` / `core_memory_append` at runtime based on its own judgment. So "what gets extracted" is whatever the model decided to save during the conversation. This is tool-call-as-extractor.
- Scope / multi-tenant: Enforced at the ORM layer. Every passage carries `organization_id` (line 589 of passage_manager.py), `archive_id`, `agent_id`. `ArchivalPassage.read_async(..., actor=actor)` on line 94 and throughout uses `actor.organization_id` for row-level security. Much stronger than Mem0's filter-based model — it's enforced at the SQL model, not the API boundary.
- Hybrid search: No.
- Reranker: No built-in. Tag filter + datetime filter are the only post-vector knobs.
- LongMemEval code: **None in the repo.** `gh search code --repo letta-ai/letta "longmemeval OR LongMemEval"` returned zero hits. `gh search code --repo letta-ai/letta "recall"` in `.py` files also zero. Their `tests/` directory has only integration tests (agent behavior, tool sandboxes), no benchmark runner, no retrieval-recall harness.
- Storage: Postgres + pgvector (default, `cosine_distance` from pgvector at `letta/services/helpers/agent_manager_helper.py:992`), SQLite fallback with a python-side `cosine_distance` function (`letta/orm/sqlite_functions.py`), and Turbopuffer for cloud (`letta/helpers/tpuf_client.py`, distance_metric="cosine_distance").
- Reproducibility: Since there's no bench runner, external groups write their own (LongMemEval authors' `evaluation/evaluate_session_response.py` + a thin Letta adapter). Env: Postgres, pgvector extension, OpenAI (or configured provider) for embeddings + chat. Alembic migrations under `alembic/`.
- **Surprising findings:**
  - Retrieval is the simplest of the four. That's honest — Letta sells the agent loop, not retrieval sophistication. But any claim about their LongMemEval score comes from a third-party runner, and the extractor is *the base LLM*, so their score is largely a function of which LLM is used at run time.
  - Strong row-level security via ORM `actor` object. Cleanest multi-tenant model among the four.
  - No chunking of inserted passages — if the LLM dumps a long paragraph into archival memory, it becomes one retrievable unit. This interacts badly with top-k retrieval for long memories.
  - They support Turbopuffer, Pinecone, and pgvector native — but only cosine distance. No L2 or IP hybrid.

## Cross-competitor findings

- **Who discloses dataset SHA?** None of the four disclose a dataset SHA. MemPalace and Zep use `longmemeval_s.json` by filename. MemPalace ships a custom `lme_split_50_450.json` seed=42 for dev/held-out splits. Mem0 and Letta don't ship LongMemEval code at all.
- **Who discloses retrieval unit?** MemPalace (session vs turn, via `--granularity`). Zep (edges + nodes, top-20 each, composed into a context paragraph). Mem0 (one memory-item per fact). Letta (one passage, verbatim). All are in code; none are documented as "the retrieval unit" in the README. This makes cross-framework comparisons meaningless without running the numbers yourself.
- **Who uses the OFFICIAL LongMemEval scorer vs custom?**
  - MemPalace: **custom** — reimplemented R@k / NDCG@k in `benchmarks/longmemeval_bench.py:49-80`. Does not invoke the official QA-judge scorer.
  - Zep: **matches official semantics** — per-category rubric LLM-as-judge, copied from the LongMemEval paper (`zep_longmem_eval.py:49-95`). This is the closest to LongMemEval-as-published among the four.
  - Mem0: **not applicable** — no LongMemEval runner. Their LoCoMo scorer is a simple "CORRECT/WRONG" LLM judge with category 5 skipped.
  - Letta: **not applicable** — no in-repo runner.
- **Who has an "if benchmark" branch or equivalent?**
  - **Yes, MemPalace.** `build_palace_and_retrieve_hybrid_v4` (line 1339) is a benchmark-specific code path, with named question IDs in its docstring (`d6233ab6`, `4dfccbf8`, `ceb54acb`). It only exists because those specific questions failed.
  - **Yes, Mem0.** `evaluation/src/memzero/add.py:16-42` monkey-patches the extraction prompt via `update_project(custom_instructions=...)` with a LoCoMo-shaped prompt. The default prompt differs. A user running Mem0 in production would not see these extractions.
  - **Yes, Mem0 category 5 skip.** `evaluation/metrics/llm_judge.py:87` `if int(category) == 5: continue`. Undisclosed outside code.
  - Zep: none observed.
  - Letta: no runner to branch on.
- **Any shared helper libraries across competitors?** No. Each stack is isolated. Graphiti and Zep share by authorship (same org).

## Implications for Memongo's plan

- **VALIDATES** our forensic audit's apples-to-apples neutralization stance, specifically:
  - Fix the retrieval unit (session-granularity for LongMemEval-S is the default contract; anything that retrieves "facts" or "graph edges" must be collapsed back to session for the recall comparison).
  - Use the official LongMemEval scorer end-to-end. Only Zep is close to this among the four, and even Zep measures against Zep Cloud.
  - Pin dataset SHA and split. MemPalace's `lme_split_50_450.json` (seed=42) is a documented contaminated split; we should not reuse it — we need our own seed.
  - Require a `--no-rerank` leg. MemPalace's 100% is LLM-rerank-dependent. Mem0's numbers require pluggable rerankers. Our numbers must be reported with and without to avoid category errors.
- **NEW ASYMMETRIES** our audit missed:
  1. **MemPalace ships four tuned retrieval modes named after specific failing question IDs.** This is worse than "test-set leakage" — it's question-ID leakage. Our MemPalace-asymmetries memory should add this as a concrete line item with those three IDs, and insist they run with the "raw" mode only, not v2/v3/v4. If they publish hybrid_v4, we cite the docstring.
  2. **Mem0's extraction prompt is benchmark-specific and monkey-patched on start.** The default-config extraction (unit production mem0 users see) is not the prompt that produced 93.4. This should be flagged as a disclosure-ask on their side.
  3. **Mem0's LLM judge drops a question category silently.** Before we publish anything comparing to Mem0's LoCoMo numbers, we must confirm which category 5 is and whether skipping it is systematic.
  4. **Letta's 'extractor' is the base LLM itself, not a library.** Any comparison has to control for the base model on both sides, or Letta's number is conflated with "which LLM you ran."
  5. **Graphiti write path has ~4–8 LLM calls per episode.** If we benchmark wall-clock ingest time, Graphiti will look slow; if we benchmark pure retrieval recall given a prewarmed graph, it will look strong. Report both.
  6. **Multi-tenant isolation varies wildly** — Letta enforces at ORM, Mem0 enforces at API filter, MemPalace does not enforce at all (one Chroma collection per palace). If Memongo publishes a "multi-tenant" story, this is a genuine differentiator worth isolating as its own comparison axis.
  7. **MemPalace owner is `MemPalace/mempalace` (org)**, not `milla-jovovich/mempalace`. Fix the source-of-truth URL in our memory file.
- **REPRODUCIBILITY RISKS:**
  - **Easy:** MemPalace (OSS + self-contained Python, local Chroma, deterministic). Graphiti self-hosted (docker-compose with Neo4j, OSS code). Letta (OSS, Postgres+pgvector, docker-compose).
  - **Hard:** Zep numbers (need paid Zep Cloud with undisclosed ontology updates between versions). Mem0 numbers (need paid Mem0 Cloud with custom_instructions for each benchmark).
  - **Impossible without vendor cooperation:** Reproducing Mem0's published 93.4 LongMemEval. There is literally no code for it. Our plan needs to declare that number as "vendor-unverified" if cited.

## Code Patterns (proof excerpts)

- MemPalace test-set leakage, `benchmarks/longmemeval_bench.py:1343-1366`:
  ```
  Hybrid V4: hybrid_v3 + three targeted fixes for the final 3 misses.
  Miss 1 — 'high school reunion' (d6233ab6, single-session-preference) ...
  Miss 2 — 'Rachel/ukulele' (4dfccbf8, temporal-reasoning) ...
  Miss 3 — 'sexual compulsions' (ceb54acb, single-session-assistant) ...
  ```
- Mem0 benchmark prompt injection, `evaluation/src/memzero/add.py:16-42`:
  ```
  custom_instructions = """Generate personal memories that follow these guidelines: ...
   - Identity and self-acceptance journeys
   - Family planning and parenting ..."""
  self.mem0_client.update_project(custom_instructions=custom_instructions)
  ```
- Mem0 category-5 skip, `evaluation/metrics/llm_judge.py:85-87`:
  ```
  # Skip category 5
  if int(category) == 5:
      continue
  ```
- Zep retrieval unit, `benchmarks/longmemeval/zep_longmem_eval.py:343-348`:
  ```
  edges_results = await self.zep.graph.search(user_id=user_id, query=question, limit=20)
  nodes_results = await self.zep.graph.search(user_id=user_id, query=question, search_scope="nodes", limit=20)
  ```
- Letta pure cosine kNN, `letta/services/helpers/agent_manager_helper.py:992`:
  ```
  main_query = main_query.order_by(combined_query.c.embedding.cosine_distance(embedded_text).asc())
  ```
- Letta no-chunking insert, `letta/services/passage_manager.py:566-567`:
  ```
  # TODO: check to make sure token count is okay for embedding model
  text_chunks = [text]
  ```

## Gotchas for our plan

- Don't cite MemPalace's 100% in any table — cite 96.6% (raw) and/or 98.4% (held-out 450) with the retrieval-recall qualifier, or we re-commit their category error.
- Don't cite Mem0's 93.4 LongMemEval without a "vendor-reported, not reproducible in this repo" footnote.
- When we run Letta in-house, pin the embedding model and the base LLM explicitly; their retrieval quality is dominated by those two choices.
- For Graphiti self-hosted, we need to pin which `search_config_recipes.py` preset we use — they default to `COMBINED_HYBRID_SEARCH_RRF`, and cross-encoder is opt-in. Anyone citing "Graphiti" without the preset is ambiguous.

## What Changed the Recommendation

MemPalace's `benchmarks/longmemeval_bench.py:1339-1366` — a single function header naming three LongMemEval question IDs by hash as "the final 3 misses" to patch — proves that our MemPalace-specific asymmetries memory needs to be upgraded from "suspected test-set tuning" to "documented, self-admitted test-set leakage with named question IDs." Our benchmark runner should explicitly require `--mode raw` and refuse to report hybrid_v2/v3/v4 numbers without an asterisk.

## References

- MemPalace/mempalace@68319dc (develop): https://github.com/MemPalace/mempalace/tree/68319dc/
  - benchmarks/longmemeval_bench.py
  - benchmarks/BENCHMARKS.md
  - benchmarks/HYBRID_MODE.md
  - mempalace/backends/chroma.py
  - mempalace/layers.py
  - mempalace/general_extractor.py
  - Issue #875 (closed): https://github.com/MemPalace/mempalace/issues/875
- mem0ai/mem0@54a03cc (main): https://github.com/mem0ai/mem0/tree/54a03cc/
  - mem0/memory/main.py
  - evaluation/run_experiments.py
  - evaluation/src/memzero/add.py
  - evaluation/src/memzero/search.py
  - evaluation/metrics/llm_judge.py
  - PR #4811: https://github.com/mem0ai/mem0/pull/4811
- getzep/graphiti@c427615 (main): https://github.com/getzep/graphiti/tree/c427615/
  - graphiti_core/graphiti.py
  - graphiti_core/search/search.py
  - graphiti_core/search/search_config_recipes.py
  - graphiti_core/prompts/ (extract_nodes.py, extract_edges.py, ...)
- getzep/zep@faf2ace (main): https://github.com/getzep/zep/tree/faf2ace/
  - benchmarks/longmemeval/zep_longmem_eval.py
- letta-ai/letta@bb52a89 (main): https://github.com/letta-ai/letta/tree/bb52a89/
  - letta/services/helpers/agent_manager_helper.py
  - letta/services/passage_manager.py
  - letta/services/archive_manager.py
  - letta/services/tool_executor/core_tool_executor.py
  - letta/functions/function_sets/base.py

---
GitHub research complete.
