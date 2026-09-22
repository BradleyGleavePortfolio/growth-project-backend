#!/usr/bin/env bash
# S1 R4 narrow discriminator for S1-R3-A-01 (effective TRUNCATE gap in verify.sql).
#
# Runs the shared controls in test/db/_support/s1-truncate-controls.sh against an
# ALREADY PROTECTED synthetic database (the S1 proof database after the full harness,
# or S2's guarded PG 17.6 composition fixture after the real 164-parent replay plus
# candidate 165). It does NOT drop/create databases, does NOT replay migrations and
# does NOT install anything; it only GRANTs/REVOKEs TRUNCATE on the seeded standalone
# public."MuxProcessedEvent" and restores it. Every step's exit is recorded; the
# script exits 0 only if every check passed.
#
# Target boundary: the SAME two-layer guard as the destructive harness
# (test/db/_support/s1-target-guard.sh) — literal loopback URL, pinned port,
# s1_rls_* namespace, explicit confirmation, read-only preflight proving the
# disposable cluster (marker, data root, superuser, PG 17.x, no foreign DBs, fixture
# role flags) — BEFORE any other connection. The confirmation string is the harness's
# DESTROY-… literal even though this script destroys nothing: one contract, no
# weaker variant.
#
# Usage (parent-authorized slot only):
#   S1_PG_SUPER_URL='postgresql://<super>:<pw>@127.0.0.1:54321/postgres' \
#   S1_PG_PORT=54321 S1_PG_DISPOSABLE_CONFIRM='DESTROY-127.0.0.1:54321/<db>,<db>_lock' \
#   S1_PRISMA_CLI=/abs/path/node_modules/prisma/build/index.js \
#   [S1_PROOF_LOG=/abs/path/detail.log] [S1_R4_LOCK_HOLDER='<who holds the canonical lock>'] \
#   test/db/s1-r4-truncate-discriminator.sh <s1_rls_dbname>
#
# Canonical lock: taken here NONBLOCKING (exit 75 if busy) unless S1_R4_LOCK_HOLDER is
# set, in which case the caller (e.g. S2's lock-bearing wrapper) asserts it already
# holds /home/user/workspace/execution/test-validation.lock and that fact is stamped.
#
# Preconditions (checked, fail closed, never repaired here): target database exists;
# fixture roles postgres/authenticator with the bootstrap's synthetic passwords; the
# CURRENT verify.sql passes on the target (protected state); predecessor verify.sql
# (frozen b7d7fe59) reproducible from this repository's history with its pinned sha256.
set -u
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
SUPER_URL=${S1_PG_SUPER_URL-}
DB=${1-}
LOCK=${S1_LOCK_PATH:-/home/user/workspace/execution/test-validation.lock}
# ---------- 0. guard: offline layer, then lock, then read-only preflight — before anything else
. test/db/_support/s1-target-guard.sh
s1_guard_offline "$SUPER_URL" "$DB"
if [ -n "${S1_R4_LOCK_HOLDER-}" ]; then
  LOCK_STAMP="held by caller: $S1_R4_LOCK_HOLDER (asserted, not re-acquired)"
else
  exec 9>"$LOCK"
  flock -n 9 || { echo "validation lock busy ($LOCK); not waiting" >&2; exit 75; }
  LOCK_STAMP="$LOCK held nonblocking by pid $$"
fi
s1_guard_preflight "$SUPER_URL" "$DB"

MIG=20261224000000_rls_close_public_exposure
MIG_DIR=prisma/migrations/$MIG
HOST_PART=$S1_GUARD_HOSTPORT
PG_URL="postgresql://postgres:postgres_local_synthetic@${HOST_PART}/${DB}"
AUTHN_URL="postgresql://authenticator:authenticator_local_synthetic@${HOST_PART}/${DB}"
PRISMA_CLI=${S1_PRISMA_CLI:-node_modules/prisma/build/index.js}
PRISMA="node $PRISMA_CLI"
LOG=${S1_PROOF_LOG:-/tmp/s1-r4-truncate.$$.log}
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2] got [$3])"; fi; }
q()    { psql "$1" -X -qAt -v ON_ERROR_STOP=1 -c "$2" 2>>"$LOG"; }
rc0(){ [ "$1" -eq 0 ] && echo 0 || echo 1; }
verify_rc(){ psql "$1" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql >>"$LOG" 2>&1; rc0 $?; }
verify_msg(){ psql "$1" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql 2>&1 | grep -o 'S1-DB-01 VERIFY [A-Z]*.*' | head -1; }
prisma_verify_rc(){ $PRISMA db execute --url "$1" --file $MIG_DIR/verify.sql >>"$LOG" 2>&1; rc0 $?; }
export PGOPTIONS='-c client_min_messages=warning'
redact(){ sed -E 's#://[^@[:space:]]*@#://<redacted>@#g'; }

# ---------- 1. stamps (every field required; missing tool/hash fails closed before any DB write)
[ -f "$PRISMA_CLI" ] || { echo "prisma CLI not found at $PRISMA_CLI" >&2; exit 70; }
command -v psql >/dev/null || { echo "psql not on PATH" >&2; exit 70; }
command -v node >/dev/null || { echo "node not on PATH" >&2; exit 70; }
command -v git  >/dev/null || { echo "git not on PATH" >&2; exit 70; }
STATUS=$(git status --porcelain --untracked-files=all -- prisma/migrations/$MIG test/db 2>/dev/null)
DIRTY_FP=$([ -z "$STATUS" ] && echo clean || { printf '%s\n' "$STATUS" | sha256sum | cut -c1-16; })
echo "== S1 R4 TRUNCATE discriminator on $HOST_PART db=$DB (log: $LOG)"
echo "start_utc=$(date -u +%FT%TZ)"
echo "head=$(git rev-parse HEAD) tree=$(git rev-parse 'HEAD^{tree}') branch=$(git rev-parse --abbrev-ref HEAD)"
echo "scoped_status=$DIRTY_FP (prisma/migrations/$MIG + test/db; 'clean' or sha256-16 of porcelain)"
echo "verify_sql_sha256=$(sha256sum $MIG_DIR/verify.sql | cut -c1-64)"
echo "controls_sha256=$(sha256sum test/db/_support/s1-truncate-controls.sh | cut -c1-64)"
echo "guard_sha256=$(sha256sum test/db/_support/s1-target-guard.sh | cut -c1-64)"
echo "discriminator_sha256=$(sha256sum test/db/s1-r4-truncate-discriminator.sh | cut -c1-64)"
echo "prisma_cli=$PRISMA_CLI sha256=$(sha256sum "$PRISMA_CLI" | cut -c1-64)"
echo "prisma_version=$($PRISMA --version 2>&1 | tr '\n' ' ')"
echo "node_version=$(node --version) psql_version=$(psql --version)"
echo "S1_PG_PORT=$S1_GUARD_PORT S1_PG_SUPER_URL=$(printf '%s' "$SUPER_URL" | redact) S1_PG_DISPOSABLE_CONFIRM=$S1_PG_DISPOSABLE_CONFIRM"
echo "lock=$LOCK_STAMP"
echo "guard=offline+preflight accepted before any non-guard connection"

# ---------- 2. preconditions on the target (read-only): exists, fixture roles connect, protected
check "precondition: target database $DB exists on the guarded cluster" 1 "$(q "$SUPER_URL" "select count(*) from pg_database where datname='$DB'")"
check "precondition: fixture owner role connects (postgres, BYPASSRLS, non-superuser) and PG 17.x" "t,f,17" \
  "$(q "$PG_URL" "select concat_ws(',', (select rolbypassrls from pg_roles where rolname=current_user), (select rolsuper from pg_roles where rolname=current_user), left(current_setting('server_version_num'),2))")"
check "precondition: authenticator connects and can SET ROLE anon" "anon" "$(q "$AUTHN_URL" "set role anon; select current_user")"
echo "server_version=$(q "$PG_URL" 'show server_version')"
check "precondition: CURRENT verify.sql passes on the target (protected state; psql route)" 0 "$(verify_rc "$PG_URL")"
check "precondition (S2 gate route): prisma db execute --file verify.sql exits ZERO on the target" 0 "$(prisma_verify_rc "$PG_URL")"

# ---------- 3. predecessor verifier from history, pinned
S1_PRED_HEAD=b7d7fe5964680050ab441c195055ea946282a9c3
S1_PRED_VERIFY_SHA256=2bbce0d7ca2e2761f6a6b3d5cebe2df752ac47767f9936d0b77357a46996323e
TMP=$(mktemp -d)
PRED_VERIFY="$TMP/verify-predecessor-b7d7fe59.sql"
git show "$S1_PRED_HEAD:$MIG_DIR/verify.sql" >"$PRED_VERIFY" 2>>"$LOG" || : >"$PRED_VERIFY"
check "predecessor control: frozen b7d7fe59 verify.sql extracted from history matches its pinned sha256" "$S1_PRED_VERIFY_SHA256" "$(sha256sum "$PRED_VERIFY" | cut -c1-64)"
check "current verifier differs from the predecessor (a changed verifier is under test)" differs "$(cmp -s "$PRED_VERIFY" $MIG_DIR/verify.sql && echo same || echo differs)"

# ---------- 4. precondition decision BEFORE any write of ours (S1-R4-A-01 low observation):
#               if anything above failed, issue no INSERT/GRANT at all. The guard and read-only
#               probes have already run, so this is "no write issued by this script", not "nothing
#               happened on the connection".
PRECOND_FAIL=$FAIL
SEEDED_BY_US=0
if [ "$PRECOND_FAIL" -ne 0 ]; then
  bad "controls NOT run: $PRECOND_FAIL precondition check(s) failed above; this script issued no INSERT/GRANT/REVOKE (fail closed)"
else
  # ---------- 5a. seed marker row only if the control table is empty (synthetic, removed at the end)
  if [ "$(q "$PG_URL" 'select count(*) from "MuxProcessedEvent"')" = "0" ]; then
    q "$PG_URL" "insert into \"MuxProcessedEvent\"(mux_event_id, type) values ('s1-r4-synthetic-control','s1.r4.truncate.control')" >/dev/null
    SEEDED_BY_US=1
    echo "note: control table was empty; inserted one synthetic marker row (removed at the end)"
  fi
  # ---------- 5b. the shared controls (identical to the full harness §4b)
  . test/db/_support/s1-truncate-controls.sh
  s1_truncate_controls "$PG_URL" "$AUTHN_URL" "$PRED_VERIFY"
fi

# ---------- 6. cleanup of our own marker row only; final positive control
if [ $SEEDED_BY_US -eq 1 ]; then
  q "$PG_URL" "delete from \"MuxProcessedEvent\" where mux_event_id='s1-r4-synthetic-control'" >/dev/null
  check "cleanup: synthetic marker row removed" 0 "$(q "$PG_URL" "select count(*) from \"MuxProcessedEvent\" where mux_event_id='s1-r4-synthetic-control'")"
fi
check "final: CURRENT verify.sql passes on the target after all controls (psql route)" 0 "$(verify_rc "$PG_URL")"
rm -rf "$TMP"
echo "end_utc=$(date -u +%FT%TZ)"
echo "== $PASS passed, $FAIL failed (server $(q "$PG_URL" 'show server_version'), head $(git rev-parse --short HEAD) scoped_status=$DIRTY_FP)"
[ $FAIL -eq 0 ]
