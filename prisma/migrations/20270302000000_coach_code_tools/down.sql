-- Rollback for 20270302000000_coach_code_tools. Drops the signup ledger and
-- the four InviteCode columns. Codes keep working; signup history recorded
-- since deploy is lost.
DROP TABLE IF EXISTS "InviteRedemption";
DROP INDEX IF EXISTS "InviteCode_coach_id_idempotency_key_key";
DROP INDEX IF EXISTS "InviteCode_rotated_from_id_key";
ALTER TABLE "InviteCode" DROP CONSTRAINT IF EXISTS "InviteCode_rotated_from_id_fkey";
ALTER TABLE "InviteCode" DROP COLUMN IF EXISTS "rotated_from_id",
  DROP COLUMN IF EXISTS "idempotency_key",
  DROP COLUMN IF EXISTS "revoked_at",
  DROP COLUMN IF EXISTS "label";
