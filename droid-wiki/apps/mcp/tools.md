# Tools

Active contributors: Rom Iluz

Memongo's MCP surface has 47 distinct tool names split across three categories, defined in `apps/mcp/src/tools/core.ts`, `apps/mcp/src/tools/admin.ts`, and `apps/mcp/src/tools/aliases.ts`, and assembled into `toolCatalog` by `apps/mcp/src/tool-registry.ts`. Which tools a given MCP host actually sees is controlled by two env flags (see [MCP server](index.md#tool-surface-gating)). Every tool's exact input schema field set is conformance-tested against `packages/lib/src/contract-mcp.ts` in `apps/mcp/src/mcp-contract-conformance.test.ts` — that file, not this page, is the source of truth for field-level detail; this page documents what each tool does and why it exists.

## Core tools (always registered)

Defined in `apps/mcp/src/tools/core.ts`. These 12 tools are the default MCP surface: the write -> extract -> recall loop plus profile/state/self-edit/feedback.

| Tool | What it does |
| --- | --- |
| `memongo_search` | Semantic search across memory; the quick-lookup default. |
| `memongo_search_detailed` | Full CRAG search pipeline with scores, trust annotations, and source provenance — for auditing why memories matched or tuning retrieval (`recipe`, `fusionMethod`, time range, passes). |
| `memongo_add` | Add a user message to memory verbatim. |
| `memongo_write_event` | Write a conversation event of any role (user/assistant/system/tool) to memory; the general-purpose write tool, typically followed by `memongo_extract`. |
| `memongo_write_structured` | Write a structured memory entry (`type`+`key`+`value`, e.g. a decision or preference) directly; writing the same `type`+`key` again updates the existing entry. |
| `memongo_recall_conversation` | Retrieve past conversation messages with canonical citations, filterable by session, role, or time range. |
| `memongo_build_context_bundle` | Assemble a prompt-ready context bundle (profile, active items, evidence); `mode: wake-up` returns a compact ~250-token projection for session start. |
| `memongo_profile` | Synthesize the user/agent profile (stable preferences, identity facts, traits) rather than raw events. |
| `memongo_state_unified` | Fetch profile, blocks, and bundle in one call instead of three round trips. |
| `memongo_self_edit` | Edit a core memory block (`user`, `persona`, `instructions`) directly — append, replace, or prepend. |
| `memongo_memory_feedback` | Apply `confirm`/`correct`/`irrelevant` feedback to a structured memory by its stable handle. |
| `memongo_extract` | Extract structured memories, entities, and relations from a previously written event (async, returns a job id); completes the write -> extract pipeline. |

## Admin tools (`MEMONGO_MCP_ADMIN=1`)

Defined in `apps/mcp/src/tools/admin.ts`. Operator diagnostics, lifecycle handle management, jobs/traces, and probes — not part of the default surface because most agent sessions never need them.

| Tool | What it does |
| --- | --- |
| `memongo_search_kb` | Search the knowledge base lane, with tag/category/source filtering and fusion method control. |
| `memongo_read_file` | Read a memory-backed file by path (`memory_get` parity). |
| `memongo_lifecycle_get` | Fetch the current structured memory or procedure for a stable lifecycle handle. |
| `memongo_lifecycle_update` | Update a structured memory or procedure via its handle; creates a new revision and preserves history. |
| `memongo_lifecycle_delete` | Invalidate a memory item via its handle (history-preserving, not a hard delete). |
| `memongo_lifecycle_history` | Fetch ordered revision history for a handle. |
| `memongo_procedure_outcome` | Record success/failure for a procedure by its handle, updating outcome counters. |
| `memongo_status` | Memory provider status. |
| `memongo_chain_trace` | Trace a derived fact's provenance chain back to its source events. |
| `memongo_novelty_scan` | Scan for the most novel/surprising events using vector distance scoring. |
| `memongo_consolidate` | Run the consolidation pipeline that promotes high-value events to structured facts. |
| `memongo_import_conversations` | Bulk-import conversation history through the canonical `writeConversationEvent()` pipeline. |
| `memongo_admin_access_trends` | Inspect rolling 7-day access trends from the `access_events` time series collection. |
| `memongo_admin_access_summaries` | Inspect aggregate access counts and last-access timestamps for a set of memory IDs. |
| `memongo_admin_list_traces` | List recent recall traces for operator debugging. |
| `memongo_admin_get_trace` | Fetch one recall trace by `traceId`. |
| `memongo_list_jobs` | List background memory jobs (consolidation, extraction, import, materialization, enrichment) for an agent. |
| `memongo_get_job` | Fetch one memory job by `jobId`. |
| `memongo_hydrate_active_slate` | Load the highest-salience active memories (hot context for the current session). |
| `memongo_discovery_projection` | Build a discovery projection: `entity-brief`, `topic-brief`, `what-changed`, or `contradiction-report`. |
| `memongo_write_procedure` | Write a step-by-step procedure. |
| `memongo_status_detailed` | Detailed health status: event/entity counts, projection lag, lane coverage, diagnostics. |
| `memongo_stats` | Memory statistics: source counts, embedding coverage, index stats. |
| `memongo_sync` | Trigger a memory sync operation. |
| `memongo_probe_embedding` | Probe embedding model availability. |
| `memongo_probe_vector` | Probe vector search availability. |
| `memongo_relevance_explain` | Detailed relevance diagnostics for a query: artifacts, health, scores. |
| `memongo_relevance_report` | Relevance health report: hit rate, empty rate, fallback rate. |
| `memongo_relevance_sample_rate` | Current relevance sampling rate and degraded-signal count. |

## Alias tools (`MEMONGO_MCP_ALIASES=1`)

Defined in `apps/mcp/src/tools/aliases.ts`. Pure semantic duplicates of canonical tools, kept for MCP host configs already pointed at the older names; they run through the exact same runtime path as their canonical counterpart (`RECALL_TOOL_NAMES`, `LIFECYCLE_*_TOOL_NAMES`, and `IMPORT_TOOL_NAMES` sets in `apps/mcp/src/server.ts` dispatch both names to the same handler branch).

| Alias | Canonical tool |
| --- | --- |
| `memongo_recall_messages` | `memongo_recall_conversation` |
| `memongo_memory_get` | `memongo_lifecycle_get` |
| `memongo_memory_update` | `memongo_lifecycle_update` |
| `memongo_memory_delete` | `memongo_lifecycle_delete` |
| `memongo_memory_history` | `memongo_lifecycle_history` |
| `memongo_import_conversation_history` | `memongo_import_conversations` |

## Key source files

| File | Purpose |
| --- | --- |
| `apps/mcp/src/tools/core.ts` | Core tool definitions and input schemas. |
| `apps/mcp/src/tools/admin.ts` | Admin tool definitions and input schemas. |
| `apps/mcp/src/tools/aliases.ts` | Alias tool definitions, sharing input schemas with their canonical tools where practical (e.g. `recallMessagesInputSchema`). |
| `apps/mcp/src/tool-registry.ts` | `toolCatalog` assembly, `selectEnabledTools`, `parseMcpToolFlags`. |
| `apps/mcp/src/server.ts` | `handleToolCall` — the dispatcher mapping every tool name above to a typed `MemongoClient` call. |
| `apps/mcp/src/mcp-contract-conformance.test.ts` | Conformance test comparing each tool's live input schema field set against `packages/lib/src/contract-mcp.ts`. |

For the request flow common to every tool call (host -> transport -> `handleToolCall` -> `MemongoClient` -> API), see [MCP server](index.md).
