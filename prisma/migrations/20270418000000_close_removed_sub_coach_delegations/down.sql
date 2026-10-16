-- Reverse of 20270418000000_close_removed_sub_coach_delegations. Only for a
-- confirmed defect: reopening a delegation gives the removed sub-coach back
-- read access to that client.
--
-- Reopens exactly the delegations the migration closed (found through its
-- AuditLog rows) and deletes those AuditLog rows. A delegation is left closed
-- when the pair's seat is active again (a re-invited sub-coach starts with no
-- clients) or when the client has another open delegation now (one open
-- delegation per client). No schema change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

WITH reopened AS (
  UPDATE "SubCoachAssignment" s
     SET "unassigned_at" = NULL
    FROM "AuditLog" a, "TeamSubCoachAssignment" t
   WHERE a."action" = 'sub_coach.assignment_closed_on_removal'
     AND a."metadata" ->> 'migration' = '20270418000000_close_removed_sub_coach_delegations'
     AND a."target_id" = s."id"
     AND t."head_coach_id" = s."head_coach_id"
     AND t."sub_coach_id" = s."sub_coach_id"
     AND t."archived_at" IS NOT NULL
     AND s."unassigned_at" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "SubCoachAssignment" o
        WHERE o."client_id" = s."client_id" AND o."unassigned_at" IS NULL
     )
  RETURNING s."id"
)
DELETE FROM "AuditLog"
 WHERE "action" = 'sub_coach.assignment_closed_on_removal'
   AND "metadata" ->> 'migration' = '20270418000000_close_removed_sub_coach_delegations'
   AND "target_id" IN (SELECT "id" FROM reopened);

COMMIT;
