# Production-ready checklist

Use this before npm publish, release tags, or public production-ready claims for Memongo.

## Official release lanes

Memongo is only release-ready when every release-blocking lane below is green on the branch you intend to ship.

### 1. `repo-foundation`

Run from repo root:

```bash
bun install
bun run check-types
bun run lint
bun run build
bun run test
```

### 2. `api-contract`

With MongoDB reachable and `apps/api` running:

```bash
export MEMONGO_API_URL=http://127.0.0.1:3847
bun run proof-pack
```

### 3. `package-publishability`

From repo root:

```bash
bun run check-publishability
```

This lane verifies built `dist` entrypoints, tarball contents, workspace-dependency closure, and temp-project install smoke for the published package set.

### 4. `live-core`

Use a real MongoDB stack for the core live path.

Managed Atlas cloud is the control lane for serious benchmark and release validation:

```bash
export MEMONGO_MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=memongo"
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
bun run mongodb:parity
```

Atlas Local Preview remains the local reproducibility lane:

```bash
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
docker compose -f docker/mongodb/docker-compose.preview.yml up -d
export MEMONGO_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
```

Then run:

```bash
cd packages/memory-engine
MONGODB_TEST_URI="mongodb://127.0.0.1:27017/?directConnection=true" \
bunx vitest run \
  src/production-readiness.e2e.test.ts
```

Without an `al-...` Atlas Model key, auto-embed/vector assertions should be
treated as skipped capability checks, not product proof.

### 5. `live-capability`

Capability lanes are separate from the core release lane and must be run with the environment they actually require.

- Auto-embed/search lane:
  Requires managed Atlas cloud or `docker/mongodb/docker-compose.preview.yml` and an Atlas Model key with the `al-...` prefix. A direct Voyage `pa-...` key is not a valid MongoDB auto-embed environment.
- Replica-set-only lane:
  Use `docker/mongodb/docker-compose.mongodb.yml` `replicaset` or `fullstack`, then run `packages/memory-engine/src/mongodb-e2e.e2e.test.ts` with:

```bash
MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true"
```

This lane covers transactions, change streams, and other replica-set-specific behavior. Do not treat the preview connection string as proof for those features unless that lane is green too.

### 6. `real-agent`

With `apps/api` running against managed Atlas cloud or the preview stack:

```bash
export MEMONGO_LLM_BASE_URL="https://api.openai.com/v1"
export MEMONGO_LLM_API_KEY="your-llm-api-key"
export MEMONGO_LLM_MODEL="gpt-4o-mini"
export MEMONGO_API_URL="http://127.0.0.1:3847"
bun run agent-smoke
```

This lane is the closest supported proof that a real model can use Memongo as memory, not just that the engine and API pass standalone tests.

## Operational honesty

Passing these gates does not certify hosting SLAs, backups, monitoring, or org security review. Document your own runbook; see [self-host.md](self-host.md).

## Publish steps

See [publish.md](publish.md) for scope, versioning, dependency-closure, and npm mechanics.
