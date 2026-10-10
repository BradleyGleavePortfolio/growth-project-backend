#!/usr/bin/env bash
# scripts/ci/replay-migrations.sh <database>
#
# D5: build <database> on the local CI Postgres from EMPTY the way a new
# Supabase project would get it: the Supabase shim (roles, auth.uid/jwt/role,
# default privileges that grant every new public table to anon/authenticated/
# service_role), then `prisma migrate deploy` over the whole migration chain.
# The loose prisma/migrations/*.sql files are NOT applied; only migration
# directories are. CI only: refuses any URL but the local service container
# (scripts/ci/local-db-url.mjs) and drops libpq's routing variables.
set -euo pipefail
DB="${1:?usage: replay-migrations.sh <database>}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "[replay] bad database name" >&2; exit 1; }
ADMIN_URL="${RLS_ADMIN_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
unset PGHOST PGHOSTADDR PGSERVICE
node scripts/ci/local-db-url.mjs "$ADMIN_URL" RLS_ADMIN_DATABASE_URL
TARGET_URL="$(node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];console.log(u.toString())' "$ADMIN_URL" "$DB")"
psql "$ADMIN_URL" -XAtq -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\""
psql "$TARGET_URL" -XAtq -v ON_ERROR_STOP=1 -f scripts/ci/supabase-shim.sql
DATABASE_URL="$TARGET_URL" DIRECT_URL="$TARGET_URL" npx prisma migrate deploy
APPLIED="$(psql "$TARGET_URL" -XAtq -c 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
ON_DISK="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
echo "[replay] $DB: $APPLIED of $ON_DISK migration directories applied from empty"
if [ "$ON_DISK" -eq 0 ] || [ "$APPLIED" != "$ON_DISK" ]; then echo "[replay] chain incomplete" >&2; exit 1; fi
