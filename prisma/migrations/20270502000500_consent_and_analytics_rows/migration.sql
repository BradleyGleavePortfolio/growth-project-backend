-- RLSLIVE3c (RLSINV I03, H07; owner "RLS for everything!"): only the client
-- grants consent, and only to the coach who coaches them now; the derived
-- analytics rows are written by the server only. Policy text and comments
-- only: no data, grant, helper or table change.
--
-- GAP (production catalog of 2026-10-13; all 25 policies on these five tables
-- are the chain's, with the same text, so none is production-only):
--   * ClientCoachConsent: p_clientcoachconsent_insert admitted coach_id =
--     caller and the caller's client, so a coach granted itself the scopes the
--     consent gate asks the client for, for another coach's client too, and a
--     client granted scopes naming any coach (I03).
--     p_clientcoachconsent_select admitted coach_id = caller with no end, so a
--     former coach kept reading a moved client's consent rows.
--   * ClientSignal, PtmPrediction, HolisticInsightCache: insert/update/delete
--     for the row's user and their current coach, so either rewrote the risk
--     predictions, behaviour signals and cached insights the coach triage
--     reads (H07). ClientOutcome: the same, so a client labelled or deleted
--     their own outcome.
--
-- NOW:
--   * ClientCoachConsent insert: the caller is the client (client_id) and
--     coach_id is the caller's coach now (app.is_user_coached_by), or the
--     owner admin. Select: the client, or the named coach while still
--     coaching that client, or the owner admin. Update and delete stay
--     owner admin only (unchanged).
--   * ClientSignal, PtmPrediction, HolisticInsightCache: their select policy
--     only (the user, their current coach, the owner admin).
--   * ClientOutcome: insert and update by the client's current coach or the
--     owner admin; no delete policy; select unchanged.
-- Unchanged: every *_service_role_all policy.
--
-- Nothing in the app depends on a dropped or narrowed branch: Prisma connects
-- as service_role (BYPASSRLS), every write of these tables in src/ is a
-- Prisma call (consent: ConsentService.grant/revoke and, on join and first
-- sign-in, grantCoachSharingAtJoinTx; signals: PtmService.recordSignal;
-- predictions: PtmRecomputeService; insights: HolisticInsightsService;
-- outcomes: AdminPtmService.labelOutcome; deletes: the account-deletion
-- manifest), src/ sets no role, and the mobile app reads no table through the
-- Supabase Data API. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_clientcoachconsent_insert" ON "ClientCoachConsent"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"))));
COMMENT ON POLICY "p_clientcoachconsent_insert" ON "ClientCoachConsent" IS
  '20270502000500: only the client records consent, and only naming the coach who coaches them now (app.is_user_coached_by); owner admin also. Coaches never grant consent at the row layer.';
ALTER POLICY "p_clientcoachconsent_select" ON "ClientCoachConsent"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"))))));
COMMENT ON POLICY "p_clientcoachconsent_select" ON "ClientCoachConsent" IS
  '20270502000500: the consenting client, the named coach while still coaching that client (a former coach reads none), or an owner.';

DROP POLICY IF EXISTS "p_clientsignal_insert" ON "ClientSignal";
DROP POLICY IF EXISTS "p_clientsignal_update" ON "ClientSignal";
DROP POLICY IF EXISTS "p_clientsignal_delete" ON "ClientSignal";

DROP POLICY IF EXISTS "p_ptmprediction_insert" ON "PtmPrediction";
DROP POLICY IF EXISTS "p_ptmprediction_update" ON "PtmPrediction";
DROP POLICY IF EXISTS "p_ptmprediction_delete" ON "PtmPrediction";

DROP POLICY IF EXISTS "p_holisticinsightcache_insert" ON "HolisticInsightCache";
DROP POLICY IF EXISTS "p_holisticinsightcache_update" ON "HolisticInsightCache";
DROP POLICY IF EXISTS "p_holisticinsightcache_delete" ON "HolisticInsightCache";

DROP POLICY IF EXISTS "p_clientoutcome_delete" ON "ClientOutcome";
ALTER POLICY "p_clientoutcome_insert" ON "ClientOutcome"
  WITH CHECK ((app.is_owner() OR app.is_current_coach_of("user_id")));
COMMENT ON POLICY "p_clientoutcome_insert" ON "ClientOutcome" IS
  '20270502000500: the client''s current coach or an owner labels an outcome; the client does not.';
ALTER POLICY "p_clientoutcome_update" ON "ClientOutcome"
  USING ((app.is_owner() OR app.is_current_coach_of("user_id")))
  WITH CHECK ((app.is_owner() OR app.is_current_coach_of("user_id")));
COMMENT ON POLICY "p_clientoutcome_update" ON "ClientOutcome" IS
  '20270502000500: the client''s current coach or an owner relabels an outcome; the client does not.';

COMMIT;
