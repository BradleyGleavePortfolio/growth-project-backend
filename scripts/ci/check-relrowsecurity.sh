#!/usr/bin/env bash
# scripts/ci/check-relrowsecurity.sh
#
# PR-RLS-01 — Long-term safety net for the Cycle B Supabase RLS work.
#
# Queries pg_class for every regular table in the public schema and lists any
# whose relrowsecurity flag is false. Prints the list, then exits with status
# determined by RLS_ENFORCEMENT_FULL:
#
#   RLS_ENFORCEMENT_FULL=on  -> exit 1 if any row is returned (hard gate).
#   anything else            -> exit 0 (soft report; print count + list).
#
# The soft mode is the default until PR-RLS-08 ships, because PR-RLS-01..07
# leave the 50-table gap partially open. After PR-RLS-08 merges and the
# advisor returns zero rls_disabled_in_public lints, flip the CI workflow to
# export RLS_ENFORCEMENT_FULL=on to lock the floor at zero forever.
#
# Required env: DATABASE_URL (Postgres connection string with read access to
# pg_class in the target schema).
#
# Requires: psql client in PATH.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[check-relrowsecurity] DATABASE_URL is not set; skipping (set DATABASE_URL to run)." >&2
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[check-relrowsecurity] psql client not found in PATH; skipping." >&2
  exit 0
fi

QUERY='SELECT n.nspname || '"'"'.'"'"' || c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind = '"'"'r'"'"'
  AND n.nspname = '"'"'public'"'"'
  AND NOT c.relrowsecurity
ORDER BY 1;'

# -A unaligned, -t tuples-only, -X no psqlrc, ON_ERROR_STOP for safety.
ROWS=$(PSQL_PAGER= psql "$DATABASE_URL" -XAtv ON_ERROR_STOP=1 -c "$QUERY")

COUNT=0
if [ -n "$ROWS" ]; then
  COUNT=$(printf '%s\n' "$ROWS" | grep -c .)
fi

echo "[check-relrowsecurity] tables in public.* without RLS enabled: ${COUNT}"
if [ "${COUNT}" -gt 0 ]; then
  echo "----- begin table list -----"
  printf '%s\n' "$ROWS"
  echo "----- end table list -----"
fi

if [ "${RLS_ENFORCEMENT_FULL:-off}" = "on" ]; then
  if [ "${COUNT}" -gt 0 ]; then
    echo "[check-relrowsecurity] RLS_ENFORCEMENT_FULL=on and ${COUNT} table(s) lack RLS -> failing build." >&2
    exit 1
  fi
  echo "[check-relrowsecurity] RLS_ENFORCEMENT_FULL=on and floor is zero. OK."
  exit 0
fi

echo "[check-relrowsecurity] soft mode (RLS_ENFORCEMENT_FULL is not 'on'); not failing build."
echo "[check-relrowsecurity] To enforce zero, export RLS_ENFORCEMENT_FULL=on in the CI workflow."
exit 0
