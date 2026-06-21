#!/usr/bin/env bash
set -euo pipefail

# _bench/freshdb.sh <id>
# Creates a fresh Postgres database and runs migrations.
# Outputs the connection URL to stdout.
# ID can be e.g. RG01 or rg01 (lowercased automatically for Postgres compatibility).

ID="${1:?Usage: freshdb.sh <id>}"
# Postgres folds unquoted identifiers to lowercase, so use lc throughout
LC_ID="$(echo "${ID}" | tr '[:upper:]' '[:lower:]')"
DB_NAME="forge_${LC_ID}"
PG_URL="postgres://forge:forge@localhost:54329"
FULL_URL="${PG_URL}/${DB_NAME}"

echo "=== freshdb: creating database ${DB_NAME} ===" >&2

# Drop if exists (idempotent), then create
PGPASSWORD=forge psql -h localhost -p 54329 -U forge -d postgres \
  -c "DROP DATABASE IF EXISTS ${DB_NAME};" 2>/dev/null || true
PGPASSWORD=forge psql -h localhost -p 54329 -U forge -d postgres \
  -c "CREATE DATABASE ${DB_NAME};"

# Short sleep to let Postgres commit the create
sleep 0.5

# Run migrations against the fresh database
FORGE_DATABASE_URL="${FULL_URL}" \
  node "$(dirname "$0")/../packages/forge-cli/dist/cli.js" state migrate

echo "${FULL_URL}"
