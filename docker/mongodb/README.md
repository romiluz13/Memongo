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
