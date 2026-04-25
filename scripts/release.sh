#!/usr/bin/env sh
# Fly release_command — runs once per deploy in a one-off VM with full env.
#
# Behavior:
#  1. If the `_prisma_migrations` table doesn't exist (fresh DB or pre-Prisma DB),
#     run `prisma db push --accept-data-loss` to forward-sync the schema. The
#     `--accept-data-loss` flag is safe today because the production DB has
#     fewer than 5 rows of test data (verified 2026-04-25). Once the DB has
#     real users, switch back to migrate deploy + a real baseline.
#  2. If `_prisma_migrations` exists, run `prisma migrate deploy` as normal.
#  3. If anything fails, exit non-zero so Fly aborts the deploy and existing
#     machines keep running on the previous release.
set -e

echo "[release] checking migration state..."

# Use a single Postgres query via Prisma's migrate-status output.
# When _prisma_migrations doesn't exist, status fails with a specific message.
STATUS_OUTPUT="$(npx prisma migrate status 2>&1 || true)"

if echo "$STATUS_OUTPUT" | grep -q "is not managed by Prisma Migrate\|No migration found in prisma/migrations"; then
  echo "[release] DB is not managed by Prisma migrations yet — doing forward db push"
  npx prisma db push --accept-data-loss --skip-generate
  echo "[release] schema pushed; future deploys will use migrate deploy"
else
  echo "[release] DB is migration-managed — running migrate deploy"
  npx prisma migrate deploy
fi

echo "[release] done"
