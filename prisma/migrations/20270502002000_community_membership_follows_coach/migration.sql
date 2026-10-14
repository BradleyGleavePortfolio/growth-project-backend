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
-- NOW, one rule, at the row that changes: a client's open memberships in a
-- community whose coach is not their coach (or the head of their coach's team,
-- app.client_in_coach_tenant, 20270414000000) are ended.
--   * app.close_community_memberships_left_by_move(user): sets those rows to
--     status 'removed' with removed_at, the same soft end the coach's Remove
--     uses. Nothing is deleted: posts, comments, wins and the membership row
--     itself stay (erasure and retention rules unchanged). Returns the count.
--   * A trigger on "User" runs it in the same transaction as every write that
--     changes coach_id (team moves, account-deletion detach, an owner's fix),
--     so no move path can miss it. The next GET /community/me finds no open
--     membership and joins the client to the new coach's community (existing
--     bootstrap; a durable ban there still keeps them out).
--   * The rule runs once below for clients who moved before this migration.
--   * community_memberships_coach_all: a workspace coach reads and writes a
--     client's membership only while that client is still theirs (same helper),
--     so the former coach reads none of a moved client's rows, ended or not.
--     Rows of coach and assistant members are unchanged.
-- The client-side helpers already ignore 'removed' rows, so the moved client
-- reads nothing of the old community. The backend reads through Prisma
-- credentials that bypass RLS; its community checks already require an active
-- membership. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
      FROM public."community_workspaces" w, public."User" u
     WHERE m."user_id" = p_user_id
       AND m."role" = 'student'
       AND m."status" <> 'removed'
       AND w."id" = m."workspace_id"
       AND u."id" = p_user_id
       AND u."role" = 'student'
       AND NOT app.client_in_coach_tenant(p_user_id, w."coach_id")
    RETURNING 1
  )
  SELECT count(*)::integer FROM closed
$$;
COMMENT ON FUNCTION app.close_community_memberships_left_by_move(text) IS
  'COMMUNITYMOVE (20270502002000): for a client (role student), ends (status removed, removed_at) every open client membership in a community whose coach is not the user''s coach or team head (app.client_in_coach_tenant). Deletes nothing. Returns the number ended. Server-only.';

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

REVOKE ALL ON FUNCTION app.close_community_memberships_left_by_move(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.community_memberships_follow_coach() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.close_community_memberships_left_by_move(text) TO service_role;

DROP TRIGGER IF EXISTS "trg_user_coach_change_closes_community" ON public."User";
CREATE TRIGGER "trg_user_coach_change_closes_community"
  AFTER UPDATE OF "coach_id" ON public."User"
  FOR EACH ROW
  WHEN (OLD."coach_id" IS DISTINCT FROM NEW."coach_id")
  EXECUTE FUNCTION app.community_memberships_follow_coach();

-- The former coach reads and writes a client's membership only while the
-- client is still theirs.
ALTER POLICY "community_memberships_coach_all" ON public."community_memberships"
  USING (
    app.is_community_workspace_coach("workspace_id")
    AND ("role" <> 'student' OR app.client_in_coach_tenant("user_id", app.current_user_id()))
  )
  WITH CHECK (
    app.is_community_workspace_coach("workspace_id")
    AND ("role" <> 'student' OR app.client_in_coach_tenant("user_id", app.current_user_id()))
  );

-- Clients who moved before this migration: the same rule, once.
DO $$
BEGIN
  PERFORM app.close_community_memberships_left_by_move(open_member."user_id")
     FROM (
       SELECT DISTINCT "user_id" FROM public."community_memberships"
        WHERE "role" = 'student' AND "status" <> 'removed'
     ) open_member;
END
$$;

COMMIT;
