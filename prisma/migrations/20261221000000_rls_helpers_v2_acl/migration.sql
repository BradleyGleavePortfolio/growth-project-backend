-- W1.5-A3.1 (F-A3 fix) — RLS spine convergence: ACL lockdown for the v2 helpers.
--
-- Append-only follow-up to 20261220000000_rls_helpers_v2, which created the two
-- new-namespace helpers (app.current_user_id_v2(), app.current_gym_ids()) but
-- omitted the canonical privilege-locking block. Migrations are append-only
-- (ENGINEERING_RULES §26 "Never edit a shipped migration file"), so the ACL is
-- applied here as a new timestamped migration rather than by editing the
-- already-shipped helper migration.
--
-- ACL pattern (R/RLS-01 canonical, applied identically to every RLS helper per
-- R42 cross-PR consistency — see 20260704000000_rls01_helper_searchpath_hibp):
--   REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--   REVOKE EXECUTE ON FUNCTION ... FROM anon;
--   GRANT EXECUTE ON FUNCTION ... TO authenticated, service_role;
--
-- Rationale: these helpers read the per-request session GUCs (app.user_id /
-- app.gym_ids) that only the authenticated NestJS path ever sets. The anon role
-- has no legitimate reason to evaluate them, and the explicit REVOKE-from-anon
-- defends against a future GRANT regression or PostgREST exposing them as RPC
-- endpoints. This is pure privilege hardening: ZERO live RLS policy is
-- re-pointed and no function body changes — the helpers stay unreferenced by
-- any policy until the deferred A3.2 cutover.
--
-- Forward-only. Re-runnable: REVOKE/GRANT are idempotent. The Supabase-
-- convention roles (anon/authenticated/service_role) are provisioned by the
-- platform in prod and by scripts/ci/supabase-shim.sql in CI before migrations
-- run, matching every prior RLS helper migration.
--
-- Rollback (clean no-op for live RLS — no policy references these helpers):
--   GRANT EXECUTE ON FUNCTION app.current_user_id_v2() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION app.current_gym_ids()    TO PUBLIC;

BEGIN;

REVOKE ALL ON FUNCTION app.current_user_id_v2() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.current_user_id_v2() FROM anon;
GRANT EXECUTE ON FUNCTION app.current_user_id_v2() TO authenticated, service_role;

REVOKE ALL ON FUNCTION app.current_gym_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.current_gym_ids() FROM anon;
GRANT EXECUTE ON FUNCTION app.current_gym_ids() TO authenticated, service_role;

COMMIT;
