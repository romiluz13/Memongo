# Memory framework comparison note

This is a maintainer note for the Memongo framework slice. It is research
context, not a public superiority claim. Sources were checked on June 27, 2026
using upstream GitHub repositories and official docs where available.

## Positioning rule

Frame Memongo as a MongoDB-native long-term memory framework with a small
supported core:

- API server
- MCP server
- TypeScript client
- AI SDK tools
- MongoDB memory engine
- Web console
- Docs and release checks

Do not frame Memongo as a universal memory OS, a coding-agent-only product, or a
benchmark winner outside the exact evidence lane that has been verified.

## Comparison

| System | Pattern to learn from | What to avoid | Source anchor |
|---|---|---|---|
| Mem0 | Simple add/search surface, multi-signal retrieval, temporal reasoning | Vague universal-memory framing without exact evidence | <https://github.com/mem0ai/mem0/blob/main/README.md> |
| OpenMemory | Local-first, self-hosted memory with connector and trace emphasis | Treating an in-rewrite project as a stability reference | <https://github.com/CaviraOSS/OpenMemory/blob/main/README.md> |
| Graphiti | Temporal context graph, provenance, validity windows | Flattening facts into static vectors only | <https://github.com/getzep/graphiti/blob/main/README.md>, <https://github.com/getzep/graphiti/blob/main/mcp_server/README.md> |
| Zep | Clear split between managed platform and OSS graph core | Treating integration examples as the entire product | <https://github.com/getzep/zep/blob/main/README.md> |
| Cognee | Persistent cross-session memory with graph plus vector search | Trust or company-brain claims without proof | <https://github.com/topoteretes/cognee/blob/main/README.md> |
| LangMem | Storage-agnostic memory primitives and hot-path/background separation | Hiding memory management inside prompt-only hacks | <https://github.com/langchain-ai/langmem/blob/main/README.md>, <https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/tools.py> |
| Letta | Explicit stateful-agent memory blocks | Anthropomorphic or self-improving claims that Memongo does not prove | <https://github.com/letta-ai/letta/blob/main/README.md>, <https://github.com/letta-ai/letta/blob/main/letta/schemas/memory.py> |

## Memongo fit

Memongo already has the primitives needed for a Company Brain framework:

- Context bundles for answer-ready recall.
- Write-event, structured-memory, and procedure-memory paths.
- Lifecycle update, delete, history, and feedback paths.
- MCP tools for agent clients.
- TypeScript client and AI SDK helpers for apps.
- Scope values for `session`, `user`, `agent`, `workspace`, `tenant`, and
  `global`.
- Trace surfaces and maintainer-level deterministic bundle utilities.

The first safe gap to close is not runtime capability. It is the framework
contract: taxonomy, scope policy, read/write rules, adapter templates, and
evaluation gates.

## Product guidance

- Use "Company Brain" for the broad product narrative.
- Use "coding-agent memory" only as one adapter path.
- Say "MongoDB-native long-term memory framework" when being technical.
- Separate retrieval evidence from judged-answer claims.
- Keep explicit-write-only as the default until background consolidation has a
  separate privacy, provenance, and rollback design.
