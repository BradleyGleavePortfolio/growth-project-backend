-- Rollback for 20270303000000_messaging_core_actions.
--
-- CoachMessage RLS: coach_message_participant_access is dropped only when the
-- forward migration created it (its ownership comment); a pre-existing policy
-- (production, or any chain-migrated database) is never dropped here. RLS
-- ENABLE + FORCE on CoachMessage stays on: a rollback never reopens a tenant
-- table (re-applying the forward migration is then a no-op for it).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = '"CoachMessage"'::regclass
       AND p.polname = 'coach_message_participant_access'
       AND obj_description(p.oid, 'pg_policy') = 'created by 20270303000000_messaging_core_actions'
  ) THEN
    DROP POLICY "coach_message_participant_access" ON "CoachMessage";
  END IF;
END $$;
DROP TABLE IF EXISTS "CoachThreadState";
ALTER TABLE "CoachMessage" DROP CONSTRAINT IF EXISTS "CoachMessage_reply_to_id_fkey";
DROP INDEX IF EXISTS "CoachMessage_sender_id_client_message_id_key";
DROP INDEX IF EXISTS "CoachMessage_coach_id_client_id_pinned_at_idx";
ALTER TABLE "CoachMessage"
  DROP COLUMN IF EXISTS "client_message_id",
  DROP COLUMN IF EXISTS "deleted_at",
  DROP COLUMN IF EXISTS "deleted_by_id",
  DROP COLUMN IF EXISTS "edited_at",
  DROP COLUMN IF EXISTS "pinned_at",
  DROP COLUMN IF EXISTS "pinned_by_id",
  DROP COLUMN IF EXISTS "reply_to_id";
