# Memongo vs local reference memory projects

This doc compares **Memongo** (MongoDB-native gateway memory + `memongo-platform` product layer) to projects commonly kept alongside it for evaluation—for example **claude-mem** and **Supermemory-shaped** APIs. It is written for **buyers and integrators**, not as a scorecard.

## Scope of the reference tree

A typical “memory reference” checkout bundles **several** systems (for example Claude Code memory plugins, Mem0, hosted-memory SDKs). They solve **different** problems. Below, **claude-mem** is the main contrast for “agent memory beside the editor,” and **Supermemory** is the contrast for “hosted memory API product shape.”

## Claude-Mem (editor-centric, local SQLite)

**What it is:** A **Claude Code**-oriented persistence and compression system with a worker, plugin surface, and local store (see upstream project docs and license).

**Typical strengths**

- Tight **Claude Code** integration and plugin distribution.
- **Local-first** operation without a DBA-managed cluster.
- AGPL-3.0 upstream (verify license fit for **your** product).

**Where Memongo differs**

- **Data plane:** Memongo targets **MongoDB Community + mongot** (Atlas Local / replica set) as the **system of record**, with hybrid lexical + vector retrieval, structured memory, graph, episodes, and operational tooling aligned to a **multi-channel gateway** (not only a single IDE).
- **Deployment:** Memongo assumes **ops-owned** MongoDB (on-prem, VM, or your cloud), optional HTTP API (`memongo-platform`), MCP, and web console—closer to **platform** memory than a single-plugin install.
- **License:** Memongo engine tracks the OpenClaw/Memongo upstream license story; confirm for your distribution.

**When to prefer claude-mem**

- You only need **Claude Code** session persistence and local tooling, not a shared org-wide memory plane.

**When to prefer Memongo**

- You need **durable, queryable memory** on **MongoDB**, **multi-agent or multi-channel** access, and **hybrid search** with explicit operational and relevance controls.

## Supermemory-shaped hosted API

**What it is:** A **hosted** “memory API + SDK + tools + dashboard” product (external SaaS).

**Typical strengths**

- Fast integration if you accept **vendor-hosted** storage and billing.
- Productized dashboards and SDKs.

**Where Memongo differs**

- **Memongo POC** mirrors the **shape** (SDK, HTTP, MCP, web) but keeps the **database under your control** (`mongodb-atlas-local` or your cluster).
- You trade managed SaaS convenience for **data residency, indexing control, and MongoDB-native operations**.

## Honest positioning line (safe for README)

Use wording like:

> Memongo is a **MongoDB-native** AI memory and gateway stack. Unlike **single-IDE** local memory plugins, it is built for **shared, operational memory** on a real database. Unlike **hosted memory SaaS**, you **own the cluster** and can run the same surfaces (HTTP, MCP, console) **on your infra**.

Avoid absolute claims (“always faster,” “always better”) unless you publish **reproducible benchmarks** on your workloads.

## Evidence to collect before “production” marketing

1. **CI green** on the engine and `memongo-platform` (see [PRODUCTION-READY.md](PRODUCTION-READY.md)).
2. **Live MongoDB** gate on `mongodb/mongodb-atlas-local:preview` with `VOYAGE_API_KEY` (Atlas Model API key) where embeddings matter.
3. **Your** SLOs: p95 search latency, write throughput, recovery drills, backup/restore on MongoDB.

## References (external)

- MongoDB Atlas Local Docker: [Docker Hub `mongodb/mongodb-atlas-local`](https://hub.docker.com/r/mongodb/mongodb-atlas-local)
- Memongo getting started: [docs/start/memongo-getting-started.md](../../docs/start/memongo-getting-started.md) (repo root)
