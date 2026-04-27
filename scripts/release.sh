#!/usr/bin/env sh
# Fly release_command — runs once per deploy in a one-off VM with full env.
#
# Behavior:
#  1. Try `prisma migrate deploy` (the proper, safe path once the DB is
#     migration-managed).
#  2. If that fails specifically because the DB isn't migration-managed yet
#     (P3005 / "database schema is not empty" / "is not managed by Prisma
#     Migrate" / "No migration found"), fall back to `prisma db push
#     --accept-data-loss` to forward-sync today's schema. `--accept-data-loss`
#     was originally documented as safe because the production DB had fewer
#     than 5 rows of test data (verified 2026-04-25). That is a one-time
#     condition — once real data lands, the fallback is dangerous.
#
#     Two non-destructive guards now protect this path:
#       a) RELEASE_ALLOW_DB_PUSH=1 must be explicitly set, so the data-loss
#          branch never runs by accident on a routine deploy.
#       b) If the database already contains a `_prisma_migrations` table
#          we *abort* rather than push — a populated migrations table means
#          baselining has already happened and a fresh db push would silently
#          drop the migration history.
#
#  3. If migrate deploy fails for any other reason, exit non-zero so Fly
#     aborts the deploy and existing machines keep running.
set -e

echo "[release] attempting prisma migrate deploy..."

LOG=/tmp/prisma_migrate.log
if npx prisma migrate deploy 2>&1 | tee "$LOG"; then
  echo "[release] migrate deploy succeeded"
  exit 0
fi

if grep -qE "P3005|database schema is not empty|is not managed by Prisma Migrate|No migration found in prisma/migrations" "$LOG"; then
  if [ "${RELEASE_ALLOW_DB_PUSH:-0}" != "1" ]; then
    echo "[release] DB needs a baseline (P3005) but RELEASE_ALLOW_DB_PUSH is not set."
    echo "[release] Refusing to run 'prisma db push --accept-data-loss' implicitly."
    echo "[release] Operator action: either"
    echo "          1) baseline the DB locally (prisma migrate resolve / generate baseline migration), or"
    echo "          2) re-deploy with RELEASE_ALLOW_DB_PUSH=1 set as a Fly secret"
    echo "             (only when you have a fresh backup AND know the DB is empty/test data)."
    exit 1
  fi

  echo "[release] checking for existing _prisma_migrations table before db push..."
  HAS_MIGRATIONS=$(npx prisma db execute --stdin <<'SQL' 2>/dev/null || echo ""
SELECT to_regclass('public._prisma_migrations');
SQL
  )
  if echo "$HAS_MIGRATIONS" | grep -q "_prisma_migrations"; then
    echo "[release] _prisma_migrations table exists — refusing to run db push (it would orphan the migration history)."
    echo "[release] Operator action: investigate why migrate deploy failed against a baselined DB and resolve it manually."
    exit 1
  fi

  echo "[release] DB is not migration-managed yet — forward-syncing schema with db push"
  echo "[release] WARNING: --accept-data-loss is enabled. This is only safe on an empty/test DB."
  npx prisma db push --accept-data-loss --skip-generate
  echo "[release] schema pushed; future deploys will use migrate deploy once a baseline migration is added"
  exit 0
fi

echo "[release] migrate deploy failed for a non-baseline reason — aborting"
exit 1
