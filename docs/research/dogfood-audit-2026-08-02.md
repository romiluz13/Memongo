# Memongo × Pi Dogfood Audit

**Period:** 2026-08-01 → 2026-08-02 (single dogfood session)
**Dogfooder:** Rom (memongo creator) + Pi coding agent (`@memongo/pi-extension`)
**Goal:** Use memongo as the durable semantic memory for the Pi coding agent, alongside the existing `pi-hermes-memory` local store.

This report classifies every issue hit during dogfooding into three buckets:
- **🟠 Memongo product issue** — fix upstream, ship to all users
- **🔵 Our setup / integration issue** — fix locally (Pi extension, env, config)
- **⚪ Observation** — not a bug; a product/UX decision for Rom to make

Each issue has: what happened, root cause, fix, and **ship status** (published to npm vs. on main vs. not started).

---

## Issue summary table

| # | Issue | Bucket | Root cause | Fix status |
|---|-------|--------|-----------|------------|
| 1 | API dies on reboot/terminal close | 🟠 Memongo | No process management | Fixed on main (Dockerfile + compose); not an npm publish |
| 2 | `MEMONGO_MONGODB_DATABASE` env var missing | 🟠 Memongo | DB name only via shared config file | **On main, NOT published to npm** (engine/bridge still 2.0.0) |
| 3 | Cross-app contamination (nanoclaw → pi memory) | 🟠+🔵 | #2 + one shared `~/.memongo/memongo.json` | Fixed locally (per-app env); upstream fix (#2) not published |
| 4 | "Memongo completely sucks" (HTTP 401 for days) | 🔵 Ours | Pi extension read env var Pi doesn't inherit | Fixed + published (`@memongo/pi-extension@2.1.1`) |
| 5 | Search returns 0 results | ⚪ Observation | Correct tenant isolation (defaults to `scope=agent`) | Worked around in extension (`scope=global`); product decision pending |
| 6 | Client SDK `searchDetailed` missing `scope`/`scopeRef` | 🟠 Memongo | SDK doesn't expose params the API + bridge accept | **Not fixed** |
| 7 | LLM never calls memongo tools (no force) | 🟠+⚪ | No integration layer routes hermes → memongo | **Not fixed** — the core dogfood blocker |
| 8 | Publishability check didn't handle Pi extensions | 🟠 Memongo (tooling) | Required `dist/` entrypoints | Fixed + shipped (commit `737b9fed6c`) |

---

## 🟠 Memongo product issues (fix upstream)

### 1. API has no process management — dies on reboot/terminal close
- **What happened:** The API (`apps/api`) is a bare `node --import tsx src/server.ts` foreground process. It dies when you close the terminal, reboot, or it crashes. No auto-restart. This made dogfooding impossible across reboots.
- **Root cause:** Memongo ships no process manager, no Dockerfile for the API, no launchd/systemd unit. The only orchestration is `docker/mongodb/start-preview.sh` for MongoDB — the API is left to the user.
- **Fix (shipped on main, commit `aad1931cfb`):**
  - Added `apps/api/Dockerfile` (multi-stage: `turbo prune` → `bun install` → `tsc build` → `node:22-slim` runner with healthcheck, runs as `node` user, binds `0.0.0.0`).
  - Added `docker/docker-compose.full.yml` (API service + optional local Mongo via `--profile local`; Atlas via `MEMONGO_MONGODB_URI` env).
  - Added `apps/api/.dockerignore`.
- **Ship status:** ✅ on `main`. Not an npm publish (it's Docker config). **Every self-hosted user benefits.**

### 2. `MEMONGO_MONGODB_DATABASE` env var missing → cross-app contamination
- **What happened:** The database name could ONLY be set via `~/.memongo/memongo.json` (the `memory.mongodb.database` field). There was no env var. Every app on the machine reads the SAME config file. When nanoclaw started its API, it overwrote the file with `database: "nanoclaw-demo-2"`. When Pi's API read the same file, it connected to nanoclaw's database. Hospital patient data landed in Pi's memory. Last app to write wins.
- **Root cause:** `packages/memory-bridge/src/memory-config.ts` (`buildMemongoConfig`) read `uri` and `collectionPrefix` from env, but NOT `database`. The `database` field defaulted to `"memongo"` and could only be overridden via the shared config file. No per-app isolation mechanism.
- **Fix (on main, commit `aad1931cfb`):**
  - `memory-config.ts`: read `env.MEMONGO_MONGODB_DATABASE` and merge into `mergedMongo.database`.
  - `backend-config.ts`: also read `process.env.MEMONGO_MONGODB_DATABASE` as a fallback.
- **Ship status:** ⚠️ **FIXED ON MAIN, NOT PUBLISHED TO NPM.** `@memongo/memory-engine` and `@memongo/memory-bridge` are still `2.0.0` on npm (same version in repo). The publish workflow skips already-published versions. **ACTION: bump engine + bridge to `2.0.1` (or `2.1.0`) and tag a release so the fix reaches npm.** Without this, every Docker/per-app user hits the same contamination.

### 3. Cross-app contamination (consequence of #2)
- **What happened:** 31 chunks of nanoclaw hospital data (patient names, clinical protocols) landed in `rom-memory-dev` (Pi's intended database). Zero Pi memory was saved there. The database was unusable.
- **Root cause:** #2 (no env var) + the architectural footgun of one shared global config file. Partially memongo (the env var gap), partially our setup (we didn't isolate per-app until I added `MEMONGO_MONGODB_DATABASE=pi-memory` to the launchd plist).
- **Fix:** Dropped the contaminated `rom-memory-dev` database. Created a clean `pi-memory` database. Set `MEMONGO_MONGODB_DATABASE=pi-memory` in Pi's launchd plist (env var overrides the shared config file). Set `MEMONGO_AGENT_ID=pi` so the collection prefix is `memongo_pi_` (separate from nanoclaw's `memongo_main_`).
- **Ship status:** ✅ Fixed locally. Upstream fix (#2) not yet published.

### 6. Client SDK `searchDetailed` is missing `scope`/`scopeRef` params
- **What happened:** The Pi extension needed to search at `scope=global` (single-user dogfood). The HTTP API accepts `scope` in the body (verified — returns results). The bridge (`memongoBridgeSearchDetailed`) accepts `scope?: MemoryScope`. But the **client SDK** (`@memongo/client`, `searchDetailed`) does NOT accept `scope`/`scopeRef`. I had to bypass the SDK with raw `fetch`.
- **Root cause:** `packages/client/src/client.ts`, `searchDetailed` input type omits `scope`/`scopeRef` — even though the underlying `apiPost("/v1/search-detailed", ...)` would forward them if they were in the input object. The SDK is incomplete relative to the API.
- **Fix:** Add `scope?: MemoryScope` and `scopeRef?: string` to the `searchDetailed` input type (and `search()`, `searchKB()` for consistency), forward them in the `apiPost` body.
- **Ship status:** ❌ **NOT FIXED.** Real SDK gap. Any external SDK consumer who needs tenant-scoped search is stuck bypassing the SDK.

### 8. Publishability check didn't handle Pi-style extensions (no `dist/`)
- **What happened:** `scripts/check-publishability.ts` required every package to have `main`/`types` → `./dist/`. Pi extensions ship TS source (Pi loads it via jiti, no build step). The check blocked publishing.
- **Root cause:** The check assumed all publishable packages are built libraries. No concept of a "runtime-only" package that ships source.
- **Fix (shipped, commit `737b9fed6c`):** Added a `piExtension` flag to the publishable package spec. `assertPiExtensions` verifies the `pi.extensions` manifest + entrypoints exist. `assertTarballContents` handles directory entries. `installSmoke` checks the manifest instead of `import()` for Pi extensions. Added `packages/pi-extension` to the publish workflow.
- **Ship status:** ✅ Fixed + shipped.

---

## 🔵 Our setup / integration issues (fix locally)

### 4. "Memongo completely sucks" — HTTP 401 for days
- **What happened:** From inside Pi, every `memongo_search` / `memongo_save` / `memongo_status` call returned "Memongo unavailable: HTTP 401: unauthorized." For days. The backend was fine the whole time (25 chunks, vector search, writes all working via curl). It looked like memongo was completely broken.
- **Root cause:** The Pi extension read `MEMONGO_API_KEY` from `process.env`. But **Pi does not inherit `~/.zshrc` exports** — the env var was `undefined` in the Pi process. The extension sent no auth header → 401. **This was my extension's bug, not memongo's.**
- **Fix (published, `@memongo/pi-extension@2.1.1`):** Baked `local-dev-secret` as the default API key directly into the extension. Env vars still override if present. Commit `8f02a85989`.
- **Ship status:** ✅ Fixed + published.
- **Lesson:** I should have tested the actual `memongo_status` tool from inside Pi immediately after setup, instead of only testing via curl. The curl test had the env var; Pi didn't.

### 5. Search returns 0 results (worked around in extension)
- **What happened:** `memongo_search` returned 0 even though data existed and indexes were READY.
- **Root cause:** NOT a bug. The API defaults to `scope=agent` when no scope is passed (`mongodb-manager.ts:3201`) — correct tenant isolation. But `memongo_save` writes with `scope=global`, so the default search never found them.
- **Fix (published, `@memongo/pi-extension@2.1.1`):** Extension now searches `scope=global` by default (Pi is single-user). Commit `e0cd20ac8a`.
- **Ship status:** ✅ Fixed locally. See observation #5 below for the upstream product question.

---

## ⚪ Observations (product decisions for Rom)

### 5/obs. Single-user search default scope
- The `scope=agent` default is correct for multi-tenant SaaS. But for single-user self-hosted dogfood, it makes search feel broken (0 results for your own data).
- **Product question:** should there be a config flag like `searchDefaultScope: "global"` for single-user deployments? Not a code bug — a UX decision.

### 7/obs. The core dogfood blocker — nothing forces the LLM to call memongo
- **What happened:** Over days of dogfooding, the LLM almost never called `memongo_save` or `memongo_search` on its own. Memongo felt dead — not because it was broken, but because **nothing auto-triggers it**.
- **Root cause:** This is the architecture, not a bug:
  - `pi-hermes-memory` auto-saves aggressively (4 triggers: correction detector, background review every 10 turns, session flush, explicit tool calls) — but to its **own** local SQLite, never to memongo.
  - `@memongo/pi-extension` has **zero auto-triggers** — it only fires when the agent explicitly calls the tools.
  - There is **no orchestrator** routing hermes → memongo. The two systems are parallel and independent. The LLM sees all tools from all extensions and picks based on descriptions + the system prompt. Hermes's policy prompt nags the agent to use `memory`/`memory_search` (hermes's own tools), not `memongo_*`.
- **Is this a memongo issue?** Partially. Memongo exposes the API correctly — the gap is that **memongo provides no integration layer / auto-trigger mode**. A consumer who wants "auto-save everything to memongo" has to build it themselves. That's an integration gap that every non-trivial consumer will hit.
- **Options to fix (the "smartest way"):**
  - **(A) Memongo-side: an auto-trigger mode.** Memongo ships an integration extension (for Pi, or framework-agnostic) that hooks `message_end` / correction detection / background review and mirrors to memongo. Makes memongo self-sufficient.
  - **(B) Bridge: mirror hermes writes to memongo.** A thin extension hooks hermes's `memory` tool writes and mirrors them to `memongo_save`. Hermes stays the brain; memongo becomes the durable semantic mirror. This was the original "Stage 2 hybrid" plan.
  - **(C) Prompt-level force.** Strengthen the memongo tool descriptions + add a system prompt policy (like hermes does) that tells the agent WHEN to use `memongo_save`/`memongo_search`. Cheapest, but least reliable — the LLM still has to choose.
- **Rom's instinct ("with no clear force, this tool will not be called") is correct.** Without (A), (B), or (C), the LLM won't call memongo. This is the #1 dogfood finding.

---

## What's published vs. pending (action list for Rom)

| Package | npm version | Repo version | State |
|---------|-------------|--------------|-------|
| `@memongo/memory-engine` | 2.0.0 | 2.0.0 | **`MEMONGO_MONGODB_DATABASE` fix on main, NOT published** — bump + release |
| `@memongo/memory-bridge` | 2.0.0 | 2.0.0 | **same fix on main, NOT published** — bump + release |
| `@memongo/client` | 2.0.0 | 2.0.0 | **`scope`/`scopeRef` gap NOT fixed** — fix + bump + release |
| `@memongo/pi-extension` | 2.1.1 | 2.1.1 | ✅ up to date |
| Docker (API Dockerfile + compose) | n/a | on main | ✅ shipped (not an npm package) |

### Recommended upstream actions (in priority order)
1. **Fix client SDK `searchDetailed` scope gap** (#6) — add `scope`/`scopeRef`, bump `@memongo/client` to `2.0.1`, publish.
2. **Publish the `MEMONGO_MONGODB_DATABASE` fix** (#2) — bump `@memongo/memory-engine` + `@memongo/memory-bridge` to `2.0.1`, tag, publish. This unblocks per-app isolation for every Docker/self-hosted user.
3. **Decide on the auto-trigger story** (#7) — this is the real dogfood blocker. Option A (memongo auto-trigger integration), B (hermes mirror bridge), or C (prompt force). Without one, memongo won't get used by the LLM.
4. **Decide on single-user search default scope** (#5/obs) — `searchDefaultScope` config flag.

### Recommended local actions (already done, for reference)
- Per-app database isolation via `MEMONGO_MONGODB_DATABASE=pi-memory` in launchd plist ✅
- `MEMONGO_AGENT_ID=pi` for collection prefix isolation ✅
- Baked API key default in the Pi extension ✅ (published 2.1.1)
- Extension searches `scope=global` ✅ (published 2.1.1)
- Clean Atlas state: only `pi-memory` (Pi) + `nanoclaw-demo-2` (nanoclaw) remain ✅

---

## Dogfood verdict

Memongo's **backend is solid** — MongoDB Atlas, hybrid vector+text+graph search, auto-embeddings, bi-temporal validity, revisions, provenance. The search engine works (score 0.729 on a semantic match). The contamination was a config-architecture gap (no env var), not a data-integrity bug.

The **real dogfood blocker is not the backend — it's the integration layer.** Memongo provides no auto-triggers and no orchestrator. A consumer who wants "auto-save everything to memongo" has to build it themselves. That's the gap that made memongo feel dead for days. The LLM won't call `memongo_save` without a force — and that force is nobody's job today.

Fix the two real product bugs (#2 publish, #6 SDK scope), then build the auto-trigger integration (#7). That's the path from "fucking impossible" to "it just works."
