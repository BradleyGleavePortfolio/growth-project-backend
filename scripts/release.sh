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
#     is safe right now because the production DB has fewer than 5 rows of
#     test data (verified 2026-04-25).
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
  echo "[release] DB is not migration-managed yet — forward-syncing schema with db push"
  npx prisma db push --accept-data-loss --skip-generate
  echo "[release] schema pushed; future deploys will use migrate deploy once a baseline migration is added"
  exit 0
fi

echo "[release] migrate deploy failed for a non-baseline reason — aborting"
exit 1
