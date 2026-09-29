#!/usr/bin/env bash
# S12-B4 validation harness — NOT part of the pilot pack. Runs 00-07 with the synthetic
# parameters against the throwaway local PG this script is given, using the exact same SELECT
# statements the pack ships (extracted verbatim, not paraphrased). Never point $1 at anything
# but a throwaway local database.
set -uo pipefail
DBURL="$1"
PSQL=/usr/bin/psql
COACH_C=11111111-1111-1111-1111-111111111111
COACH_D=22222222-2222-2222-2222-222222222222
INTENT_1=33333333-3333-3333-3333-333333333333
INTENT_OPEN=ffffffff-ffff-ffff-ffff-ffffffffffff

run() {
  local label="$1"; shift
  echo "=== $label ==="
  "$PSQL" "$DBURL" -v ON_ERROR_STOP=1 "$@"
  echo "RC=$?"
}

run "00_find_coach (coach-c@example.test)" -v email="coach-c@example.test" -f docs/pilot/sql/00_find_coach.sql
run "01_run_identity (coach C, settled run)" -v coach_id="$COACH_C" -v intent_id="$INTENT_1" -f docs/pilot/sql/01_run_identity.sql
run "01_run_identity (coach C, OPEN run)" -v coach_id="$COACH_C" -v intent_id="$INTENT_OPEN" -f docs/pilot/sql/01_run_identity.sql
run "02_declarations_and_observations" -v coach_id="$COACH_C" -v intent_id="$INTENT_1" -f docs/pilot/sql/02_declarations_and_observations.sql
run "03_settled_basis" -v coach_id="$COACH_C" -v intent_id="$INTENT_1" -f docs/pilot/sql/03_settled_basis.sql
run "04_provenance_and_roster" -v coach_id="$COACH_C" -v intent_id="$INTENT_1" -f docs/pilot/sql/04_provenance_and_roster.sql
run "05_tenant_isolation (window covers seed)" -v coach_id="$COACH_C" -v window_start="2000-01-01T00:00:00Z" -v window_end="2100-01-01T00:00:00Z" -f docs/pilot/sql/05_tenant_isolation.sql
run "06_open_runs (coach C)" -v coach_id="$COACH_C" -f docs/pilot/sql/06_open_runs.sql
run "07_client_directed_sends (7a; 7b is an environment-specific template, not run)" -v coach_id="$COACH_C" -v intent_id="$INTENT_1" -f docs/pilot/sql/validation/07a_extracted_for_validation.sql
