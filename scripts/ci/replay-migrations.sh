#!/usr/bin/env bash
# scripts/ci/replay-migrations.sh <database>
#
# D5: build <database> on the local CI Postgres from EMPTY the way a new
# Supabase project would get it: the Supabase shim (roles, auth.uid/jwt/role,
# default privileges that grant every new public table to anon/authenticated/
# service_role), then `prisma migrate deploy` over the whole migration chain.
# The loose prisma/migrations/*.sql files are NOT applied; only migration
# directories are. CI only: refuses any host but the local service container.
set -euo pipefail
DB="${1:?usage: replay-migrations.sh <database>}"
ADMIN_URL="${RLS_ADMIN_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
case "$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$ADMIN_URL")" in
  localhost|127.0.0.1|postgres) ;;
  *) echo "[replay] refusing a non-local database host" >&2; exit 1 ;;
esac
TARGET_URL="$(node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];console.log(u.toString())' "$ADMIN_URL" "$DB")"
psql "$ADMIN_URL" -XAtq -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\""
psql "$TARGET_URL" -XAtq -v ON_ERROR_STOP=1 -f scripts/ci/supabase-shim.sql
DATABASE_URL="$TARGET_URL" DIRECT_URL="$TARGET_URL" npx prisma migrate deploy
APPLIED="$(psql "$TARGET_URL" -XAtq -c 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
ON_DISK="$(find prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | wc -l | tr -d ' ')"
echo "[replay] $DB: $APPLIED of $ON_DISK migrations applied from empty"
[ "$APPLIED" = "$ON_DISK" ] || { echo "[replay] chain incomplete" >&2; exit 1; }
