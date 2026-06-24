#!/bin/bash
# Memongo MongoDB Quick Start
# Usage:
#   ./docker/mongodb/start.sh standalone    # Simplest, no transactions/search
#   ./docker/mongodb/start.sh replicaset    # Transactions, $text search
#   ./docker/mongodb/start.sh fullstack     # Transactions + vector search + auto-embedding
#   ./docker/mongodb/start.sh stop          # Stop all services
#   ./docker/mongodb/start.sh clean         # Stop and remove all data

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.mongodb.yml"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

case "${1:-fullstack}" in
  standalone)
    echo -e "${GREEN}Starting MongoDB (standalone mode)...${NC}"
    echo -e "${YELLOW}Note: No transactions or vector search in standalone mode.${NC}"
    docker compose -f "$COMPOSE_FILE" --profile standalone up -d
    echo ""
    echo -e "${GREEN}MongoDB is starting on port ${MONGODB_PORT:-27017}${NC}"
    echo "Connection string: mongodb://localhost:${MONGODB_PORT:-27017}"
    echo ""
    echo "Features available:"
    echo "  - Basic CRUD operations"
    echo "  - \$text keyword search"
    echo "  - NO transactions (withTransaction will fall back to sequential writes)"
    echo "  - NO vector search (\$vectorSearch not available)"
    ;;

  replicaset)
    echo -e "${GREEN}Starting MongoDB (replica set mode)...${NC}"
    # Run setup first for auth files
    echo "Running setup (generates keyfile + auth files)..."
    docker compose -f "$COMPOSE_FILE" --profile setup run --rm setup-generator
    docker compose -f "$COMPOSE_FILE" --profile replicaset up -d
    echo ""
    echo -e "${GREEN}MongoDB replica set is starting on port ${MONGODB_PORT:-27017}${NC}"
    echo "Connection string: mongodb://admin:${ADMIN_PASSWORD:-admin}@localhost:${MONGODB_PORT:-27017}/memongo?authSource=admin&replicaSet=rs0&directConnection=true"
    echo ""
    echo "Features available:"
    echo "  - ACID transactions (withTransaction)"
    echo "  - \$text keyword search"
    echo "  - Change streams"
    echo "  - NO vector search (requires fullstack profile with mongot)"
    ;;

  fullstack)
    echo -e "${GREEN}Starting MongoDB (full stack: mongod + mongot)...${NC}"
    # Run setup first for auth files
    echo "Running setup (generates keyfile + auth files)..."
    docker compose -f "$COMPOSE_FILE" --profile setup run --rm setup-generator
    docker compose -f "$COMPOSE_FILE" --profile fullstack up -d
    echo "Restarting mongot to reload regenerated runtime config..."
    docker compose -f "$COMPOSE_FILE" --profile fullstack restart mongot
    echo ""
    echo -e "${GREEN}MongoDB full stack is starting...${NC}"
    echo "  mongod: port ${MONGODB_PORT:-27017}"
    echo "  mongot: gRPC port ${MONGOT_GRPC_PORT:-27028}, health port ${MONGOT_HEALTH_PORT:-8080}"
    echo ""
    echo "Connection string: mongodb://admin:${ADMIN_PASSWORD:-admin}@localhost:${MONGODB_PORT:-27017}/memongo?authSource=admin&replicaSet=rs0&directConnection=true"
    echo ""
    echo "Features available:"
    echo "  - ACID transactions (withTransaction)"
    echo "  - \$text keyword search"
    echo "  - \$vectorSearch (semantic/vector search)"
    echo "  - \$search with \$rankFusion and \$scoreFusion"
    echo "  - Automated embeddings (when embedding API keys are provided)"
    echo "  - Change streams"
    if [ -n "${VOYAGE_API_KEY:-}" ] || [ -n "${VOYAGE_API_QUERY_KEY:-}" ] || [ -n "${VOYAGE_API_INDEXING_KEY:-}" ]; then
      echo ""
      echo -e "${GREEN}Embedding API key detected - mongot config includes auto-embedding.${NC}"
    else
      echo ""
      echo -e "${YELLOW}For auto-embedding: export VOYAGE_API_KEY=al-your-atlas-model-api-key && ./start.sh fullstack${NC}"
    fi
    ;;

  stop)
    echo "Stopping all Memongo MongoDB services..."
    docker compose -f "$COMPOSE_FILE" --profile standalone --profile replicaset --profile fullstack down
    echo -e "${GREEN}All services stopped.${NC}"
    ;;

  clean)
    echo -e "${RED}Stopping and removing ALL data (volumes)...${NC}"
    read -p "Are you sure? This deletes all MongoDB data. (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      docker compose -f "$COMPOSE_FILE" --profile standalone --profile replicaset --profile fullstack down -v
      echo -e "${GREEN}All services stopped and data removed.${NC}"
    else
      echo "Aborted."
    fi
    ;;

  *)
    echo "Usage: $0 {standalone|replicaset|fullstack|stop|clean}"
    echo ""
    echo "Deployment Tiers:"
    echo "  standalone   - Simplest MongoDB. No transactions, no search."
    echo "  replicaset   - MongoDB replica set. Transactions + \$text search."
    echo "  fullstack    - mongod + mongot. Transactions + vector search + auto-embedding."
    echo ""
    echo "Management:"
    echo "  stop         - Stop all services"
    echo "  clean        - Stop and remove all data (WARNING: destructive)"
    exit 1
    ;;
esac
