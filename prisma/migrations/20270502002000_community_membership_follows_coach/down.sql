-- Down for 20270502002000_community_membership_follows_coach (COMMUNITYMOVE).
-- Drops the eight restrictive "*_moved_client_out" policies, the trigger and
-- its four functions. This brings back the gap: a coach change no longer ends
-- the client's old memberships, and the former coach reads a moved client's
-- community rows again. Memberships the migration or the trigger ended stay
-- ended: they cannot be told apart from a coach's Remove, and reopening them
-- would put moved clients back in the old coach's community. Nothing was
-- deleted, so there is nothing to restore.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "community_posts_moved_client_out" ON public."community_posts";
DROP POLICY IF EXISTS "community_messages_moved_client_out" ON public."community_messages";
DROP POLICY IF EXISTS "community_responses_moved_client_out" ON public."community_responses";
DROP POLICY IF EXISTS "community_voice_notes_moved_client_out" ON public."community_voice_notes";
DROP POLICY IF EXISTS "community_search_entries_moved_client_out" ON public."community_search_entries";
DROP POLICY IF EXISTS "community_event_rsvps_moved_client_out" ON public."community_event_rsvps";
DROP POLICY IF EXISTS "community_challenge_participations_moved_client_out" ON public."community_challenge_participations";
DROP POLICY IF EXISTS "community_memberships_moved_client_out" ON public."community_memberships";

DROP TRIGGER IF EXISTS "trg_user_coach_change_closes_community" ON public."User";
DROP FUNCTION IF EXISTS app.community_memberships_follow_coach();
DROP FUNCTION IF EXISTS app.close_community_memberships_left_by_move(text);
DROP FUNCTION IF EXISTS app.community_row_hidden_from_caller(text, uuid);
DROP FUNCTION IF EXISTS app.community_author_moved(text, uuid);

COMMIT;
