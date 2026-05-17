BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$$;

CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT client_user_id IS NOT NULL
     AND coach_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" u
       WHERE u."id" = client_user_id
         AND u."coach_id" = coach_user_id
         AND u."role" = 'student'
     )
$$;

CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$$;

COMMENT ON FUNCTION app.current_user_role() IS
  'Returns the NestJS-authenticated role stored in app.current_user_role for RLS policies; NULL means unauthenticated/no role context.';
COMMENT ON FUNCTION app.is_owner() IS
  'True when the RLS context identifies an authenticated owner user.';
COMMENT ON FUNCTION app.is_user_coached_by(text, text) IS
  'Security-definer helper for RLS policies: true when the first User.id is a student currently assigned to the second User.id coach.';
COMMENT ON FUNCTION app.is_current_coach_of(text) IS
  'True when app.current_user_id() is the current coach of the supplied client User.id.';

-- Enable + force RLS on remaining audited tables.
ALTER TABLE "AiRequestAudit"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiRequestAudit"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "AICallLog"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AICallLog"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "AIDraft"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AIDraft"             FORCE ROW LEVEL SECURITY;
ALTER TABLE "AiActionDraft"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiActionDraft"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "secret_rotation_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_rotation_log" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CoachProfile"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachProfile"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "SplitLedgerEntry"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SplitLedgerEntry"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConnectTransfer"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectTransfer"     FORCE ROW LEVEL SECURITY;
ALTER TABLE "PaymentFailure"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentFailure"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "MacroTarget"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MacroTarget"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "FastingWindow"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FastingWindow"       FORCE ROW LEVEL SECURITY;

-- Keep force enabled on existing health tables being repaired.
ALTER TABLE "CheckIn"             FORCE ROW LEVEL SECURITY;
ALTER TABLE "BloodworkPanel"      FORCE ROW LEVEL SECURITY;

-- AiRequestAudit
DROP POLICY IF EXISTS "ai_request_audit_owner_all" ON "AiRequestAudit";
CREATE POLICY "ai_request_audit_owner_all" ON "AiRequestAudit"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "ai_request_audit_participant_select" ON "AiRequestAudit";
CREATE POLICY "ai_request_audit_participant_select" ON "AiRequestAudit"
  FOR SELECT TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "requester_id" = app.current_user_id()
      OR "subject_user_id" = app.current_user_id()
      OR "tenant_coach_id" = app.current_user_id()
    )
  );

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

-- AICallLog
DROP POLICY IF EXISTS "ai_call_log_owner_all" ON "AICallLog";
CREATE POLICY "ai_call_log_owner_all" ON "AICallLog"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "ai_call_log_participant_select" ON "AICallLog";
CREATE POLICY "ai_call_log_participant_select" ON "AICallLog"
  FOR SELECT TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND ("coachId" = app.current_user_id() OR "clientId" = app.current_user_id())
  );

DROP POLICY IF EXISTS "ai_call_log_participant_insert" ON "AICallLog";
CREATE POLICY "ai_call_log_participant_insert" ON "AICallLog"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND ("coachId" = app.current_user_id() OR "clientId" = app.current_user_id())
  );

-- AIDraft
DROP POLICY IF EXISTS "ai_draft_owner_all" ON "AIDraft";
CREATE POLICY "ai_draft_owner_all" ON "AIDraft"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "ai_draft_coach_all" ON "AIDraft";
CREATE POLICY "ai_draft_coach_all" ON "AIDraft"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id());

DROP POLICY IF EXISTS "ai_draft_client_select_approved" ON "AIDraft";
CREATE POLICY "ai_draft_client_select_approved" ON "AIDraft"
  FOR SELECT TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "clientId" = app.current_user_id()
    AND "status" = 'APPROVED'
  );

-- AiActionDraft
DROP POLICY IF EXISTS "ai_action_draft_owner_all" ON "AiActionDraft";
CREATE POLICY "ai_action_draft_owner_all" ON "AiActionDraft"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "ai_action_draft_participant_select" ON "AiActionDraft";
CREATE POLICY "ai_action_draft_participant_select" ON "AiActionDraft"
  FOR SELECT TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "requester_id" = app.current_user_id()
      OR "subject_user_id" = app.current_user_id()
      OR "tenant_coach_id" = app.current_user_id()
      OR "decided_by_id" = app.current_user_id()
    )
  );

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

DROP POLICY IF EXISTS "ai_action_draft_tenant_decide_update" ON "AiActionDraft";
CREATE POLICY "ai_action_draft_tenant_decide_update" ON "AiActionDraft"
  FOR UPDATE TO public
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

-- AuditLog
DROP POLICY IF EXISTS "audit_log_owner_all" ON "AuditLog";
CREATE POLICY "audit_log_owner_all" ON "AuditLog"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- SecretRotationLog mapped table
DROP POLICY IF EXISTS "secret_rotation_log_owner_all" ON "secret_rotation_log";
CREATE POLICY "secret_rotation_log_owner_all" ON "secret_rotation_log"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- CoachProfile
DROP POLICY IF EXISTS "coach_profile_owner_all" ON "CoachProfile";
CREATE POLICY "coach_profile_owner_all" ON "CoachProfile"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "coach_profile_self_select" ON "CoachProfile";
CREATE POLICY "coach_profile_self_select" ON "CoachProfile"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());

-- SplitLedgerEntry
DROP POLICY IF EXISTS "split_ledger_entry_owner_all" ON "SplitLedgerEntry";
CREATE POLICY "split_ledger_entry_owner_all" ON "SplitLedgerEntry"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "split_ledger_entry_payee_select" ON "SplitLedgerEntry";
CREATE POLICY "split_ledger_entry_payee_select" ON "SplitLedgerEntry"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "payee_user_id" = app.current_user_id());

-- ConnectTransfer
DROP POLICY IF EXISTS "connect_transfer_owner_all" ON "ConnectTransfer";
CREATE POLICY "connect_transfer_owner_all" ON "ConnectTransfer"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "connect_transfer_destination_select" ON "ConnectTransfer";
CREATE POLICY "connect_transfer_destination_select" ON "ConnectTransfer"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "destination_user_id" = app.current_user_id());

-- PaymentFailure
DROP POLICY IF EXISTS "payment_failure_owner_all" ON "PaymentFailure";
CREATE POLICY "payment_failure_owner_all" ON "PaymentFailure"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "payment_failure_coach_select" ON "PaymentFailure";
CREATE POLICY "payment_failure_coach_select" ON "PaymentFailure"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());

-- MacroTarget
DROP POLICY IF EXISTS "macro_target_owner_all" ON "MacroTarget";
CREATE POLICY "macro_target_owner_all" ON "MacroTarget"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "macro_target_coach_all" ON "MacroTarget";
CREATE POLICY "macro_target_coach_all" ON "MacroTarget"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());

DROP POLICY IF EXISTS "macro_target_client_select" ON "MacroTarget";
CREATE POLICY "macro_target_client_select" ON "MacroTarget"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id());

-- FastingWindow
DROP POLICY IF EXISTS "fasting_window_owner_all" ON "FastingWindow";
CREATE POLICY "fasting_window_owner_all" ON "FastingWindow"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "fasting_window_user_all" ON "FastingWindow";
CREATE POLICY "fasting_window_user_all" ON "FastingWindow"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());

DROP POLICY IF EXISTS "fasting_window_current_coach_select" ON "FastingWindow";
CREATE POLICY "fasting_window_current_coach_select" ON "FastingWindow"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("user_id"));

-- Replace unsafe CoachMessage policy defensively, even though the later financial RLS migration already fixed it.
DROP POLICY IF EXISTS "coach_message_participant_access" ON "CoachMessage";
CREATE POLICY "coach_message_participant_access" ON "CoachMessage"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "client_id" = app.current_user_id()
      OR "sender_id" = app.current_user_id()
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "client_id" = app.current_user_id()
      OR "sender_id" = app.current_user_id()
    )
  );

-- Replace unsafe InviteCode policy NULL comparison.
DROP POLICY IF EXISTS "invite_code_coach_owner_access" ON "InviteCode";
CREATE POLICY "invite_code_coach_owner_access" ON "InviteCode"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "invited_by_user_id" = app.current_user_id()
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "invited_by_user_id" = app.current_user_id()
    )
  );

-- Replace unsafe CheckIn FOR ALL policy and close arbitrary-client writes.
DROP POLICY IF EXISTS "check_in_client_or_coach_access" ON "CheckIn";
DROP POLICY IF EXISTS "check_in_owner_all" ON "CheckIn";
CREATE POLICY "check_in_owner_all" ON "CheckIn"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "check_in_client_all" ON "CheckIn";
CREATE POLICY "check_in_client_all" ON "CheckIn"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
    AND ("coach_id" IS NULL OR app.is_user_coached_by("user_id", "coach_id"))
  );

DROP POLICY IF EXISTS "check_in_coach_select" ON "CheckIn";
CREATE POLICY "check_in_coach_select" ON "CheckIn"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());

DROP POLICY IF EXISTS "check_in_current_coach_insert" ON "CheckIn";
CREATE POLICY "check_in_current_coach_insert" ON "CheckIn"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_current_coach_of("user_id")
  );

DROP POLICY IF EXISTS "check_in_current_coach_update" ON "CheckIn";
CREATE POLICY "check_in_current_coach_update" ON "CheckIn"
  FOR UPDATE TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_current_coach_of("user_id")
  );

-- Replace unsafe BloodworkPanel FOR ALL policy and close arbitrary-client writes.
DROP POLICY IF EXISTS "bloodwork_panel_client_or_coach_access" ON "BloodworkPanel";
DROP POLICY IF EXISTS "bloodwork_panel_owner_all" ON "BloodworkPanel";
CREATE POLICY "bloodwork_panel_owner_all" ON "BloodworkPanel"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "bloodwork_panel_client_all" ON "BloodworkPanel";
CREATE POLICY "bloodwork_panel_client_all" ON "BloodworkPanel"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id())
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "client_id" = app.current_user_id()
    AND ("coach_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id"))
  );

DROP POLICY IF EXISTS "bloodwork_panel_coach_select" ON "BloodworkPanel";
CREATE POLICY "bloodwork_panel_coach_select" ON "BloodworkPanel"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());

DROP POLICY IF EXISTS "bloodwork_panel_current_coach_insert" ON "BloodworkPanel";
CREATE POLICY "bloodwork_panel_current_coach_insert" ON "BloodworkPanel"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_current_coach_of("client_id")
  );

DROP POLICY IF EXISTS "bloodwork_panel_current_coach_update" ON "BloodworkPanel";
CREATE POLICY "bloodwork_panel_current_coach_update" ON "BloodworkPanel"
  FOR UPDATE TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_current_coach_of("client_id")
  );

GRANT USAGE ON SCHEMA app TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.current_user_role() TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.is_owner() TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.is_user_coached_by(text, text) TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.is_current_coach_of(text) TO service_role, anon, authenticated;

COMMIT;
