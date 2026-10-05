-- Rollback for 20270303000000_messaging_core_actions.
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
