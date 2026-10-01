-- R2 — AI processing consent (PLAN_roman_intelligence §6.2).
--
-- Additive only: one new table + index + RLS. No shipped migration is altered.
--
-- "AiProcessingConsent" records that a user allowed their Roman messages and
-- client data to be sent to a third-party AI processor (processor='anthropic',
-- purpose='client_ai_processing', consent_version='client-ai-v2'). The server
-- refuses every Roman turn with 403 ROMAN_CONSENT_REQUIRED, and every coach-AI
-- request about that client with 403 CLIENT_AI_CONSENT_REQUIRED, until a live
-- row for the current version exists. The effective state is derived exactly like
-- "ClientCoachConsent": granted_at set AND (revoked_at IS NULL OR
-- revoked_at < granted_at).
--
-- RLS summary (same shape as RomanSession, migration 20261216000000):
--   * service_role bypass (Primitive A) for server-side writes;
--   * owner-self SELECT / INSERT / UPDATE (user_id = app.current_user_id());
--     platform owner may read all;
--   * no DELETE policy for non-service principals (revocation is an UPDATE
--     that sets revoked_at; history is kept for the audit trail);
--   * anon (NULL current_user_id) sees zero rows.

-- =====================================================================
-- 1) Table
-- =====================================================================
CREATE TABLE "AiProcessingConsent" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "processor"       TEXT NOT NULL,
    "purpose"         TEXT NOT NULL,
    "consent_version" TEXT NOT NULL,
    "copy_sha256"     TEXT,
    "granted_at"      TIMESTAMP(3),
    "revoked_at"      TIMESTAMP(3),
    -- Owner ruling 2026-09-30 16:31 #5: the same onboarding "I agree" box
    -- records the personal-training waiver acceptance. Nullable: a plain
    -- Roman re-consent leaves them untouched.
    "waiver_version"     TEXT,
    "waiver_accepted_at" TIMESTAMP(3),
    "platform"        TEXT,
    "app_version"     TEXT,
    "locale"          TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiProcessingConsent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiProcessingConsent_user_id_processor_purpose_key"
    ON "AiProcessingConsent"("user_id", "processor", "purpose");
CREATE INDEX "AiProcessingConsent_user_id_idx"
    ON "AiProcessingConsent"("user_id");

ALTER TABLE "AiProcessingConsent"
    ADD CONSTRAINT "AiProcessingConsent_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 2) RLS — owner-self, service_role bypass
-- =====================================================================
ALTER TABLE "AiProcessingConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiProcessingConsent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_aiprocessingconsent_service_role_all" ON "AiProcessingConsent";
CREATE POLICY "p_aiprocessingconsent_service_role_all" ON "AiProcessingConsent" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_aiprocessingconsent_service_role_all" ON "AiProcessingConsent" IS 'Primitive A: service_role bypass for server-side consent writes, jobs, migrations and seeds.';

DROP POLICY IF EXISTS "p_aiprocessingconsent_select" ON "AiProcessingConsent";
CREATE POLICY "p_aiprocessingconsent_select" ON "AiProcessingConsent" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_aiprocessingconsent_select" ON "AiProcessingConsent" IS 'Owner-self read: a user reads only their own AI-processing consent rows; platform owner reads all; anon sees zero. A coach never reads a client''s consent through this table.';

DROP POLICY IF EXISTS "p_aiprocessingconsent_insert" ON "AiProcessingConsent";
CREATE POLICY "p_aiprocessingconsent_insert" ON "AiProcessingConsent" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_aiprocessingconsent_insert" ON "AiProcessingConsent" IS 'Owner-self write: a user may INSERT only their own consent row (user_id = self). A forged user_id is rejected by the WITH CHECK.';

DROP POLICY IF EXISTS "p_aiprocessingconsent_update" ON "AiProcessingConsent";
CREATE POLICY "p_aiprocessingconsent_update" ON "AiProcessingConsent" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_aiprocessingconsent_update" ON "AiProcessingConsent" IS 'Owner-self update: covers grant / re-grant / revoke (granted_at, revoked_at, consent_version). CHECK prevents re-owning a row to another user_id. No DELETE policy: history is kept.';

DROP POLICY IF EXISTS "deny_all_anon_aiprocessingconsent" ON "AiProcessingConsent";
CREATE POLICY "deny_all_anon_aiprocessingconsent" ON "AiProcessingConsent" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_aiprocessingconsent" ON "AiProcessingConsent" IS 'RESTRICTIVE deny-all: anon can never read or write consent rows regardless of any permissive policy.';
