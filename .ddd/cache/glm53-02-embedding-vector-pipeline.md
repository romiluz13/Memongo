# 02 — Embedding & Vector Pipeline: Deep Review Findings

Reviewer: 02 (independent pass). All claims below were verified against source at
commit `1d98eb36f1` (main). File references are repo-root relative. External
claims are cited to MongoDB / Voyage AI documentation fetched during this review.

## Executive summary

Memongo's vectorization layer is architecturally coherent: it is 100% Atlas
autoEmbed (server-side embedding), every writer stores plain text and marks it
`embeddingStatus: "pending"`, and all query embedding happens inside
`$vectorSearch` via `query: { text }` + `model`. Two guardrails adapted from
`mongodb-partners/agent-memory` (dimension consistency, model-migration refusal)
are genuinely wired into manager startup (`packages/memory-engine/src/mongodb-manager.ts:653,660`),
and a per-request search budget caps aggregation/embedding storms.

The layer's problems are concentrated in four places:

1. **The entire product depends on a MongoDB Preview feature** ("do not use in
   production" per MongoDB's own docs) with zero fallback — and the ~1,600-line
   client-side provider stack that *looks* like a fallback is dead code that no
   production path can reach.
2. **The model literal `"voyage-4-large"` is hardcoded in 9 separate call sites**
   beyond the single source of truth; only the guardrails compare against the
   source of truth, so a model change leaves the fallbacks silently sending the
   old model.
3. **Coverage measurement uses an ANN probe with `numCandidates == limit`**,
   which conflates HNSW recall loss with missing embeddings and fabricates
   "pending" documents.
4. **Cost accounting exists only for query-time embeds inside searchV2** — the
   query-cache semantic probe, consolidation pipelines, and *all* indexing-time
   embeddings (the dominant cost) are unbudgeted and uncounted.

Finding counts: **1 P0, 2 P1, 4 P2, 4 P3**.

---

## Checklist verification

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Production is 100% autoEmbed; no client-side path left | **PASS** (with dead-code caveat, F9) | Writers write text + `embeddingStatus: "pending"` only (`mongodb-sync.ts`, `mongodb-kb.ts`, `mongodb-structured-memory.ts`); `buildVectorSearchStage` returns `null` unless `embeddingMode === "automated"` (`mongodb-search.ts:604-609`); `probeEmbeddingAvailability` rejects every mode except `"automated"` (`mongodb-manager-admin.ts:592`); the `embeddings*.ts` provider family has zero production consumers (verified by repo-wide import grep — only intra-family imports, `internal.ts`'s byte estimator, and tests) |
| 2 | Model literal defined once, pinned, old data protected on change | **PARTIAL FAIL** | Source of truth: `INDEX_AUTOEMBED_MODEL` (`mongodb-schema-search-definitions.ts:262`), used by index definitions and both guardrails. But `"voyage-4-large"` is duplicated as a fallback literal in 9 call sites (F2). Old data on change: Guardrail 2 refuses to start and reports re-embed blast radius unless `MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE=true` (`embedding-validation.ts` `refuseToStrandExistingDocuments`) — this part is solid |
| 3 | Dimension flow can never disagree | **PASS** (latent gap, F7) | autoEmbed index definitions deliberately carry no `numDimensions`/`similarity`/`quantization` — the server rejects them and the model determines all (documented with live-probe scars in `mongodb-schema-search-definitions.ts` `buildAutoEmbedVectorDefinition` docblock). Queries never supply `queryVector` in production, so client/server dimension disagreement is structurally impossible. Startup Guardrail 1 cross-checks query-model vs index-model dimensions (`mongodb-manager.ts:653`). Caveat: the guardrail checks *dimensions*, but the server's compatibility rule is *model family* (F7) |
| 4 | `embeddingStatus` lifecycle; can a doc stay "pending" forever; does search exclude non-ready docs | **PARTIAL FAIL** | Statuses: `pending`/`success`/`failed` (`mongodb-embedding-retry.ts`). Writers always write `"pending"`; nothing ever advances it in automated mode — `reconcileEmbeddingStatus` (`mongodb-analytics.ts:433`) advances only docs with an on-document `embedding` array, which never exists under autoEmbed (vectors live in Atlas's managed store). So yes: every chunk/kb/structured doc stays `"pending"` forever, no reaper. Mitigations: search never filters on `embeddingStatus` (correct — the index skips un-embedded docs server-side), and analytics stopped reading the field (issue #26 fix, `mongodb-analytics.ts` `measureEmbeddingCoverage` derives from index `numDocs`/live probe). Net effect: the persisted field is vestigial and lies to anyone reading it directly (F6) |
| 5 | Voyage API usage, key config/validation, rate limits, retry | **PARTIAL FAIL** | No production embedding HTTP calls to Voyage — embedding is server-side. The only live direct Voyage HTTP client in the engine is the *reranker* (`mongodb-reranker.ts:42-47`, routes `al-` keys to `ai.mongodb.com`, others to `api.voyageai.com`). The embedding API key (`VOYAGE_API_KEY`) is consumed exclusively by the mongot container (`docker/compose.yaml`, `docker/mongodb/start.sh`); the app never reads or validates it — an invalid key surfaces only as embedding 403s / stuck indexes (documented in `docker/mongodb/README.md` troubleshooting). Separate query/indexing keys (`VOYAGE_API_QUERY_KEY`/`VOYAGE_API_INDEXING_KEY`) are supported in `docker/mongodb/setup-generator.sh`, aligning with MongoDB's docs recommendation. No TPM/RPM accounting anywhere (F5, U2) |
| 6 | What text gets embedded; empty/very long/non-English/code | **PARTIAL FAIL** | Chunks: capped at `chunking.tokens * 4` chars per chunk by `chunkMarkdown` (`internal.ts:470,529`). Session evidence: truncated at 8,000 chars at sentence boundary (`mongodb-session-evidence.ts:70`). **Unbounded**: `events.body` written verbatim (`mongodb-events.ts:231`) and `structured_mem.value` written verbatim — both are autoEmbed target fields, and voyage-4 models have a 32k-token input limit, so oversized inputs fail server-side with no signal (F4). `splitTextToUtf8ByteLimit` exists (`embedding-input-limits.ts:34`) but has zero non-test consumers. Empty text / non-English / code-block handling: NOT VERIFIED in this pass |
| 7 | Index type, similarity, quantization, filters | **PASS** | Type `vectorSearch` (not legacy `atlasVectorSearch` — capability checks use `isSearchIndexTypeCompatible(type, "vectorSearch")`, `mongodb-schema-capabilities.ts`). `similarity`/`numDimensions`/`quantization` omitted because the server rejects them on autoEmbed fields (model determines all; live-probed on 8.3.4, recorded in definition docblock). Quantization is probe-adopted: configured value ships, server rejection is caught and retried via `withoutFieldQuantization`. Filter fields (`scope`, `scopeRef`, `agentId`, ...) added via `buildAutoEmbedVectorDefinition` filterPaths. `storedSource` include-lists are field-usage-mapped per collection and version-gated (8.3.7+) via the capability registry |
| 8 | Re-embedding on update | **PASS** | MongoDB docs: autoEmbed "generates embeddings for existing and new documents that you insert or update" — Atlas re-embeds on every update, so stale vectors after edit are structurally impossible. Model change triggers a full corpus re-embed; that blast radius is exactly what Guardrail 2 refuses at startup (with an explicit error listing per-index document counts) |
| 9 | Cost accounting | **PARTIAL PASS** | Query-time: a real per-request budget exists — `runWithSearchBudget` (12 aggregations / 5 embeddings, AsyncLocalStorage-shared across lanes, atomic reservations, exhaustion degrades to empty-not-error; `mongodb-search-budget.ts`, established only at `mongodb-search-v2.ts:237`). Indexing-time: **zero accounting** — every write costs a server-side embedding and nothing counts or caps it (U2). Token accounting: none (budget counts embed calls, not tokens; MongoDB rate limits are TPM/RPM). Cache probe + consolidation embeds bypass the budget entirely (F5) |

---

## Correctness findings

### F1 (P0, architectural) — Entire embedding layer depends on a Preview feature with no fallback

**Evidence:** MongoDB "Automated Embeddings" documentation (fetched this review):
"Automated Embeddings is available as a Preview feature... Do not use this
feature in your production environment." Memongo's embedding mode is exclusively
`"automated"` (`mongodb-manager-admin.ts:592` returns `ok: false, "unsupported
embedding mode"` for anything else). The client-side provider stack
(`embeddings.ts`, `embeddings-voyage.ts`, `embeddings-gemini.ts`,
`embeddings-ollama.ts`, `embeddings-openai.ts`, `embeddings-mistral.ts`,
`embeddings-remote-*.ts`, `embedding-vectors.ts`) is exported from its module
but unreachable from production (not in `index.ts`, not imported by
memory-bridge/apps; verified via repo-wide import grep). The `"client"` branch
in `measureEmbeddingCoverage` (`mongodb-analytics.ts`) is vestigial.

**Impact:** A Preview deprecation, breaking definition change, or pricing/limit
shift breaks every memory product built on memongo simultaneously, with no
code-level fallback and no migration path short of writing a new client-side
pipeline. The dead provider code creates a false impression that a fallback
exists.

**Fix:** Either (a) treat this as an explicit, documented deployment constraint
(atlas-local-preview / atlas-managed only, Preview semantics accepted) and
delete or clearly quarantine the dead provider stack, or (b) build a real
client-embedding fallback mode (the analytics `"client"` branch already sketches
the measurement side). Do not leave the current ambiguity.

### F2 (P1, drift trap) — `"voyage-4-large"` fallback literal duplicated across 9 production call sites

**Evidence:** Source of truth is `INDEX_AUTOEMBED_MODEL`
(`mongodb-schema-search-definitions.ts:262`). Independent fallback literals:

- `packages/memory-engine/src/mongodb-search.ts:608` (`base.model = input.model ?? "voyage-4-large"`)
- `packages/memory-engine/src/mongodb-search-v2.ts:359`
- `packages/memory-engine/src/mongodb-manager-lifecycle.ts:512`
- `packages/memory-engine/src/mongodb-kb.ts:126`
- `packages/memory-engine/src/mongodb-sync.ts:448`
- `packages/memory-engine/src/mongodb-consolidator.ts:889,1205,1357`
- `packages/memory-engine/src/mongodb-novelty.ts:167`

**Impact:** If `INDEX_AUTOEMBED_MODEL` ever changes to a model outside the
voyage-4 family, these fallbacks silently keep sending `"voyage-4-large"` as the
query model. Per MongoDB docs, out-of-family query models are incompatible with
the index model — `$vectorSearch` returns nothing / errors. Guardrail 1 only
checks the *configured* `queryEmbeddingModel` against the index model; callers
that never set a model bypass the guardrail's premise entirely. Guardrail 2
would catch the index-side change, but the fix (restore old model) fights the
intent of the change.

**Fix:** Every `?? "voyage-4-large"` must become `?? INDEX_AUTOEMBED_MODEL`
(single import), and a lint rule / test should forbid the bare literal outside
`mongodb-schema-search-definitions.ts`.

### F3 (P1, correctness) — Coverage probe uses ANN with `numCandidates == limit`, fabricating "pending" documents

**Evidence:** `countRetrievableViaVectorIndex`
(`packages/memory-engine/src/mongodb-analytics.ts:204-234`) runs
`$vectorSearch` with `numCandidates: params.limit, limit: params.limit`
(line 218). MongoDB docs: ANN recall requires `numCandidates` "at least 20
times higher than limit"; with them equal, HNSW beam search can miss indexed
documents. The result feeds `measureEmbeddingCoverage`, which computes
`success = min(total, indexedCount)` and `pending = total - indexedCount` —
so recall loss is reported as un-embedded documents.

**Impact:** Operators see inflated "pending" counts (or deflated coverage) on
collections that are fully embedded, and may trigger re-indexing/re-embedding
investigations for a non-problem. On a 10k-doc collection the error can be
hundreds of docs.

**Fix:** Use ENN for counting: `exact: true` and omit `numCandidates` (the
10k cap already bounds `limit`). ENN is the documented tool for
"query less than 10000 documents" / measurement use cases. Optionally
cross-check `numDocs` from `$listSearchIndexes` when present.

### F4 (P2, silent failure) — No input-length guard on autoEmbed inputs (`events.body`, `structured_mem.value`)

**Evidence:** `mongodb-events.ts:231` writes `body: event.body` verbatim;
`mongodb-structured-memory.ts` writes `value: entry.value` verbatim. Both are
autoEmbed target fields (`autoEmbedVectorField("body")`,
`autoEmbedVectorField("value")` in `mongodb-schema-search-indexes.ts`).
Voyage-4 family input limit is 32k tokens; nothing in the engine bounds these
fields (chunks are bounded via `chunkMarkdown` `maxChars = tokens*4`,
`internal.ts:470`; session evidence via 8k-char truncation,
`mongodb-session-evidence.ts:70`). `splitTextToUtf8ByteLimit`
(`embedding-input-limits.ts:34`) exists for exactly this and is unused in
production. Events documents carry no `embeddingStatus` field at all, so there
is not even a lying marker — the doc is stored, never retrievable via
`events_vector`, with zero signal.

**Impact:** One oversized event or structured value silently disappears from
semantic retrieval forever — the exact "memory exists but is not recallable,
which reads as 'the user never told us that'" failure agent-memory's
`embedding_check.py` was written to prevent.

**Fix:** Bound every autoEmbed target field at write time (truncate-and-mark,
or chunk long bodies like chunks are chunked); wire
`splitTextToUtf8ByteLimit` (or a token estimator) into the events and
structured-memory writers.

### F5 (P2, cost) — Query-cache semantic probe and consolidation pipelines spend unbudgeted paid embeddings

**Evidence:** Only `mongodb-search-v2.ts:237` establishes a search budget. The
tier-2 cache probe calls `buildVectorSearchStage` directly
(`mongodb-query-cache.ts:360`) → `tryConsumeSearchEmbed()`
(`mongodb-search.ts:600`) → `tryConsume` returns `true` unthrottled for
unbudgeted callers — the code comments this explicitly: "Unbudgeted callers
(cache probe, diagnostics, legacy paths outside searchV2) are never throttled"
(`mongodb-search-budget.ts:167`). Consolidation `$vectorSearch` calls
(`mongodb-consolidator.ts:889,1205,1357`) are likewise outside any budget.

**Impact:** Every search pays at least one extra paid query embedding (cache
probe on miss) on top of the budget-capped lanes; the budget that exists to
stop embedding storms cannot see this spend. Deliberate (documented in the
comment) but unaccounted: no metric, no cap, no token count.

**Fix:** Either admit the cache probe into the request budget (it is per-search
spend, which is what the budget is for), or emit an explicit embed-spend metric
per search covering all `$vectorSearch` executions. Same for consolidation,
which should carry its own (batch-scale) budget.

### F6 (P3, lying state) — `embeddingStatus` stays `"pending"` forever in automated mode

**Evidence:** Writers always write `"pending"`
(`mongodb-sync.ts`, `mongodb-kb.ts`, `mongodb-structured-memory.ts`);
`reconcileEmbeddingStatus` (`mongodb-analytics.ts:433`) advances only documents
with an on-document `embedding` array (`"embedding.0": { $exists: true }`),
which never exists under autoEmbed. Its own docblock acknowledges this.

**Impact:** Low today — analytics no longer reads the field (issue #26) and
search never filters on it — but any consumer that reads the raw field
(dashboards, exports, future code) sees 100% pending, and the field costs a
write on every document.

**Fix:** Either stop writing `embeddingStatus` in automated mode, or repurpose
it (e.g., `embeddingMode` provenance marker) so persisted state stops lying.

### F7 (P2, latent guardrail gap) — Guardrail 1 compares dimensions, but the server's compatibility rule is model-family membership

**Evidence:** `assertQueryModelDimensionsMatch` (`embedding-validation.ts:79-93`)
compares `KNOWN_MODEL_DIMENSIONS` entries and throws only on dimension
inequality. MongoDB `$vectorSearch` docs: "All the models in the `voyage-4`
family are compatible with each other, but `voyage-code-3` is not compatible."
`KNOWN_MODEL_DIMENSIONS` lists `voyage-3: 1024` — same dimension count as
`voyage-4-large` but not family-compatible. Today this is unreachable because
`resolveQueryEmbeddingModel` (`backend-config.ts`) allow-lists only
voyage-4-large/voyage-4/voyage-4-lite. The error message also advises "set a
model with the same dimensions" — advice that is neither necessary nor
sufficient in general.

**Impact:** The moment the allow-list widens (voyage-code-3 is an obvious
candidate for a coding-memory product — same 1024 dims), Guardrail 1 passes and
`$vectorSearch` silently returns nothing: precisely the failure the guardrail
was built to prevent.

**Fix:** Compare *family compatibility*, not dimensions: assert the query model
is in the same family as `INDEX_AUTOEMBED_MODEL` (today: the voyage-4 set), and
keep the dimension table only as diagnostic metadata.

### F8 (P3, readiness overstatement) — `probeEmbeddingAvailability` never validates the Voyage key and reads startup-cached capabilities

**Evidence:** `mongodb-manager-admin.ts:592`: in automated mode `ok` is exactly
`this.host.capabilities.vectorSearch` — index exists, type-compatible, READY
and queryable (`mongodb-schema-capabilities.ts` `detectCapabilities`).
Capabilities are detected at startup (`waitForSearchCapabilities`) and cached on
the host. The app never checks `VOYAGE_API_KEY` presence, prefix, or health;
`docker/mongodb/README.md` documents the real failure mode: "an invalid
`VOYAGE_API_KEY`. Every embedding call returns 403."

**Impact:** A key that is valid at boot and revoked/rotated later leaves status
green while every embedding silently fails (queries degrade to empty). A key
that is invalid from the start *probably* surfaces via stuck/FAILED indexes,
but that coupling is undocumented and deployment-specific.

**Fix:** Make the probe execute (or at least replay the outcome of) a live
`$vectorSearch` like `canReturnStoredSource` does, and re-probe on demand
rather than serving the boot-time snapshot forever.

### F9 (P3, dead code) — ~1,600 lines of unreachable client-side embedding provider code

**Evidence:** `embeddings.ts` (provider auto-selection, fallback chain,
node-llama-cpp local provider), `embeddings-voyage.ts`,
`embeddings-gemini.ts`, `embeddings-ollama.ts`, `embeddings-openai.ts`,
`embeddings-mistral.ts`, `embeddings-remote-fetch.ts` (3-retry HTTP with
429/5xx/timeout backoff, sanitize+normalize), `embedding-vectors.ts`,
`embedding-inputs.ts` — imported only by each other, their tests, and one byte
estimator in `internal.ts`. Not exported from the engine `index.ts`, not
consumed by memory-bridge or any app.

**Impact:** Maintenance cost, test-time cost, and — worse — a false signal
that a client-side fallback path exists (compounds F1). The remote-fetch retry
logic is genuinely good and is exactly what a future client mode would need,
which makes its dead status a trap.

**Fix:** Delete, or move behind an explicit `embeddingMode: "client"`
implementation so the code and the mode live or die together.

### F10 (P3, syntax drift) — Coverage probe uses legacy `query: "<string>"` form

**Evidence:** `mongodb-analytics.ts:217` passes `query: COVERAGE_PROBE_QUERY`
(a bare string) while every production path and the capability probe use the
documented object form `query: { text: ... }`
(`mongodb-search.ts:607`, `mongodb-schema-capabilities.ts:62`).

**Impact:** None today (both forms are accepted by current builds), but if the
string form is ever dropped, the probe throws, is caught, returns `null`, and
coverage silently degrades to `unknown` — a quiet diagnostics loss.

**Fix:** Use `query: { text: COVERAGE_PROBE_QUERY }` for consistency.

### F11 (P2, privacy / OWASP LLM sensitive-disclosure adjacent) — API-recorded event bodies are embedded (sent to Voyage) without redaction; session-file ingestion is redacted

**Evidence:** `session-files.ts:122` applies `redactSecrets(text)` before
storing/embedding session text — a redaction layer exists on that path. The
event write path has no such layer: `mongodb-events.ts:231` stores
`body: event.body` verbatim, and that body is autoEmbedded server-side (i.e.,
leaves the cluster to the Voyage/Atlas embedding endpoint). Repo-wide grep
shows `redactSecrets` applied nowhere else in the engine write path.
Structured-memory `value`/`context` likewise unredacted.

**Impact:** Secrets or sensitive data pasted into conversations via the API
record path are transmitted to a third-party embedding service, in contrast to
the session-file path which redacts first. Inconsistent data-exposure posture
between two ingestion paths into the same embedding pipeline.

**Fix:** Apply the same `redactSecrets` (or a stronger, configurable redaction
gate) uniformly at every autoEmbed input boundary, or document explicitly which
ingestion paths are pre-redaction-safe.

---

## Unknown unknowns (beyond the checklist)

- **U1 — Preview deprecation blast radius (F1's tail):** autoEmbed has no
  stability guarantee; a definition-syntax or model-catalog change lands as a
  startup index-creation failure that `ensureSearchIndexes` currently handles
  by logging and degrading to `{ vector: false }` — semantic search silently
  disappears on an upgrade. There is no version pin of the mongot/atlas-local
  image behavior beyond the docker image tag.
- **U2 — Indexing-time embedding cost is entirely uncounted.** The search
  budget was built to stop query-time storms, but the dominant spend is
  indexing: every event, chunk, KB doc, structured value, procedure, and
  consolidation write triggers a server-side embedding. No counter, no metric,
  no cap, no per-tenant metering exists. A bulk KB import of a large corpus is
  an unbounded embedding bill.
- **U3 — TPM/RPM rate-limit collisions:** MongoDB docs specify per-project
  TPM/RPM limits for automated embedding. Bulk ingest + concurrent searches
  can hit them; the failure mode (embedding generation pauses, index lag) is
  invisible to the engine, which has no signal for index lag beyond the
  startup `waitForSearchIndexesQueryable` (60s default timeout, then proceeds).
- **U4 — Embedding storage cost:** MongoDB docs state autoEmbed vectors are
  stored in a separate internal database on-cluster (M10+ requires storage
  auto-scaling; a full disk transitions the index to Stale and pauses
  embedding). Nothing in memongo accounts for or monitors this.
- **U5 — Re-embed on every update:** autoEmbed re-embeds on every document
  update (docs), and memongo's sync/projection paths rewrite documents on
  schedule — unchanged-but-rewritten documents may be re-embedded at full
  price. Whether `mongodb-sync.ts` skips byte-identical chunks was NOT
  VERIFIED in this pass; if it does not, there is a dedup/cache opportunity
  (the unknown-unknowns directive's "identical texts re-embedded every time").
- **U6 — Guardrail 2 fails open:** if `listSearchIndexes` throws mid-scan
  (e.g. transient Atlas API error), `findStrandingModelChanges` returns `[]`
  with only a `console.warn` — the re-embed refusal silently does not happen
  for that scan (`embedding-validation.ts`, documented in-code as intentional).
  A startup retry or hard-fail option would be safer for a guardrail whose
  entire purpose is refusing.
- **U7 — `queryNorm` cache embeddings are never TTL-checked against model
  drift:** the query_cache index embeds normalized queries with the query model;
  if the index model changes (with the env bypass set), cached queryNorm
  vectors/queries from the old model remain in the cache collection and are
  compared against new-model query embeddings — cross-family cosine
  comparisons are meaningless. Cache invalidation on model change was NOT
  VERIFIED.

---

## Competitor comparison (source-inspected)

| Competitor | What they do (verified in source) | What memongo lacks / should adopt |
|---|---|---|
| `mem0ai/mem0` | `mem0/embeddings/*`: 12+ provider classes (openai, ollama, huggingface, azure, gemini, vertexai, together, lmstudio, langchain, bedrock, fastembed...) behind an `EmbeddingBase` ABC; `EmbedderConfig` validates provider at config time; `embed_batch()` with native-batch override and a `memory_action` context ("add"/"search"/"update") so index-time and query-time embedding can differ | Any provider portability at all (single server-managed model). Not necessarily wrong — but memongo's equivalent abstraction (`embeddings.ts`) is dead code; either commit to the autoEmbed bet (delete it) or make it real |
| `mongodb-partners/agent-memory` | `agent_memory/core/embedding_check.py`: pre-write batch validation — refuses (never repairs) on vector-count != input-count or wrong width, with a documented rationale for refusal-over-repair; `migrations.py`: `find_stranding_dimension_changes`, drop-and-recreate for dimension changes, two-stage index init, and reconciliation of *existing* index definitions against shipped ones (not just creation) | Memongo already adapted both patterns (verified in `embedding-validation.ts` header: Guardrail 1 ← `expected_dimension()`, Guardrail 2 ← `find_stranding_dimension_changes()` + `_refuse_to_strand_existing_vectors()`), correctly moved to startup since there is no client write path. Remaining gap: agent-memory's count-check (silent partial-batch loss) has no autoEmbed analogue — the server-side equivalent is "doc written but never embedded," which memongo detects nowhere per-document (F4/F6) |
| `letta-ai/letta` | Per-block embedding config | NOT VERIFIED — GitHub code search returned no results for embedding_model in the repo via the API in this pass; treat as unverified |
| `topoteretes/cognee` | `cognee/infrastructure/databases/vector/embeddings/EmbeddingEngine.py`: a Protocol that makes `get_vector_size()` and `get_batch_size()` *interface-level contracts* alongside `embed_text()`; multiple engine implementations (LiteLLM, OpenAI-compatible, Ollama, Fastembed) | The dimension/batching contract idea: memongo's KNOWN_MODEL_DIMENSIONS is a side table consulted by one guardrail, rather than a declared contract on the (server-side) embedding path. Low priority given autoEmbed, but the family-compatibility contract (F7) is the missing analogue |

---

## External documentation alignment

| Doc claim (source) | Memongo behavior | Aligned? |
|---|---|---|
| Automated Embeddings is Preview; "Do not use this feature in your production environment" (MongoDB automated-embedding docs) | Product is built exclusively on it; deployment profiles are atlas-local-preview / atlas-managed | **Misaligned (F1)** — accepted risk, but undocumented as such |
| voyage-4 family models are mutually compatible; voyage-code-3 is not; `model` optional, defaults to index model (MongoDB `$vectorSearch` docs) | Query model always sent (with fallback literal); allow-list restricts to voyage-4 family; Guardrail 1 checks dimensions, not family | **Partially aligned** — works today, dimension check is the wrong predicate (F7); fallback literal bypasses the premise (F2) |
| `numCandidates <= 10000`; recommend `>= 20x limit` for ANN recall; ENN for <10k docs / measurement (MongoDB `$vectorSearch` docs) | Search lanes default 500 numCandidates (legacy path uses `max(20*limit, 100)` — aligned); coverage probe uses `numCandidates == limit` | **Misaligned in the probe only (F3)** |
| Automated embedding rate limits are TPM/RPM (MongoDB docs) | No token or request accounting anywhere; per-search embed-count budget only, and only inside searchV2 | **Misaligned (F5, U2, U3)** |
| autoEmbed re-embeds on insert *and* update; model change triggers full re-embed (MongoDB docs) | Relies on both behaviors; Guardrail 2 makes the model-change blast radius a startup refusal with per-index doc counts | **Aligned** (best-in-class vs competitors inspected) |
| Embedding vectors stored in a separate internal database on-cluster; disk-full → index Stale, embedding pauses (MongoDB docs) | No monitoring or accounting of embedding storage | **Gap (U4)** |
| `queryVector` format must match index quantization or results are empty (MongoDB docs) | Moot — no production `queryVector` use; automated mode always `query: { text }` | Aligned (N/A) |
| Separate query/indexing API keys recommended (MongoDB docs) | Supported in `docker/mongodb/setup-generator.sh` (`VOYAGE_API_QUERY_KEY` / `VOYAGE_API_INDEXING_KEY`) | **Aligned** |
| `maxTimeMS` supported for `$vectorSearch` cancellation (MongoDB docs) | `DEFAULT_USER_SEARCH_MAX_TIME_MS = 10_000` applied to user-driven pipelines, env-overridable (`mongodb-search-budget.ts`) | **Aligned** |
| voyage-4-large: 1024 dims default (256/512/2048 configurable), 32k-token input (Voyage AI docs) | `KNOWN_MODEL_DIMENSIONS["voyage-4-large"] = 1024`; no input-length enforcement on events/structured (F4) | **Partially aligned** |

---

## Recommendations (ranked)

**P0**
1. F1: Decide and document the Preview-feature posture. Either declare
   atlas-local-preview/atlas-managed with Preview semantics an explicit
   supported-target contract, or build the client-side fallback. Delete or
   quarantine the dead provider stack either way.

**P1**
2. F2: Replace all 9 `"voyage-4-large"` fallback literals with
   `INDEX_AUTOEMBED_MODEL`; add a repo lint/test forbidding the bare literal.
3. F3: Switch the coverage probe to ENN (`exact: true`, no `numCandidates`).

**P2**
4. F4: Bound `events.body` and `structured_mem.value` (and any other autoEmbed
   target) at write time; wire `splitTextToUtf8ByteLimit` or an equivalent.
5. F5: Bring the cache-probe (and consolidation) embeddings under a budget or
   an explicit spend metric; add indexing-time embed counters.
6. F7: Change Guardrail 1 to family-compatibility checking.
7. F11: Apply redaction uniformly across all ingestion paths that feed
   autoEmbed, or document the exposure boundary per path.

**P3**
8. F6: Stop writing (or repurpose) `embeddingStatus` in automated mode.
9. F8: Make `probeEmbeddingAvailability` reflect live embedding health, not
   boot-time index readiness.
10. F10: Normalize the coverage-probe query to `query: { text }`.
11. F9: Remove or activate the dead provider code (subsumed by rec 1).

**Unverified in this pass (honest gaps):** letta per-block embedding config
(code search unreachable); empty-text autoEmbed behavior; non-English/code-block
retrieval quality; whether `mongodb-sync.ts` skips byte-identical chunks on
re-sync (U5 dedup question); query-cache invalidation on model change (U7);
upstream (apps/api) redaction before `recordEvent`.
