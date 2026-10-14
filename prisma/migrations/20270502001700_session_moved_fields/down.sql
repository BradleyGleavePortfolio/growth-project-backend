-- Reverse of 20270502001700_session_moved_fields (drops only what it added).
ALTER TABLE "CoachingSession"
  DROP COLUMN IF EXISTS "last_moved_at",
  DROP COLUMN IF EXISTS "moved_by_role",
  DROP COLUMN IF EXISTS "moved_from_start_at";
DROP TYPE IF EXISTS "SessionMovedBy";
