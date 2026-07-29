# Memongo MongoDB Setup

Atlas Local preview is the canonical Memongo MongoDB stack.

## Recommended: Preview (Single Container)

The fastest way to run Memongo's full MongoDB stack:

```bash
# Start (bundles mongod + mongot + Atlas Search + Vector Search)
./docker/mongodb/start-preview.sh

# With auto-embeddings
VOYAGE_API_KEY=al-your-atlas-model-api-key ./docker/mongodb/start-preview.sh

# Stop
./docker/mongodb/start-preview.sh stop
```

This uses `mongodb/mongodb-atlas-local:preview` (~584 MB) -- a single container with everything Memongo needs:

- mongod (MongoDB 8.x, single-node replica set)
- mongot (community search engine)
- Atlas Search + Atlas Vector Search
- Auto-embeddings via Voyage AI (when `VOYAGE_API_KEY` is an Atlas Model key)

**Connection string:** `mongodb://localhost:27017/?directConnection=true` (no auth needed)

**Docker Compose file:** `docker/mongodb/docker-compose.preview.yml`

For most users, this is all you need. The multi-container setup below is for advanced validation and environment-specific checks.

---

## Advanced: Multi-Container Setup

> **Note:** Most users should use the [Preview single container](#recommended-preview-single-container) above.
> The multi-container setup is for users who need separate mongod/mongot control, custom auth, or specific MongoDB versions.

Adapted from [mdb-community-search](https://github.com/JohnGUnderwood/mdb-community-search) (MongoDB engineer reference implementation).

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (Docker Desktop or Docker Engine)
- [Docker Compose](https://docs.docker.com/compose/install/) (included in Docker Desktop)
- At least 2GB of available RAM (4GB recommended for fullstack)

### Three Deployment Tiers

| Tier           | Description                       | Transactions | Vector Search | Text Search | Auto-Embedding  |
| -------------- | --------------------------------- | :----------: | :-----------: | :---------: | :-------------: |
| **standalone** | Single mongod, simplest setup     |      No      |      No       | $text only  |       No        |
| **replicaset** | Single-node replica set with auth |     Yes      |      No       | $text only  |       No        |
| **fullstack**  | mongod + mongot (search engine)   |     Yes      |      Yes      |   $search   | Yes (Voyage AI) |

## Quick Start

### Option 1: Use the start script (recommended)

```bash
# Full stack (recommended) - transactions + vector search + auto-embedding
./docker/mongodb/start.sh fullstack

# Replica set only - transactions + $text search
./docker/mongodb/start.sh replicaset

# Standalone - simplest, no transactions or search
./docker/mongodb/start.sh standalone

# Stop all services
./docker/mongodb/start.sh stop

# Stop and remove all data (WARNING: destructive)
./docker/mongodb/start.sh clean
```

### Option 2: Use docker compose directly

```bash
# Full stack
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile setup run --rm setup-generator
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile fullstack up -d

# Replica set
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile setup run --rm setup-generator
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile replicaset up -d

# Standalone
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile standalone up -d
```

## Connection Strings

| Tier       | Connection String                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| standalone | `mongodb://localhost:27017/memongo`                                                                   |
| replicaset | `mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true` |
| fullstack  | `mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true` |

## Environment Variables

| Variable                             | Default                                  | Description                                   |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------- |
| `ADMIN_PASSWORD`                     | `admin`                                  | Root admin password                           |
| `MONGOT_PASSWORD`                    | `mongotPassword`                         | Password for mongot search coordinator        |
| `MONGODB_PORT`                       | `27017`                                  | MongoDB port mapping                          |
| `MONGOT_GRPC_PORT`                   | `27028`                                  | mongot gRPC port (fullstack only)             |
| `MONGOT_HEALTH_PORT`                 | `8080`                                   | mongot health check port (fullstack only)     |
| `MONGOT_METRICS_PORT`                | `9946`                                   | mongot metrics port (fullstack only)          |
| `VOYAGE_API_KEY`                     | _(empty)_                               | Shared Atlas Model API key (`al-...`) for query + indexing |
| `VOYAGE_API_QUERY_KEY`               | _(empty)_                               | Optional Atlas Model API key (`al-...`) for query-time embedding |
| `VOYAGE_API_INDEXING_KEY`            | _(empty)_                               | Optional Atlas Model API key (`al-...`) for indexing-time embedding |
| `MONGOT_EMBEDDING_PROVIDER_ENDPOINT` | `https://ai.mongodb.com/v1/embeddings` | MongoDB Atlas Embedding API endpoint          |

### Custom Passwords

```bash
ADMIN_PASSWORD=mySecurePass MONGOT_PASSWORD=mongotPass ./docker/mongodb/start.sh fullstack
```

## Auto-Embedding with Voyage AI

To enable server-side automatic embeddings (no application-level embedding code needed):

1. Provision an Atlas Model API key for Voyage-backed MongoDB auto-embedding.
   Use an `al-...` key from Atlas. Direct Voyage `pa-...` keys are for the
   legacy/direct Voyage API and do not authenticate MongoDB auto-embed.
2. Set the environment variable before starting:
   ```bash
   export VOYAGE_API_KEY=al-your-atlas-model-api-key
   ./docker/mongodb/start-preview.sh
   ```
3. The preview container enables the auto-embed path when the key is present at startup.

Use the multi-container stack below only if you specifically need separate mongod/mongot orchestration.

## Architecture

### Standalone

```
[Memongo] --> [mongod-standalone:27017]
```

### Replica Set

```
[Memongo] --> [mongod:27017 (rs0)]
                 |-- auth via keyfile
```

### Full Stack

```
[Memongo] --> [mongod:27017 (rs0)]
                 |-- auth via keyfile
                 |-- gRPC --> [mongot:27028]
                               |-- sync from mongod
                               |-- health: 8080
                               |-- metrics: 9946
```

## Troubleshooting

### mongod fails to start

**Symptom:** Container exits immediately or health check fails.

**Fix:**

```bash
# Check logs
docker logs memongo-mongod

# Common issue: keyfile permissions
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile setup run --rm setup-generator
```

### Preview container exits after recreating it (replica set name mismatch)

**Symptom:** After `docker rm` + re-create of `memongo-preview` while keeping
the existing data volume, the container reaches `healthy` briefly and then
exits with `panic: error checking mongot: mongot health check ... context
deadline exceeded`. `mongod` is running but no mongot process exists, and
`replSetGetStatus` returns `InvalidReplicaSetConfig`.

**Cause:** `mongodb-atlas-local` derives the replica set name from the
container hostname, which Docker defaults to the container ID. Recreating the
container changes that name, so it no longer matches the replica set config
persisted in the `/data/db` volume. mongod cannot become primary, mongot never
starts, and the supervisor panics on its health check.

**Fix:** pin the hostname to the replica set name already in the volume.

```bash
# 1. Read the persisted name (start a standalone mongod on the volume)
docker run --rm -d --name rs-probe -v mongodb_memongo_preview_data:/data/db \
  -p 27021:27017 --entrypoint mongod mongodb/mongodb-atlas-local:preview \
  --dbpath /data/db --bind_ip_all
mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet \
  --eval 'db.getSiblingDB("local").system.replset.findOne()._id'
docker rm -f rs-probe

# 2. Recreate with that name as the hostname
docker run -d --name memongo-preview --hostname <THAT_NAME> -p 27019:27017 \
  -e VOYAGE_API_KEY=al-... -e MONGODB_ATLAS_TELEMETRY_ENABLE=false \
  -v mongodb_memongo_preview_data:/data/db \
  -v mongodb_memongo_preview_config:/data/configdb \
  mongodb/mongodb-atlas-local:preview
```

Alternatively, discard the volume (`start-preview.sh clean`) and let the new
container initialise its own replica set. Set `hostname:` in the compose file
if you intend to recreate the container repeatedly against one volume.

### Auto-embedding indexes stay PENDING and mongot eventually dies

**Symptom:** Vector indexes never reach `queryable`, mongot logs repeat
`Concurrent initial sync limit for embedding indexes reached`, and the
container later fails its health check.

**Cause:** an invalid `VOYAGE_API_KEY`. Every embedding call returns 403, so
no auto-embedding index can finish its initial sync. mongot syncs embedding
indexes one at a time, so the queue never drains and the backlog grows until
the health check times out.

**Fix:** verify the key before starting the container. A `401` means no
credential was sent; a `403` means the key is recognised but denied — revoked,
disabled, or the Atlas org has no model credits.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ai.mongodb.com/v1/embeddings \
  -H "Authorization: Bearer $VOYAGE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"voyage-4-large","input":["hi"]}'
```

`200` is the only healthy answer. Keys must be Atlas Model keys (`al-...`):
the preview image routes embeddings through `ai.mongodb.com`, so direct Voyage
keys (`pa-...`) are rejected.

### mongot fails to start

**Symptom:** mongot container keeps restarting.

**Fix:**

```bash
# Check logs
docker logs memongo-mongot

# mongot depends on mongod being healthy first
# Wait for mongod health check to pass, then mongot starts automatically
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile fullstack ps
```

### Connection refused

**Symptom:** Memongo cannot connect to MongoDB.

**Fix:**

```bash
# Verify services are running
docker compose -f docker/mongodb/docker-compose.mongodb.yml --profile fullstack ps

# Test connection manually
docker exec memongo-mongod mongosh --eval "db.adminCommand('ping')"

# Check port mapping
docker port memongo-mongod
```

### Auth errors

**Symptom:** Authentication failed when connecting.

**Fix:**

- Standalone tier has no auth (no password needed)
- Replicaset/fullstack use `admin:admin` by default (or your `ADMIN_PASSWORD`)
- Ensure `authSource=admin` is in your connection string

### mongot search indexes not working

**Symptom:** `$vectorSearch` or `$search` returns errors.

**Fix:**

```bash
# Verify mongot is healthy
docker exec memongo-mongot wget -qO- http://localhost:9946/metrics | head -5

# Check mongot sync status
docker logs memongo-mongot | tail -20
```

## Upgrading Between Tiers

### Standalone to Replica Set

```bash
# Stop standalone
./docker/mongodb/start.sh stop

# Start replica set (uses different data volume)
./docker/mongodb/start.sh replicaset
```

Note: Data does not migrate between tiers (different volumes). Export/import if needed.

### Replica Set to Full Stack

```bash
# Stop replica set
./docker/mongodb/start.sh stop

# Start full stack (adds mongot, same mongod data)
./docker/mongodb/start.sh fullstack
```

Replica set and full stack share the same mongod data volume, so your data is preserved.

## Data Persistence

Data is stored in Docker named volumes:

| Volume                   | Used By               | Description                     |
| ------------------------ | --------------------- | ------------------------------- |
| `mongod_standalone_data` | standalone            | Standalone MongoDB data         |
| `mongod_data`            | replicaset, fullstack | Replica set MongoDB data        |
| `mongod_configdb`        | replicaset, fullstack | MongoDB config                  |
| `mongot_data`            | fullstack             | mongot search index data        |
| `auth-files`             | replicaset, fullstack | Generated keyfile and passwords |

To completely remove all data:

```bash
./docker/mongodb/start.sh clean
```

## Ports Reference

| Port  | Service | Protocol | Description           |
| ----- | ------- | -------- | --------------------- |
| 27017 | mongod  | TCP      | MongoDB wire protocol |
| 27028 | mongot  | gRPC     | Search coordination   |
| 8080  | mongot  | HTTP     | Health check endpoint |
| 9946  | mongot  | HTTP     | Prometheus metrics    |

## Running e2e against MongoDB Atlas instead of the local container

The local `atlas-local` image runs mongod **and** mongot (a JVM) in one
container. On a Docker Desktop VM sized at the 2 GB default it idles at ~966 MB
— roughly half the VM — and the e2e suite's index builds and vector fan-out push
it past the limit. The container is then OOM-killed (`exit 137`), and the run
reports connection-refused failures plus a large number of *skipped* tests,
which reads like a code failure but is not one.

If you see `ECONNREFUSED 127.0.0.1:27019`, or a run where most tests are
skipped, check this first:

```bash
docker inspect memongo-preview --format '{{.State.ExitCode}}'   # 137 = OOM
docker info --format '{{.MemTotal}}'                            # VM memory
```

Give the Docker VM at least 8 GB and 4 CPUs (Settings → Resources), or run the
suite against Atlas.

### Pointing the suite at Atlas

```bash
MONGODB_TEST_URI='mongodb+srv://<user>:<pass>@<cluster>/?appName=memongo' \
  bun run --filter @memongo/memory-engine test:e2e
```

Two things the cluster must provide, both verified by probing rather than
assumed:

- **`dbAdminAnyDatabase` on the database user.** The suites create randomized
  databases and drop them in `afterAll`. `readWriteAnyDatabase` alone cannot run
  `dropDatabase`, so every run silently leaves its database behind and the
  cluster accumulates garbage between runs.
- **A tier that is not search-index capped.** The engine creates up to 14 Search
  indexes per prefix. Confirm headroom by creating several on a scratch
  collection before committing to a long run.

Atlas builds search indexes far more slowly than the local container — an
autoEmbed index took ~50s to reach READY versus near-instant locally — so a full
e2e run takes considerably longer. The tradeoff is worth it for one reason:
autoEmbed genuinely works there. Locally, with no Voyage key on the container,
mongot reports `CanonicalModel: voyage-4-large not registered yet, supported
models are: []`, so every autoEmbed index fails and the vector paths are never
really exercised.
