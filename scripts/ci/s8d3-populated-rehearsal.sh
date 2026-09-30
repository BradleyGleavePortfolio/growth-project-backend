#!/usr/bin/env bash
# S8-D3 populated-data rollout / rollback rehearsal (PR #587 fix round 2, R587-c7B-04; G13).
#
# Proves, on a real PostgreSQL with POPULATED tables, that every S8-D3 directory (20270125*: the
# twelve D3 directories 20270125000000 .. 20270125000011 plus D8's 20270125000012 when it is stacked
# on top — the glob below decides, at least 12) applies forward through the real release mechanism
# (`prisma migrate deploy`), that the full down chain (newest first) reverses them WITHOUT touching a
# row, and that the forward chain applies again — with row counts and per-table checksums identical
# at every stage, every S8-D3 constraint VALIDATED and every CONCURRENTLY index VALID at the end.
# Every phase is timed and the row counts are printed, so the log is the evidence record. TIMING lines
# are written on fd 3 (a dup of the script's stdout taken before any redirect), so a `>/dev/null` on a
# timed psql/prisma command silences that command's output WITHOUT swallowing its timing
# (S4B-C01: at 798208b7 only two of the sixteen-plus timings reached the CI log).
#
# Also proves the step-1 down's FAIL-CLOSED guard on populated data: with ONE person-owned row
# present the down refuses (fixed text) and drops nothing; after the row is moved it succeeds.
#
# Inputs: DATABASE_URL / DIRECT_URL (the disposable CI database; the Supabase-equivalent bootstrap
# already applied), REHEARSAL_SCALE (row multiplier, default 1 = about 1.0M rows across the twelve
# populated tables below; the scans this rehearses are linear in it).
#
# Not proof of: production row counts or production lock contention under live traffic. It is the
# populated rehearsal G13 asks for, on synthetic data of stated size.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PSQL_URL="${DATABASE_URL%%\?*}"
PSQL="psql --no-psqlrc -v ON_ERROR_STOP=1 -X -q $PSQL_URL"
SCALE="${REHEARSAL_SCALE:-1}"
S8D3_PREFIX=20270125
mapfile -t S8D3_DIRS < <(find prisma/migrations -mindepth 1 -maxdepth 1 -type d -name "${S8D3_PREFIX}*" | LC_ALL=C sort)
[[ ${#S8D3_DIRS[@]} -ge 12 ]] || { echo "expected at least 12 S8-D3 directories, found ${#S8D3_DIRS[@]}" >&2; exit 2; }

now_ms() { date +%s%3N; }
exec 3>&1 # evidence channel for TIMING lines: survives a per-command `>/dev/null` (S4B-C01)
timed() { # timed <label> <cmd...>   (the command's own stdout may be redirected by the caller)
  local label="$1"; shift
  local t0; t0=$(now_ms)
  "$@"
  local t1; t1=$(now_ms)
  echo "TIMING ${label}: $((t1 - t0)) ms" >&3
}
sql() { $PSQL -At -c "$1"; }

# ---------------------------------------------------------------------------------------------
# 1. Base chain (everything BEFORE S8-D3) through the real release mechanism, from a filtered copy
#    of the migrations tree (Prisma resolves `migrations/` next to the schema file).
# ---------------------------------------------------------------------------------------------
BASE_TREE="$(mktemp -d)"
cp prisma/schema.prisma "$BASE_TREE/schema.prisma"
mkdir -p "$BASE_TREE/migrations"
cp prisma/migrations/migration_lock.toml "$BASE_TREE/migrations/"
for d in prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" == ${S8D3_PREFIX}* ]] && continue
  cp -r "$d" "$BASE_TREE/migrations/$name"
done
BASE_COUNT=$(find "$BASE_TREE/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)
echo "== 1. applying the $BASE_COUNT pre-S8-D3 directories (prisma migrate deploy)"
timed "base-chain-deploy" npx prisma migrate deploy --schema "$BASE_TREE/schema.prisma" >/dev/null

# ---------------------------------------------------------------------------------------------
# 2. Populate (synthetic, deterministic ids; every row user-owned, exactly the production pre-state).
# ---------------------------------------------------------------------------------------------
echo "== 2. populating (REHEARSAL_SCALE=$SCALE)"
timed "populate" $PSQL <<SQL
SET row_security = off;
CREATE TEMP TABLE sc AS SELECT ${SCALE}::int AS k;
-- 40k coaches/clients per scale unit: 40 coaches, 2000 clients each; 10 sub-coaches are irrelevant here.
INSERT INTO public."User" ("id","supabase_id","email","name","role","coach_id")
SELECT 'reh-coach-'||g, gen_random_uuid()::text, 'reh-coach-'||g||'@example.invalid', 'c', 'coach'::"Role", NULL
FROM generate_series(1, 40 * (SELECT k FROM sc)) g;
INSERT INTO public."User" ("id","supabase_id","email","name","role","coach_id")
SELECT 'reh-client-'||g, gen_random_uuid()::text, 'reh-client-'||g||'@example.invalid', 'u', 'student'::"Role",
       'reh-coach-'||(1 + (g % (40 * (SELECT k FROM sc))))
FROM generate_series(1, 2000 * (SELECT k FROM sc)) g;
INSERT INTO public."WorkoutPlan" ("id","coach_id","name","type","updated_at")
SELECT 'reh-plan-'||g, 'reh-coach-'||(1 + (g % (40 * (SELECT k FROM sc)))), 'p', 'strength', now()
FROM generate_series(1, 2000 * (SELECT k FROM sc)) g;
INSERT INTO public."Person" ("id","coach_id","source_platform","source_person_id","display_name")
SELECT 'reh-person-'||g, 'reh-coach-'||(1 + (g % (40 * (SELECT k FROM sc)))), 'fixture', 'src-'||g, 'P'
FROM generate_series(1, 5000 * (SELECT k FROM sc)) g;
INSERT INTO public."WorkoutSession" ("id","user_id","date","workout_name","workout_type")
SELECT 'reh-ws-'||g, 'reh-client-'||(1 + (g % (2000 * (SELECT k FROM sc)))), DATE '2024-01-01' + (g % 365), 'w', 't'
FROM generate_series(1, 150000 * (SELECT k FROM sc)) g;
INSERT INTO public."ExerciseSet" ("id","workout_id","exercise_name","muscle_group","sets_completed","reps_per_set","weight_per_set")
SELECT 'reh-es-'||g, 'reh-ws-'||(1 + (g % (150000 * (SELECT k FROM sc)))), 'e', 'chest', 1, ARRAY[1], ARRAY[1.0::double precision]
FROM generate_series(1, 200000 * (SELECT k FROM sc)) g;
INSERT INTO public."WeightLog" ("id","user_id","date","weight_lbs")
SELECT 'reh-wl-'||g, 'reh-client-'||(1 + (g % (2000 * (SELECT k FROM sc)))), DATE '2024-01-01' + (g % 365), 100 + (g % 50)
FROM generate_series(1, 150000 * (SELECT k FROM sc)) g;
INSERT INTO public."Habit" ("id","user_id","name")
SELECT 'reh-habit-'||g, 'reh-client-'||(1 + (g % (2000 * (SELECT k FROM sc)))), 'h'
FROM generate_series(1, 20000 * (SELECT k FROM sc)) g;
INSERT INTO public."HabitLog" ("id","habit_id","date")
SELECT 'reh-hl-'||g, 'reh-habit-'||(1 + (g % (20000 * (SELECT k FROM sc)))), DATE '2024-01-01' + (g % 365)
FROM generate_series(1, 100000 * (SELECT k FROM sc)) g;
INSERT INTO public."CheckIn" ("id","user_id","coach_id","date","soreness")
SELECT 'reh-ci-'||g, 'reh-client-'||(1 + (g % (2000 * (SELECT k FROM sc)))),
       'reh-coach-'||(1 + ((1 + (g % (2000 * (SELECT k FROM sc)))) % (40 * (SELECT k FROM sc)))),
       DATE '2024-01-01' + (g % 365), 1 + (g % 5)
FROM generate_series(1, 100000 * (SELECT k FROM sc)) g;
INSERT INTO public."ClientWorkoutAssignment" ("id","workout_plan_id","client_id","assigned_by_coach_id","scheduled_for")
SELECT 'reh-cwa-'||g, 'reh-plan-'||(1 + (g % (2000 * (SELECT k FROM sc)))),
       'reh-client-'||(1 + (g % (2000 * (SELECT k FROM sc)))),
       'reh-coach-'||(1 + ((1 + (g % (2000 * (SELECT k FROM sc)))) % (40 * (SELECT k FROM sc)))),
       TIMESTAMP '2024-01-01 00:00:00' + (g % 365) * INTERVAL '1 day'
FROM generate_series(1, 100000 * (SELECT k FROM sc)) g;
INSERT INTO public."ClientWorkoutAssignmentSnapshot" ("id","assignment_id","plan_name","plan_type","exercises_json","source_plan_id","source_version")
SELECT 'reh-snap-'||g, 'reh-cwa-'||g, 'p', 'strength', '[]'::jsonb, 'reh-plan-'||(1 + (g % (2000 * (SELECT k FROM sc)))), 1
FROM generate_series(1, 20000 * (SELECT k FROM sc)) g;
-- native_kind is a closed vocabulary and native_id is NOT NULL exactly when outcome <> 'unresolved'
-- (20270122000000 CHECKs); 'person' rows point at the synthetic Person rows above.
INSERT INTO public."ImportNativeProvenance" ("id","coach_id","source_namespace","entity_type","source_id","native_kind","native_id","outcome")
SELECT 'reh-prov-'||g, 'reh-coach-'||(1 + (g % (40 * (SELECT k FROM sc)))), 'ns', 'person', 'src-'||g, 'person', 'reh-person-'||(1 + (g % (20000 * (SELECT k FROM sc)))), 'created'
FROM generate_series(1, 20000 * (SELECT k FROM sc)) g;
ANALYZE;
SQL

# Fixed column lists (the down drops person_id / linked_user_id; the checksum must not see them).
declare -A COLS=(
  [WorkoutSession]='"id","user_id","date","workout_name","workout_type"'
  [ExerciseSet]='"id","workout_id","exercise_name","sets_completed"'
  [WeightLog]='"id","user_id","date","weight_lbs"'
  [Habit]='"id","user_id","name"'
  [HabitLog]='"id","habit_id","date"'
  [CheckIn]='"id","user_id","coach_id","date","soreness"'
  [WorkoutPlan]='"id","coach_id","name"'
  [ClientWorkoutAssignment]='"id","workout_plan_id","client_id","assigned_by_coach_id","scheduled_for"'
  [ClientWorkoutAssignmentSnapshot]='"id","assignment_id","plan_name","source_plan_id","source_version"'
  [Person]='"id","coach_id","source_platform","source_person_id"'
  [ImportNativeProvenance]='"id","coach_id","source_namespace","entity_type","source_id","native_kind","native_id","outcome"'
  [User]='"id","role","coach_id"'
)
TABLES=(WorkoutSession ExerciseSet WeightLog Habit HabitLog CheckIn WorkoutPlan ClientWorkoutAssignment ClientWorkoutAssignmentSnapshot Person ImportNativeProvenance User)
fingerprint() { # prints "<table> <count> <md5>" per table
  for t in "${TABLES[@]}"; do
    sql "SET row_security = off; SELECT '$t', count(*), md5(coalesce(string_agg(ROW(${COLS[$t]})::text, '|' ORDER BY \"id\"), '')) FROM public.\"$t\""
  done
}
echo "== row counts / checksums BEFORE S8-D3"
FP0="$(fingerprint)"; printf '%s\n' "$FP0"

# ---------------------------------------------------------------------------------------------
# 3. Forward: the S8-D3 directories (12 D3 + D8's 000012 when stacked) through `prisma migrate deploy`
#    (timed as a whole).
# ---------------------------------------------------------------------------------------------
echo "== 3. forward: S8-D3 chain (prisma migrate deploy on the populated database)"
timed "s8d3-forward-deploy" npx prisma migrate deploy
APPLIED=$(sql "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name LIKE '${S8D3_PREFIX}%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
[[ "$APPLIED" == "${#S8D3_DIRS[@]}" ]] || { echo "FAIL: $APPLIED of ${#S8D3_DIRS[@]} S8-D3 directories recorded as applied" >&2; exit 1; }

verify_forward_state() {
  local invalid_idx invalid_con nn
  invalid_con=$(sql "SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname='public' AND NOT c.convalidated AND c.conname IN ('WorkoutSession_owner_xor_check','WeightLog_owner_xor_check','Habit_owner_xor_check','CheckIn_owner_xor_check','CheckIn_person_coach_check','ClientWorkoutAssignment_owner_xor_check','CheckIn_person_id_coach_id_fkey','PersonInvite_person_id_coach_id_fkey','PersonLink_person_id_coach_id_fkey','PersonLinkProposal_person_id_coach_id_fkey','WorkoutSession_person_id_fkey','WeightLog_person_id_fkey','Habit_person_id_fkey','ClientWorkoutAssignment_person_id_fkey','ImportNativeProvenance_person_id_fkey','Person_linked_user_id_fkey')")
  [[ "$invalid_con" == "0" ]] || { echo "FAIL: $invalid_con S8-D3 constraints are NOT validated" >&2; exit 1; }
  local present
  present=$(sql "SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname='public' AND c.conname IN ('WorkoutSession_owner_xor_check','WeightLog_owner_xor_check','Habit_owner_xor_check','CheckIn_owner_xor_check','CheckIn_person_coach_check','ClientWorkoutAssignment_owner_xor_check','CheckIn_person_id_coach_id_fkey','PersonInvite_person_id_coach_id_fkey','PersonLink_person_id_coach_id_fkey','PersonLinkProposal_person_id_coach_id_fkey','WorkoutSession_person_id_fkey','WeightLog_person_id_fkey','Habit_person_id_fkey','ClientWorkoutAssignment_person_id_fkey','ImportNativeProvenance_person_id_fkey','Person_linked_user_id_fkey')")
  [[ "$present" == "16" ]] || { echo "FAIL: $present of 16 S8-D3 constraints present" >&2; exit 1; }
  # Every index on the S8-D3 tables is valid (the CONCURRENTLY builds did not leave an INVALID index; R587-c7B C5).
  invalid_idx=$(sql "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid")
  [[ "$invalid_idx" == "0" ]] || { echo "FAIL: $invalid_idx INVALID index(es) after the forward chain" >&2; sql "SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid"; exit 1; }
  nn=$(sql "SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND NOT a.attisdropped AND a.attnotnull AND ((c.relname IN ('WorkoutSession','WeightLog','Habit','CheckIn') AND a.attname='user_id') OR (c.relname='ClientWorkoutAssignment' AND a.attname='client_id'))")
  [[ "$nn" == "0" ]] || { echo "FAIL: owner column still NOT NULL on $nn parent(s)" >&2; exit 1; }
  local pcount
  pcount=$(sql "SET row_security = off; SELECT (SELECT count(*) FROM public.\"WorkoutSession\" WHERE person_id IS NOT NULL) + (SELECT count(*) FROM public.\"WeightLog\" WHERE person_id IS NOT NULL) + (SELECT count(*) FROM public.\"Habit\" WHERE person_id IS NOT NULL) + (SELECT count(*) FROM public.\"CheckIn\" WHERE person_id IS NOT NULL) + (SELECT count(*) FROM public.\"ClientWorkoutAssignment\" WHERE person_id IS NOT NULL)")
  [[ "$pcount" == "0" ]] || { echo "FAIL: $pcount person-owned rows appeared (no backfill is allowed)" >&2; exit 1; }
  echo "  forward state OK: 16/16 constraints validated, 0 invalid indexes, owner columns nullable, 0 person-owned rows"
}
verify_forward_state
echo "== row counts / checksums AFTER forward"
FP1="$(fingerprint)"; printf '%s\n' "$FP1"
[[ "$FP0" == "$FP1" ]] || { echo "FAIL: data fingerprint changed across the forward chain" >&2; diff <(printf '%s\n' "$FP0") <(printf '%s\n' "$FP1") || true; exit 1; }

# ---------------------------------------------------------------------------------------------
# 4. Down chain, newest first, each directory timed. The step-1 down is first exercised with ONE
#    person-owned row present: it must refuse with the fixed text and drop nothing.
# ---------------------------------------------------------------------------------------------
echo "== 4. down chain (newest first) on the populated database"
for (( i = ${#S8D3_DIRS[@]} - 1; i >= 1; i-- )); do
  d="${S8D3_DIRS[$i]}"
  timed "down $(basename "$d")" $PSQL -f "$d/down.sql" >/dev/null
done
STEP1="${S8D3_DIRS[0]}"
[[ "$(basename "$STEP1")" == 20270125000000_* ]] || { echo "unexpected first directory $STEP1" >&2; exit 2; }
echo "  fail-closed check: one person-owned WorkoutSession row present"
sql "SET row_security = off; INSERT INTO public.\"WorkoutSession\" (\"id\",\"user_id\",\"person_id\",\"date\",\"workout_name\",\"workout_type\") VALUES ('reh-ws-person', NULL, 'reh-person-1', DATE '2024-06-01', 'w', 't')" >/dev/null
set +e
OUT=$($PSQL -f "$STEP1/down.sql" 2>&1)
RC=$?
set -e
[[ $RC -ne 0 ]] || { echo "FAIL: step-1 down succeeded with a person-owned row present" >&2; exit 1; }
grep -q "S8-D3 refuses removal of person-owned rows" <<<"$OUT" || { echo "FAIL: refusal text not found: $OUT" >&2; exit 1; }
RAILS=$(sql "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('PersonInvite','PersonInviteChallenge','PersonLink','PersonLinkProposal','PersonLinkOutbox')")
[[ "$RAILS" == "5" ]] || { echo "FAIL: refused down dropped link-rail tables ($RAILS of 5 remain)" >&2; exit 1; }
TMPCHK=$(sql "SELECT count(*) FROM pg_constraint WHERE conname LIKE '%_rollback_not_null'")
[[ "$TMPCHK" == "0" ]] || { echo "FAIL: refused down left $TMPCHK temporary rollback CHECK(s)" >&2; exit 1; }
echo "  refused as designed (rc=$RC), nothing dropped"
sql "SET row_security = off; DELETE FROM public.\"WorkoutSession\" WHERE \"id\" = 'reh-ws-person'" >/dev/null
timed "down $(basename "$STEP1") (populated; 3 transactions)" $PSQL -f "$STEP1/down.sql" >/dev/null
# Post-down state: owner columns NOT NULL again, person_id gone, no temporary CHECK left, rails gone.
NN=$(sql "SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND NOT a.attisdropped AND a.attnotnull AND ((c.relname IN ('WorkoutSession','WeightLog','Habit','CheckIn') AND a.attname='user_id') OR (c.relname='ClientWorkoutAssignment' AND a.attname='client_id'))")
[[ "$NN" == "5" ]] || { echo "FAIL: NOT NULL restored on $NN of 5 parents" >&2; exit 1; }
PCOL=$(sql "SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND NOT a.attisdropped AND ((c.relname IN ('WorkoutSession','WeightLog','Habit','CheckIn','ClientWorkoutAssignment','ImportNativeProvenance') AND a.attname='person_id') OR (c.relname='Person' AND a.attname='linked_user_id'))")
[[ "$PCOL" == "0" ]] || { echo "FAIL: $PCOL S8-D3 column(s) survived the down" >&2; exit 1; }
TMPCHK=$(sql "SELECT count(*) FROM pg_constraint WHERE conname LIKE '%_rollback_not_null'")
[[ "$TMPCHK" == "0" ]] || { echo "FAIL: $TMPCHK temporary rollback CHECK(s) left behind" >&2; exit 1; }
RAILS=$(sql "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('PersonInvite','PersonInviteChallenge','PersonLink','PersonLinkProposal','PersonLinkOutbox')")
[[ "$RAILS" == "0" ]] || { echo "FAIL: $RAILS link-rail table(s) survived the down" >&2; exit 1; }
echo "  down state OK: NOT NULL back on 5/5 parents, S8-D3 columns gone, no temporary CHECK, rails gone"
echo "== row counts / checksums AFTER down chain"
FP2="$(fingerprint)"; printf '%s\n' "$FP2"
[[ "$FP0" == "$FP2" ]] || { echo "FAIL: data fingerprint changed across the down chain" >&2; diff <(printf '%s\n' "$FP0") <(printf '%s\n' "$FP2") || true; exit 1; }

# ---------------------------------------------------------------------------------------------
# 5. Forward again (raw SQL, in order, as the reversibility job does) and re-verify.
# ---------------------------------------------------------------------------------------------
echo "== 5. forward again (raw migration.sql, in order)"
for d in "${S8D3_DIRS[@]}"; do
  timed "forward $(basename "$d")" $PSQL -f "$d/migration.sql" >/dev/null
done
verify_forward_state
echo "== row counts / checksums AFTER second forward"
FP3="$(fingerprint)"; printf '%s\n' "$FP3"
[[ "$FP0" == "$FP3" ]] || { echo "FAIL: data fingerprint changed across the second forward chain" >&2; diff <(printf '%s\n' "$FP0") <(printf '%s\n' "$FP3") || true; exit 1; }

echo "OK: S8-D3 populated rehearsal — forward (deploy) -> down chain -> forward (raw) with identical data; fail-closed guard honoured."
