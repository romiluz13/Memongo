# Memongo Validation Pack

Use this pack to prove that the supported Memongo core is healthy on managed MongoDB Atlas cloud, Atlas Local Preview, and the repo's official gates.

## Release-blocking lanes

### 1. `repo-foundation`

Run from repo root:

```bash
bun run check-types
bun run lint
bun run build
bun run test
```

### 2. `api-contract`

Start the API against a real MongoDB stack, then run:

```bash
MEMONGO_API_URL=http://127.0.0.1:3847 \
MEMONGO_AGENT_ID=proof-main \
MEMONGO_SESSION_ID=proof-session \
bun run proof-pack
```

This validates the supported HTTP contract for:
- `GET /health`
- `GET /openapi.json`
- `POST /v1/add`
- `POST /v1/write-event`
- `POST /v1/write-structured`
- `POST /v1/write-procedure`
- `POST /v1/search`
- `POST /v1/search-detailed`
- `POST /v1/hydrate-active-slate`
- `POST /v1/discovery-projection`
- `POST /v1/context-bundle`
- `POST /v1/profile`
- `GET /v1/status`
- `GET /v1/stats`
- `GET /v1/admin/relevance/report`

### 3. `package-publishability`

Run from repo root:

```bash
bun run check-publishability
```

This validates:
- built `dist` entrypoints
- tarball hygiene
- runtime dependency closure
- temp-project install smoke for the published package set

### 4. `live-core`

Use managed Atlas cloud for the control lane:

```bash
export MEMONGO_MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=memongo"
export VOYAGE_API_KEY="al-your-atlas-model-api-key"
bun run mongodb:parity
```

Use Atlas Local Preview for the local parity lane:

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

If the runtime does not have an Atlas Model key with the `al-...` prefix, the
vector-only assertions in `production-readiness.e2e.test.ts` will skip.

### 5. `live-capability`

These lanes are real but environment-specific:
- Auto-embed/search:
  `packages/memory-engine/src/real-e2e-v2.e2e.test.ts` against managed Atlas cloud or the preview stack with a valid `al-...` Atlas Model key.
- Replica-set-only:
  `packages/memory-engine/src/mongodb-e2e.e2e.test.ts` against `docker/mongodb/docker-compose.mongodb.yml` `replicaset` or `fullstack` using:

```bash
MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true"
```

### 6. `real-agent`

Start `apps/api` against the preview stack, then run:

```bash
export MEMONGO_LLM_BASE_URL="https://api.openai.com/v1"
export MEMONGO_LLM_API_KEY="your-llm-api-key"
export MEMONGO_LLM_MODEL="gpt-4o-mini"
export MEMONGO_API_URL="http://127.0.0.1:3847"
bun run agent-smoke
```

This lane proves a real tool-calling agent can:
- call an OpenAI-compatible chat-completions endpoint
- persist events into Memongo through the supported HTTP API
- search memory through live retrieval paths
- hydrate active memory for current-state questions
- build discovery projections for changes and contradictions
- build prompt-ready context bundles for handoff-style turns
- answer follow-up recall and synthesis questions from stored evidence

The harness lives in `scripts/real-agent-smoke.ts`.

### 7. `seeded-eval`

Run the deterministic seeded eval pack against a live API:

```bash
MEMONGO_API_URL=http://127.0.0.1:3847 \
bun run memory-eval
```

This lane seeds realistic multi-scope memory and scores:
- stale fact supersession
- abstention on missing exact evidence
- scope isolation
- active-slate hydration
- what-changed synthesis
- contradiction projection quality
- context-bundle handoff quality under a token budget

The harness lives in `scripts/real-memory-eval.ts`.

### 8. `compare-seeded-eval`

Compare a baseline and candidate API directly:

```bash
MEMONGO_BASELINE_API_URL=http://127.0.0.1:3847 \
MEMONGO_CANDIDATE_API_URL=http://127.0.0.1:3850 \
bun run compare-memory-eval
```

This emits a release-gate summary with:
- pass-rate delta
- average-score delta
- exact-evidence delta
- scope-leak delta
- stale-failure delta
- abstention delta
- p95 latency ratio

## Proof artifacts

`bun run proof-pack`, `bun run memory-eval`, `bun run compare-memory-eval`, `bun run agent-smoke`, and `bun run capability-stress` can persist comparable JSON run artifacts when one of these is true:
- `MEMONGO_PROOF_ARTIFACT_DIR` is set

This keeps baseline and candidate evidence local-only by default while still making the proof lanes reproducible.

## What this proves

Memongo is ready for release only when every release-blocking lane is green and every claimed capability was validated in its correct environment.

## Related
- [Benchmark pack](benchmark-pack.md)
- [Self-host runbook](self-host.md)
