-- RLSLIVE2a (RLSINV G02, G03, G04; owner "RLS for everything!", "The new
-- coach never sees coach A's chat, private notes, nudges or tags"): coach
-- nudges and review markers belong to the coaching relationship they were
-- written in, clients never write coach-only rows, and a DM needs workspace
-- membership and a recipient in that workspace. Policy text, comments and one
-- helper only: no data, grant on a table, or column change.
--
-- GAP:
--   * CoachNudge p_coachnudge_*: one branch set for every command,
--     coach_id = caller OR client_id = caller OR app.is_current_coach_of
--     (client_id). The new coach read, edited and deleted every nudge the
--     former coach sent a moved client; the former coach kept them; the client
--     inserted nudges "from" any coach and edited or deleted them (G02).
--   * ConversationReview conversation_review_participant_access (FOR ALL;
--     20270412000000 already ends the former coach's branch): the client
--     inserted, updated and deleted the coach's "reviewed" marker, which hides
--     unread messages from the coach's triage (G03).
--   * community_messages_author_insert: the DM branch was only
--     recipient_user_id IS NOT NULL, so a member posted a DM into any
--     workspace, to anyone, where that workspace's coach then read it (G04).
--
-- NOW:
--   * CoachNudge: read by the client (every nudge they ever got: history
--     follows the client), by the sending coach while the client is still
--     theirs, and by the owner admin. Written (insert, update, delete) only by
--     the sending coach, as coach_id, for a client they coach now.
--   * ConversationReview: conversation_review_coach_access (FOR ALL) is the
--     marker's coach while the client is still theirs. The client reads every
--     marker of their own threads, old ones included (history follows the
--     client; conversation_review_client_read backs the client's "coach
--     reviewed" read, MessagingService.coachReviewForClient) and writes none.
--     owner_all unchanged.
--   * community_messages: a DM is inserted by its sender only as a member of
--     the workspace (app.is_community_workspace_member), to a recipient who is
--     a participant of that same workspace (new app.workspace_has_participant:
--     its coach or a member who was not removed). The workspace coach's DM
--     needs that same recipient rule; the coach's cohort posts and the cohort
--     branch are unchanged.
-- Every branch keys on app.current_user_id() and the tenure helper
-- app.is_user_coached_by (SECURITY DEFINER, 20260607000000), never auth.uid():
-- a Data API caller (JWT, no GUC) reads and writes nothing here.
--
-- Nothing in the app depends on the dropped or narrowed branches: Prisma
-- connects as service_role (BYPASSRLS), and every read and write of these
-- tables is a Prisma call (src/nudges/nudges.service.ts, src/coach/command-
-- center/churn-intervention.service.ts, src/users/account.service.ts,
-- src/messaging/messaging.service.ts, src/coach/home/coach-home.service.ts,
-- src/community/dms|messages|ack|challenges repositories). src/ never sets a
-- role and uses no Supabase client on a table; RlsContextInterceptor sets no
-- GUC (req.user is the Prisma User row, without .sub). The mobile app uses
-- Supabase only for auth and broadcast channels.
-- Merge order: after #973 (20270412000000 rewrites the policy this drops).
-- Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- CoachNudge.
ALTER POLICY "p_coachnudge_select" ON "CoachNudge"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id")))));
COMMENT ON POLICY "p_coachnudge_select" ON "CoachNudge" IS '20270502000200: the nudge client (all history), the sending coach while the client is still theirs, or an owner may read.';
ALTER POLICY "p_coachnudge_insert" ON "CoachNudge"
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"));
COMMENT ON POLICY "p_coachnudge_insert" ON "CoachNudge" IS '20270502000200: only the sending coach, for a client they coach now, may insert.';
ALTER POLICY "p_coachnudge_update" ON "CoachNudge"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"));
COMMENT ON POLICY "p_coachnudge_update" ON "CoachNudge" IS '20270502000200: only the sending coach, for a client they coach now, may update.';
ALTER POLICY "p_coachnudge_delete" ON "CoachNudge"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"));
COMMENT ON POLICY "p_coachnudge_delete" ON "CoachNudge" IS '20270502000200: only the sending coach, for a client they coach now, may delete.';

-- ConversationReview.
DROP POLICY "conversation_review_participant_access" ON "ConversationReview";
CREATE POLICY "conversation_review_coach_access" ON "ConversationReview"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"))
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"));
COMMENT ON POLICY "conversation_review_coach_access" ON "ConversationReview" IS '20270502000200: the marker coach reads and writes it while the client is still theirs.';
CREATE POLICY "conversation_review_client_read" ON "ConversationReview"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id());
COMMENT ON POLICY "conversation_review_client_read" ON "ConversationReview" IS '20270502000200: the client reads every marker of their own threads (history follows the client), and writes none.';

-- community_messages: the DM branch.
CREATE FUNCTION app.workspace_has_participant(p_workspace_id uuid, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p_workspace_id IS NOT NULL AND p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public."community_workspaces" w WHERE w."id" = p_workspace_id AND w."coach_id" = p_user_id)
    OR EXISTS (SELECT 1 FROM public."community_memberships" m
               WHERE m."workspace_id" = p_workspace_id AND m."user_id" = p_user_id AND m."status" <> 'removed')
  )
$fn$;
ALTER FUNCTION app.workspace_has_participant(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.workspace_has_participant(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.workspace_has_participant(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.workspace_has_participant(uuid, text) TO authenticated;
COMMENT ON FUNCTION app.workspace_has_participant(uuid, text) IS
  '20270502000200: the user is the workspace coach or holds a membership there that was not removed (the DM recipient rule of community_messages_author_insert).';

ALTER POLICY "community_messages_author_insert" ON "community_messages"
  WITH CHECK (
    "sender_id"::text = app.current_user_id()
    AND (
      (app.is_community_workspace_coach("workspace_id")
       AND ("scope" <> 'dm' OR app.workspace_has_participant("workspace_id", "recipient_user_id")))
      OR ("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))
      OR ("scope" = 'dm' AND app.is_community_workspace_member("workspace_id")
          AND app.workspace_has_participant("workspace_id", "recipient_user_id"))
    )
  );

COMMIT;
