# Memongo parity and production-readiness audit

**Date:** 2026-03-25  
**PLAN_MODE:** `execution_plan`  
**VERIFICATION_RIGOR:** `standard`  
**Scope:** Read-only audit before production ship; no implementation in this phase.

---

## Request summary

Produce evidence-backed parity against two user-selected targets (ClawMongo-v2 core memory; Supermemory public product surface) and clear Memongo-specific production-readiness gates, culminating in ship/no-ship artifacts.

---

## Requirements snapshot

- Audit the **entire** Memongo system (engine, bridge, apps, packages, CI, docs, docker) with emphasis on pre-ship risk.
- **Track A — ClawMongo-v2 parity:** **core memory behavior only** (not CLI/HTTP/operator surfaces of ClawMongo).
- **Track B — Supermemory parity:** **public product surface only** (API/SDK/MCP/docs/web story); deployment/release mechanics are **out of scope** as parity targets unless needed as **audit evidence** for Memongo readiness.

---

## Constraints snapshot

- Plan-only; no code edits during the audit.
- Use **repo-relative paths** for Memongo; reference external repos by simple repo-relative paths (e.g. `ClawMongo-v2/packages/...`) when citing comparisons.
- Research summary provided; deeper ClawMongo/Supermemory code walks happen **during** audit execution, not assumed here.

---

## In scope

- Parity matrices and gap lists for both tracks.
- Production-readiness gates for Memongo (security, reliability, operability, quality bars).
- Risk register and ship/no-ship decision inputs.

## Out of scope

- Implementing fixes, refactors, or new features.
- Full ClawMongo or Supermemory repo mirroring beyond evidence needed for parity rows.
- Parity on ClawMongo non-core surfaces; Supermemory internal ops/deployment parity.

---

## Open decisions

**None** for audit methodology (user fixed parity scopes). Execution may surface product decisions (e.g. which gaps block v1) — capture in risk register, not here.

---

## Differences from agreement

**None.**

---

## Recommended defaults

- **Evidence format:** One **parity matrix** per track (spreadsheet or markdown tables) with columns: capability, Memongo location, target reference, status (present / partial / missing / N/A), evidence (file:line or doc section), owner follow-up.
- **ClawMongo reference:** Treat user-provided capability list as the checklist; map each item to `packages/memory-engine`, `packages/memory-bridge`, and `packages/memongo-memory` first; note cross-cutting concerns (indexes, migrations) in `packages/memory-engine` migration/index code and `docker/mongodb`.
- **Supermemory reference:** Use Memongo’s own public story (`README.md`, `apps/api` OpenAPI, `packages/client`, `apps/mcp`, `apps/web`, `docs/`) as the “expected surface”; compare to Supermemory README/docs in their repo when validating naming and flows.

---

## Current state (Memongo anchors)

| Area | Key files / surfaces |
|------|----------------------|
| API | `apps/api/src/server.ts` (`/health`, `/openapi.json`, `/v1/*`, optional `MEMONGO_API_KEY` auth) |
| V1 routes | `apps/api/src/routes/v1.js` (and siblings under `apps/api/src/`) |
| OpenAPI | `apps/api/src/openapi-spec.ts` |
| MCP | `apps/mcp/` |
| Web | `apps/web/` |
| Client SDK | `packages/client/` |
| Engine | `packages/memory-engine/` |
| Bridge | `packages/memory-bridge/` |
| Re-exports | `packages/memongo-memory/` |
| CI | `.github/workflows/ci.yml` (typecheck filters published packages; full `bun run test`) |
| Publish | `.github/workflows/publish.yml` (path triggers; `pnpm publish` with `--no-git-checks` and `|| true`) |
| Local DB | `docker/mongodb/docker-compose.mongodb.yml` |

---

## Alternatives (audit approach)

- **A — Bottom-up:** Start in `packages/memory-engine` and trace outward. **Viable:** Strong for Track A; slower for Track B.
- **B — Top-down:** Start from `README.md` + OpenAPI + client, then drill to engine. **Viable:** Strong for Track B; use for cross-checking Track A.

**Recommendation:** Run **A** for ClawMongo core-memory rows and **B** for Supermemory surface rows; reconcile in a single weekly review.

---

## Drawbacks

- Parity is **documentation of intent**, not formal equivalence; some behaviors may match without identical architecture.
- CI currently does not typecheck `apps/api`, `apps/mcp`, `apps/web` — audit must explicitly run/record local `check-types` or equivalent for apps to avoid blind spots.
- Publish workflow’s `|| true` masks publish failures — flag as **operational risk** in evidence, not as Supermemory parity.

---

## Critical-path verification design

**Not required** (`VERIFICATION_RIGOR=standard`). Audit still records **behavior notes** for high-risk areas (auth, data loss, migration) in the risk register.

---

## Phase plan

### Phase 0 — Audit charter and inventory

- **Objective:** Freeze scope, list all Memongo entrypoints and version pins.
- **Inputs:** This plan, repo tree.
- **Files:** Root `package.json`, `turbo.json`, `apps/*/package.json`, `packages/*/package.json`.
- **Artifacts:** Inventory appendix (apps, packages, ports, env vars).
- **Checks:** Complete list of `MEMONGO_*` and documented ports.
- **Checkpoint:** `none`
- **Exit:** Single table of “what ships” for v1.

### Phase 1 — Track A: ClawMongo core-memory parity matrix

- **Objective:** Map each **core-memory** capability (event-sourced conversation, projections/chunks, hybrid retrieval + fusion, retrieval planner paths, query cache, reranker, structured memory, procedures, profiles, KB, graph/entities, episodes, sync bridge, automated embeddings, telemetry/relevance/mutations, change streams, migration) to Memongo code paths.
- **Inputs:** Capability list (from user), Memongo engine/bridge source.
- **Files (primary):** `packages/memory-engine/src/**`, `packages/memory-bridge/src/**`, tests under those packages; `packages/memongo-memory/**`.
- **Artifacts:** Parity matrix Track A; gap list (ranked: P0/P1/P2).
- **Checks:** Each row has evidence pointer; “missing” rows have suggested owner.
- **Checkpoint:** `[CHECKPOINT]` only if a capability is ambiguous (e.g. same name, different semantics) — resolve with product owner.
- **Exit:** Signed-off matrix or explicit deferred rows.

### Phase 2 — Track B: Supermemory public-surface parity matrix

- **Objective:** Verify **public** install and usage story: HTTP API shape (Supermemory-compatible routes per `README.md`), SDK (`packages/client`), MCP config/transport (`apps/mcp`), docs (`docs/`, root `README.md`), web onboarding/dashboard (`apps/web`).
- **Inputs:** Supermemory public README/docs (in their repo); Memongo `README.md`, `apps/api/src/openapi-spec.ts`, `packages/client` README if present.
- **Files:** `README.md`, `docs/**`, `apps/api/src/openapi-spec.ts`, `packages/client/**`, `apps/mcp/**`, `apps/web/**`.
- **Artifacts:** Parity matrix Track B; UX/doc gaps list.
- **Checks:** Each public flow has “user can do X” scenario with evidence.
- **Checkpoint:** `none` unless branding/URL promises conflict with actual defaults.
- **Exit:** Doc/API/SDK alignment report.

### Phase 3 — Production-readiness: security and data safety

- **Objective:** AuthZ for API (`MEMONGO_API_KEY`), secret handling, PII/logging posture, tenant/session isolation if present, backup/restore assumptions.
- **Files:** `apps/api/src/server.ts`, `apps/api/src/routes/**`, any auth middleware; engine APIs that accept external input.
- **Artifacts:** Security findings list; severity; “must fix before ship” vs “follow-up.”
- **Checks:** STRIDE-style pass documented in one page.
- **Exit:** No undocumented auth bypass on `/v1/*`.

### Phase 4 — Production-readiness: reliability and operations

- **Objective:** Health/readiness (`/health`), error model, timeouts, idempotency where relevant, MongoDB failure modes, observability hooks (logging/metrics if any).
- **Files:** `apps/api/src/**`, engine connection lifecycle, `docker/mongodb/**`.
- **Artifacts:** Ops readiness checklist; “runbook gaps.”
- **Exit:** Clear answer on “what breaks if Mongo is down / slow.”

### Phase 5 — Quality bar: tests, types, CI/CD evidence

- **Objective:** Map test coverage to critical paths; record CI gaps (e.g. apps not in `check-types` filter); evaluate publish workflow behavior as **evidence** (not Supermemory parity).
- **Files:** `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `**/*.test.ts` under packages and apps.
- **Artifacts:** Test/CI gap matrix; recommendation list for CI (for follow-up implementation).
- **Checks:** Document result of `bun run test` and explicit `turbo run check-types` with app filters on audit branch.
- **Exit:** Known blind spots listed before ship.

### Phase 6 — Consolidation: risk register and ship/no-ship

- **Objective:** Merge findings; assign overall **go / no-go / go with conditions**; owners and dates.
- **Artifacts:** Risk register (probability × impact); ship/no-ship one-pager; executive summary.
- **Checks:** Every P0 gap has owner or explicit waiver.
- **Exit:** Stakeholder sign-off checkpoint (process, not code).

---

## Acceptance criteria

### Parity achieved (Track A — ClawMongo core memory)

- Parity matrix covers **all** user-listed core-memory capabilities with **present / partial / missing** and **file-level evidence** in Memongo.
- **Partial** and **missing** rows include impact statement (functional vs performance vs future-compat).
- No row relies on guesswork: if unclear, row is **ambiguous** with a follow-up spike ID.

### Parity achieved (Track B — Supermemory public surface)

- Documented alignment between Memongo’s **public** promises (`README.md`, OpenAPI, client install) and actual routes and artifacts.
- MCP and web surfaces are covered at **user-visible** level (how to run, how to configure), without requiring deployment parity with Supermemory.
- Gaps are classified: **doc fix**, **API fix**, **out of scope for v1**.

### Production readiness (Memongo)

- Security pass completed with **no open P0** items unless explicitly waived in writing.
- Ops/reliability checklist completed for **single-tenant / self-hosted** assumptions (adjust if product is multi-tenant).
- CI/test blind spots are **explicitly listed** (including apps not in default typecheck filter).
- **Ship decision** recorded with conditions, if any.

---

## Suggested final deliverables

| Deliverable | Purpose |
|-------------|---------|
| **Parity matrix A** (ClawMongo core memory) | Traceability for engine/bridge completeness |
| **Parity matrix B** (Supermemory public surface) | Product/marketing/engineering alignment |
| **Gap list** (prioritized backlog) | Feed implementation sprints |
| **Risk register** | Probability × impact; mitigations |
| **Ship / no-ship decision doc** | Formal go-live gate |
| **Evidence appendix** (commands run, commit SHA, log snippets) | Audit defensibility |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| ClawMongo-v2 code not pinned to a commit | Record exact commit SHA used for comparison in Track A. |
| Supermemory public docs drift | Snapshot README URLs/sections in appendix. |
| Hidden behavior only in `apps/api` not typechecked | Explicitly run app-level typecheck during audit Phase 5. |
| Publish workflow masks failures | List as operational risk; do not conflate with product parity. |

---

## Acceptance checks (commands / scenarios)

- `bun install --frozen-lockfile` succeeds; `bun run test` recorded.
- `bunx turbo run check-types` with expanded filters to include `apps/api`, `apps/mcp`, `apps/web` (or per-package `check-types`) — record pass/fail.
- Manual or scripted smoke: `GET /health`, `GET /openapi.json` against local API (document env).
- Docker: `docker compose -f docker/mongodb/docker-compose.mongodb.yml` up — document whether E2E smoke was run.

---

## Recommended skills for follow-up BUILD (SKILL_HINTS)

- `mongodb-ai`, `mongodb-query-and-index-optimize`, `mongodb-schema-design` (engine parity fixes)
- `react-best-practices` or `vercel-react-best-practices` (web gaps)
- `mongodb-transactions-consistency` if migration/multi-write paths are touched

---

## Scenarios (acceptance-oriented)

| # | Scenario | Given | When | Then |
|---|----------|-------|------|------|
| 1 | Track A row complete | A core-memory capability exists in Memongo | Reviewer opens cited files | Status and evidence are uncontroversial |
| 2 | Track B public flow | User follows `README.md` quick start | They call documented API + SDK path | Observed behavior matches matrix or gap is filed |
| 3 | Ship gate | Risk register has no open P0 | Ship meeting | Decision doc is signed or blocked with reasons |
| 4 | CI honesty | Audit branch | Typecheck includes apps | Blind spot is confirmed or closed |

---

## Summary

- **Plan saved:** `docs/plans/2026-03-25-memongo-parity-production-readiness-audit-plan.md`
- **Phases:** 7 (0–6)
- **Risks:** 4 identified
- **Key decisions:** Two-track parity (core memory vs public surface); deployment out of scope for parity; publish/CI as Memongo evidence only

**Confidence score: 78/100** — Memongo paths verified against `README.md`, `apps/api/src/server.ts`, `ci.yml`, `publish.yml`; `.claude/cc10x/v10` memory files absent; external repo SHAs to be fixed during audit execution.

---

## Router contract (machine-readable)

```yaml
STATUS: PLAN_CREATED
PLAN_MODE: execution_plan
VERIFICATION_RIGOR: standard
CONFIDENCE: 78
PLAN_FILE: "docs/plans/2026-03-25-memongo-parity-production-readiness-audit-plan.md"
PHASES: 7
RISKS_IDENTIFIED: 4
SCENARIOS:
  - name: "Track A evidence complete"
    given: "A core-memory capability exists in Memongo"
    when: "Reviewer opens cited files"
    then: "Status and evidence are uncontroversial"
  - name: "Track B public flow"
    given: "User follows README quick start"
    when: "They call documented API and SDK path"
    then: "Behavior matches matrix or gap is filed"
  - name: "Ship gate"
    given: "Risk register has no open P0"
    when: "Ship meeting runs"
    then: "Decision doc is signed or blocked with reasons"
  - name: "CI blind spot closure"
    given: "Audit branch with expanded typecheck"
    when: "turbo check-types includes apps"
    then: "Blind spot confirmed or closed"
ASSUMPTIONS:
  - "ClawMongo-v2 and Supermemory repos are available at known paths/commits for comparison."
  - "Production target is self-hosted/single-tenant unless product states otherwise."
DECISIONS:
  - "Track A scope is core memory only; Track B is public surface only."
OPEN_DECISIONS: []
DIFFERENCES_FROM_AGREEMENT: []
RECOMMENDED_DEFAULTS:
  - "Evidence: parity matrix per track with file-level pointers"
ALTERNATIVES:
  - "Bottom-up audit (engine-first)"
  - "Top-down audit (API/docs-first)"
DRAWBACKS:
  - "Parity is interpretive, not bit-for-bit equivalence"
  - "CI does not typecheck apps by default"
PROVABLE_PROPERTIES: []
BLOCKING: false
NEXT_ACTION: "build"
REMEDIATION_NEEDED: false
REQUIRES_REMEDIATION: false
REMEDIATION_REASON: null
GATE_PASSED: true
USER_INPUT_NEEDED: []
MEMORY_NOTES:
  learnings:
    - "Two-track parity reduces scope creep: core memory vs public surface."
  patterns:
    - "Anchor Memongo audit on memory-engine, memory-bridge, apps/api OpenAPI, packages/client, apps/mcp, apps/web."
  verification:
    - "Plan: docs/plans/2026-03-25-memongo-parity-production-readiness-audit-plan.md with 78/100 confidence"
```
