#!/usr/bin/env bash
# S1+S2 release composition proof — runs the UNMODIFIED scripts/release.sh (the Fly release_command)
# against a disposable, guarded PostgreSQL 17.x fixture whose pre-state is prepared exactly the way the
# frozen S1 harness prepares it (test/db/s1-rls-close-public-exposure.sh lines 93–98 at b7d7fe59):
# Supabase-like bootstrap → REAL `prisma migrate deploy` of the full parent chain (every migration
# directory except the candidate) as the non-superuser `postgres` role → out-of-band
# prisma/migrations/rls_fitness_backend.sql. The ledger is genuine (no `migrate resolve --applied`
# baselining, no fake Prisma). release.sh then has exactly the candidate pending, as production would.
#
# Ownership: this file, scripts/release.sh and scripts/release-required-verifiers.txt are S2's.
# The guard, bootstrap, migration, down.sql and verify.sql are S1's and are used byte-for-byte
# (hashes stamped). Drift statements below are the ones S1's own harness already proved to make
# verify.sql RAISE (section 3e/3f/8 of the S1 harness); nothing new is authored against S1 objects.
#
# Controls (each is a real `bash scripts/release.sh` process; its exit code is recorded, never masked):
#   C0  S2-only tree (no S1 migration)          → refuses at step 0, exit 1, NO database contact
#   C0b integrated tree minus verify.sql         → refuses at step 0, exit 1, NO database contact
#   P   pre-state prep on <db> and <db>_lock     → 164 real parent migrations applied; candidate pending
#   C1  integrated release on pre-state          → exit 0; deploys candidate (165); verifier discovered+passed
#   C2  release again                            → exit 0; nothing pending; verifier still runs
#   C3  out-of-band down.sql (exposure class)    → exit 1; migrate status says up to date, verifier FAILS
#   C4  S1-documented direct re-apply, release   → exit 0 (recovery through the release path)
#   C5  allowed-path drift (revoke service_role) → exit 1; ALLOWED-PATH text; then restore → C5r exit 0
#   C7  late-stage lock on <db>_lock, release    → exit ≠ 0 from step 2 (real Prisma failure propagates)
#   C8  release blocker, resolve --rolled-back, release → exit 0 (S1 fact 1: failed-row recovery)
#
# Usage (all inputs literal; the S1 guard refuses anything not loopback/pinned/confirmed):
#   S1_PG_SUPER_URL='postgresql://<user>:<pw>@127.0.0.1:54321/postgres' S1_PG_PORT=54321 \
#   S1_PG_DISPOSABLE_CONFIRM='DESTROY-127.0.0.1:54321/s1_rls_s2comp,s1_rls_s2comp_lock' \
#   S2_COMP_OUT=<dir> test/release/s1s2-composition.sh [s1_rls_s2comp]
# Requirements: psql (>=17 client), node, node_modules/prisma in this tree (npm ci), git.
set -u
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
SUPER_URL=${S1_PG_SUPER_URL-}
DB=${1-s1_rls_s2comp}
OUT=${S2_COMP_OUT:-/tmp/s1s2-composition.$$}
S2_ONLY_COMMIT=${S2_ONLY_COMMIT:-e15e25c28824b43558f7c231eec26a5ac64bafa9}
MIG=20261224000000_rls_close_public_exposure
MIG_DIR=prisma/migrations/$MIG

# ---------- 0. S1 disposable-target guard FIRST: nothing below runs until both layers pass.
#              (offline layer = pure string checks, exit 64 without any connection;
#               preflight = ONE bounded read-only connection proving the synthetic cluster)
. test/db/_support/s1-target-guard.sh
s1_guard_offline "$SUPER_URL" "$DB"
s1_guard_preflight "$SUPER_URL" "$DB"

mkdir -p "$OUT"
HOST_PART=$S1_GUARD_HOSTPORT
DB2=$S1_GUARD_DB_LOCK
APP_URL="postgresql://postgres:postgres_local_synthetic@${HOST_PART}/${DB}"
APP2_URL="postgresql://postgres:postgres_local_synthetic@${HOST_PART}/${DB2}"
SUPER_DB_URL="${SUPER_URL%/*}/${DB}"
SUPER_DB2_URL="${SUPER_URL%/*}/${DB2}"
CLOSED_URL='postgresql://x:x@127.0.0.1:1/x'   # port 1: nothing listens; any contact would show as P1001
PRISMA_CLI=node_modules/prisma/build/index.js
LOG=$OUT/harness.log
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1" | tee -a "$LOG"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1" | tee -a "$LOG"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2] got [$3])"; fi; }
note() { echo "      $*" | tee -a "$LOG"; }
q()    { psql "$1" -X -qAt -v ON_ERROR_STOP=1 -c "$2" 2>>"$LOG"; }
sha()  { sha256sum "$1" | cut -c1-64; }
export PGOPTIONS='-c client_min_messages=warning'

# release.sh writes to these fixed paths (it does not honour TMPDIR). Refuse to start if any exist:
# they would belong to another run and would blur the "absent after C0" assertion.
RELEASE_TMP_FILES="/tmp/prisma_migrate.log /tmp/prisma_status.log /tmp/prisma_verify.log /tmp/prisma_verifier.log /tmp/release_verifiers_discovered.txt"
for f in $RELEASE_TMP_FILES; do [ -e "$f" ] && { echo "refusing: $f exists (another release.sh run's artifact?)"; exit 70; }; done

# ---------- stamps (after the guard, before any mutation)
{
  echo "== S1+S2 composition proof start_utc=$(date -u +%FT%TZ) pid=$$ host=$HOST_PART db=$DB db2=$DB2 out=$OUT"
  echo "head=$(git rev-parse HEAD) tree=$(git rev-parse HEAD^{tree}) parents=$(git log -1 --format=%P)"
  echo "clean=$([ -z "$(git status --porcelain --untracked-files=all)" ] && echo yes || echo NO)"
  echo "s2_only_commit=$S2_ONLY_COMMIT"
  for f in scripts/release.sh scripts/release-required-verifiers.txt $MIG_DIR/migration.sql $MIG_DIR/down.sql $MIG_DIR/verify.sql \
           test/db/_support/s1-target-guard.sh test/db/_support/supabase-like-bootstrap.sql prisma/migrations/rls_fitness_backend.sql package-lock.json; do
    echo "sha256 $(sha "$f")  $f  blob=$(git rev-parse HEAD:"$f")"
  done
  echo "psql=$(command -v psql) $(psql --version)"
  echo "node=$(command -v node) $(node --version)"
  echo "prisma_cli=$ROOT/$PRISMA_CLI sha256=$(sha "$PRISMA_CLI")"
  echo "prisma_version: $(node "$PRISMA_CLI" --version 2>/dev/null | tr -s ' ' | tr '\n' ';')"
  echo "npx_resolves_to=$(cd "$ROOT" && npx --no-install prisma --version 2>/dev/null | grep -m1 '^prisma' | tr -s ' ')"
  echo "PATH=$PATH"
  echo "server_version=$(q "$SUPER_URL" 'show server_version') cluster=$(q "$SUPER_URL" "select current_setting('cluster_name')") datadir=$(q "$SUPER_URL" "select current_setting('data_directory')")"
  echo "migration_dirs_total=$(ls prisma/migrations | grep -cE '^[0-9]{14}_') (candidate included)"
} | tee -a "$LOG"

# run_release <label> <dir> <db_url> : runs the real release.sh, preserves rc, captures its /tmp artifacts
RC=; RLOG=
run_release() {
  local label=$1 dir=$2 url=$3 t0 t1
  RLOG=$OUT/$label.release.log; mkdir -p "$OUT/$label"
  t0=$(date -u +%FT%TZ)
  ( cd "$dir" && DATABASE_URL="$url" DIRECT_URL="$url" GIT_SHA="$(git -C "$ROOT" rev-parse HEAD)" RELEASE_VERSION="s1s2-composition-$label" \
      timeout --foreground 600 bash scripts/release.sh ) >"$RLOG" 2>&1
  RC=$?; t1=$(date -u +%FT%TZ)
  echo "== $label dir=$dir start=$t0 end=$t1 release_sh_exit=$RC log=$RLOG" | tee -a "$LOG"
  for f in $RELEASE_TMP_FILES; do [ -e "$f" ] && { cp "$f" "$OUT/$label/"; rm -f "$f"; }; done
  ls "$OUT/$label" | sed 's/^/      captured tmp artifact: /' | tee -a "$LOG"
}
has()  { grep -qF -- "$2" "$1" && echo 1 || echo 0; }
hasE() { grep -qE -- "$2" "$1" && echo 1 || echo 0; }

# ---------- C0: S2-only tree (frozen S2 head, no S1 migration) refuses at step 0 without DB contact
TMP=$(mktemp -d)
mkdir -p "$TMP/s2only" && git archive "$S2_ONLY_COMMIT" | tar -x -C "$TMP/s2only" && ln -s "$ROOT/node_modules" "$TMP/s2only/node_modules"
check "C0 tree: S2-only tree extracted from $S2_ONLY_COMMIT has release.sh identical to integrated head" "$(sha scripts/release.sh)" "$(sha "$TMP/s2only/scripts/release.sh")"
check "C0 tree: S2-only tree has NO S1 verifier" 0 "$([ -f "$TMP/s2only/$MIG_DIR/verify.sql" ] && echo 1 || echo 0)"
run_release C0 "$TMP/s2only" "$CLOSED_URL"
check "C0: S2-only release.sh exits 1" 1 "$RC"
check "C0: refuses with 'REQUIRED catalog verifier missing'" 1 "$(has "$RLOG" 'REQUIRED catalog verifier missing from this image')"
check "C0: prisma CLI present in that tree (refusal is not 'prisma missing')" 1 "$(hasE "$RLOG" 'prisma_cli += prisma')"
check "C0: no 'step 1:' reached (no migrate status)" 0 "$(has "$RLOG" 'step 1:')"
check "C0: no connection attempt (no P1001 / Can't reach)" 0 "$(hasE "$RLOG" "P1001|Can't reach database")"
check "C0: /tmp/prisma_migrate.log never created" 0 "$([ -e "$OUT/C0/prisma_migrate.log" ] && echo 1 || echo 0)"
check "C0: no success banner" 0 "$(has "$RLOG" 'release_command completed successfully')"

# ---------- C0b: integrated tree with the required verify.sql removed refuses at step 0 without DB contact
mkdir -p "$TMP/nover" && git archive HEAD | tar -x -C "$TMP/nover" && ln -s "$ROOT/node_modules" "$TMP/nover/node_modules"
rm -f "$TMP/nover/$MIG_DIR/verify.sql"
run_release C0b "$TMP/nover" "$CLOSED_URL"
check "C0b: integrated tree minus verify.sql exits 1" 1 "$RC"
check "C0b: names the missing required verifier" 1 "$(has "$RLOG" "REQUIRED catalog verifier missing from this image: $MIG_DIR/verify.sql")"
check "C0b: no 'step 1:' reached, no DB contact" 0 "$(hasE "$RLOG" "step 1:|P1001")"

# ---------- P: pre-state on BOTH databases exactly as the S1 harness does (ADDENDUM_02 recipe)
echo "== P: pre-state preparation start_utc=$(date -u +%FT%TZ)" | tee -a "$LOG"
psql "$SUPER_URL" -X -qAt -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "DROP DATABASE IF EXISTS \"$DB2\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DB\"" -c "CREATE DATABASE \"$DB2\"" >/dev/null 2>>"$LOG" || { echo "cannot create databases"; exit 1; }
psql "$SUPER_DB_URL"  -X -q -v ON_ERROR_STOP=1 -f test/db/_support/supabase-like-bootstrap.sql >/dev/null 2>>"$LOG" || { echo "bootstrap failed ($DB)"; exit 1; }
psql "$SUPER_DB2_URL" -X -q -v ON_ERROR_STOP=1 -f test/db/_support/supabase-like-bootstrap.sql >/dev/null 2>>"$LOG" || { echo "bootstrap failed ($DB2)"; exit 1; }
cp -r prisma "$TMP/prisma"; rm -rf "$TMP/prisma/migrations/$MIG"
PARENT_DIRS=$(ls "$TMP/prisma/migrations" | grep -cE '^[0-9]{14}_')
note "parent migration directories in the temp copy (candidate removed): $PARENT_DIRS"
for pair in "$DB|$APP_URL|P1" "$DB2|$APP2_URL|P2"; do
  d=${pair%%|*}; rest=${pair#*|}; u=${rest%%|*}; lbl=${rest#*|}
  ( export DATABASE_URL="$u" DIRECT_URL="$u"; node "$PRISMA_CLI" migrate deploy --schema "$TMP/prisma/schema.prisma" ) >"$OUT/$lbl.parent-deploy.log" 2>&1; rc=$?
  check "$lbl ($d): REAL prisma migrate deploy of the parent chain as non-superuser postgres exits 0" 0 "$rc"
  APPLIED=$(grep -c '^Applying migration' "$OUT/$lbl.parent-deploy.log")
  check "$lbl ($d): parent chain applied count == parent directories ($PARENT_DIRS)" "$PARENT_DIRS" "$APPLIED"
  check "$lbl ($d): _prisma_migrations holds exactly $PARENT_DIRS finished rows (genuine ledger)" "$PARENT_DIRS" "$(q "$u" "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")"
  psql "$u" -X -q -v ON_ERROR_STOP=1 -f prisma/migrations/rls_fitness_backend.sql >>"$LOG" 2>&1
  check "$lbl ($d): out-of-band rls_fitness_backend.sql applied (production pre-state twin)" 0 $?
  psql "$u" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql >"$OUT/$lbl.verify-prestate.log" 2>&1; rc=$?
  check "$lbl ($d): verify.sql FAILS on the pre-state via psql (exposure present, candidate pending)" 1 "$([ $rc -eq 0 ] && echo 0 || echo 1)"
  check "$lbl ($d): candidate row absent from ledger before release" 0 "$(q "$u" "select count(*) from _prisma_migrations where migration_name='$MIG'")"
done
note "first/last parent migration applied: $(grep '^Applying migration' "$OUT/P1.parent-deploy.log" | sed -n '1p;$p' | tr '\n' ' ')"

# ---------- C1: integrated release on the pre-state (positive control)
run_release C1 "$ROOT" "$APP_URL"
check "C1: release.sh exits 0" 0 "$RC"
check "C1: step 0 accepted the contract: verifiers_required = 1 (all present)" 1 "$(has "$RLOG" 'verifiers_required = 1 (all present)')"
check "C1: step 1 saw exactly the candidate pending (pending_before=1)" 1 "$(has "$RLOG" 'pending_before=1')"
check "C1: step 2 ran real migrate deploy and applied the candidate" 1 "$(has "$RLOG" "Applying migration \`$MIG\`")"
check "C1: step 4 invoked the discovered verifier" 1 "$(has "$RLOG" "verifier: $MIG_DIR/verify.sql")"
check "C1: verifiers_passed=1 verifiers_required=1" 1 "$(has "$RLOG" 'verifiers_passed=1 verifiers_required=1')"
ALL1=$(sed -n 's/.*ALL_APPLIED=\([0-9a-z]*\).*/\1/p' "$RLOG" | head -1); note "C1 ALL_APPLIED=$ALL1 (expected $((PARENT_DIRS+1)))"
check "C1: ALL_APPLIED == parent chain + candidate" "$((PARENT_DIRS+1))" "$ALL1"
check "C1v: ledger row for the candidate is finished (deploy was real)" 1 "$(q "$APP_URL" "select count(*) from _prisma_migrations where migration_name='$MIG' and finished_at is not null and rolled_back_at is null")"
check "C1v: ledger total == parent chain + candidate" "$((PARENT_DIRS+1))" "$(q "$APP_URL" "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")"
note "C1v: prisma db execute route exposes exit code only; NOTICE text present in prisma_verifier.log: $(has "$OUT/C1/prisma_verifier.log" 'S1-DB-01 VERIFY OK')"
PGOPTIONS='-c client_min_messages=notice' psql "$APP_URL" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql >"$OUT/C1v.verify-psql.log" 2>&1
check "C1v: same verify.sql via psql stop-on-error exits 0 on the released state" 0 $?
check "C1v: psql route prints S1's OK line (18 relations, 4 partitions)" 1 "$(has "$OUT/C1v.verify-psql.log" 'S1-DB-01 VERIFY OK: 18 relations protected (4 community_messages partitions)')"

# ---------- C2: idempotent re-release; verifier still runs with nothing pending
run_release C2 "$ROOT" "$APP_URL"
check "C2: release.sh exits 0 again" 0 "$RC"
check "C2: nothing pending (pending_before=0)" 1 "$(has "$RLOG" 'pending_before=0')"
check "C2: verifier still invoked" 1 "$(has "$RLOG" "verifier: $MIG_DIR/verify.sql")"
check "C2: verifiers_passed=1" 1 "$(has "$RLOG" 'verifiers_passed=1 verifiers_required=1')"

# ---------- C3: out-of-band reversal (S1 down.sql) — Prisma status is NOT truth; verifier must fail the release
psql "$APP_URL" -X -1 -q -v ON_ERROR_STOP=1 -f $MIG_DIR/down.sql >>"$LOG" 2>&1
check "C3 setup: S1 down.sql applied out of band (--single-transaction)" 0 $?
run_release C3 "$ROOT" "$APP_URL"
check "C3: release.sh exits 1 (verifier failure propagates)" 1 "$RC"
check "C3: step 3 still reported 'up to date' (ledger untouched by out-of-band reversal)" 1 "$(has "$OUT/C3/prisma_verify.log" 'Database schema is up to date')"
check "C3: step 4 banner 'catalog verifier FAILED' names the S1 verifier" 1 "$(has "$RLOG" "catalog verifier FAILED: $MIG_DIR/verify.sql")"
check "C3: Prisma's real error text (S1 EXPOSURE class) appears in the release log tail" 1 "$(hasE "$RLOG" 'S1-DB-01 VERIFY FAILED.*exposure problem')"
check "C3: no success banner" 0 "$(has "$RLOG" 'release_command completed successfully')"

# ---------- C4: S1-documented recovery for a clean applied history = direct re-apply (ADDENDUM_01 fact 2), then release
psql "$APP_URL" -X -1 -q -v ON_ERROR_STOP=1 -f $MIG_DIR/migration.sql >>"$LOG" 2>&1
check "C4 setup: direct re-apply of migration.sql (psql --single-transaction) exits 0" 0 $?
run_release C4 "$ROOT" "$APP_URL"
check "C4: release.sh exits 0 after recovery" 0 "$RC"
check "C4: verifiers_passed=1" 1 "$(has "$RLOG" 'verifiers_passed=1 verifiers_required=1')"

# ---------- C5: allowed-path drift (S1 harness 3e statement) fails the release; restore → green
q "$APP_URL" "revoke select on table \"DunningAttempt\" from service_role" >/dev/null
run_release C5 "$ROOT" "$APP_URL"
check "C5: release.sh exits 1 on allowed-path drift" 1 "$RC"
check "C5: ALLOWED-PATH class reported (0 exposure; 1 allowed-path)" 1 "$(has "$RLOG" '0 exposure problem(s); 1 allowed-path problem(s)')"
check "C5: names the lost privilege" 1 "$(has "$RLOG" 'ALLOWED-PATH: DunningAttempt: service_role lost SELECT')"
q "$APP_URL" "grant select on table \"DunningAttempt\" to service_role" >/dev/null
run_release C5r "$ROOT" "$APP_URL"
check "C5r: release.sh exits 0 after restoring the grant" 0 "$RC"

# ---------- C7: real step-2 failure propagation — late-stage lock held on <db>_lock while release.sh deploys
PGAPPNAME=s1_blocker psql "$APP2_URL" -X -qAt -c "begin; select 1 from only community_messages_2027_01 limit 1; select pg_sleep(120);" >/dev/null 2>&1 &
BLOCKER=$!; sleep 1
check "C7 setup: blocker holds a lock on community_messages_2027_01" 1 "$(q "$APP2_URL" "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='community_messages_2027_01' and l.granted")"
T0=$(date +%s); run_release C7 "$ROOT" "$APP2_URL"; T1=$(date +%s)
check "C7: release.sh exits non-zero while the late-stage lock is held" 1 "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
note "C7 exit=$RC elapsed=$((T1-T0))s"
check "C7: failure banner from the ERR trap with Prisma's own output tail" 1 "$(hasE "$RLOG" 'FAIL at line [0-9]+ \(exit=[1-9]')"
check "C7: Prisma's real failure text (P3018 / lock timeout 55P03) is in the release log" 1 "$(hasE "$RLOG" 'P3018|canceling statement due to lock timeout|55P03')"
check "C7: the failing migration named is the candidate" 1 "$(has "$RLOG" "$MIG")"
check "C7: no step 4 / no success banner" 0 "$(hasE "$RLOG" 'step 4:|release_command completed successfully')"
check "C7: failed deploy recorded in ledger (finished_at null, rolled_back_at null)" 1 "$(q "$APP2_URL" "select count(*) from _prisma_migrations where migration_name='$MIG' and finished_at is null and rolled_back_at is null")"
check "C7: whole-file rollback — verify.sql still fails via psql (pre-state intact)" 1 "$(psql "$APP2_URL" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql >>"$LOG" 2>&1; [ $? -eq 0 ] && echo 0 || echo 1)"
q "$APP2_URL" "select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name='s1_blocker' and datname=current_database()" >/dev/null
kill $BLOCKER 2>/dev/null; wait $BLOCKER 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(q "$APP2_URL" "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='community_messages_2027_01'")" = "0" ] && break; sleep 1; done
check "C7: blocker released" 0 "$(q "$APP2_URL" "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='community_messages_2027_01'")"

# ---------- C8: S1 fact 1 recovery (failed row → resolve --rolled-back), then release through the real path
( export DATABASE_URL="$APP2_URL" DIRECT_URL="$APP2_URL"; node "$PRISMA_CLI" migrate resolve --rolled-back $MIG ) >"$OUT/C8.resolve.log" 2>&1
check "C8 setup: prisma migrate resolve --rolled-back succeeds on the REAL failed row" 0 $?
run_release C8 "$ROOT" "$APP2_URL"
check "C8: release.sh exits 0 after failed-row recovery" 0 "$RC"
check "C8: candidate was pending again (pending_before=1) and applied" 1 "$(has "$RLOG" 'pending_before=1')"
check "C8: verifiers_passed=1" 1 "$(has "$RLOG" 'verifiers_passed=1 verifiers_required=1')"
check "C8: ledger total == parent chain + candidate (rolled-back row excluded)" "$((PARENT_DIRS+1))" "$(q "$APP2_URL" "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")"

# ---------- byte-identity after the run: nothing in the tree changed
check "post-run: worktree still clean (release.sh/contract/S1 files untouched)" yes "$([ -z "$(git status --porcelain --untracked-files=all)" ] && echo yes || echo NO)"
for f in $RELEASE_TMP_FILES; do [ -e "$f" ] && bad "post-run: $f left behind"; done
rm -rf "$TMP"
echo "== $PASS passed, $FAIL failed (server $(q "$APP_URL" 'show server_version'), head $(git rev-parse --short HEAD), end_utc=$(date -u +%FT%TZ))" | tee -a "$LOG"
[ $FAIL -eq 0 ]
