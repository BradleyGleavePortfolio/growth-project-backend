#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Fly release_command — runs once per deploy in a one-off VM with full env.
#
# CONTRACT
# ────────
#   • Apply every pending Prisma migration to the production database before
#     the new application image is rolled out.
#   • Either succeed visibly (exit 0, "ALL_APPLIED=<n>" log line) or fail
#     visibly (exit non-zero, with the offending migration and Prisma's own
#     error in the log). There is no silent path. Ever.
#   • Idempotent — re-running this script must be a no-op if no new
#     migrations have been added.
#
# WHY THIS FILE IS THE WAY IT IS
# ──────────────────────────────
# A previous version of this script used:
#
#     if npx prisma migrate deploy 2>&1 | tee "$LOG"; then ...
#
# Because Bash pipelines return the exit code of the LAST command (tee)
# and `pipefail` was not set, `prisma migrate deploy` could fail with
# auth errors, drift errors, or syntax errors — and the wrapper would
# happily report success. Production drifted ~25 migrations behind
# without any deploy ever turning red. That is the kind of failure mode
# this script is explicitly designed to make impossible.
#
# Every shell-safety flag below is load-bearing. Do not remove them.
#
# OPERATOR REFERENCE
# ──────────────────
# • Logs from this script are captured by Fly's release_command machine and
#   visible via `fly logs -a backend-spring-lake-3890` (filter by the
#   release machine ID printed in the deploy output).
# • To dry-run locally:
#       DATABASE_URL=...  DIRECT_URL=...  bash scripts/release.sh
# • See docs/deploy-runbook.md §9 for the full release contract.
# ─────────────────────────────────────────────────────────────────────────────

set -Eeuo pipefail
# -E  : ERR trap inherited by functions/subshells/command substitutions.
# -e  : exit on any unhandled non-zero exit code.
# -u  : treat unset variables as errors (catches typos in env var names).
# -o pipefail : a pipeline's exit code is the FIRST non-zero in the chain,
#               not just the last command's. Without this, `cmd | tee log`
#               masks a failed `cmd`. This single flag is why this script
#               exists.

# Print a structured banner so future log readers can locate this run quickly.
RELEASE_ID="${FLY_MACHINE_ID:-local-$(date +%s)}"
echo "[release] ────────────────────────────────────────────────────────────"
echo "[release] starting release_command"
echo "[release]   machine_id   = ${RELEASE_ID}"
echo "[release]   git_sha      = ${GIT_SHA:-unknown}"
echo "[release]   release_ver  = ${RELEASE_VERSION:-unknown}"
echo "[release]   node_version = $(node -v 2>/dev/null || echo 'node missing')"
echo "[release]   prisma_cli   = $(npx --no-install prisma --version 2>/dev/null | head -1 || echo 'prisma cli missing')"
echo "[release] ────────────────────────────────────────────────────────────"

# Centralized failure reporter — fires on any unexpected exit so we never get
# a green light from a half-finished release. Echoes the failing line + the
# captured command output, then re-exits with the original status.
on_error() {
  local exit_code=$?
  # Guard 1 (clean exit): the EXIT trap fires on ALL exits, including successful
  # ones. Skip the failure banner when the script completed normally.
  # Non-zero exit (error, SIGTERM, SIGINT, OOM kill) falls through.
  # (Finding 9 — MEDIUM, audit 2026-05-19)
  [[ ${exit_code} -eq 0 ]] && return 0
  # Guard 2 (single-fire): on an ordinary command error, ERR fires first and
  # calls on_error; that on_error then calls `exit ${exit_code}`, which triggers
  # the EXIT trap, which calls on_error a second time with the same non-zero
  # code. Without this guard we print duplicate failure banners and the second
  # invocation's ${LINENO} is the EXIT trap context, not the original failing
  # command — obscuring the real failure site.
  [[ "${ERROR_REPORTED:-0}" == "1" ]] && return 0
  ERROR_REPORTED=1
  local line=${1:-?}
  echo "[release] ❌ FAIL at line ${line} (exit=${exit_code})"
  if [[ -f /tmp/prisma_migrate.log ]]; then
    echo "[release] ─── last prisma output ─────────────────────────────────"
    tail -n 60 /tmp/prisma_migrate.log || true
    echo "[release] ────────────────────────────────────────────────────────"
  fi
  echo "[release] Deploy ABORTED. Existing machines on Fly are unaffected."
  echo "[release] See docs/deploy-runbook.md §9 for recovery."
  exit "${exit_code}"
}
trap 'on_error ${LINENO}' ERR
trap 'on_error ${LINENO}' EXIT  # catches SIGTERM, SIGINT, OOM kills (Finding 9)

# Sanity-check the env the migration tool needs. We fail fast and loudly
# rather than letting Prisma emit a confusing P1001/P1012 error.
require_env() {
  local var=$1
  if [[ -z "${!var:-}" ]]; then
    echo "[release] missing required env var: ${var}"
    echo "[release] set it with: fly secrets set ${var}=... -a <app>"
    exit 1
  fi
}
require_env DATABASE_URL
# DIRECT_URL is what `prisma migrate deploy` actually uses (it bypasses the
# connection pooler). Required if schema.prisma declares `directUrl`.
require_env DIRECT_URL

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Count pending migrations BEFORE applying.
#
# `prisma migrate status` exits 0 when up-to-date, exit 1 when migrations
# are pending OR the DB is drifted/un-baselined. We treat exit 1 here as
# "interesting" and inspect the output, instead of letting the script fail.
# ─────────────────────────────────────────────────────────────────────────────
echo "[release] step 1: checking migration status..."
STATUS_LOG=/tmp/prisma_status.log
# Use `|| true` so set -e doesn't kill us before we inspect the output;
# pipefail is fine here because tee always succeeds last.
npx prisma migrate status 2>&1 | tee "${STATUS_LOG}" || true

# Prisma 5 lists pending migrations with an ASCII dash (-), NOT the Unicode
# bullet (•, U+2022) that was used in Prisma 4 and earlier. Using the bullet
# always matched 0 lines. (Finding 4 — HIGH, audit 2026-05-19)
# Any non-whitespace token follows the dash — migration names may contain
# underscores, digits, letters, or hyphens. [^[:space:]]+ matches all of them.
# (re-audit followup A)
PENDING_COUNT=$(
  grep -cE '^[[:space:]]+-[[:space:]]+[^[:space:]]+$' "${STATUS_LOG}" \
    || echo 0
)
echo "[release]   pending_migrations_detected = ${PENDING_COUNT}"

# If the DB is fundamentally not baselined (P3005, schema not empty), abort
# with a clear operator message instead of silently `db push --accept-data-loss`.
# That fallback existed in a previous version of this script and is now
# explicitly removed — accept-data-loss against a populated production DB
# is never a routine action.
if grep -qE "P3005|database schema is not empty|is not managed by Prisma Migrate" "${STATUS_LOG}"; then
  echo "[release] DB is not baselined for Prisma Migrate (P3005)."
  echo "[release] This is a one-time operator task — do NOT auto-resolve from CI."
  echo "[release] See docs/deploy-runbook.md §9.2 for the baseline runbook."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Apply pending migrations.
#
# `prisma migrate deploy` is the production-safe path: it never resets the
# database, never generates new migrations, and exits non-zero on the first
# failure. With pipefail set, a failure in `prisma` propagates through `tee`.
# ─────────────────────────────────────────────────────────────────────────────
echo "[release] step 2: applying pending migrations (prisma migrate deploy)..."
LOG=/tmp/prisma_migrate.log
npx prisma migrate deploy 2>&1 | tee "${LOG}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Verify post-state. Belt-and-braces: even if `migrate deploy`
# claimed success, re-check `migrate status` and require it to report
# "Database schema is up to date!" before this script is allowed to exit 0.
# ─────────────────────────────────────────────────────────────────────────────
echo "[release] step 3: verifying database is up-to-date..."
VERIFY_LOG=/tmp/prisma_verify.log
if ! npx prisma migrate status 2>&1 | tee "${VERIFY_LOG}"; then
  echo "[release] migrate status returned non-zero AFTER migrate deploy."
  echo "[release] Refusing to mark this release green."
  exit 1
fi

if ! grep -qE "Database schema is up to date|No pending migrations" "${VERIFY_LOG}"; then
  echo "[release] migrate status did not confirm 'up to date' after deploy."
  echo "[release] Refusing to mark this release green."
  exit 1
fi

# Count successfully applied (rolled_back_at IS NULL) rows in _prisma_migrations
# so the log emits a single grep-able line for monitoring/observability.
#
# Write raw output to a temp file so stderr is captured in the release log
# without polluting the metric value. Using a command substitution with 2>&1
# feeds stderr into awk/the variable; warnings appear inside APPLIED_COUNT,
# corrupting ALL_APPLIED= into a multi-line string. The temp-file approach
# keeps the metric clean and lets us emit warnings to stdout separately.
# (Finding 7 — MEDIUM, audit 2026-05-19; re-audit blocker 3)
APPLIED_TMP=$(mktemp)
if npx prisma db execute --stdin <<'SQL' >"${APPLIED_TMP}" 2>&1
SELECT COUNT(*) FROM _prisma_migrations WHERE rolled_back_at IS NULL;
SQL
then
  APPLIED_COUNT=$(awk '/^[[:space:]]*[0-9]+/ { print $1; exit }' "${APPLIED_TMP}")
  if [[ -z "${APPLIED_COUNT}" ]]; then
    echo "[release] WARNING: could not parse applied count from prisma output:"
    sed 's/^/[release]   /' "${APPLIED_TMP}"
    APPLIED_COUNT="unknown"
  fi
else
  echo "[release] WARNING: prisma db execute failed querying _prisma_migrations:"
  sed 's/^/[release]   /' "${APPLIED_TMP}"
  APPLIED_COUNT="unknown"
fi
rm -f "${APPLIED_TMP}"

echo "[release] ────────────────────────────────────────────────────────────"
echo "[release] ✔ release_command completed successfully"
echo "[release]   ALL_APPLIED=${APPLIED_COUNT}"
echo "[release]   pending_before=${PENDING_COUNT}"
echo "[release]   release_id=${RELEASE_ID}"
echo "[release] ────────────────────────────────────────────────────────────"
exit 0
