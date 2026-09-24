#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Fly release_command — runs once per deploy in a one-off VM with full env.
#
# CONTRACT
# ────────
#   • Refuse (before any database contact) unless the catalog-verifier
#     contract is satisfied by this image (step 0).
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
# Prisma 6 prints "Prisma schema loaded from …" before the version table, so
# `head -1` never showed the CLI version. Capture the whole output first (no
# early pipe close / SIGPIPE under pipefail), then pick the `prisma : X.Y.Z`
# row. (S2 B1 finding D3, 2026-09-22)
PRISMA_VERSION_OUT=$(npx --no-install prisma --version 2>/dev/null || true)
PRISMA_CLI_LINE=$(printf '%s\n' "${PRISMA_VERSION_OUT}" | awk '/^prisma[[:space:]]+:[[:space:]]+/ { print "prisma " $3; found=1 } END { if (!found) print "prisma cli missing" }')
echo "[release]   prisma_cli   = ${PRISMA_CLI_LINE}"
echo "[release] ────────────────────────────────────────────────────────────"

# Centralized failure reporter — fires on any unexpected exit so we never get
# a green light from a half-finished release. Echoes the failing line + the
# captured command output, then re-exits with the original status.
# shellcheck disable=SC2317  # body runs only via the ERR/EXIT traps below — shellcheck cannot see the indirect invocation.
on_error() {
  local exit_code=$?
  # Guard 1 (clean exit): the EXIT trap fires on ALL exits, including successful
  # ones. Skip the failure banner when the script completed normally.
  # Non-zero exit (command error, `exit N`, or a child killed by a signal that
  # bash reports as a non-zero status) falls through.
  # Boundary: EXIT runs only if bash itself is still alive to run it. A SIGKILL
  # (e.g. OOM killer) or Fly destroying the release machine ends this process
  # without any trap; the release is then marked failed by Fly (release_command
  # exit status unavailable / non-zero) rather than by this banner. Nothing
  # here can make a killed process report — do not rely on the banner as proof
  # that a failure was observed. (Finding 9 — MEDIUM, audit 2026-05-19)
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
  echo "[release] Deploy ABORTED by release_command. Fly does not roll out the new image."
  echo "[release] Machines keep the previous image; if step 2 (migrate deploy) already ran,"
  echo "[release] the DATABASE may have changed — see docs/deploy-runbook.md §11.4 (stage-specific recovery)."
  exit "${exit_code}"
}
trap 'on_error ${LINENO}' ERR
trap 'on_error ${LINENO}' EXIT  # any exit bash can still process (not SIGKILL/OOM-kill; see boundary note above)

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
# STEP 0 — Catalog-verifier contract preflight. Runs BEFORE any database
# connection so a missing or broken verifier set refuses the release while the
# database is still untouched (S2-R2-A-03: discovery failure must never mean
# "zero verifiers passed").
#
#   • prisma/migrations must be a directory.
#   • Discovery is an explicitly checked pipeline into a list file — never a
#     process-substitution loop over find, whose failure the loop ignores.
#   • scripts/release-required-verifiers.txt (S2-owned runner contract; the
#     verifier CONTENT and grant/role expectations inside verify.sql are S1's)
#     must exist and name at least one migration directory. Each entry must be
#     a bare directory name (no slashes, no `..`, no duplicates) and must
#     resolve to a discovered prisma/migrations/<name>/verify.sql.
#
# This step proves only that the required verifier files are present in THIS
# image before THIS release_command mutates anything. It says nothing about
# production state, other machines, or whether earlier deploys changed the DB.
# ─────────────────────────────────────────────────────────────────────────────
echo "[release] step 0: verifier contract preflight (no database contact)..."
MIGRATIONS_DIR="prisma/migrations"
# Pinned path, deliberately NOT env-overridable: the environment must not be able to
# select a different (weaker) expected-verifier set at release time.
REQUIRED_VERIFIERS_FILE="scripts/release-required-verifiers.txt"
DISCOVERED_LIST=/tmp/release_verifiers_discovered.txt
if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
  echo "[release] ${MIGRATIONS_DIR} is not a directory in this image."
  echo "[release] Refusing to release: verifier discovery impossible."
  exit 1
fi
if ! find "${MIGRATIONS_DIR}" -mindepth 2 -maxdepth 2 -name verify.sql -type f | LC_ALL=C sort >"${DISCOVERED_LIST}"; then
  echo "[release] catalog verifier DISCOVERY FAILED (find/sort returned non-zero)."
  echo "[release] Refusing to release: cannot tell zero verifiers from a broken enumeration."
  exit 1
fi
DISCOVERED_COUNT=$(grep -c . "${DISCOVERED_LIST}" || true)
echo "[release]   verifiers_discovered = ${DISCOVERED_COUNT}"
if [[ ! -f "${REQUIRED_VERIFIERS_FILE}" || ! -r "${REQUIRED_VERIFIERS_FILE}" ]]; then
  echo "[release] required-verifier contract missing/unreadable: ${REQUIRED_VERIFIERS_FILE}"
  echo "[release] Refusing to release: the expected verifier set is not established in this image."
  exit 1
fi
REQUIRED_COUNT=0
REQUIRED_SEEN=" "
while IFS= read -r raw || [[ -n "${raw}" ]]; do
  entry="${raw%%#*}"                       # strip comments
  entry="${entry#"${entry%%[![:blank:]]*}"}" # ltrim spaces/tabs only (CR is NOT trimmed: CRLF is malformed)
  entry="${entry%"${entry##*[![:blank:]]}"}" # rtrim
  [[ -n "${entry}" ]] || continue
  if [[ ! "${entry}" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]*$ ]]; then
    echo "[release] required-verifier entry is not a bare migration directory name: '${entry}'"
    echo "[release] Refusing to release (contract file malformed)."
    exit 1
  fi
  if [[ "${REQUIRED_SEEN}" == *" ${entry} "* ]]; then
    echo "[release] required-verifier entry listed twice: '${entry}'"
    echo "[release] Refusing to release (contract file malformed)."
    exit 1
  fi
  REQUIRED_SEEN="${REQUIRED_SEEN}${entry} "
  REQUIRED_COUNT=$((REQUIRED_COUNT + 1))
  expected_path="${MIGRATIONS_DIR}/${entry}/verify.sql"
  if ! grep -qxF -- "${expected_path}" "${DISCOVERED_LIST}"; then
    echo "[release] REQUIRED catalog verifier missing from this image: ${expected_path}"
    echo "[release] Refusing to release: the integrated candidate is incomplete (S1 migration not composed)."
    exit 1
  fi
  echo "[release]   required verifier present: ${expected_path}"
done <"${REQUIRED_VERIFIERS_FILE}"
if [[ "${REQUIRED_COUNT}" -lt 1 ]]; then
  echo "[release] required-verifier contract lists no verifiers: ${REQUIRED_VERIFIERS_FILE}"
  echo "[release] Refusing to release: an empty expected set is not an established contract."
  exit 1
fi
echo "[release]   verifiers_required = ${REQUIRED_COUNT} (all present)"

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

# Prisma 6.19.3 (pinned) `migrate status` prints, when the database is behind:
#   Following migration(s) have not yet been applied:
#   <name>            ← one bare directory name per line, no dash/bullet/indent
#   <blank line>
# (locked CLI source: `Following migration${…} have not yet been applied:\n${names.join("\n")}\n\n`).
# The previous regex expected the Prisma-5 "  - name" form and always counted
# 0; and `grep -c … || echo 0` emitted a two-line "0\n0" value. Count the
# non-empty lines strictly inside that block with a single awk pass that
# always prints exactly one integer. (S2 B1 finding D1, 2026-09-22)
PENDING_COUNT=$(awk '
  /have not yet been applied:$/ { inblock=1; next }
  inblock && /^[[:space:]]*$/    { inblock=0 }
  inblock && /^[^[:space:]]+$/   { n++ }
  END { print n+0 }' "${STATUS_LOG}")
echo "[release]   pending_migrations_detected = ${PENDING_COUNT}"

# If the DB is fundamentally not baselined (P3005, schema not empty), abort
# with a clear operator message instead of silently `db push --accept-data-loss`.
# That fallback existed in a previous version of this script and is now
# explicitly removed — accept-data-loss against a populated production DB
# is never a routine action.
if grep -qE "P3005|database schema is not empty|is not managed by Prisma Migrate" "${STATUS_LOG}"; then
  echo "[release] DB is not baselined for Prisma Migrate (P3005)."
  echo "[release] This is a one-time operator task — do NOT auto-resolve from CI."
  echo "[release] See docs/deploy-runbook.md §2.1 for the baseline runbook."
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

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Catalog verifiers. `migrate status` answers from _prisma_migrations,
# not from the catalog: DDL reversed out-of-band (down.sql, manual psql, an
# older restore) still reads "up to date". Any migration folder may ship a
# verify.sql that inspects pg_catalog directly and RAISEs on drift; every one
# discovered in step 0 must pass before this release is green. Runs against
# DIRECT_URL (same connection migrate deploy used). The runtime image has no
# psql, so prisma db execute is the runner; a RAISE inside the script is a
# non-zero exit. The list was captured and checked in step 0 — this loop
# iterates that file, so an enumeration failure cannot be mistaken for an
# empty set, and the run count is asserted against the discovered count.
# ─────────────────────────────────────────────────────────────────────────────
echo "[release] step 4: running catalog verifiers (prisma/migrations/*/verify.sql)..."
VERIFIER_COUNT=0
VERIFIER_LOG=/tmp/prisma_verifier.log
: >"${VERIFIER_LOG}"
while IFS= read -r verifier; do
  [[ -n "${verifier}" ]] || continue
  VERIFIER_COUNT=$((VERIFIER_COUNT + 1))
  echo "[release]   verifier: ${verifier}"
  if ! npx prisma db execute --url "${DIRECT_URL}" --file "${verifier}" >>"${VERIFIER_LOG}" 2>&1; then
    echo "[release] catalog verifier FAILED: ${verifier}"
    sed 's/^/[release]   /' "${VERIFIER_LOG}" | tail -n 40
    echo "[release] Refusing to mark this release green (schema drift or incomplete migration)."
    echo "[release] NOTE: migrate deploy already ran; the database may now be ahead of the running code."
    exit 1
  fi
done <"${DISCOVERED_LIST}"
if [[ "${VERIFIER_COUNT}" -ne "${DISCOVERED_COUNT}" || "${VERIFIER_COUNT}" -lt "${REQUIRED_COUNT}" || "${VERIFIER_COUNT}" -lt 1 ]]; then
  echo "[release] verifier accounting mismatch: ran=${VERIFIER_COUNT} discovered=${DISCOVERED_COUNT} required=${REQUIRED_COUNT}"
  echo "[release] Refusing to mark this release green."
  exit 1
fi
echo "[release]   verifiers_passed = ${VERIFIER_COUNT} (discovered=${DISCOVERED_COUNT}, required=${REQUIRED_COUNT})"

# Count successfully applied (rolled_back_at IS NULL) rows in _prisma_migrations
# so the log emits a single grep-able line for monitoring/observability.
#
# Write raw output to a temp file so stderr is captured in the release log
# without polluting the metric value. Using a command substitution with 2>&1
# feeds stderr into awk/the variable; warnings appear inside APPLIED_COUNT,
# corrupting ALL_APPLIED= into a multi-line string. The temp-file approach
# keeps the metric clean and lets us emit warnings to stdout separately.
# (Finding 7 — MEDIUM, audit 2026-05-19; re-audit blocker 3)
# `prisma db execute` is documented (6.19.3 --help) as "not meant for returning
# data, but only to report success or failure", and in Prisma 6 it also
# requires --url/--schema; the previous call failed every time and ALL_APPLIED
# was always "unknown". The runtime image has no psql, but it does ship the
# generated @prisma/client (postinstall `prisma generate`, asserted by the
# Dockerfile), so query the ledger through the client's $queryRaw against
# DIRECT_URL and print exactly one integer. Rows are counted only when
# finished and not rolled back — the same rows `migrate deploy` treats as
# applied. Any failure or unexpected result shape is reported verbatim and
# leaves ALL_APPLIED=unknown (observability metric; gating unchanged).
# (S2 B1 finding D2, 2026-09-22)
APPLIED_TMP=$(mktemp)
# shellcheck disable=SC2016  # JS source for node -e; $queryRaw must not expand
if APPLIED_COUNT=$(DIRECT_URL="${DIRECT_URL}" node -e '
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: [] });
  prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
    .then((rows) => {
      if (!Array.isArray(rows) || rows.length !== 1 || !Number.isInteger(rows[0].n) || rows[0].n < 0) {
        throw new Error("unexpected _prisma_migrations count result: " + JSON.stringify(rows));
      }
      process.stdout.write(String(rows[0].n));
      return prisma.$disconnect();
    })
    .catch((err) => { console.error(err && err.message ? err.message : String(err)); process.exit(2); });
' 2>"${APPLIED_TMP}") && [[ "${APPLIED_COUNT}" =~ ^[0-9]+$ ]]; then
  :
else
  echo "[release] WARNING: could not read finished, non-rolled-back count from _prisma_migrations via @prisma/client:"
  sed 's/^/[release]   /' "${APPLIED_TMP}"
  APPLIED_COUNT="unknown"
fi
rm -f "${APPLIED_TMP}"

echo "[release] ────────────────────────────────────────────────────────────"
echo "[release] ✔ release_command completed successfully"
echo "[release]   ALL_APPLIED=${APPLIED_COUNT}"
echo "[release]   pending_before=${PENDING_COUNT}"
echo "[release]   verifiers_passed=${VERIFIER_COUNT} verifiers_required=${REQUIRED_COUNT}"
echo "[release]   release_id=${RELEASE_ID}"
echo "[release] ────────────────────────────────────────────────────────────"
exit 0
