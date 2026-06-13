# MongoDB Benchmark Capability Doctrine

Status: required decision log for benchmark-affecting retrieval, indexing,
schema, and answer-context changes.

This doctrine exists so Memongo wins by being a better MongoDB-native memory
framework, not by chasing benchmark questions. Every benchmark-affecting change
must map to a MongoDB capability, cite current MongoDB docs or MongoDB MCP
knowledge, and preserve raw artifacts.

## Required Decision Record

Before changing retrieval, index definitions, schema, scoring envelopes, or
answer-context packaging, record:

| Field | Required value |
| --- | --- |
| Capability family | Search, Vector Search, Hybrid Search, aggregation/schema, graph/provenance, readiness, cost/latency |
| MongoDB feature | Specific operator, stage, index type, schema pattern, or readiness API |
| Version support | Local Preview / Atlas version and whether the feature is preview/GA |
| Index shape | Indexed fields, filter fields, analyzers, vector dimensions, quantization/autoEmbed status |
| Query shape | Pipeline/stage order, filters, `limit`, `numCandidates`, fusion weights, projected diagnostics |
| Artifact impact | Which benchmark artifacts will show the feature and warnings/degradations |
| Stop condition | The exact condition that blocks the benchmark run |

## Current MongoDB Capability Defaults

| Need | Default MongoDB path | Documentation basis | Benchmark rule |
| --- | --- | --- | --- |
| Lexical/proper-name/date evidence | MongoDB Search `$search` with analyzers and relevance scoring | `https://www.mongodb.com/docs/atlas/atlas-search/` | Use for exact-ish evidence; do not replace with `$regex` or legacy `$text` for benchmark search lanes. |
| Semantic memory recall | MongoDB Vector Search `$vectorSearch` | `https://www.mongodb.com/docs/vector-search/` | Record embedding model, vector dimensions, `limit`, and `numCandidates`. |
| ANN recall stability | `numCandidates >= 20 * limit` as starting policy | `https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/` | Any lower value needs an artifact-backed cost/quality reason. |
| Mixed lexical + semantic recall | Hybrid Search with `$rankFusion` first | `https://www.mongodb.com/docs/atlas/atlas-vector-search/hybrid-search/` and `https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/` | Disclose pipeline weights and keep retrieval-only rows separate from judged-QA rows. |
| Score-normalized fusion experiment | `$scoreFusion` only on supported MongoDB versions | `https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/` | Treat as a bake-off lane until it beats `$rankFusion` on a held-out artifact. |
| Managed embeddings | Vector Search Automated Embedding / `autoEmbed` | `https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/` | Separate Atlas lane; never silently mix with client-side embedding rows. |
| Cost/latency vector optimization | Vector quantization | `https://www.mongodb.com/docs/vector-search/about/vector-quantization/` | Publish only with remeasured recall, latency, storage, and cost. |
| Index readiness | `$listSearchIndexes` / `getSearchIndexes` status and `queryable` | `https://www.mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes/` | No measured run starts unless Search/Vector indexes are `READY` and queryable. |

## Capability Families For Misses

| Capability blocker | MongoDB-first investigation |
| --- | --- |
| Multi-session current-state memory | Check source-date preservation, supersession labels, scope filters, Search date evidence, Vector semantic evidence, and hybrid ranking. |
| Retrieval coverage | Check index readiness, prefix isolation, filter fields, `numCandidates`, top-k, score/rank diagnostics, and hidden fallback markers. |
| Temporal reasoning | Check event-date extraction, source timestamp vs ingestion timestamp, temporal query classification, and aggregation-side ordering. |
| Assistant recall | Check role-aware filters, assistant-authored provenance, and whether answer context distinguishes assistant advice from user state. |
| Count/current-state aggregation | Check source-backed candidate extraction, dedupe/grouping, completed vs planned action filters, and uncertainty labels. |
| Answer-context packing | Check duplicate compression, stale/current labels, source grouping, top-50/top-200 context drift, and scorer-visible canonical text. |
| Judge contract | Check saved prediction artifacts, model metadata, blank generated answers, and evaluate-only repeatability. |

## Non-Negotiable Stop Conditions

Stop before the benchmark if:

- A MongoDB Search or Vector Search index is missing, `STALE`, not `READY`, or
  not queryable.
- A retrieval/index/schema change lacks a MongoDB docs or MCP decision record.
- A fix depends on question IDs, gold answers, scorer edits, prompt edits, or
  competitor harness changes beyond transport headers.
- A run uses hidden fallback, mixes retrieval recall with judged answer accuracy,
  or cannot prove its exact MongoDB prefix.
- A managed Atlas feature, autoEmbed, quantization, `$rankFusion`, or
  `$scoreFusion` setting is mixed into an existing row without a new lane label.
