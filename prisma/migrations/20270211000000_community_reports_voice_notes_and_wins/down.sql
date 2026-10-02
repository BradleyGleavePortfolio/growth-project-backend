-- Reverse of 20270211000000_community_reports_voice_notes_and_wins.
--
-- Restores the pre-PR "CommunityWin" policies (including the public read arm),
-- drops the moderation-column trigger, the teammate helper and the durable ban
-- table, then "CommunityWin"."hidden_at".
--
-- Dropping hidden_at UN-HIDES every win a moderator hid, and dropping
-- community_workspace_bans forgets every durable ban (members stay removed only
-- where a removed membership row exists): run it only after re-hiding or
-- deleting those rows by another route, or before any win has been hidden or
-- member banned. Legacy wins migrated from 'public' to 'circle' stay 'circle'
-- (the original value is not recorded; circle is the safe value).
-- The enum values 'voice_note' and 'win' on "CommunityModerationTargetType"
-- cannot be dropped on PostgreSQL < 17; they stay. Rows in
-- community_moderation_actions that use them must be deleted or re-pointed by
-- hand before any rollback of the application code that writes them (older
-- code would fail to parse those rows).
-- Section 5 (comments on workspace-wide posts / challenges): restoring the
-- original scope-shape check fails while any cohort-less comment row exists;
-- delete or re-home those comments first.
ALTER TABLE "community_messages" DROP CONSTRAINT IF EXISTS "community_messages_scope_shape_check";
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_scope_shape_check" CHECK (
    ("scope" = 'cohort' AND "cohort_id" IS NOT NULL AND "dm_key" IS NULL)
    OR ("scope" = 'dm' AND "cohort_id" IS NULL AND "dm_key" IS NOT NULL)
);

DROP TRIGGER IF EXISTS trg_community_win_guard_moderation ON "CommunityWin";
DROP FUNCTION IF EXISTS public.community_win_guard_moderation();

DROP POLICY IF EXISTS "p_communitywin_select" ON "CommunityWin";
CREATE POLICY "p_communitywin_select" ON "CommunityWin" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR ("visibility" = 'public') OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_communitywin_insert" ON "CommunityWin";
CREATE POLICY "p_communitywin_insert" ON "CommunityWin" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_communitywin_update" ON "CommunityWin";
CREATE POLICY "p_communitywin_update" ON "CommunityWin" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));

DROP FUNCTION IF EXISTS app.community_win_teammate_visible(text, text);

DROP TABLE IF EXISTS "community_workspace_bans";

ALTER TABLE "CommunityWin" DROP COLUMN IF EXISTS "hidden_at";
