-- SPACE-OWNER-ALERTS (owner rule D, 10-26): in a public space "ALL alerts and information go to the space
-- owner and their team, plus your resident coach (or just the space owner if coachless)". The space owner
-- and their team already read the space (community_can_access). The poster's own coach is not a member of
-- another coach's public space, so the API (src/community/inbox/community-coach-inbox.repository.ts) now
-- hands that coach their client's rows there, and these PERMISSIVE SELECT policies let the row layer agree:
-- a signed-in coach reads a row of a public space whose author is their current client (a student whose
-- coach_id is them). Nothing else: no other author, no space that is not public, no DM, no deleted or
-- unreleased row. The RESTRICTIVE policies still AND on top (*_author_stays, *_unbanned_unblocked: a ban
-- or a block either way still hides the row). No table, column, data or table grant changes.
-- Reverse: down.sql. Live proof: test/rls/community-coach-inbox-voice-rls.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- True when the space is public and the author is the caller's current client. Answers one yes/no and
-- exposes no row of "User" or "community_cohorts"; a caller with no id gets false.
CREATE FUNCTION app.community_public_row_of_my_client(p_cohort_id uuid, p_author_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p_cohort_id IS NOT NULL AND p_author_id IS NOT NULL AND app.current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public."community_cohorts" c
      WHERE c."id" = p_cohort_id AND c."visibility" = 'public'
    )
    AND EXISTS (
      SELECT 1 FROM public."User" u
      WHERE u."id" = p_author_id AND u."role" = 'student' AND u."coach_id" = app.current_user_id()
    )
$fn$;
ALTER FUNCTION app.community_public_row_of_my_client(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_public_row_of_my_client(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_public_row_of_my_client(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_public_row_of_my_client(uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_public_row_of_my_client(uuid, text) IS
  '20270502009800: true when the space is public and the author is the caller''s current client (rule D: the poster''s own coach).';

DROP POLICY IF EXISTS "community_messages_public_own_coach" ON "community_messages";
CREATE POLICY "community_messages_public_own_coach" ON "community_messages" FOR SELECT TO authenticated
  USING ("scope" = 'cohort' AND app.community_public_row_of_my_client("cohort_id", "sender_id"));

DROP POLICY IF EXISTS "community_posts_public_own_coach" ON "community_posts";
CREATE POLICY "community_posts_public_own_coach" ON "community_posts" FOR SELECT TO authenticated
  USING ("scope" = 'cohort' AND ("release_at" IS NULL OR "release_at" <= now()) AND "visibility" = 'active'
         AND app.community_public_row_of_my_client("cohort_id", "author_id"));

DROP POLICY IF EXISTS "community_voice_notes_public_own_coach" ON "community_voice_notes";
CREATE POLICY "community_voice_notes_public_own_coach" ON "community_voice_notes" FOR SELECT TO authenticated
  USING ("soft_deleted_at" IS NULL AND "conversation_id" IS NULL
         AND app.community_public_row_of_my_client("cohort_id", "author_id"));

COMMIT;
