-- Reverse of 20270502000100_health_history_follows_the_client. Only for a
-- confirmed defect: it reopens H01-H04 (a former coach reads a moved client's
-- check-ins, bloodwork, alerts and wearable prompts; the client reads,
-- resolves and deletes alerts about themself) and H10 (the new coach reads no
-- earlier rows). Restores the text and comments of 20260607000000,
-- 20261212010000, 20261213000000 and 20261219000000 verbatim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "check_in_coach_select" ON "CheckIn"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
COMMENT ON POLICY "check_in_coach_select" ON "CheckIn" IS NULL;

ALTER POLICY "bloodwork_panel_coach_select" ON "BloodworkPanel"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
COMMENT ON POLICY "bloodwork_panel_coach_select" ON "BloodworkPanel" IS NULL;
CREATE POLICY "bloodwork_panel_current_coach_insert" ON "BloodworkPanel"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_current_coach_of("client_id")
  );

ALTER POLICY "p_bloodworkresult_select" ON "BloodworkResult"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkResult"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkresult_select" ON "BloodworkResult" IS 'Read PHI lab markers only for the panel client, panel coach, the current coach of that client, or an owner.';
ALTER POLICY "p_bloodworkresult_insert" ON "BloodworkResult"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkResult"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkresult_insert" ON "BloodworkResult" IS 'Insert lab markers only into panels the caller owns, coaches, or is an owner of.';

ALTER POLICY "p_bloodworkattachment_select" ON "BloodworkAttachment"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkAttachment"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkattachment_select" ON "BloodworkAttachment" IS 'Read PHI attachment pointers only for the panel client, panel coach, the current coach of that client, or an owner.';
ALTER POLICY "p_bloodworkattachment_insert" ON "BloodworkAttachment"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkAttachment"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkattachment_insert" ON "BloodworkAttachment" IS 'Insert attachment pointers only into panels the caller owns, coaches, or is an owner of.';

ALTER POLICY "p_coachalert_select" ON "CoachAlert"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_select" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may read.';
ALTER POLICY "p_coachalert_update" ON "CoachAlert"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_update" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may update.';
CREATE POLICY "p_coachalert_insert" ON "CoachAlert" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_insert" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may insert.';
CREATE POLICY "p_coachalert_delete" ON "CoachAlert" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_delete" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may delete.';

ALTER POLICY "community_wearable_prompts_coach_all" ON "community_wearable_prompts"
  USING (app.is_community_workspace_coach("workspaceId"))
  WITH CHECK (app.is_community_workspace_coach("workspaceId"));
COMMENT ON POLICY "community_wearable_prompts_coach_all" ON "community_wearable_prompts" IS NULL;
ALTER POLICY "community_wearable_prompt_sources_coach_all" ON "community_wearable_prompt_sources"
  USING (EXISTS (SELECT 1 FROM "community_wearable_prompts" p WHERE p."id" = "community_wearable_prompt_sources"."promptId" AND app.is_community_workspace_coach(p."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "community_wearable_prompts" p WHERE p."id" = "community_wearable_prompt_sources"."promptId" AND app.is_community_workspace_coach(p."workspaceId")));
COMMENT ON POLICY "community_wearable_prompt_sources_coach_all" ON "community_wearable_prompt_sources" IS NULL;

COMMIT;
