-- RLSLIVE3a (RLSINV H01-H04, H10 for check-ins and bloodwork; owner "RLS for
-- everything!", "History always follows the client", "Safety alerts are never
-- lost"): the health rows a coach reads through row security belong to the
-- client's current coach, whoever wrote them, and red-flag alerts stay with
-- the coach. Policy text and comments only: no data, grant, helper or table
-- change.
--
-- GAP (every branch below keyed on the writer, not on who coaches the client
-- now; app.is_current_coach_of reads "User".coach_id, so it ends at a move):
--   * CheckIn.check_in_coach_select and BloodworkPanel.bloodwork_panel_coach_
--     select admitted coach_id = caller: the former coach kept every row of a
--     moved client and the new coach read none of the earlier ones (H02, H10).
--   * p_bloodworkresult_* / p_bloodworkattachment_* select and insert carried
--     the same bare bp.coach_id branch through the panel join, and admitted
--     the current coach on insert; bloodwork_panel_current_coach_insert let a
--     coach create panels for a client. Lab rows are client-entered: coaches
--     only review and scan (src/bloodwork/coach-bloodwork.controller.ts) (H03).
--   * CoachAlert: the client read, resolved and deleted alerts about
--     themself, anyone in the row could insert one naming any coach, and the
--     alert's coach_id kept the former coach in after a move (H01).
--   * community_wearable_prompts(_sources): FOR ALL on the workspace alone,
--     so the former coach kept prompts built from a moved client's wearable
--     data (H04).
--
-- NOW:
--   * CheckIn, BloodworkPanel: the client's current coach reads every row,
--     from any tenure; a former coach reads none.
--   * BloodworkResult, BloodworkAttachment: read by the panel's client or the
--     client's current coach; written only by the panel's client (owner
--     admin unchanged). bloodwork_panel_current_coach_insert is dropped.
--   * CoachAlert: read and updated (USING and WITH CHECK) by the client's
--     current coach or the owner admin. No INSERT or DELETE policy: alerts
--     are created by the server only and can never be removed at the row
--     layer.
--   * Wearable prompts and their sources: the workspace coach, and only
--     while the prompt's client is still theirs.
-- Unchanged: the client's own branches, owner_all, the current-coach update
-- policies, the service_role policies.
--
-- Nothing in the app depends on the dropped or narrowed branches: Prisma
-- connects as service_role (BYPASSRLS; every read and write of these tables
-- is a Prisma call), src/ never sets a role or uses a Supabase client on a
-- table (SupabaseService uses the service-role key, for storage only), and
-- the mobile app uses Supabase only for auth and broadcast channels.
-- Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "check_in_coach_select" ON "CheckIn"
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("user_id"));
COMMENT ON POLICY "check_in_coach_select" ON "CheckIn" IS '20270502000100: the client''s current coach reads every check-in of the client, from any tenure; a former coach reads none.';

ALTER POLICY "bloodwork_panel_coach_select" ON "BloodworkPanel"
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("client_id"));
COMMENT ON POLICY "bloodwork_panel_coach_select" ON "BloodworkPanel" IS '20270502000100: the client''s current coach reads every panel of the client, from any tenure; a former coach reads none.';
DROP POLICY "bloodwork_panel_current_coach_insert" ON "BloodworkPanel";

ALTER POLICY "p_bloodworkresult_select" ON "BloodworkResult"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkResult"."panel_id" AND (bp."client_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkresult_select" ON "BloodworkResult" IS '20270502000100: read lab markers as the panel client, the client''s current coach, or an owner.';
ALTER POLICY "p_bloodworkresult_insert" ON "BloodworkResult"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkResult"."panel_id" AND bp."client_id" = app.current_user_id()))));
COMMENT ON POLICY "p_bloodworkresult_insert" ON "BloodworkResult" IS '20270502000100: lab markers are entered only by the panel client (or an owner); coaches review.';

ALTER POLICY "p_bloodworkattachment_select" ON "BloodworkAttachment"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkAttachment"."panel_id" AND (bp."client_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkattachment_select" ON "BloodworkAttachment" IS '20270502000100: read attachment pointers as the panel client, the client''s current coach, or an owner.';
ALTER POLICY "p_bloodworkattachment_insert" ON "BloodworkAttachment"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkAttachment"."panel_id" AND bp."client_id" = app.current_user_id()))));
COMMENT ON POLICY "p_bloodworkattachment_insert" ON "BloodworkAttachment" IS '20270502000100: attachment pointers are added only by the panel client (or an owner); coaches scan through the server.';

ALTER POLICY "p_coachalert_select" ON "CoachAlert"
  USING ((app.is_owner() OR app.is_current_coach_of("client_id")));
COMMENT ON POLICY "p_coachalert_select" ON "CoachAlert" IS '20270502000100: the client''s current coach (or an owner) reads alerts about the client; the client and a former coach read none.';
ALTER POLICY "p_coachalert_update" ON "CoachAlert"
  USING ((app.is_owner() OR app.is_current_coach_of("client_id")))
  WITH CHECK ((app.is_owner() OR app.is_current_coach_of("client_id")));
COMMENT ON POLICY "p_coachalert_update" ON "CoachAlert" IS '20270502000100: the client''s current coach (or an owner) acknowledges alerts about the client.';
DROP POLICY "p_coachalert_insert" ON "CoachAlert";
DROP POLICY "p_coachalert_delete" ON "CoachAlert";

ALTER POLICY "community_wearable_prompts_coach_all" ON "community_wearable_prompts"
  USING (app.is_community_workspace_coach("workspaceId") AND app.is_current_coach_of("clientId"))
  WITH CHECK (app.is_community_workspace_coach("workspaceId") AND app.is_current_coach_of("clientId"));
COMMENT ON POLICY "community_wearable_prompts_coach_all" ON "community_wearable_prompts" IS '20270502000100: the workspace coach, only while the prompt''s client is still theirs.';
ALTER POLICY "community_wearable_prompt_sources_coach_all" ON "community_wearable_prompt_sources"
  USING (EXISTS (SELECT 1 FROM "community_wearable_prompts" p WHERE p."id" = "community_wearable_prompt_sources"."promptId" AND app.is_community_workspace_coach(p."workspaceId") AND app.is_current_coach_of(p."clientId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "community_wearable_prompts" p WHERE p."id" = "community_wearable_prompt_sources"."promptId" AND app.is_community_workspace_coach(p."workspaceId") AND app.is_current_coach_of(p."clientId")));
COMMENT ON POLICY "community_wearable_prompt_sources_coach_all" ON "community_wearable_prompt_sources" IS '20270502000100: sources of a prompt the caller may read (workspace coach, client still theirs).';

COMMIT;
