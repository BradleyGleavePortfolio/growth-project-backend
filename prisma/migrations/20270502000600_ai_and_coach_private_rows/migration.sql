-- RLSLIVE3d (RLSINV P04, P05, P06, P07; owner "RLS for everything!", "A
-- former coach loses every read of a moved client except their own money
-- records", "The new coach never sees coach A's chat, private notes, nudges or
-- tags"): Roman's approval drafts, AI audit rows and the activity feed are
-- written by the server only, and a coach keeps a row about a client only
-- while that client is still theirs. Policy text and comments only: no data,
-- grant, helper or column change.
--
-- GAP (the text on main and in production, 2026-10-13 catalog; they match):
--   * AiActionDraft ai_action_draft_requester_insert: requester_id = caller OR
--     tenant_coach_id = caller, so a client queued a draft in another coach's
--     approval queue and a coach queued drafts about another tenant's client.
--     ai_action_draft_participant_select / _tenant_decide_update: the former
--     coach kept reading and deciding a moved client's drafts (P05).
--   * AiRequestAudit ai_request_audit_requester_insert / _tenant_update: the
--     coach inserted and rewrote its own AI audit rows; a client inserted rows
--     naming any coach; the former coach kept reading them (P06).
--   * AIDraft ai_draft_coach_all, MessageDraft message_draft_coach_access:
--     FOR ALL on the coach column only, so a coach wrote drafts about another
--     tenant's client and kept every draft about a client who moved (P07).
--   * ActivityEvent p_activityevent_insert/_update/_delete: any of actor,
--     coach, client or the client's current coach inserted, edited and deleted
--     feed events, naming any coach; p_activityevent_select let the former
--     coach keep reading a moved client's events (P04).
--
-- NOW:
--   * AiActionDraft, AiRequestAudit: no insert policy (and no update policy on
--     the audit, which is append-only). A row is read by its client (subject;
--     history follows the client) and by a requester, tenant coach or decider
--     only while the client is still the caller's (a row naming no client stays
--     with its participants). The tenant coach decides a draft on the same
--     terms. owner_all unchanged.
--   * AIDraft, MessageDraft: the draft's coach, for a client who is still his.
--     The client's read of approved AI drafts and owner_all are unchanged.
--   * ActivityEvent: read only (insert, update and delete dropped): the event's
--     client, the client's current coach, the owner admin, and for an event
--     naming no client its actor or coach. service_role_all unchanged.
-- Every branch keys on app.current_user_id() and the tenure helper
-- app.is_user_coached_by (SECURITY DEFINER, 20260607000000; app.is_current_
-- coach_of wraps it), never auth.uid(): a Data API caller (JWT, no GUC) reads
-- and writes nothing here.
--
-- Nothing in the app depends on a dropped or narrowed branch: Prisma connects
-- as service_role (BYPASSRLS) and every write of these tables is a Prisma call.
-- AiActionDraft: src/ai/gateway/ai-gateway.service.ts:480 (create),
-- src/wearables/insights/wearable-insights.controller.ts:172 (create),
-- src/ai/gateway/ai-approval.service.ts:460/565 and the materialisers (decide,
-- expire). AiRequestAudit: ai-gateway.service.ts:505, src/ai/ai.service.ts:706,
-- src/roman/roman.service.ts:1695/1751, src/roman/background/
-- roman-background-spend.ts:155/201, ai-approval.service.ts:479. AIDraft:
-- src/ai/coach/coach-ai.service.ts. MessageDraft: src/v1/v1-coach.service.ts:557/
-- 617. ActivityEvent: v1-coach.service.ts:637 (the only writer). Deletes on a
-- move: src/coach/moved-client-drafts.ts. src/ never sets a role or uses a
-- Supabase client on a table; RlsContextInterceptor sets no GUC (req.user is the
-- Prisma User row, without .sub). The mobile app uses Supabase only for auth
-- and broadcast channels.
-- Merge order: after RLSLIVE3c (20270502000500, timestamp order); no policy
-- overlap with any open PR. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- AiActionDraft.
DROP POLICY IF EXISTS "ai_action_draft_requester_insert" ON "AiActionDraft";
ALTER POLICY "ai_action_draft_participant_select" ON "AiActionDraft"
  USING (app.current_user_id() IS NOT NULL AND ("subject_user_id" = app.current_user_id() OR (("requester_id" = app.current_user_id() OR "tenant_coach_id" = app.current_user_id() OR "decided_by_id" = app.current_user_id()) AND ("subject_user_id" IS NULL OR app.is_user_coached_by("subject_user_id", app.current_user_id())))));
COMMENT ON POLICY "ai_action_draft_participant_select" ON "AiActionDraft" IS '20270502000600: the draft''s client, or its requester, tenant coach or decider while the client is still theirs (a draft naming no client: its participants).';
ALTER POLICY "ai_action_draft_tenant_decide_update" ON "AiActionDraft"
  USING (app.current_user_id() IS NOT NULL AND "tenant_coach_id" = app.current_user_id() AND ("requester_id" IS NULL OR "requester_id" <> app.current_user_id()) AND ("subject_user_id" IS NULL OR app.is_user_coached_by("subject_user_id", "tenant_coach_id")))
  WITH CHECK (app.current_user_id() IS NOT NULL AND "tenant_coach_id" = app.current_user_id() AND ("requester_id" IS NULL OR "requester_id" <> app.current_user_id()) AND ("subject_user_id" IS NULL OR app.is_user_coached_by("subject_user_id", "tenant_coach_id")));
COMMENT ON POLICY "ai_action_draft_tenant_decide_update" ON "AiActionDraft" IS '20270502000600: the tenant coach decides a draft he did not request, while its client is still his.';

-- AiRequestAudit (append-only).
DROP POLICY IF EXISTS "ai_request_audit_requester_insert" ON "AiRequestAudit";
DROP POLICY IF EXISTS "ai_request_audit_tenant_update" ON "AiRequestAudit";
ALTER POLICY "ai_request_audit_participant_select" ON "AiRequestAudit"
  USING (app.current_user_id() IS NOT NULL AND ("subject_user_id" = app.current_user_id() OR (("requester_id" = app.current_user_id() OR "tenant_coach_id" = app.current_user_id()) AND ("subject_user_id" IS NULL OR app.is_user_coached_by("subject_user_id", app.current_user_id())))));
COMMENT ON POLICY "ai_request_audit_participant_select" ON "AiRequestAudit" IS '20270502000600: the row''s client, or its requester or tenant coach while the client is still theirs (a row naming no client: its participants). Server-written only.';

-- AIDraft.
ALTER POLICY "ai_draft_coach_all" ON "AIDraft"
  USING (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id() AND app.is_user_coached_by("clientId", "coachId"))
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id() AND app.is_user_coached_by("clientId", "coachId"));
COMMENT ON POLICY "ai_draft_coach_all" ON "AIDraft" IS '20270502000600: the draft''s coach, for a client who is still his.';

-- MessageDraft.
ALTER POLICY "message_draft_coach_access" ON "MessageDraft"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"))
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"));
COMMENT ON POLICY "message_draft_coach_access" ON "MessageDraft" IS '20270502000600: the draft''s coach, for a client who is still his.';

-- ActivityEvent (server-written feed).
DROP POLICY IF EXISTS "p_activityevent_insert" ON "ActivityEvent";
DROP POLICY IF EXISTS "p_activityevent_update" ON "ActivityEvent";
DROP POLICY IF EXISTS "p_activityevent_delete" ON "ActivityEvent";
ALTER POLICY "p_activityevent_select" ON "ActivityEvent"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id") OR ("client_id" IS NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id())))));
COMMENT ON POLICY "p_activityevent_select" ON "ActivityEvent" IS '20270502000600: owner, the event client, the client''s current coach, or for an event naming no client its actor or coach. Server-written only.';

COMMIT;
