# Memongo Public Presentation and MongoDB Feature Showcase

> **For Claude:** REQUIRED: Follow this plan phase-by-phase. Each phase has explicit file paths, content structure, and acceptance checks.
> **Research:** See `docs/research/2026-03-22-openclaw-positioning-web.md` and `docs/research/2026-03-22-openclaw-ecosystem-github.md`.

**Goal:** Rewrite Memongo's public-facing surfaces (README, npm metadata, docs) to position it as "the MongoDB edition of OpenClaw" with deep technical content on WHY MongoDB is the best agentic data layer and HOW each feature works.

**Architecture:** Documentation-only changes across 4 surfaces: README.md, package.json metadata, a new MongoDB capability deep-dive doc page, and a new getting-started guide. No code changes. The README is the hero page; the docs pages are the technical depth.

**Tech Stack:** Markdown, JSON (package.json metadata only)

**Prerequisites:** All existing Memongo code is already built and working (205 v2 memory unit tests, 573 total memory tests, 53 live e2e tests against MongoDB 8.2 + Voyage AI, 20 collections, 53 indexes). This plan covers presentation, not implementation.

**Note on upstream default memory name:** Use "QMD (SQLite + Markdown)" consistently when referring to OpenClaw's default memory backend.

**Note on forward references:** Phase 2 (README) links to doc files created in Phases 3-5. Use relative paths; they will resolve after all phases complete.

---

## Requirements Snapshot

1. README must position Memongo as "the MongoDB edition of OpenClaw" (distribution, not competitor)
2. README must showcase all 12 MongoDB capabilities with WHY + HOW for each
3. npm package.json must have keywords, description, and author filled in
4. A new deep-dive doc page must explain each MongoDB capability in technical detail
5. A new getting-started guide must cover MongoDB-specific prerequisites and setup
6. A comparison section (Memongo vs OpenClaw default memory) must exist, NOT vs Mem0/Zep
7. Target three audiences in priority order: OpenClaw power users, MongoDB developers, production teams
8. Onboarding flow design doc for future Memongo-specific onboarding (design only, no code)

## Constraints Snapshot

- DO NOT change any source code (TypeScript, tests, build)
- DO NOT position Memongo as competing with Mem0/Zep (different category entirely)
- DO NOT remove upstream OpenClaw feature sections from README (channels, apps, tools still matter)
- DO NOT add i18n/translations (out of scope)
- Use American English spelling throughout
- No emojis in file content unless already present in upstream sections
- README-header image reference must be preserved as-is

## In Scope

- README.md complete rewrite with MongoDB-first positioning
- package.json metadata (keywords, description, author)
- New doc: `docs/reference/mongodb-capabilities.md` (12 capabilities deep dive)
- New doc: `docs/start/memongo-getting-started.md` (MongoDB-specific setup)
- New doc: `docs/reference/memongo-vs-default-memory.md` (comparison page)
- New doc: `docs/design/memongo-onboarding-flow.md` (onboarding design, no code)

## Out of Scope

- Code architecture changes (already 8.2/10)
- Actual onboarding code implementation
- Managed/hosted tier documentation
- Marketing website
- i18n/translations
- Changes to upstream OpenClaw docs site (docs.openclaw.ai)

## Planning Mode

- Plan mode: `execution_plan`
- Verification rigor: `standard`

## Open Decisions

- None (all decisions pre-approved in brainstorming)

## Differences From Agreement

- None

## Recommended Defaults

- README length target: ~400-500 lines (down from current 796, which has significant duplication)
- MongoDB capability deep-dive format: WHY paragraph + HOW paragraph + code/config example for each capability
- Getting-started guide assumes Docker as quickest path for MongoDB + mongot

## Current State

- **README.md** (796 lines): Already has MongoDB memory sections but buries them below generic OpenClaw content. The "Why Memongo Is Different" section exists but reads like internal architecture docs, not developer marketing. Current structure: header -> why different -> sponsors -> install -> quick start -> upstream sync -> from source -> security -> highlights -> star history -> everything built -> how it works -> key subsystems -> tailscale -> remote -> macOS -> agent-to-agent -> skills -> chat commands. The MongoDB content is strong technically but poorly positioned.
- **package.json**: `description` says "MongoDB-first multi-channel agent runtime built on OpenClaw" (decent but undersells). `keywords` is empty array. `author` is empty string.
- **docs/reference/**: Has heart-brain-boundary.md, memory-config.md, upstream-sync.md but no MongoDB capability showcase page.
- **docs/start/**: Has getting-started.md, quickstart.md, wizard.md but all point to upstream OpenClaw docs, no Memongo-specific MongoDB setup guide.
- **docs/design/**: Exists, contains `memongo-memory-v2-improvement-plan.md`. New onboarding flow doc will go here.

### Context References (files the builder must read)

- `README.md` (current README to rewrite)
- `package.json:1-20` (metadata fields to update)
- `src/memory/mongodb-schema.ts:1-50` (collection definitions for accuracy)
- `src/memory/mongodb-events.ts` (event architecture for accuracy)
- `src/memory/mongodb-graph.ts` (knowledge graph for accuracy)
- `src/memory/mongodb-episodes.ts` (episode materialization for accuracy)
- `src/memory/mongodb-retrieval-planner.ts` (retrieval paths for accuracy)
- `src/memory/mongodb-hybrid.ts` (hybrid search for accuracy)
- `src/memory/mongodb-structured-memory.ts` (structured memory for accuracy)
- `src/memory/mongodb-manager.ts` (writeEventAndProject, searchV2 for accuracy)
- `docs/reference/heart-brain-boundary.md` (existing heart-brain docs)
- `docs/reference/memory-config.md` (existing memory config docs)
- `docs/research/2026-03-22-openclaw-positioning-web.md` (research: OpenClaw product identity)
- `docs/research/2026-03-22-openclaw-ecosystem-github.md` (research: ecosystem comparison)
- `docs/plans/2026-03-15-memory-architecture-v2-design.md` (v2 architecture design -- canonical reference)

---

## Phase 1: npm Metadata and Package Identity

**Objective:** Set the package.json metadata so npm listing, search, and install surfaces reflect Memongo's identity.

**Inputs:** Current package.json, research findings on npm positioning

**Files/surfaces:**

- Modify: `package.json:1-20` (metadata fields only)

**Expected artifacts:**

- Updated `description`, `keywords`, and `author` fields in package.json

**Content specification:**

```json
{
  "description": "The MongoDB edition of OpenClaw - personal AI assistant with production-grade MongoDB memory, 22 channels, knowledge graph, episode materialization, and Voyage AI vector search",
  "keywords": [
    "mongodb",
    "ai-assistant",
    "personal-ai",
    "openclaw",
    "agent-memory",
    "vector-search",
    "knowledge-graph",
    "voyage-ai",
    "multi-channel",
    "whatsapp",
    "telegram",
    "discord",
    "slack",
    "event-sourcing",
    "graphlookup",
    "mongot",
    "hybrid-search",
    "episode-materialization",
    "retrieval-planner",
    "typescript"
  ],
  "author": "Rom Iluz <rom@openclaw.ai>"
}
```

**Required checks:**

- `cat package.json | head -20` shows updated fields
- `pnpm build` still passes (metadata-only change should not break build)

**Checkpoint type:** None (straightforward)

**Exit criteria:** package.json has non-empty description, keywords, and author fields. Build passes.

---

## Phase 2: README Rewrite - Structure and Hero Section

**Objective:** Restructure README.md with "MongoDB edition of OpenClaw" positioning as the hero, MongoDB capabilities as the showcase, and OpenClaw platform features as supporting context.

**Inputs:** Current README.md, both research files, approved positioning decisions

**Files/surfaces:**

- Modify: `README.md` (complete rewrite, preserve header image reference)

**Expected artifacts:**

- New README.md with restructured content

**Content structure (top to bottom):**

### Section 1: Hero (lines 1-30 approx)

- Header image (preserve existing `README-memongo-header-v2.png` reference)
- Tagline: "The MongoDB Edition of OpenClaw"
- One-paragraph elevator pitch: Memongo is OpenClaw (the most popular open-source personal AI assistant, 329K stars, 22 channels, native apps) with a production-grade MongoDB memory system replacing the default SQLite/Markdown backend
- Badges (preserve existing CI, release, Discord, license badges)
- Quick links row

### Section 2: What Is Memongo? (30 lines approx)

- Distribution framing: "Like Ubuntu is to Linux, Memongo is the MongoDB edition of OpenClaw"
- What you get: the FULL OpenClaw assistant (22 channels, 78 extensions, voice, canvas, native apps) PLUS MongoDB-native memory
- NOT a memory library, NOT competing with Mem0/Zep -- this is a complete personal AI assistant
- Three audiences explicitly addressed: OpenClaw users upgrading memory, MongoDB developers wanting an AI assistant, teams needing production-grade agent memory

### Section 3: Why MongoDB for Agent Memory? (40 lines approx)

- Opening argument: MongoDB is uniquely suited for agent memory because it combines document flexibility, vector search, full-text search, graph traversal, and operational guarantees in a single platform
- Brief intro to each of the 12 capabilities (2-3 lines each, linking to deep-dive doc for details):
  1. Automated Embeddings (Voyage AI via mongot)
  2. Vector Search ($vectorSearch)
  3. Full-Text Search (mongot)
  4. Hybrid Search ($rankFusion/$scoreFusion)
  5. Knowledge Graph ($graphLookup)
  6. Event-Sourcing (canonical events)
  7. Schema Validation (JSON Schema)
  8. Change Streams
  9. TTL Indexes
  10. Multi-Tenant Isolation
  11. Idempotent Upserts
  12. Relevance Telemetry
- Link to full deep-dive: `docs/reference/mongodb-capabilities.md`

### Section 4: Memongo vs Default OpenClaw Memory (30 lines approx)

- Comparison table (NOT vs Mem0/Zep -- vs OpenClaw's SQLite/QMD default)
- Columns: Capability | OpenClaw Default | Memongo
- Rows covering: storage backend, vector search, knowledge graph, episodes, structured memory, procedures, retrieval paths, operational visibility, collections/indexes, data model
- Decision rule: when to use default vs Memongo
- Link to full comparison: `docs/reference/memongo-vs-default-memory.md`

### Section 5: MongoDB Memory Architecture (40 lines approx)

- Event-sourcing diagram (preserve existing ASCII art, refine)
- 20 collections listed with purpose
- Retrieval planner and 8 paths table (preserve existing)
- Reranking summary
- This section is the "HOW it works" technical meat

### Section 6: Quick Start (30 lines approx)

- Prerequisites: MongoDB 7+ with mongot, Voyage AI API key, Node 22+
- `npm install -g @romiluz/memongo@latest`
- `memongo onboard --install-daemon`
- Link to full getting-started guide: `docs/start/memongo-getting-started.md`

### Section 7: The Full OpenClaw Platform (50 lines approx)

- Channels list (preserve existing 22 channels, this is a differentiator)
- Apps + nodes summary (macOS, iOS, Android -- preserve)
- Tools + automation summary (browser, canvas, cron -- preserve)
- Skills + extensions (78 plugins -- highlight the number)
- This section says: "You get ALL of this, plus MongoDB memory"

### Section 8: Development and Ops (30 lines approx)

- Install from source
- Keep in sync with upstream (preserve `pnpm upstream:steady`)
- Development channels (stable/beta/dev)
- Security defaults (preserve DM pairing section)

### Section 9: Star History + Links (10 lines approx)

- Star History chart
- Contributing, license, upstream credit

**Key writing guidelines for the builder:**

- Lead with MongoDB value, not OpenClaw features (those come after)
- Every MongoDB capability gets a WHY (business value) and HOW (technical mechanism)
- Use "Memongo" as the primary name, "OpenClaw" when referring to the upstream project
- Technical depth over marketing fluff -- this is for developers
- American English throughout
- No emojis except the existing lobster in the H1 title

**Required checks:**

- README renders correctly in GitHub preview (no broken markdown)
- All links are valid (internal file references and external URLs)
- No mentions of Mem0, Zep, or other memory libraries as competitors
- "MongoDB edition of OpenClaw" phrasing appears in first 5 lines
- All 12 MongoDB capabilities are mentioned

**Checkpoint type:** [CHECKPOINT] README structure review before proceeding to deep-dive docs

**Exit criteria:** README.md is rewritten, renders correctly, positions Memongo as MongoDB edition of OpenClaw, and showcases all 12 MongoDB capabilities.

---

## Phase 3: MongoDB Capability Deep-Dive Page

**Objective:** Create a comprehensive reference doc that explains each of the 12 MongoDB capabilities Memongo uses, with WHY (business value), HOW (technical mechanism), and concrete examples.

**Inputs:** Source code (mongodb-schema.ts, mongodb-events.ts, mongodb-graph.ts, etc.), research findings, existing README technical sections

**Files/surfaces:**

- Create: `docs/reference/mongodb-capabilities.md`

**Expected artifacts:**

- New doc page with 12 capability sections

**Content structure:**

```markdown
# MongoDB Capabilities in Memongo

Memongo uses 12 MongoDB features that make it the best agentic data layer.
This page explains WHY each feature matters for agent memory and HOW Memongo implements it.

## Table of Contents

[12 capabilities listed]

## 1. Automated Embeddings (Voyage AI via mongot)

### Why This Matters

[2-3 paragraphs: No application-side embedding pipeline. No embedding library dependency.
No batch embedding jobs. mongot handles it at index time and query time. This eliminates
an entire class of infrastructure (embedding queues, retry logic, model version management)
that other solutions require.]

### How It Works

[Technical explanation: mongot reads the `text` field, calls Voyage AI API, stores
embedding in the index. At query time, $vectorSearch sends query text to mongot,
which embeds it and runs ANN search. Model: voyage-4-large, 1024 dimensions.]

### Configuration

[Code block: vector search index definition with autoEmbed]
[Code block: memory.mongodb.embeddingMode = "automated" config]

### Collections Using This

- chunks (conversation memory)
- kb_chunks (knowledge base)
- structured_mem (structured facts)

---

## 2. Vector Search ($vectorSearch)

[Same WHY/HOW/Config/Collections pattern]

## 3. Full-Text Search (mongot)

[Same pattern]

## 4. Hybrid Search ($rankFusion / $scoreFusion)

[Same pattern -- explain both fusion methods, when each is used]

## 5. Knowledge Graph ($graphLookup)

[Same pattern -- include bi-directional $facet expansion diagram]

## 6. Event-Sourcing (Canonical Events Collection)

[Same pattern -- include writeEventAndProject flow diagram]

## 7. Schema Validation (JSON Schema)

[Same pattern -- include example schema from mongodb-schema.ts]

## 8. Change Streams

[Same pattern -- explain real-time sync use case]

## 9. TTL Indexes

[Same pattern -- explain automatic lifecycle management]

## 10. Multi-Tenant Isolation

[Same pattern -- explain agentId compound indexes, $graphLookup restrictSearchWithMatch]

## 11. Idempotent Upserts

[Same pattern -- explain $setOnInsert/$set pattern, compound unique keys]

## 12. Relevance Telemetry

[Same pattern -- explain explain-driven diagnostics]

## The Full Picture

[Summary diagram showing how all 12 capabilities work together in a single query/write cycle]
```

**For each capability, the builder MUST:**

1. Read the relevant source file to verify technical accuracy
2. Include at least one code/config example
3. Explain WHY in terms of developer/team value (not just technical correctness)
4. Explain HOW with enough detail that a MongoDB developer could understand the implementation

**Required checks:**

- All 12 capabilities have WHY + HOW + example sections
- Code examples match actual implementation in source code
- No references to external vector DBs, graph DBs, or non-MongoDB solutions
- Technical claims are verifiable against source code

**Checkpoint type:** None (follows approved capability list)

**Exit criteria:** `docs/reference/mongodb-capabilities.md` exists with all 12 capabilities documented, each with WHY/HOW/example.

---

## Phase 4: Memongo vs Default Memory Comparison Page

**Objective:** Create a comparison page showing what developers get with Memongo's MongoDB memory vs OpenClaw's default SQLite/QMD memory.

**Inputs:** Research findings on OpenClaw default memory, Memongo architecture knowledge

**Files/surfaces:**

- Create: `docs/reference/memongo-vs-default-memory.md`

**Expected artifacts:**

- Comparison doc with feature-by-feature table and decision guidance

**Content structure:**

```markdown
# Memongo vs OpenClaw Default Memory

## Overview

OpenClaw ships with SQLite + Markdown files as its default memory backend.
Memongo replaces this with MongoDB Community + mongot + Voyage AI.
This page compares the two approaches feature by feature.

## Feature Comparison

| Capability             | OpenClaw Default (SQLite/QMD)                          | Memongo (MongoDB)                                                                    |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Storage backend        | SQLite file + Markdown files                           | MongoDB Community (replica set)                                                      |
| Vector search          | sqlite-vec extension or LanceDB                        | mongot + Voyage AI autoEmbed                                                         |
| Embedding management   | Application-side (OpenAI/Gemini/Voyage/Mistral/Ollama) | Automated via mongot (zero app-side code)                                            |
| Full-text search       | SQLite FTS5 or BM25                                    | mongot text indexes                                                                  |
| Hybrid search          | BM25 + vector with MMR                                 | $rankFusion / $scoreFusion                                                           |
| Knowledge graph        | None                                                   | $graphLookup with entities/relations                                                 |
| Episodes               | None                                                   | Auto-materialized from event windows                                                 |
| Event sourcing         | None (append-only Markdown)                            | Canonical events collection                                                          |
| Structured memory      | Basic key-value                                        | Salience, temporal validity, state, provenance                                       |
| Procedures             | None                                                   | Versioned workflow artifacts                                                         |
| Retrieval paths        | 1 (search)                                             | 8 (active-critical, procedural, structured, raw-window, graph, episodic, kb, hybrid) |
| Schema validation      | None                                                   | JSON Schema on all collections                                                       |
| Multi-tenant isolation | Filesystem separation                                  | Compound indexes with agentId prefix                                                 |
| Operational visibility | Limited                                                | Ingest runs, projection runs, relevance telemetry                                    |
| Data model             | Flat files + SQLite rows                               | 20 collections, 53 indexes                                                           |
| Sync across instances  | File sync (rsync, git)                                 | MongoDB replica set                                                                  |

## When to Use OpenClaw Default Memory

[Guidance: single user, small corpus, local-only, no operational requirements]

## When to Use Memongo

[Guidance: team scale, growing corpus, retrieval quality SLOs, operational visibility needs, production deployment]

## Migration Path

[Brief: Memongo includes v1-to-v2 migration (backfillEventsFromChunks). Existing OpenClaw users can migrate their SQLite/Markdown data into MongoDB.]
```

**Required checks:**

- Comparison is factually accurate for both sides
- No unfair characterization of OpenClaw default (it's good for what it does)
- Decision guidance is honest and helpful
- No mention of Mem0/Zep/external competitors

**Checkpoint type:** None

**Exit criteria:** `docs/reference/memongo-vs-default-memory.md` exists with complete comparison table and decision guidance.

---

## Phase 5: Memongo Getting Started Guide

**Objective:** Create a Memongo-specific getting-started guide that walks developers through MongoDB setup, mongot configuration, Voyage AI, and first agent interaction.

**Inputs:** Existing docs/start/getting-started.md (upstream), Memongo-specific requirements

**Files/surfaces:**

- Create: `docs/start/memongo-getting-started.md`

**Expected artifacts:**

- Step-by-step getting-started guide for Memongo

**Content structure:**

```markdown
# Getting Started with Memongo

Memongo is the MongoDB edition of OpenClaw. This guide gets you from zero
to a working personal AI assistant with MongoDB-native memory in about 10 minutes.

## Prerequisites

### Required

- **Node.js 22+** (24 recommended)
- **MongoDB** via `mongodb-atlas-local:preview` Docker image (bundles mongod + mongot + auto-embeddings)
- **Voyage AI API key** (set as VOYAGE_API_KEY env var on the container)
- **LLM API key** (Anthropic Claude recommended, or OpenAI, Google, etc.)

### MongoDB Setup Options

#### Option A: Docker with atlas-local:preview (Quickest)

[Single container: docker compose -f docker/mongodb/docker-compose.preview.yml up -d]

#### Option B: Atlas CLI Local Deployment

[atlas deployments setup memongo --type local --port 27017]

### Voyage AI Setup

[Sign up at voyageai.com, get API key, set VOYAGE_API_KEY env var on container]

## Install Memongo

[npm install -g @romiluz/memongo@latest]

## Configure MongoDB Connection

[memongo config set memory.mongodb.uri "mongodb://..."]
[memongo config set memory.mongodb.embeddingMode "automated"]

## Run Onboarding

[memongo onboard --install-daemon]
[Step-by-step what happens during onboarding]

## Verify Memory

[memongo gateway status -- check MongoDB connection]
[memongo channels status --probe -- verify channels]
[Send a test message, verify it appears in MongoDB]

## Next Steps

- Connect a channel (Telegram is quickest)
- Import knowledge base documents
- Configure structured memory
- Read the MongoDB capability deep-dive: docs/reference/mongodb-capabilities.md
```

**Required checks:**

- All commands are correct and match actual CLI interface
- Docker compose example actually works (if included)
- Prerequisites are complete and accurate
- No references to SQLite/QMD setup steps

**Checkpoint type:** [CHECKPOINT] Getting-started guide accuracy review -- commands must match actual CLI

**Exit criteria:** `docs/start/memongo-getting-started.md` exists with complete setup guide.

---

## Phase 6: Onboarding Flow Design Document

**Objective:** Design the Memongo-specific onboarding flow (MongoDB connection, mongot verification, Voyage AI setup, channel configuration). Design only -- no code changes.

**Inputs:** Existing onboarding code (src/commands/onboard\*.ts), Memongo-specific requirements

**Files/surfaces:**

- Create: `docs/design/memongo-onboarding-flow.md`

**Expected artifacts:**

- Design document for future onboarding code changes

**Content structure:**

```markdown
# Memongo Onboarding Flow Design

## Overview

Memongo's onboarding must verify MongoDB infrastructure before proceeding
to channel setup. This is a design document for future implementation.

## Current State

[Describe current onboarding: model provider -> API key -> gateway -> channels]
[What's missing: MongoDB connection verification, mongot check, Voyage AI check]

## Proposed Flow

### Step 1: MongoDB Connection

- Prompt for MongoDB URI (or detect from environment)
- Test connection with ping
- Verify replica set (required for change streams)
- Check MongoDB version >= 7.0

### Step 2: mongot Verification

- Check if mongot is running (search index creation test)
- If not: provide setup instructions
- If Atlas: verify Search is enabled

### Step 3: Voyage AI Configuration

- Prompt for Voyage AI API key
- Test embedding generation
- Configure embeddingMode = "automated"

### Step 4: Collection Bootstrap

- Run ensureCollections + ensureIndexes
- Verify all 20 collections created
- Verify all 53 standard indexes created
- If mongot available: create search indexes

### Step 5: LLM Provider (existing flow)

- Select model provider
- Enter API key
- Test model connection

### Step 6: Channel Setup (existing flow)

- Select channel(s)
- Configure credentials
- Test channel connection

### Step 7: Health Check

- memongo doctor (with MongoDB-specific checks)
- Verify memory write + read cycle
- Show status summary

## Error Handling

[What happens when MongoDB is unreachable, mongot not found, Voyage AI key invalid]

## Implementation Notes

[Which files to modify: onboard-interactive.ts, onboard-config.ts]
[New checks needed: MongoDB ping, mongot detection, Voyage AI verification]
[Estimated implementation effort: medium]
```

**Required checks:**

- Design references correct source files
- Flow is complete (no missing steps)
- Error handling is considered
- Clearly marked as design-only (no code changes expected from this phase)

**Checkpoint type:** None

**Exit criteria:** `docs/design/memongo-onboarding-flow.md` exists with complete onboarding design.

---

## Acceptance Checks

After all phases complete:

1. **README test:** Open `README.md` in GitHub preview -- verify it renders correctly, "MongoDB edition of OpenClaw" appears in first 5 lines, all 12 MongoDB capabilities are mentioned, no broken links
2. **package.json test:** `node -e "const p = require('./package.json'); console.log(p.description, p.keywords.length, p.author)"` -- all three are non-empty
3. **Docs existence test:** All 4 new docs exist:
   - `docs/reference/mongodb-capabilities.md`
   - `docs/reference/memongo-vs-default-memory.md`
   - `docs/start/memongo-getting-started.md`
   - `docs/design/memongo-onboarding-flow.md`
4. **Build test:** `pnpm build` passes (no code changes, but verify)
5. **Content audit:** No mentions of Mem0/Zep as competitors anywhere in new content
6. **Positioning audit:** Memongo is consistently framed as "MongoDB edition of OpenClaw" (distribution), not as a standalone product or memory library

## Risks and Mitigations

| Risk                                 | Probability | Impact | Score | Mitigation                                                       |
| ------------------------------------ | ----------- | ------ | ----- | ---------------------------------------------------------------- |
| README too long/unfocused            | 3           | 3      | 9     | Strict section structure with line count targets                 |
| Technical claims inaccurate          | 2           | 4      | 8     | Builder must verify against source code for each capability      |
| Upstream links become stale          | 2           | 2      | 4     | Use docs.openclaw.ai links which are more stable than file paths |
| MongoDB version requirements unclear | 2           | 3      | 6     | Getting-started guide explicitly lists version requirements      |
| Onboarding design becomes stale      | 3           | 2      | 6     | Clearly marked as design doc, references current source files    |

## Summary

- Plan saved: `docs/plans/2026-03-22-memongo-presentation-plan.md`
- Phases: 6
- Risks: 5 identified
- Key decisions: Distribution positioning (approved), three-audience priority (approved), no Mem0/Zep comparison (approved)
- All decisions pre-approved from brainstorming session

## Recommended Skills for BUILD

- `cc10x:architecture-patterns` (multi-component documentation work)
- No MongoDB agent skills (per project patterns: use ONLY mcp**mongodb**search-knowledge)
