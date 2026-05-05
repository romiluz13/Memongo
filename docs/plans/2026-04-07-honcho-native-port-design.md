# Memongo Native Memory Intelligence — Reasoning Chain + Novelty + Consolidation Design

## Purpose
Add 6 memory intelligence capabilities to Memongo as native features: provenance traversal (reasoning chains), novelty detection (surprisal scoring), importance-based ranking (access tracking + decay), knowledge categorization (wiki sources), and offline consolidation (Dreamer agent). Validated end-to-end with 3 real-world scenarios using Docker MongoDB Atlas Local Preview, real seeded data, and a scored evaluation report.

## Users
- AI agents connecting via MCP, HTTP API, or AI SDK tools
- Developers integrating Memongo into their applications
- Operators monitoring memory health via web console

## Success Criteria
- [ ] All 6 features integrated natively across 5 layers: Engine → Bridge → API → MCP → Client SDK
- [ ] 450+ seeded events across 3 real-world scenarios (coding assistant, support, productivity)
- [ ] E2E evaluation passes with ≥90/100 overall score, no dimension below 70
- [ ] 10-dimension score card: chain completeness, ordering, novelty accuracy, degradation, consolidation yield, idempotency, importance decay, access tracking, wiki categorization, cross-agent isolation
- [ ] All features feel native to Memongo (no "Honcho" references, follows Memongo naming conventions)
- [ ] Docker MongoDB Atlas Local Preview as the test backend
- [ ] `bun run build` + `bun run check-types` pass
- [ ] ~42 unit tests + comprehensive E2E evaluation test file

## Constraints
- MongoDB-only — no external databases
- Native Memongo conventions: `memongoBridge*` functions, `@memongo/*` package structure, Hono API routes
- All features go through ALL 5 layers (Engine → Bridge → API → MCP → Client SDK + AI SDK Tools)
- Docker `mongodb/mongodb-atlas-local:preview` for E2E (single container: mongod + mongot + search)
- Access tracking must be server-side (not in-process timers — standalone product)
- agentId isolation at every layer
- Graceful degradation when mongot unavailable (novelty detection)
- Approximation pattern for access tracking (batched writes)

## Out of Scope
- Cross-agent consolidation (workspace-level) — future feature
- LLM-based entity extraction — future feature
- Web console UI for new features — future feature
- Obsidian import for wiki — future feature
- Dream diary narrative surface — future feature

## Approach Chosen
**Port-Then-Validate Sequential** — Port all 6 features first across all 5 layers, then build comprehensive E2E evaluation harness with 3 scenarios and scoring.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ E2E EVALUATION HARNESS                                              │
│  ├─ Scenario 1: AI Coding Assistant (3 agents, 200+ events)       │
│  ├─ Scenario 2: Customer Support (2 agents, 150+ events)          │
│  ├─ Scenario 3: Personal Productivity (1 agent, 100+ events)      │
│  └─ 10-Dimension Score Card (≥90/100 pass threshold)              │
├─────────────────────────────────────────────────────────────────────┤
│ 5-LAYER NATIVE INTEGRATION (per feature)                           │
│  Engine → Bridge → API → MCP → Client SDK + AI SDK Tools          │
├─────────────────────────────────────────────────────────────────────┤
│ EXISTING MEMONGO STACK (unchanged)                                  │
│  HTTP (Hono :3847) → Bridge → Engine → MongoDB Atlas Local Preview │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### Feature Integration Matrix (5-layer native)

| Feature | Engine | Bridge | API Route | MCP Tool | Client + AI SDK |
|---------|--------|--------|-----------|----------|-----------------|
| Reasoning Chain | `mongodb-reasoning-chain.ts` | `memongoBridgeTraceChain()` | `POST /v1/chain-trace` | `memongo_chain_trace` | `client.traceChain()` |
| Novelty Detection | `mongodb-novelty.ts` | `memongoBridgeScanNovelty()` | `POST /v1/novelty-scan` | `memongo_novelty_scan` | `client.scanNovelty()` |
| Access Tracking | `mongodb-access-tracker.ts` | Server-side middleware | Transparent (auto-tracks on search) | N/A | N/A |
| Importance Decay | In `mongodb-result-trust.ts` | Automatic in search | Built into search scoring | N/A | N/A |
| Wiki Categorization | In `mongodb-schema.ts` | Automatic in KB writes | Extended `/v1/search-kb` | Extended params | Extended filter |
| Consolidation Agent | `mongodb-consolidator.ts` | `memongoBridgeConsolidate()` | `POST /v1/consolidate` | `memongo_consolidate` | `client.consolidate()` |

### New Files (in Memongo)

**Engine** (`packages/memory-engine/src/`):
- `mongodb-reasoning-chain.ts` (~200 LOC) — $lookup provenance traversal
- `mongodb-reasoning-chain.test.ts` (~10 tests)
- `mongodb-novelty.ts` (~150 LOC) — Atlas Vector Search centroid novelty
- `mongodb-novelty.test.ts` (~8 tests)
- `mongodb-access-tracker.ts` (~120 LOC) — server-side batched access tracking
- `mongodb-access-tracker.test.ts` (~6 tests)
- `mongodb-consolidator.ts` (~400 LOC) — offline Dreamer pipeline
- `mongodb-consolidator.test.ts` (~12 tests)

**Bridge** (`packages/memory-bridge/src/`):
- Extended with 3 new bridge functions

**API** (`apps/api/src/routes/`):
- Extended v1.ts with 3 new routes

**MCP** (`apps/mcp/src/`):
- Extended server.ts with 3 new tool definitions

**Client** (`packages/client/src/`):
- Extended client class with 3 new methods

**Tools** (`packages/tools/src/`):
- Extended with 3 new AI SDK tool definitions

**E2E** (`packages/memory-engine/src/`):
- `e2e-evaluation.e2e.test.ts` (~3000 LOC) — comprehensive evaluation harness
- `scripts/seed-scenarios.ts` — scenario data seeder

### Schema Changes
- Events: +`importance`, `accessCount`, `lastAccessedAt`, `dreamerProcessedAt`, `dreamerRunId`
- Episodes: +`importance`, `accessCount`, `lastAccessedAt`, `sourceEventIds`
- KB: +`wikiSource`, `vault`, `section` on both KB_SCHEMA and KB_CHUNKS_SCHEMA
- New collection: `consolidation_runs`
- New indexes: 3 (episodes promotion, consolidation_runs tracking, kb_chunks wiki)

### Baselines After Build
- Collections: 25 → 26 (+consolidation_runs)
- Standard indexes: current + 3
- mongodb-*.ts files: 80 → 84 (+4 new modules)
- New tools: 3 (chain-trace, novelty-scan, consolidate)
- New API routes: 3
- New MCP tools: 3

## Data Flow

### Scenario Seeding (450+ events)
```
Scenario 1: AI CODING ASSISTANT (3 agents, 200+ events, 4 simulated weeks)
  - Preferences: "I prefer TypeScript", "always use dark mode", "tabs over spaces"
  - Decisions: "decided to use Bun", "chose MongoDB Atlas", "picked GitHub Actions"
  - Facts: "deployment uses Docker", "staging is on AWS", "prod budget is $5k/mo"
  - Anomalies: "switching to Rust for performance" (novel), "considering Supabase" (novel)

Scenario 2: CUSTOMER SUPPORT (2 agents, 150+ events, 50 sessions)
  - Customer preferences: "prefers email", "timezone is PST"
  - Procedures: "reinstall driver to fix", "escalate after 3 attempts"
  - Facts: "customer has 3 open tickets", "last purchase was $499"
  - Anomalies: "customer threatening legal action" (novel)

Scenario 3: PERSONAL PRODUCTIVITY (1 agent, 100+ events, 3 weeks)
  - Preferences: "morning meetings before 10am", "no calls on Friday"
  - Decisions: "cancel newsletter", "switch to standing desk"
  - Facts: "Q4 report due Dec 15", "team has 8 members"
  - Anomalies: "considering career change" (novel)
```

### E2E Evaluation Flow (10 phases)
```
A: SEED → Write 450+ events via POST /v1/write-event
B: BASELINE → Verify search, read, status all work
C: CONSOLIDATE → POST /v1/consolidate per agent → Dreamer promotes facts
D: CHAIN TRACE → POST /v1/chain-trace for promoted facts → verify provenance
E: NOVELTY SCAN → POST /v1/novelty-scan per agent → verify anomaly ranking
F: IMPORTANCE DECAY → Search at t=0 vs t=28days → verify decay curve
G: ACCESS TRACKING → 50 searches → verify accessCount batched correctly
H: WIKI → Seed KB with wikiSource → verify filtered search
I: ISOLATION → Verify zero cross-agent leakage
J: SCORE CARD → Generate weighted 10-dimension report
```

## Error Handling

| Error Case | Expected Behavior |
|------------|------------------|
| mongot unavailable | Novelty returns `{ events: [], error: "mongot_unavailable" }`, no crash |
| Empty events collection | Chain empty, consolidation no-ops, novelty empty |
| Invalid agentId | 400 error with message from API |
| Rate-limited consolidation | Returns `{ eventsProcessed: 0 }` within minInterval |
| Missing sourceEventIds | Chain returns single-node, no crash |
| Concurrent access tracking | Server-side batching handles concurrency |

## Testing Strategy

### Score Card (10 dimensions, each 0-100)

| # | Dimension | Weight | Perfect = 100 | Fail < 70 |
|---|-----------|--------|---------------|-----------|
| 1 | Chain Completeness | 15% | 100% chains have zero gaps | >30% chains have gaps |
| 2 | Chain Ordering | — (part of 1) | All chains timestamp-sorted | Any chain misordered |
| 3 | Novelty Accuracy | 15% | All seeded anomalies in top-5 | No anomaly in top-10 |
| 4 | Novelty Degradation | — (part of 3) | Empty report on mongot-down | Crash or timeout |
| 5 | Consolidation Yield | 20% | ≥80% preference/decision promoted | <50% promoted |
| 6 | Consolidation Idempotency | — (part of 5) | 0 new facts on re-run | Any duplicates |
| 7 | Importance Decay | 10% | Decay within ±5% of formula | >15% deviation |
| 8 | Access Tracking | 10% | accessCount ≥ expected batch | Count = 0 after searches |
| 9 | Wiki Categorization | 5% | Zero false positives | Any wrong source in results |
| 10 | Cross-Agent Isolation | 25% | 0 cross-agent leakage | Any leakage |

**Pass threshold**: ≥ 90/100 overall, no dimension below 70.

### Test Files
- `mongodb-reasoning-chain.test.ts` — 10 unit tests
- `mongodb-novelty.test.ts` — 8 unit tests
- `mongodb-access-tracker.test.ts` — 6 unit tests
- `mongodb-consolidator.test.ts` — 12 unit tests (+ 2 markEventsDreamerProcessed)
- `mongodb-result-trust.test.ts` — 4 new decay tests
- `e2e-evaluation.e2e.test.ts` — comprehensive 10-phase evaluation (~3000 LOC)

## Build Phases (Sequential)

| Phase | What | Est. LOC |
|-------|------|----------|
| 0 | Schema changes (engine) | ~60 |
| 1 | Reasoning Chain (engine + tests) | ~350 |
| 2 | Novelty Detection (engine + tests) | ~250 |
| 3 | Access Tracker (engine + tests) | ~220 |
| 4 | Importance Decay (engine + tests) | ~60 |
| 5 | Wiki Categorization (engine) | ~40 |
| 6 | Consolidation Agent (engine + tests) | ~600 |
| 7 | Bridge functions | ~200 |
| 8 | API routes | ~150 |
| 9 | MCP tools | ~100 |
| 10 | Client SDK + AI SDK tools | ~150 |
| 11 | Manager wiring | ~100 |
| 12 | E2E Evaluation Harness (seed + test + score) | ~3000 |
| 13 | Final validation + commit + push | — |

## Questions Resolved
- Q: What scenarios for E2E?
  A: All three (coding assistant, support, productivity) for maximum coverage.
- Q: Sequential or scenario-driven?
  A: Port-then-validate. Build all features, then comprehensive E2E.
- Q: Native or patch?
  A: 100% native. No "Honcho" references. Memongo naming conventions throughout.
- Q: Client SDK included?
  A: Yes. All 5 layers: Engine → Bridge → API → MCP → Client SDK + AI SDK Tools.
- Q: Access tracking endpoint?
  A: Transparent server-side middleware. No explicit user-facing endpoint.
