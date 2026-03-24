# Production-ready release checklist (Memongo + memongo-platform)

Use this before **npm publish**, **tagged releases**, or **public “production” claims**. It aligns with `.github/workflows/memongo-platform.yml` and engine expectations.

## 1. Repository gates (required)

Run from the **Memongo repo root** (engine + bridge):

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Notes:

- `pnpm check` includes lint/format and repo policy scripts; expect several minutes on a full tree.
- If the full test suite is heavy locally, use the repo’s documented test profiles (see `docs/help/testing.md`) and still run **CI-equivalent** coverage before publishing.

## 2. memongo-platform workspace (required for platform npm publish)

```bash
cd memongo-platform
pnpm install
pnpm check-types:all
pnpm test
```

This matches the **`memongo-platform`** GitHub Actions job.

## 3. Live MongoDB gate (strongly recommended before “production” claims)

Automated CI does **not** replace a real cluster:

1. Start **`mongodb/mongodb-atlas-local:preview`** with `VOYAGE_API_KEY` (Atlas Model API key on the container). See `docker/mongodb/docker-compose.preview.yml` and `docs/start/memongo-getting-started.md`.
2. Point the gateway or `memongo-api` at that URI (`MEMONGO_FORCE_MONGODB_URI` if your file config would override).
3. Run targeted live tests you care about, for example:
   - `MONGODB_TEST_URI="mongodb://127.0.0.1:<port>/?directConnection=true" VOYAGE_API_KEY=... pnpm test -- src/memory/runtime-write.e2e.test.ts`
   - Optional broader gate: `src/memory/production-readiness.e2e.test.ts` (long; maintainer release confidence).

## 4. HTTP stress (optional but valuable)

With `memongo-api` up:

```bash
cd memongo-platform
MEMONGO_API_URL=http://127.0.0.1:3847 \
STRESS_MESSAGES=500 STRESS_CONCURRENCY=32 STRESS_SEARCHES=100 \
bun scripts/stress-live.ts
```

Treat this as **load smoke**, not a substitute for correctness proofs across all subsystems.

## 5. Publish steps

See [publish.md](publish.md) for `@romiluz/memongo` and `@romiluz/memongo-platform` tarball and semver notes.

## 6. Security and compliance

- No API keys or connection strings in git; use env vars and gitignored local files.
- Rotate any key that appeared in logs, chats, or CI debug output.
- Confirm **license** compatibility for your distribution (engine + platform packages + dependencies).

## 7. What “production ready” does **not** mean

Passing local checks does **not** certify:

- Your **hosting** SLAs, backups, or DR
- **Org** security review, pen test, or compliance frameworks
- **End-user** support and on-call

Document your own operational runbook separately.
