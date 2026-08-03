#!/bin/bash
# rs-init.sh - one-shot replica set initiator for the Memongo community stack.
#
# mongod.conf sets replSetName rs0, but nothing else initiates the set:
# without rs.initiate there is no primary, no oplog (mongot cannot sync),
# no transactions, and no change streams. This script runs once per `up`
# (restart: "no") and is idempotent: an already-initialized set is success.
#
# Requires: ADMIN_PASSWORD (root user is always `admin`).
set -e

: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"

RS_HOST="memongo-mongod.memongo-net:27017"

for attempt in $(seq 1 30); do
  STATUS=$(mongosh --quiet \
    --host "$RS_HOST" \
    -u admin -p "$ADMIN_PASSWORD" --authenticationDatabase admin \
    --eval 'try { rs.status().ok } catch (e) { e.codeName || "ERR" }' 2>/dev/null | tail -1 || true)

  if [ "$STATUS" = "1" ]; then
    echo "Replica set rs0 already initialized"
    exit 0
  fi

  echo "Attempt $attempt: initiating replica set rs0 on $RS_HOST..."
  if mongosh --quiet \
    --host "$RS_HOST" \
    -u admin -p "$ADMIN_PASSWORD" --authenticationDatabase admin \
    --eval 'rs.initiate({_id: "rs0", members: [{_id: 0, host: "memongo-mongod.memongo-net:27017"}]})'; then
    echo "Replica set rs0 initiated"
    exit 0
  fi

  sleep 2
done

echo "ERROR: failed to initiate replica set rs0 after 30 attempts" >&2
exit 1
