-- Reverse of 20270502000500_consent_and_analytics_rows. Only for a confirmed
-- defect: it reopens I03 and H07 (a coach grants itself a client's consent, a
-- former coach reads a moved client's consent rows, clients and coaches write
-- signals, predictions, cached insights and outcome labels at the row layer).
-- Restores the production text of 2026-10-13 exactly, which is the chain's:
-- the policies and comments of 20261213000000_rls_tier1_phi_financial_privacy
-- (ClientCoachConsent) and 20261213000000_rls_tier4_learning_analytics (the
-- four analytics tables). No production-only policy exists on these tables.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_clientcoachconsent_insert" ON "ClientCoachConsent" WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_clientcoachconsent_insert" ON "ClientCoachConsent" IS 'A client may record their own consent and a coach may record consent for their client; owner is also allowed.';
ALTER POLICY "p_clientcoachconsent_select" ON "ClientCoachConsent" USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_clientcoachconsent_select" ON "ClientCoachConsent" IS 'Read consent rows only as the consenting client, the named coach, the current coach of that client, or an owner.';

CREATE POLICY "p_clientsignal_insert" ON "ClientSignal" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
CREATE POLICY "p_clientsignal_update" ON "ClientSignal" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
CREATE POLICY "p_clientsignal_delete" ON "ClientSignal" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_clientsignal_insert" ON "ClientSignal" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_clientsignal_update" ON "ClientSignal" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_clientsignal_delete" ON "ClientSignal" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';

CREATE POLICY "p_ptmprediction_insert" ON "PtmPrediction" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
CREATE POLICY "p_ptmprediction_update" ON "PtmPrediction" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
CREATE POLICY "p_ptmprediction_delete" ON "PtmPrediction" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_ptmprediction_insert" ON "PtmPrediction" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_ptmprediction_update" ON "PtmPrediction" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_ptmprediction_delete" ON "PtmPrediction" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';

CREATE POLICY "p_holisticinsightcache_insert" ON "HolisticInsightCache" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
CREATE POLICY "p_holisticinsightcache_update" ON "HolisticInsightCache" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
CREATE POLICY "p_holisticinsightcache_delete" ON "HolisticInsightCache" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_holisticinsightcache_insert" ON "HolisticInsightCache" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_holisticinsightcache_update" ON "HolisticInsightCache" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_holisticinsightcache_delete" ON "HolisticInsightCache" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';

CREATE POLICY "p_clientoutcome_delete" ON "ClientOutcome" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_clientoutcome_delete" ON "ClientOutcome" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';
ALTER POLICY "p_clientoutcome_insert" ON "ClientOutcome" WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_clientoutcome_insert" ON "ClientOutcome" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
ALTER POLICY "p_clientoutcome_update" ON "ClientOutcome" USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_clientoutcome_update" ON "ClientOutcome" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';

COMMIT;
