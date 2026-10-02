-- Reverse of 20270211000000_community_reports_voice_notes_and_wins.
--
-- Drops "CommunityWin"."hidden_at". This UN-HIDES every win a moderator hid:
-- run it only after re-hiding or deleting those rows by another route, or
-- before any win has been hidden. The enum values 'voice_note' and 'win' on
-- "CommunityModerationTargetType" cannot be dropped on PostgreSQL < 17; they
-- stay. Rows in community_moderation_actions that use them must be deleted
-- or re-pointed by hand before any rollback of the application code that
-- writes them (older code would fail to parse those rows).
ALTER TABLE "CommunityWin" DROP COLUMN IF EXISTS "hidden_at";
