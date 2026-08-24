# Memongo platform overview

Memongo is a MongoDB-native long-term memory system for AI agents and apps. It stores conversations, facts, procedures, knowledge-base chunks, episodes, and graph relationships in MongoDB, then retrieves relevant context with vector search, full-text search, and hybrid ranking.

## What it does

An AI agent talks to Memongo through an HTTP API, a TypeScript SDK, an MCP server, or AI SDK tool helpers. Memongo writes what it's told to remember, derives structured facts and procedures from raw events in the background, and answers `search` and `recall` calls with ranked, provenance-tagged results. The [memory taxonomy](../features/memory-taxonomy.md) organizes what's stored; the [scope model](../features/multi-tenancy-and-scopes.md) controls who can see it.

The public repository ships a runnable product: an HTTP API, an MCP server, a TypeScript client, AI SDK tool helpers, a web console, docs, a Docker MongoDB setup, and release checks. Historical, experimental, and comparison material (other retrieval backends, abandoned prototypes) is intentionally kept out of this repo's supported surface — see `CONTRIBUTING.md`.

## Who uses it

- **Agent builders** wire an AI agent to Memongo via `packages/client` (`MemongoClient`) or `packages/tools` (Vercel AI SDK / OpenAI tool helpers) so the agent can save and recall memory mid-conversation.
- **MCP-compatible hosts** (coding agents, chat clients) attach `apps/mcp` as a stdio MCP server and get the same operations as typed tools.
- **Operators** run `apps/api` against a MongoDB Atlas (cloud or Atlas Local Preview) cluster and watch it through `apps/web`, the operator console.

## Quick links

- [Architecture](architecture.md) — how the API, bridge, engine, and MongoDB fit together
- [Getting started](getting-started.md) — install, run MongoDB, start the API, add and search memory
- [Glossary](glossary.md) — Memongo-specific vocabulary
- [Memory taxonomy](../features/memory-taxonomy.md) — the six memory types and core operations
- [Packages](../packages/index.md) and [Apps](../apps/index.md) — the workspace map
- [By the numbers](../by-the-numbers.md) — codebase size and activity snapshot

## Repository layout

```text
memongo/
  apps/
    api/          HTTP API server (Hono)
    mcp/          MCP server (stdio, calls the HTTP API)
    web/          Next.js operator console
    docs/         Public docs (Mintlify)
  packages/
    memory-engine/   Core MongoDB memory: embeddings, graph, episodes, search, KB, analytics
    memory-bridge/   Stable facade over the engine, used by apps/api
    memongo-memory/  Published `@memongo/memory` re-export barrel
    client/          TypeScript HTTP client SDK
    tools/           AI SDK tool helpers (Vercel AI SDK, OpenAI)
    lib/             Shared types, auth, and utilities (internal)
    pi-extension/    Pi coding-agent extension (additive semantic memory)
  docker/            Local MongoDB dev stack (Atlas Local Preview + mongot)
  scripts/           Benchmark, proof-pack, and release-gate scripts
  docs/              Platform docs, ADRs, and benchmark evidence
```

## Product framework contract

Memongo's public framework contract, repeated throughout this wiki:

- **Memory taxonomy**: episodic events, semantic facts, procedural playbooks, profile preferences, workspace knowledge, and provenance.
- **Core operations**: recall, context bundles, remember, update, forget, feedback, and trace.
- **Scope model**: `session`, `user`, `agent`, `workspace`, `tenant`, and `global`.
- **Safety model**: read by default; write only on explicit user, app, operator, test, or import intent.
