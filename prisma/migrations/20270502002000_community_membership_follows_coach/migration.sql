-- COMMUNITYMOVE (agent 146, owner 4: "the former coach loses access to a
-- moved client's rows and the client's history follows the client"; "RLS for
-- everything!").
--
-- GAP: nothing ended a client's community membership when their coach
-- changed. GET /community/me picks the client's oldest active membership and
-- only joins them to their coach's community when they have none, so a client
-- who moved stayed in the old coach's community (its Hall, spaces and the
-- first names of its members) and was never joined to the new one. The old
-- coach kept them on the member list, and the row policies, which go by
-- membership, kept the old community readable.
--
-- NOW, one rule, app.community_author_moved(user, workspace): the user is a
-- client (User.role student, never the writable membership role) who is not,
-- or no longer, the client of the coach who owns the community, or of that
-- coach's team (app.client_in_coach_tenant, 20270414000000). Owner 137-8:
-- "when a client moves, the old coach loses everything at once, and the
-- history stays with the client". It is used three ways:
--   * app.close_community_memberships_left_by_move(user): ends every open
--     membership of such a user (status 'removed' with removed_at, the soft end
--     the coach's Remove uses), whatever the row's role label says. Nothing is
--     deleted: posts, comments, messages, wins and the membership row stay.
--     A trigger on "User" runs it in the same transaction as every write that
--     changes coach_id, and it runs once below for clients who already moved.
--     The next GET /community/me joins the client to the new coach's community
--     (existing bootstrap; a durable ban there still keeps them out).
--   * Row policies: one RESTRICTIVE policy per table that holds a person's
--     community rows (posts, comments and cohort messages, reactions, voice
--     notes, search entries, RSVPs, challenge entries, memberships). It ANDs
--     with every permissive arm (coach_all, member select, the shared-cohort
--     peer select), so the coach who owns the community reads and writes none
--     of a moved client's rows by any route, including a membership the coach
--     wrote for themselves. Everyone else reads as before: the moved client
--     their own rows, the clients who stayed the community history (owner
--     question MOVE-POSTS is open; app.community_row_hidden_from_caller is the
--     one place to widen). Coach, assistant, team-head and current-client rows
--     are unchanged.
--   * The server (Prisma credentials bypass RLS) calls the same function to
--     hide moved clients from the former coach on every community read (see
--     src/community/community-former-clients.ts). Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.community_author_moved(p_user_id text, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public."community_workspaces" w, public."User" u
     WHERE w."id" = p_workspace_id
       AND u."id" = p_user_id
       AND u."role" = 'student'
       AND NOT app.client_in_coach_tenant(p_user_id, w."coach_id")
  )
$$;
COMMENT ON FUNCTION app.community_author_moved(text, uuid) IS
  'COMMUNITYMOVE (20270502002000): true when the user is a client (User.role student) who is not, or no longer, in the tenant of the coach who owns the community (app.client_in_coach_tenant). The one moved-author rule for the close function, the row policies and the server.';

CREATE OR REPLACE FUNCTION app.community_row_hidden_from_caller(p_user_id text, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."community_workspaces" w
     WHERE w."id" = p_workspace_id AND w."coach_id" = app.current_user_id()
  ) AND app.community_author_moved(p_user_id, p_workspace_id)
$$;
COMMENT ON FUNCTION app.community_row_hidden_from_caller(text, uuid) IS
  'COMMUNITYMOVE (20270502002000): true when the caller owns the community and the row belongs to a client who moved away (app.community_author_moved). Used by the restrictive community policies.';

CREATE OR REPLACE FUNCTION app.close_community_memberships_left_by_move(p_user_id text)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH closed AS (
    UPDATE public."community_memberships" m
       SET "status" = 'removed', "removed_at" = now(), "updated_at" = now()
     WHERE m."user_id" = p_user_id
       AND m."status" <> 'removed'
       AND app.community_author_moved(p_user_id, m."workspace_id")
    RETURNING 1
  )
  SELECT count(*)::integer FROM closed
$$;
COMMENT ON FUNCTION app.close_community_memberships_left_by_move(text) IS
  'COMMUNITYMOVE (20270502002000): ends (status removed, removed_at) every open membership, whatever its role label, in a community the client moved away from (app.community_author_moved). Deletes nothing. Returns the number ended. Server-only.';

CREATE OR REPLACE FUNCTION app.community_memberships_follow_coach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM app.close_community_memberships_left_by_move(NEW."id");
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.community_memberships_follow_coach() IS
  'COMMUNITYMOVE (20270502002000): AFTER UPDATE OF coach_id on "User": ends the user''s memberships in communities they left (app.close_community_memberships_left_by_move).';

REVOKE ALL ON FUNCTION app.community_author_moved(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.community_row_hidden_from_caller(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.close_community_memberships_left_by_move(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.community_memberships_follow_coach() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.community_author_moved(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION app.community_row_hidden_from_caller(text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.close_community_memberships_left_by_move(text) TO service_role;

DROP TRIGGER IF EXISTS "trg_user_coach_change_closes_community" ON public."User";
CREATE TRIGGER "trg_user_coach_change_closes_community"
  AFTER UPDATE OF "coach_id" ON public."User"
  FOR EACH ROW
  WHEN (OLD."coach_id" IS DISTINCT FROM NEW."coach_id")
  EXECUTE FUNCTION app.community_memberships_follow_coach();

-- The coach who owns a community reads and writes none of a moved client's
-- rows, by any permissive arm (RESTRICTIVE policies AND with all of them).
DROP POLICY IF EXISTS "community_posts_moved_client_out" ON public."community_posts";
CREATE POLICY "community_posts_moved_client_out" ON public."community_posts" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("author_id", "workspace_id"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("author_id", "workspace_id"));
DROP POLICY IF EXISTS "community_messages_moved_client_out" ON public."community_messages";
CREATE POLICY "community_messages_moved_client_out" ON public."community_messages" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("sender_id", "workspace_id"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("sender_id", "workspace_id"));
DROP POLICY IF EXISTS "community_responses_moved_client_out" ON public."community_responses";
CREATE POLICY "community_responses_moved_client_out" ON public."community_responses" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"));
DROP POLICY IF EXISTS "community_voice_notes_moved_client_out" ON public."community_voice_notes";
CREATE POLICY "community_voice_notes_moved_client_out" ON public."community_voice_notes" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("author_id", "workspace_id"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("author_id", "workspace_id"));
DROP POLICY IF EXISTS "community_search_entries_moved_client_out" ON public."community_search_entries";
CREATE POLICY "community_search_entries_moved_client_out" ON public."community_search_entries" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("authorId"::text, "workspaceId"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("authorId"::text, "workspaceId"));
DROP POLICY IF EXISTS "community_event_rsvps_moved_client_out" ON public."community_event_rsvps";
CREATE POLICY "community_event_rsvps_moved_client_out" ON public."community_event_rsvps" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"));
DROP POLICY IF EXISTS "community_challenge_participations_moved_client_out" ON public."community_challenge_participations";
CREATE POLICY "community_challenge_participations_moved_client_out" ON public."community_challenge_participations" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"));
DROP POLICY IF EXISTS "community_memberships_moved_client_out" ON public."community_memberships";
CREATE POLICY "community_memberships_moved_client_out" ON public."community_memberships" AS RESTRICTIVE FOR ALL TO public
  USING (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"))
  WITH CHECK (NOT app.community_row_hidden_from_caller("user_id", "workspace_id"));

-- Clients who moved before this migration: the same rule, once.
DO $$
BEGIN
  PERFORM app.close_community_memberships_left_by_move(open_member."user_id")
     FROM (
       SELECT DISTINCT "user_id" FROM public."community_memberships"
        WHERE "status" <> 'removed'
     ) open_member;
END
$$;

COMMIT;
