#!/usr/bin/env bash
# S1-DB-01 behavioural proof harness for
#   prisma/migrations/20261224000000_rls_close_public_exposure
#
# Runs ONLY against a disposable local PostgreSQL 17.x cluster (never a Supabase
# project). It rebuilds the observed production pre-state from source
# (Prisma chain at the parent commit + the out-of-band rls_fitness_backend.sql),
# proves the exposure exists, applies the candidate through the real
# `prisma migrate deploy` path, and then checks behaviour role-by-role,
# partition protection, lock bounding, recovery and the reversal invariant.
#
# Usage:
#   S1_PG_SUPER_URL='postgresql://<superuser>:<pw>@127.0.0.1:54321/postgres' \
#   test/db/s1-rls-close-public-exposure.sh [dbname]
#
# Requirements: psql (>=17 client), node + node_modules (prisma CLI), the roles
# defined by test/db/_support/supabase-like-bootstrap.sql are created by this
# script. Exit code 0 only if every check passed.
set -u
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
SUPER_URL=${S1_PG_SUPER_URL:?set S1_PG_SUPER_URL (superuser URL to the isolated cluster, db postgres)}
DB=${1:-s1_rls_proof}
MIG=20261224000000_rls_close_public_exposure
MIG_DIR=prisma/migrations/$MIG
HOST_PART=${SUPER_URL#*@}; HOST_PART=${HOST_PART%%/*}
PG_URL="postgresql://postgres:postgres_local_synthetic@${HOST_PART}/${DB}"
AUTHN_URL="postgresql://authenticator:authenticator_local_synthetic@${HOST_PART}/${DB}"
SUPER_DB_URL="${SUPER_URL%/*}/${DB}"
PRISMA="node node_modules/prisma/build/index.js"
LOG=${S1_PROOF_LOG:-/tmp/s1-rls-proof.$$.log}
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
check(){ # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2] got [$3])"; fi; }
q()    { psql "$1" -X -qAt -v ON_ERROR_STOP=1 -c "$2" 2>>"$LOG"; }
# sqlstate <url> <sql...>: prints SQLSTATE of the first error or 00000 on success
sqlstate(){ local url=$1; shift; local out
  out=$(printf '%s\n' "$@" | psql "$url" -X -1 -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f - 2>&1 >/dev/null)
  if [ -z "$out" ]; then echo 00000; else
    printf '%s\n' "$out" >>"$LOG"
    local st; st=$(printf '%s' "$out" | sed -n 's/^.*ERROR:  \([0-9A-Z]\{5\}\):.*/\1/p' | head -1)
    echo "${st:-XXXXX}"; fi; }
# rc0: prints 0 if the command exit code is 0, else 1 (psql -f exits 3 on error)
rc0(){ [ "$1" -eq 0 ] && echo 0 || echo 1; }
verify_rc(){ psql "$1" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql >>"$LOG" 2>&1; rc0 $?; }
DOWN=$MIG_DIR/down.sql
export PGOPTIONS='-c client_min_messages=warning'

echo "== S1-DB-01 proof on $HOST_PART db=$DB  (log: $LOG)"
psql "$SUPER_URL" -X -qAt -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "DROP DATABASE IF EXISTS ${DB}_lock WITH (FORCE)" -c "CREATE DATABASE $DB" >/dev/null 2>>"$LOG" || { echo "cannot create db"; exit 1; }
psql "$SUPER_DB_URL" -X -q -v ON_ERROR_STOP=1 -f test/db/_support/supabase-like-bootstrap.sql >/dev/null 2>>"$LOG" || { echo "bootstrap failed"; exit 1; }

# ---------- 1. pre-state: parent chain (without candidate) + out-of-band legacy RLS file
TMP=$(mktemp -d); cp -r prisma "$TMP/prisma"; rm -rf "$TMP/prisma/$MIG_DIR"; rm -rf "$TMP/prisma/migrations/$MIG"
( export DATABASE_URL="$PG_URL" DIRECT_URL="$PG_URL"; $PRISMA migrate deploy --schema "$TMP/prisma/schema.prisma" >>"$LOG" 2>&1 )
check "replay of parent migration chain (without candidate) as non-superuser postgres" 0 $?
psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 -f prisma/migrations/rls_fitness_backend.sql >>"$LOG" 2>&1
check "out-of-band rls_fitness_backend.sql applies (production pre-state twin)" 0 $?
EXPOSED_SQL="select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity"
EXPECTED18="ClientAssetGrant,CoachMediaAsset,CoachPackageContent,DripResolverMarker,DunningAttempt,MuxProcessedEvent,NudgeLog,PaymentRecoveryToken,PayoutMethod,PurchaseFanout,ScheduledDrop,UserAIQuota,coach_ltv_peak,community_messages_2026_12,community_messages_2027_01,community_messages_2027_02,community_messages_default,recent_auth_nonce"
check "pre-state reproduces exactly the 18 observed RLS-disabled public relations" "$EXPECTED18" "$(q "$PG_URL" "$EXPOSED_SQL")"
check "pre-state: anon has full CRUD on DunningAttempt via default privileges" "t,t,t,t" \
  "$(q "$PG_URL" "select concat_ws(',', has_table_privilege('anon','\"DunningAttempt\"','SELECT'), has_table_privilege('anon','\"DunningAttempt\"','INSERT'), has_table_privilege('authenticated','\"DunningAttempt\"','UPDATE'), has_table_privilege('authenticated','community_messages_2027_01','DELETE'))")"
check "pre-state: verify.sql FAILS (detects exposure)" 1 "$(verify_rc "$PG_URL")"
check "pre-state: verify.sql failure names the exposure (not an internal error)" 1 "$(psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql 2>&1 | grep -c 'S1-DB-01 VERIFY FAILED')"

# ---------- 2. synthetic data (proves data preservation + parent-path behaviour)
psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 >>"$LOG" 2>&1 <<'SQL'
insert into "User"(id, supabase_id, email, name, role) values
 ('coach-1','00000000-0000-0000-0000-000000000001','coach@example.test','Coach','coach'),
 ('client-1','00000000-0000-0000-0000-000000000002','client@example.test','Client','student'),
 ('client-2','00000000-0000-0000-0000-000000000003','other@example.test','Other','student');
insert into community_workspaces(id, coach_id, name, slug, updated_at) values ('10000000-0000-0000-0000-000000000001','coach-1','WS','ws', now());
insert into community_cohorts(id, workspace_id, name, updated_at) values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','C1', now());
insert into community_memberships(id, workspace_id, cohort_id, user_id, updated_at) values
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','client-1', now());
insert into community_messages(created_at, workspace_id, cohort_id, scope, sender_id, body, updated_at) values
 ('2027-01-05','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','cohort','coach-1','seed-1', now()),
 ('2027-02-05','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','cohort','client-1','seed-2', now());
insert into recent_auth_nonce(id, hmac_suffix, user_id, expires_at) values ('n1','abcd','client-1', now()+interval '1 hour');
insert into coach_ltv_peak(id, coach_id, updated_at) values ('p1','coach-1', now());
insert into "MuxProcessedEvent"(mux_event_id, type) values ('evt-1','video.asset.ready');
SQL
check "synthetic fixtures inserted" 0 $?
COUNT_SQL="select (select count(*) from community_messages)||'/'||(select count(*) from recent_auth_nonce)||'/'||(select count(*) from coach_ltv_peak)||'/'||(select count(*) from \"MuxProcessedEvent\")"
PRE_COUNTS=$(q "$PG_URL" "$COUNT_SQL")
SNAP_SQL="select c.relname||':'||c.relrowsecurity||c.relforcerowsecurity||':'||coalesce(array_to_string(c.relacl,';'),'-')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','p')
  and c.relname not in (select unnest(string_to_array('$EXPECTED18',','))) and c.relname<>'_prisma_migrations' order by 1"
PRE_SNAP=$(q "$PG_URL" "$SNAP_SQL" | md5sum)
POL_PRE=$(q "$PG_URL" "select count(*) from pg_policy where polrelid='community_messages'::regclass")

# ---------- 3. lock bounding + failed-deploy recovery on a SEPARATE database (keeps DB1 history clean)
DB2=${DB}_lock; PG2_URL="postgresql://postgres:postgres_local_synthetic@${HOST_PART}/${DB2}"
psql "$SUPER_URL" -X -qAt -c "DROP DATABASE IF EXISTS $DB2 WITH (FORCE)" -c "CREATE DATABASE $DB2" >/dev/null 2>>"$LOG"
psql "${SUPER_URL%/*}/${DB2}" -X -q -v ON_ERROR_STOP=1 -f test/db/_support/supabase-like-bootstrap.sql >/dev/null 2>>"$LOG"
( export DATABASE_URL="$PG2_URL" DIRECT_URL="$PG2_URL"; $PRISMA migrate deploy --schema "$TMP/prisma/schema.prisma" >>"$LOG" 2>&1 ) \
  && psql "$PG2_URL" -X -q -v ON_ERROR_STOP=1 -f prisma/migrations/rls_fitness_backend.sql >>"$LOG" 2>&1
check "DB2: parent chain + legacy RLS file replayed for the lock/recovery scenario" 0 $?
psql "$PG2_URL" -X -qAt -c "begin; select 1 from \"DunningAttempt\" limit 1; select pg_sleep(25);" >/dev/null 2>&1 &
BLOCKER=$!; sleep 1
T0=$(date +%s)
st=$(sqlstate "$PG2_URL" "\\i $MIG_DIR/migration.sql"); T1=$(date +%s)
check "DB2: migration.sql (psql --single-transaction) fails fast with lock_timeout SQLSTATE 55P03 while a lock is held" 55P03 "$st"
[ $((T1-T0)) -le 12 ] && ok "DB2: lock wait bounded ($((T1-T0))s <= 12s)" || bad "DB2: lock wait not bounded ($((T1-T0))s)"
check "DB2: failed direct attempt left the pre-state untouched (18 still exposed)" "$EXPECTED18" "$(q "$PG2_URL" "$EXPOSED_SQL")"
T0=$(date +%s)
( export DATABASE_URL="$PG2_URL" DIRECT_URL="$PG2_URL"; $PRISMA migrate deploy >>"$LOG" 2>&1 ); rc=$?; T1=$(date +%s)
check "DB2: prisma migrate deploy fails (non-zero) while the lock is held" 1 "$(rc0 $rc)"
[ $((T1-T0)) -le 20 ] && ok "DB2: prisma deploy failure bounded ($((T1-T0))s <= 20s)" || bad "DB2: prisma deploy failure not bounded ($((T1-T0))s)"
check "DB2: failed deploy recorded in _prisma_migrations (finished_at null, rolled_back_at null)" "1" \
  "$(q "$PG2_URL" "select count(*) from _prisma_migrations where migration_name='$MIG' and finished_at is null and rolled_back_at is null")"
check "DB2: failed Prisma attempt is ATOMIC — pre-state untouched (no partially protected tables)" "$EXPECTED18" "$(q "$PG2_URL" "$EXPOSED_SQL")"
check "DB2: verify.sql fails cleanly after the failed attempt" 1 "$(verify_rc "$PG2_URL")"
check "DB2: session timeout settings did not leak (fresh connection shows defaults)" "0|0" "$(q "$PG2_URL" "select current_setting('lock_timeout')||'|'||current_setting('statement_timeout')")"
wait $BLOCKER 2>/dev/null
( export DATABASE_URL="$PG2_URL" DIRECT_URL="$PG2_URL"; $PRISMA migrate resolve --rolled-back $MIG >>"$LOG" 2>&1 )
check "DB2: documented recovery step 1 — prisma migrate resolve --rolled-back succeeds after a REAL failure" 0 $?
( export DATABASE_URL="$PG2_URL" DIRECT_URL="$PG2_URL"; $PRISMA migrate deploy >>"$LOG" 2>&1 )
check "DB2: documented recovery step 2 — prisma migrate deploy succeeds once the lock is gone" 0 $?
check "DB2: verify.sql passes after recovery" 0 "$(verify_rc "$PG2_URL")"
# reversal with a failed-attempt history: resolve --rolled-back is NOT a recovery (observed behaviour recorded)
psql "$PG2_URL" -X -1 -q -v ON_ERROR_STOP=1 -f $DOWN >>"$LOG" 2>&1
check "DB2: down.sql runs (--single-transaction)" 0 $?
( export DATABASE_URL="$PG2_URL" DIRECT_URL="$PG2_URL"; $PRISMA migrate resolve --rolled-back $MIG >>"$LOG" 2>&1 ); rc=$?
echo "      DB2 observed: resolve --rolled-back after reversal WITH earlier failed row -> exit $rc; applied row: $(q "$PG2_URL" "select count(*) from _prisma_migrations where migration_name='$MIG' and finished_at is not null and rolled_back_at is null")"
check "DB2: applied row still marked applied after resolve (Prisma state unchanged by reversal)" "1" \
  "$(q "$PG2_URL" "select count(*) from _prisma_migrations where migration_name='$MIG' and finished_at is not null and rolled_back_at is null")"
check "DB2: verify.sql FAILS after reversal regardless of Prisma output" 1 "$(verify_rc "$PG2_URL")"

# ---------- 4. apply the candidate through the real path
( export DATABASE_URL="$PG_URL" DIRECT_URL="$PG_URL"; $PRISMA migrate deploy >>"$LOG" 2>&1 )
check "prisma migrate deploy applies the candidate (lock released)" 0 $?
check "verify.sql passes after apply" 0 "$(verify_rc "$PG_URL")"
check "verify.sql reports all 18 relations protected (4 partitions)" 1 "$(PGOPTIONS='-c client_min_messages=notice' psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 -f $MIG_DIR/verify.sql 2>&1 | grep -c 'VERIFY OK: 18 relations protected (4 community_messages partitions)')"
check "timeouts RESET at end of migration (fresh session defaults)" "0|0" "$(q "$PG_URL" "select current_setting('lock_timeout')||'|'||current_setting('statement_timeout')")"
check "no RLS-disabled relation remains in public that CI's floor would flag among the 18" "" "$(q "$PG_URL" "$EXPOSED_SQL" | tr ',' '\n' | grep -Fx -f <(echo "$EXPECTED18" | tr ',' '\n') | tr '\n' ',')"
check "populated data preserved (row counts unchanged)" "$PRE_COUNTS" "$(q "$PG_URL" "$COUNT_SQL")"
check "no other table's RLS flags or ACLs changed (catalog snapshot identical)" "$PRE_SNAP" "$(q "$PG_URL" "$SNAP_SQL" | md5sum)"
check "community_messages parent policies untouched" "$POL_PRE" "$(q "$PG_URL" "select count(*) from pg_policy where polrelid='community_messages'::regclass")"
check "idempotent re-run of migration.sql succeeds" 00000 "$(sqlstate "$PG_URL" "\\i $MIG_DIR/migration.sql")"
check "verify.sql still passes after re-run" 0 "$(verify_rc "$PG_URL")"

# ---------- 5. behaviour by role (authenticator -> SET ROLE, the PostgREST shape)
for role in anon authenticated; do
  allden=1
  for t in ClientAssetGrant CoachMediaAsset CoachPackageContent DripResolverMarker DunningAttempt MuxProcessedEvent NudgeLog PaymentRecoveryToken PayoutMethod PurchaseFanout ScheduledDrop UserAIQuota coach_ltv_peak recent_auth_nonce community_messages_2026_12 community_messages_2027_01 community_messages_2027_02 community_messages_default; do
    col=$(q "$PG_URL" "select attname from pg_attribute where attrelid='public.\"$t\"'::regclass and attnum=1")
    for stmt in "select count(*) from \"$t\"" "delete from \"$t\"" "update \"$t\" set \"$col\"=\"$col\" where false" "insert into \"$t\" select * from \"$t\" where false"; do
      s=$(sqlstate "$AUTHN_URL" "set role $role;" "$stmt;")
      [ "$s" = 42501 ] || { allden=0; echo "      $role $t :: $stmt -> $s" | tee -a "$LOG"; }
    done
  done
  check "$role: SELECT/INSERT/UPDATE/DELETE denied (42501) on all 18 relations" 1 $allden
  check "$role: cannot execute community_messages_create_month_partition" 42501 "$(sqlstate "$AUTHN_URL" "set role $role;" "select public.community_messages_create_month_partition(date '2028-01-01');")"
done
check "service_role (BYPASSRLS) via authenticator still reads DunningAttempt" 00000 "$(sqlstate "$AUTHN_URL" "set role service_role;" "select count(*) from \"DunningAttempt\";")"
check "service_role can write recent_auth_nonce" 00000 "$(sqlstate "$AUTHN_URL" "set role service_role;" "insert into recent_auth_nonce(id,hmac_suffix,user_id,expires_at) values ('n2','ef','client-1',now()); delete from recent_auth_nonce where id='n2';")"
check "postgres (BYPASSRLS, the source-assumed app role) reads and writes coach_ltv_peak" 00000 "$(sqlstate "$PG_URL" "update coach_ltv_peak set zero_churn_streak=1 where id='p1'; select * from coach_ltv_peak;")"

# RLS layer proven independently of grants: a non-bypass role WITH table grants is still denied by policy
q "$PG_URL" "do \$\$ begin if not exists (select 1 from pg_roles where rolname='s1_probe') then create role s1_probe login password 's1_probe_local' nobypassrls; end if; end \$\$; grant usage on schema public, app to s1_probe;
  grant select, insert, update, delete on \"DunningAttempt\", recent_auth_nonce, community_messages_2027_01 to s1_probe;
  grant select, insert on community_messages to s1_probe; grant select on community_workspaces, community_memberships, community_cohorts to s1_probe;
  grant usage on type \"CommunityMessageScope\" to s1_probe; grant execute on function app.current_user_id() to s1_probe;" >/dev/null
PROBE_URL="postgresql://s1_probe:s1_probe_local@${HOST_PART}/${DB}"
check "RLS alone (probe role WITH grants): SELECT on DunningAttempt returns 0 rows" "0" "$(q "$PROBE_URL" "select count(*) from \"DunningAttempt\"")"
check "RLS alone: SELECT on protected partition directly returns 0 rows (1 seeded)" "0" "$(q "$PROBE_URL" "select count(*) from community_messages_2027_01")"
check "RLS alone: INSERT into recent_auth_nonce rejected by policy (42501)" 42501 "$(sqlstate "$PROBE_URL" "insert into recent_auth_nonce(id,hmac_suffix,user_id,expires_at) values ('n3','x','client-1',now());")"
check "RLS alone: FORCE applies to table owner? (owner is postgres BYPASSRLS -> unaffected, expected 00000)" 00000 "$(sqlstate "$PG_URL" "select count(*) from recent_auth_nonce;")"

# ---------- 6. parent-path community behaviour unchanged with partitions protected
check "parent path: coach (via app.current_user_id) reads both seeded messages through community_messages" "2" \
  "$(q "$PROBE_URL" "set app.current_user_id='coach-1'; select count(*) from community_messages")"
check "parent path: cohort member reads cohort messages" "2" \
  "$(q "$PROBE_URL" "set app.current_user_id='client-1'; select count(*) from community_messages")"
check "parent path: non-member reads nothing" "0" \
  "$(q "$PROBE_URL" "set app.current_user_id='client-2'; select count(*) from community_messages")"
check "parent path: member INSERT routes into protected partition 2027_02 and succeeds" 00000 \
  "$(sqlstate "$PROBE_URL" "set app.current_user_id='client-1';" "insert into community_messages(created_at, workspace_id, cohort_id, scope, sender_id, body, updated_at) values ('2027-02-20','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','cohort','client-1','via-parent', now());")"
check "parent path: inserted row landed in community_messages_2027_02" "1" "$(q "$PG_URL" "select count(*) from only community_messages_2027_02 where body='via-parent'")"
check "parent path: forged sender rejected by existing parent policy (42501)" 42501 \
  "$(sqlstate "$PROBE_URL" "set app.current_user_id='client-2';" "insert into community_messages(created_at, workspace_id, cohort_id, scope, sender_id, body, updated_at) values ('2027-02-21','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','cohort','coach-1','forged', now());")"
check "app.* helpers still resolve with search_path='' (coach check true)" "t" "$(q "$PROBE_URL" "set app.current_user_id='coach-1'; select app.is_community_workspace_coach('10000000-0000-0000-0000-000000000001')")"

# ---------- 7. future partitions are protected at creation
q "$PG_URL" "select public.community_messages_create_month_partition(date '2028-03-01')" >/dev/null
check "new partition created by helper" "1" "$(q "$PG_URL" "select count(*) from pg_class where relname='community_messages_2028_03'")"
check "new partition has RLS enabled+forced and no anon/authenticated privileges" "t,t,f,f" \
  "$(q "$PG_URL" "select concat_ws(',', relrowsecurity, relforcerowsecurity, has_table_privilege('anon','community_messages_2028_03','SELECT'), has_table_privilege('authenticated','community_messages_2028_03','INSERT')) from pg_class where relname='community_messages_2028_03'")"
check "new partition carries the deny/service_role policies" "3" "$(q "$PG_URL" "select count(*) from pg_policy where polrelid='community_messages_2028_03'::regclass")"
check "anon denied on new partition" 42501 "$(sqlstate "$AUTHN_URL" "set role anon;" "select count(*) from community_messages_2028_03;")"
check "helper is idempotent (second call for same month succeeds)" 00000 "$(sqlstate "$PG_URL" "select public.community_messages_create_month_partition(date '2028-03-01');")"

# ---------- 8. reversibility gate parity (repo migration-dry-run: forward -> down.sql -> forward, schema dumps identical)
DUMP="pg_dump --schema-only --no-owner --no-privileges"
# normalise: drop the timestamp header and the per-dump random \restrict/\unrestrict tokens emitted by pg_dump >= 17.6/18
norm(){ grep -v -e '^-- Dumped' -e '^\\restrict ' -e '^\\unrestrict '; }
$DUMP "$PG_URL" 2>>"$LOG" | norm > "$TMP/fwd1.sql"
psql "$PG_URL" -X -1 -q -v ON_ERROR_STOP=1 -f $DOWN >>"$LOG" 2>&1
check "down.sql applies (--single-transaction, ON_ERROR_STOP)" 0 $?
check "down.sql restores the exposed pre-state (18 relations RLS off again; new partition also unprotected)" "$EXPECTED18" "$(q "$PG_URL" "$EXPOSED_SQL" | tr ',' '\n' | grep -v 2028_03 | paste -sd,)"
$DUMP "$PG_URL" 2>>"$LOG" | norm > "$TMP/down.sql.dump"
check "down.sql changes the schema dump (reverse is not a no-op)" differs "$(cmp -s "$TMP/fwd1.sql" "$TMP/down.sql.dump" && echo same || echo differs)"
# ---------- 9. reversal invariant (prior recovery finding) on the CLEAN history of DB1
STATUS_OUT=$( export DATABASE_URL="$PG_URL" DIRECT_URL="$PG_URL"; $PRISMA migrate status 2>&1 ); echo "$STATUS_OUT" >>"$LOG"
check "INVARIANT: after out-of-band reversal, prisma migrate status still claims up to date" "1" "$(echo "$STATUS_OUT" | grep -c 'Database schema is up to date')"
RES_OUT=$( export DATABASE_URL="$PG_URL" DIRECT_URL="$PG_URL"; $PRISMA migrate resolve --rolled-back $MIG 2>&1 ); rc=$?; echo "$RES_OUT" >>"$LOG"
check "INVARIANT (clean history): prisma migrate resolve --rolled-back refuses with P3012" "1|1" "$([ $rc -ne 0 ] && echo 1 || echo 0)|$(echo "$RES_OUT" | grep -c P3012)"
check "INVARIANT: verify.sql (catalog truth) FAILS while Prisma says up to date" 1 "$(verify_rc "$PG_URL")"
check "recovery: re-running migration.sql with psql --single-transaction restores protection" 00000 "$(sqlstate "$PG_URL" "\\i $MIG_DIR/migration.sql")"
check "recovery: verify.sql passes again" 0 "$(verify_rc "$PG_URL")"
$DUMP "$PG_URL" 2>>"$LOG" | norm > "$TMP/fwd2.sql"
check "REVERSIBILITY GATE PARITY: schema dump after forward->down->forward is byte-identical" 0 "$(cmp -s "$TMP/fwd1.sql" "$TMP/fwd2.sql"; rc0 $?)"
cp "$TMP/fwd1.sql" "${LOG%.log}.schema-forward1.sql"; cp "$TMP/fwd2.sql" "${LOG%.log}.schema-forward2.sql"; cp "$TMP/down.sql.dump" "${LOG%.log}.schema-after-down.sql"
diff "$TMP/fwd1.sql" "$TMP/fwd2.sql" | head -40 >>"$LOG"
check "prisma migrate status still up to date after direct re-apply (history untouched)" "1" "$( export DATABASE_URL="$PG_URL" DIRECT_URL="$PG_URL"; $PRISMA migrate status 2>&1 | grep -c 'Database schema is up to date')"
check "data still intact after reversal + re-apply (seeded counts + 1 parent-path insert)" "$(echo "$PRE_COUNTS" | awk -F/ '{print $1+1"/"$2"/"$3"/"$4}')" "$(q "$PG_URL" "$COUNT_SQL")"
check "row content intact (seeded bodies present, read by BYPASSRLS owner)" "seed-1,seed-2,via-parent" "$(q "$PG_URL" "select string_agg(body, ',' order by body) from community_messages")"

rm -rf "$TMP"
echo "== $PASS passed, $FAIL failed (server $(q "$PG_URL" 'show server_version'), head $(git rev-parse --short HEAD 2>/dev/null)$(git diff --quiet HEAD -- prisma/migrations/$MIG test/db 2>/dev/null || echo "+dirty"))"
[ $FAIL -eq 0 ]
