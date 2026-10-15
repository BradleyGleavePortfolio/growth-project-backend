-- Reverse of 20270502000600_ai_and_coach_private_rows. Only for a confirmed
-- defect: it reopens P04-P07 (participants write Roman drafts, AI audit rows
-- and feed events naming any coach; the former coach keeps a moved client's
-- drafts, audits and events). Restores verbatim the text of 20260607000000
-- (AiActionDraft, AiRequestAudit, AIDraft), 20260611000001 (MessageDraft) and
-- 20261213000000 (ActivityEvent, with its comments), which is also the
-- production text of the 2026-10-13 catalog: no production-only policy exists
-- on these five tables. The AI-table policies had no comment.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- AiActionDraft.
ALTER POLICY "ai_action_draft_participant_select" ON "AiActionDraft"
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "requester_id" = app.current_user_id()
      OR "subject_user_id" = app.current_user_id()
      OR "tenant_coach_id" = app.current_user_id()
      OR "decided_by_id" = app.current_user_id()
    )
  );
COMMENT ON POLICY "ai_action_draft_participant_select" ON "AiActionDraft" IS NULL;
ALTER POLICY "ai_action_draft_tenant_decide_update" ON "AiActionDraft"
  USING (
    app.current_user_id() IS NOT NULL
    AND "tenant_coach_id" = app.current_user_id()
    AND ("requester_id" IS NULL OR "requester_id" <> app.current_user_id())
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "tenant_coach_id" = app.current_user_id()
    AND ("requester_id" IS NULL OR "requester_id" <> app.current_user_id())
  );
COMMENT ON POLICY "ai_action_draft_tenant_decide_update" ON "AiActionDraft" IS NULL;
DROP POLICY IF EXISTS "ai_action_draft_requester_insert" ON "AiActionDraft";
CREATE POLICY "ai_action_draft_requester_insert" ON "AiActionDraft"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "requester_id" = app.current_user_id()
      OR "tenant_coach_id" = app.current_user_id()
    )
  );

-- AiRequestAudit.
ALTER POLICY "ai_request_audit_participant_select" ON "AiRequestAudit"
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "requester_id" = app.current_user_id()
      OR "subject_user_id" = app.current_user_id()
      OR "tenant_coach_id" = app.current_user_id()
    )
  );
COMMENT ON POLICY "ai_request_audit_participant_select" ON "AiRequestAudit" IS NULL;
DROP POLICY IF EXISTS "ai_request_audit_requester_insert" ON "AiRequestAudit";
CREATE POLICY "ai_request_audit_requester_insert" ON "AiRequestAudit"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "requester_id" = app.current_user_id()
      OR "tenant_coach_id" = app.current_user_id()
    )
  );
DROP POLICY IF EXISTS "ai_request_audit_tenant_update" ON "AiRequestAudit";
CREATE POLICY "ai_request_audit_tenant_update" ON "AiRequestAudit"
  FOR UPDATE TO public
  USING (app.current_user_id() IS NOT NULL AND "tenant_coach_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "tenant_coach_id" = app.current_user_id());

-- AIDraft.
ALTER POLICY "ai_draft_coach_all" ON "AIDraft"
  USING (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id());
COMMENT ON POLICY "ai_draft_coach_all" ON "AIDraft" IS NULL;

-- MessageDraft.
ALTER POLICY "message_draft_coach_access" ON "MessageDraft"
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );
COMMENT ON POLICY "message_draft_coach_access" ON "MessageDraft" IS NULL;

-- ActivityEvent.
ALTER POLICY "p_activityevent_select" ON "ActivityEvent"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_activityevent_select" ON "ActivityEvent" IS 'PR-RLS-06 participant-event read: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';
DROP POLICY IF EXISTS "p_activityevent_insert" ON "ActivityEvent";
CREATE POLICY "p_activityevent_insert" ON "ActivityEvent" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_activityevent_insert" ON "ActivityEvent" IS 'PR-RLS-06 participant-event insert: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';
DROP POLICY IF EXISTS "p_activityevent_update" ON "ActivityEvent";
CREATE POLICY "p_activityevent_update" ON "ActivityEvent" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_activityevent_update" ON "ActivityEvent" IS 'PR-RLS-06 participant-event update: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';
DROP POLICY IF EXISTS "p_activityevent_delete" ON "ActivityEvent";
CREATE POLICY "p_activityevent_delete" ON "ActivityEvent" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_activityevent_delete" ON "ActivityEvent" IS 'PR-RLS-06 participant-event delete: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';

COMMIT;
