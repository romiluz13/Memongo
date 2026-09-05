# Contract version 2.1.0 bump scope — 2026-09-05

**Change:** `MEMONGO_API_VERSION` 2.0.1 → 2.1.0 (apps/api/src/version.ts,
apps/mcp/src/version.ts, packages/client/src/version.ts) plus the workspace
release version surfaces (root and publishable package.json files, internal
`^2.x` dependency ranges, refreshed bun.lock), and a pi-extension tarball
hygiene fix (explicit `files` list excluding `extensions/diagnostics.test.ts`
from the published tarball).

**Routing:** ddd-scope (external API surface change; release gate interaction).
The `ddd` CLI is unavailable in this environment (`command not found`); this
scope was recorded manually against the book's artifact formats. No
`scope-change` envelope was generated; nothing below should be read as a
machine verdict.

## Boundary statement

The version constants are TypeScript but the change they encode is the
OpenAPI contract identity: the guardrails workstream (13 commits on local
main) changed the served OpenAPI surface under an unchanged `2.0.1` label,
which made the label ambiguous against mdbrain's exact version+sha pin. The
bump restores the invariant that a version label maps to exactly one
canonical contract. Consumers pinning 2.0.1 (mdbrain EL-001) keep working
against 2.0.1 servers; consumers adopting 2.1.0 must re-pin (sha changes).

## Visible gaps (not completion)

1. **No changelog entry yet** for the 2.1.0 consumer-visible contract delta
   (which endpoints/scopes changed vs 2.0.1). Deferred to the release commit.
2. **No assurance case** ties the guardrails workstream's claims to the
   2.1.0 label. If 2.1.0 becomes a published release, build the case first.
3. **Base-image/registry evidence still unlocked** (carried over from
   reports/2026-09-04-container-pipeline-scope.md).

## Operational gates (what actually protects this change)

1. `scripts/check-publishability.ts`: passed — "Version surfaces agree:
   OpenAPI/MCP 2.1.0, client header 2.1.0" and all tarball hygiene checks
   (the pi-extension `files` fix was required to keep this gate green).
2. Full test suite: passed (14 tasks) after the bump.
3. mdbrain's exact-pin semantics (version string AND canonical sha256) mean
   no consumer can silently drift onto the new surface; adoption requires an
   explicit re-capture. This is the drift protection the label fix restores.

## Validation record

Local validation, 2026-09-05:

- Publishability gate exit=0; version-consistency, dependency-range, and
  tarball checks all green.
- `bun run test`: 14/14 tasks passed.
- The 2.1.0 image builds locally (memongo-api:local) and serves the bumped
  OpenAPI version; consumer-side re-capture is tracked in the mdbrain
  repository's deployment scope report.
