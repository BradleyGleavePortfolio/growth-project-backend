-- SUBREVOKE: removing a sub-coach ends their client assignments.
--
-- Until now, removing or revoking a sub-coach archived their seat
-- (TeamSubCoachAssignment.archived_at) but left every SubCoachAssignment
-- delegation from that head coach open, so a removed sub-coach kept reading
-- the delegated clients (for example through app.caller_coaches_client).
-- The code now closes those delegations in the removal transaction. This data
-- migration closes the ones already left open by earlier removals.
--
-- Rule: close every open delegation whose (head coach, sub-coach) pair has an
-- archived seat. The pair is unique on TeamSubCoachAssignment, so an archived
-- seat means the pair has no active seat. A pair that never had a seat
-- (legacy delegation) is untouched, as is any pair whose seat is active.
--
-- Record: one AuditLog row per closed delegation (action
-- sub_coach.assignment_closed_on_removal, target_id = the delegation id,
-- metadata.migration = this directory). down.sql reopens exactly those rows.
--
-- Data only: no schema change. Like the earlier data migrations on these
-- row-secured tables it relies on the migration role bypassing row security.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

WITH closed AS (
  UPDATE "SubCoachAssignment" s
     SET "unassigned_at" = CURRENT_TIMESTAMP
    FROM "TeamSubCoachAssignment" t
   WHERE t."head_coach_id" = s."head_coach_id"
     AND t."sub_coach_id" = s."sub_coach_id"
     AND t."archived_at" IS NOT NULL
     AND s."unassigned_at" IS NULL
  RETURNING s."id", s."head_coach_id", s."sub_coach_id", s."client_id", t."archived_at"
)
INSERT INTO "AuditLog" ("id", "action", "actor_role", "target_user_id", "target_type", "target_id", "tenant_coach_id", "metadata")
SELECT gen_random_uuid()::text,
       'sub_coach.assignment_closed_on_removal',
       'system',
       c."client_id",
       'sub_coach_assignment',
       c."id",
       c."head_coach_id",
       jsonb_build_object(
         'migration', '20270418000000_close_removed_sub_coach_delegations',
         'sub_coach_id', c."sub_coach_id",
         'seat_archived_at', c."archived_at"
       )
  FROM closed c;

COMMIT;
